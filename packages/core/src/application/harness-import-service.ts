// Import of rule files into a draft harness (docs/harness.md §5). Read-only scan through the
// RuleSourceReader, parsed by the pure importer, reviewed by the user, committed as a DRAFT (never
// published). Views carry repo labels and repo-relative paths only; nothing found is executed.
import {
  ImportCommitArgsSchema,
  RULE_CATEGORIES,
  type HarnessDetail,
  type ImportCandidateView,
  type ImportCommitArgs,
  type ImportGateSuggestion,
  type ImportPreview,
  type ImportSourceView,
  type RuleCategory,
  type RuleDraft,
  type RuleSourceFormat,
  type RuleSourceView,
} from '@agent-office/shared'
import { assertAuthorized, USER, type Principal } from '../domain/authz.ts'
import { NotFoundError, ValidationError } from '../domain/errors.ts'
import { detectConflicts, normalizeRuleText } from '../domain/harness-conflicts.ts'
import type { RuleSource } from '../domain/harness-types.ts'
import type { Clock, RuleSourceFile, RuleSourceReader } from '../ports/driven.ts'
import type { HarnessImport, ProjectRepos } from '../ports/driving.ts'
import type { HarnessService } from './harness-service.ts'
import { requireProject } from './project-views.ts'
import type { ProjectsStore } from './projects-store.ts'

/** The pure parser's shape (domain/harness-import.ts), injected so tests can stub it. */
export type ParseRuleFile = (
  format: RuleSourceFormat,
  text: string,
  source: RuleSourceView,
) => {
  candidates: Omit<ImportCandidateView, 'tempId' | 'duplicateOf' | 'conflictsWith'>[]
  gates: Omit<ImportGateSuggestion, 'tempId'>[]
}
export type FormatOf = (relPath: string) => RuleSourceFormat | undefined

export interface HarnessImportDeps {
  store: ProjectsStore
  harness: HarnessService
  repos: ProjectRepos
  clock: Clock
  reader?: RuleSourceReader
  parse: ParseRuleFile
  formatOf: FormatOf
}

interface Found extends ImportSourceView {
  repoId: string
}

interface Cached {
  preview: ImportPreview
}

const MAX_CANDIDATES = 200
const isRelative = (p: string) =>
  !!p &&
  !p.startsWith('/') &&
  !p.startsWith('\\') &&
  !/^[a-zA-Z]:/.test(p) &&
  !p.split(/[\\/]/).includes('..')

export class HarnessImportService implements HarnessImport {
  /** The last preview per project (memory only). */
  private previews = new Map<string, Cached>()

  constructor(private d: HarnessImportDeps) {}

  async detect(projectId: string, as: Principal = USER): Promise<ImportSourceView[]> {
    this.authorize(projectId, as)
    return (await this.found(projectId)).map(({ repoId: _r, ...v }) => v)
  }

  async preview(
    o: { projectId: string; paths?: string[] },
    as: Principal = USER,
  ): Promise<ImportPreview> {
    this.authorize(o.projectId, as)
    const reader = this.d.reader
    if (!reader) throw new ValidationError('import unavailable')
    const now = this.d.clock.now()
    let sources = await this.found(o.projectId)
    if (o.paths) sources = sources.filter((s) => o.paths!.includes(s.path))
    const candidates: ImportCandidateView[] = []
    const gates: ImportGateSuggestion[] = []
    for (const s of sources) {
      const root = this.d.repos.repoPath(o.projectId, s.repoId)
      if (!root) continue
      let parsed: ReturnType<ParseRuleFile>
      try {
        const { text, hash } = await reader.read(root, s.path)
        const format = this.d.formatOf(s.path) ?? s.format
        const view: RuleSourceView = {
          format,
          path: s.path,
          repoLabel: s.repoLabel,
          hash,
          importedAt: now,
        }
        parsed = this.d.parse(format, text, view)
      } catch {
        continue
      }
      s.ruleCount = parsed.candidates.length
      for (const c of parsed.candidates) {
        if (candidates.length >= MAX_CANDIDATES) break
        candidates.push({ ...c, tempId: `cand_${(candidates.length + 1).toString(36)}` })
      }
      for (const g of parsed.gates)
        gates.push({ ...g, tempId: `cand_g${(gates.length + 1).toString(36)}` })
    }
    this.markDuplicates(o.projectId, candidates)
    const conflicts = detectConflicts(
      candidates.map((c) => ({ id: c.tempId, text: c.text, name: c.name })),
    )
    for (const c of conflicts) {
      if (c.kind === 'duplicate') continue
      for (const id of c.ruleIds) {
        const cand = candidates.find((x) => x.tempId === id)
        if (cand)
          cand.conflictsWith = [
            ...new Set([...(cand.conflictsWith ?? []), ...c.ruleIds.filter((x) => x !== id)]),
          ]
      }
    }
    const byCategory = Object.fromEntries(RULE_CATEGORIES.map((k) => [k, 0])) as Record<
      RuleCategory,
      number
    >
    for (const c of candidates) byCategory[c.category]++
    const preview: ImportPreview = {
      previewId: this.d.store.newId('prv'),
      projectId: o.projectId,
      sources: sources.map(({ repoId: _r, ...v }) => v),
      candidates,
      gates,
      conflicts,
      totals: { rules: candidates.length, byCategory, conflicts: conflicts.length },
    }
    this.previews.set(o.projectId, { preview })
    return preview
  }

  async commit(args: ImportCommitArgs, as: Principal = USER): Promise<HarnessDetail> {
    const parsed = ImportCommitArgsSchema.safeParse(args)
    if (!parsed.success) throw new ValidationError('invalid import arguments')
    const a = parsed.data
    const cached = [...this.previews.values()].find((c) => c.preview.previewId === a.previewId)
    if (!cached) throw new NotFoundError('preview')
    const { preview } = cached
    this.authorize(preview.projectId, as)
    const edits = new Map((a.edits ?? []).map((e) => [e.tempId, e]))
    const sources = new Map<string, RuleSource>()
    const rules: RuleDraft[] = a.selected.map((tempId) => {
      const c = preview.candidates.find((x) => x.tempId === tempId)
      if (!c) throw new ValidationError('unknown candidate')
      const e = edits.get(tempId)
      const id = this.d.store.newId('rul')
      sources.set(id, toRuleSource(c.source))
      const globs = c.source.globs?.slice(0, 50)
      return {
        id,
        name: e?.name ?? c.name,
        text: e?.text ?? c.text,
        category: e?.category ?? c.category,
        enforcement: e?.enforcement ?? c.enforcement,
        severity: e?.severity ?? c.severity,
        ...(e?.policy ? { policy: e.policy } : {}),
        ...(globs?.length ? { appliesTo: { filePatterns: globs } } : {}),
      }
    })
    const gates = a.gates.map((tempId) => {
      const g = preview.gates.find((x) => x.tempId === tempId)
      if (!g) throw new ValidationError('unknown gate suggestion')
      if (g.rejected) throw new ValidationError('this command cannot be a gate')
      return { name: g.name.slice(0, 80), argv: [...g.argv] }
    })
    const draft = {
      name: a.name,
      ...(a.description ? { description: a.description } : {}),
      rules,
      gates,
    }
    const created = await this.d.harness.createWith(draft, sources, as)
    this.previews.delete(preview.projectId)
    if (a.attach) await this.d.harness.attach(preview.projectId, created.id, as)
    return this.d.harness.get(created.id, as)
  }

  // ── internals ──

  private authorize(projectId: string, as: Principal): void {
    const p = requireProject(this.d.store, projectId)
    assertAuthorized(as, 'harness.manage', { kind: 'harness', projectId }, p)
  }

  private async found(projectId: string): Promise<Found[]> {
    const reader = this.d.reader
    const p = this.d.store.projects.get(projectId)
    if (!reader || !p) return []
    const out: Found[] = []
    for (const repo of p.repos) {
      const root = this.d.repos.repoPath(projectId, repo.id)
      if (!root) continue
      let files: RuleSourceFile[]
      try {
        files = await reader.detect(root)
      } catch {
        continue
      }
      for (const f of files)
        if (isRelative(f.path))
          out.push({
            repoId: repo.id,
            path: f.path,
            repoLabel: repo.label,
            format: f.format,
            bytes: f.bytes,
          })
    }
    return out
  }

  /** Same normalized text as an earlier candidate or an attached harness's rule. */
  private markDuplicates(projectId: string, candidates: ImportCandidateView[]): void {
    const seen = new Map<string, string>()
    const p = this.d.store.projects.get(projectId)
    for (const a of p?.harnesses ?? [])
      for (const r of this.d.store.harness(a.harnessId)?.rules ?? [])
        if (!seen.has(normalizeRuleText(r.text))) seen.set(normalizeRuleText(r.text), r.id)
    for (const c of candidates) {
      const k = normalizeRuleText(c.text)
      const first = seen.get(k)
      if (first) c.duplicateOf = first
      else seen.set(k, c.tempId)
    }
  }
}

function toRuleSource(s: RuleSourceView): RuleSource {
  return {
    format: s.format,
    path: s.path,
    repoLabel: s.repoLabel,
    hash: s.hash,
    importedAt: s.importedAt,
    ...(s.globs?.length ? { globs: [...s.globs] } : {}),
  }
}
