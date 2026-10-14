// Harness management (docs/harness.md §1, §6): drafts, versions, publish, archive, attachments.
// User actions only: every method authorizes `harness.read` / `harness.manage`.
import type {
  HarnessDetail,
  HarnessDraft,
  HarnessSummary,
  HarnessTemplateView,
} from '@agent-office/shared'
import { assertAuthorized, USER, type Principal } from '../domain/authz.ts'
import { NotFoundError, ValidationError } from '../domain/errors.ts'
import {
  archiveHarness,
  createHarness,
  publishHarness,
  reviseHarness,
  toHarnessDetail,
  toHarnessSummary,
} from '../domain/harness.ts'
import { detectConflicts } from '../domain/harness-conflicts.ts'
import { HARNESS_TEMPLATES as TEMPLATES } from '../domain/harness-templates.ts'
import type { Harness, RuleSource } from '../domain/harness-types.ts'
import { attachHarness, reorderHarnesses, detachHarness } from '../domain/project.ts'
import type { Clock } from '../ports/driven.ts'
import type { HarnessManagement } from '../ports/driving.ts'
import type { ActivityLog } from './activity-log.ts'
import { requireProject } from './project-views.ts'
import type { ProjectsStore } from './projects-store.ts'

const ANY = { kind: 'harness', projectId: null } as const

export class HarnessService implements HarnessManagement {
  constructor(private d: { store: ProjectsStore; activity: ActivityLog; clock: Clock }) {}

  list(as: Principal = USER): HarnessSummary[] {
    assertAuthorized(as, 'harness.read', ANY, undefined)
    return this.d.store
      .allHarnesses()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((h) => toHarnessSummary(h, this.projectsOf(h.id)))
  }

  get(harnessId: string, as: Principal = USER): HarnessDetail {
    assertAuthorized(as, 'harness.read', ANY, undefined)
    return this.detail(this.require(harnessId))
  }

  versions(harnessId: string, as: Principal = USER): HarnessDetail[] {
    assertAuthorized(as, 'harness.read', ANY, undefined)
    this.require(harnessId)
    return this.d.store.harnessVersions(harnessId).map((h) => this.detail(h))
  }

  async create(draft: HarnessDraft, as: Principal = USER): Promise<HarnessDetail> {
    return this.createWith(draft, undefined, as)
  }

  /** Main only (the importer): a draft whose pre-assigned rule ids carry provenance. */
  async createWith(
    draft: HarnessDraft,
    sources: ReadonlyMap<string, RuleSource> | undefined,
    as: Principal = USER,
  ): Promise<HarnessDetail> {
    assertAuthorized(as, 'harness.manage', ANY, undefined)
    const h = createHarness(draft, {
      id: this.d.store.newId('hrn'),
      now: this.d.clock.now(),
      newId: (p) => this.d.store.newId(p),
      ...(sources ? { sources } : {}),
    })
    await this.d.store.putHarness(h)
    return this.detail(h)
  }

  async update(
    harnessId: string,
    draft: HarnessDraft,
    as: Principal = USER,
  ): Promise<HarnessDetail> {
    assertAuthorized(as, 'harness.manage', ANY, undefined)
    const next = reviseHarness(this.require(harnessId), draft, this.d.clock.now(), (p) =>
      this.d.store.newId(p),
    )
    await this.d.store.putHarness(next)
    return this.detail(next)
  }

  async publish(harnessId: string, as: Principal = USER): Promise<HarnessDetail> {
    assertAuthorized(as, 'harness.manage', ANY, undefined)
    const next = publishHarness(this.require(harnessId), this.d.clock.now())
    await this.d.store.putHarness(next)
    for (const projectId of this.projectsOf(next.id))
      void this.d.activity.add(
        projectId,
        'harness.published',
        'you',
        `Published harness “${next.name}” v${next.version}`,
      )
    return this.detail(next)
  }

  async archive(harnessId: string, as: Principal = USER): Promise<HarnessDetail> {
    assertAuthorized(as, 'harness.manage', ANY, undefined)
    const next = archiveHarness(this.require(harnessId), this.d.clock.now())
    await this.d.store.putHarness(next)
    return this.detail(next)
  }

  async attach(
    projectId: string,
    harnessId: string,
    as: Principal = USER,
  ): Promise<HarnessSummary[]> {
    const p = requireProject(this.d.store, projectId)
    assertAuthorized(as, 'harness.manage', { kind: 'harness', projectId }, p)
    const h = this.require(harnessId)
    if (h.status === 'archived') throw new ValidationError('this harness is archived')
    const next = attachHarness(p, harnessId, this.d.clock.now())
    if (next !== p) {
      await this.d.store.putProject(next)
      this.d.store.emit({ type: 'harness', harnessId, projectId })
      void this.d.activity.add(projectId, 'harness.attached', 'you', `Attached harness “${h.name}”`)
    }
    return this.attached(projectId, as)
  }

  async detach(
    projectId: string,
    harnessId: string,
    as: Principal = USER,
  ): Promise<HarnessSummary[]> {
    const p = requireProject(this.d.store, projectId)
    assertAuthorized(as, 'harness.manage', { kind: 'harness', projectId }, p)
    await this.d.store.putProject(detachHarness(p, harnessId))
    this.d.store.emit({ type: 'harness', harnessId, projectId })
    return this.attached(projectId, as)
  }

  async reorder(
    projectId: string,
    harnessIds: string[],
    as: Principal = USER,
  ): Promise<HarnessSummary[]> {
    const p = requireProject(this.d.store, projectId)
    assertAuthorized(as, 'harness.manage', { kind: 'harness', projectId }, p)
    const next = reorderHarnesses(p, harnessIds)
    if (next !== p) {
      await this.d.store.putProject(next)
      this.d.store.emit({ type: 'harness', projectId })
    }
    return this.attached(projectId, as)
  }

  attached(projectId: string, as: Principal = USER): HarnessSummary[] {
    const p = requireProject(this.d.store, projectId)
    assertAuthorized(as, 'harness.read', { kind: 'harness', projectId }, p)
    return (p.harnesses ?? [])
      .map((a) => this.d.store.harness(a.harnessId))
      .filter((h): h is Harness => !!h)
      .map((h) => toHarnessSummary(h, this.projectsOf(h.id)))
  }

  templates(as: Principal = USER): HarnessTemplateView[] {
    assertAuthorized(as, 'harness.read', ANY, undefined)
    return TEMPLATES.map(({ draft: _d, version: _v, ...t }) => t)
  }

  async createFromTemplate(templateId: string, as: Principal = USER): Promise<HarnessDetail> {
    const t = TEMPLATES.find((x) => x.id === templateId)
    if (!t) throw new NotFoundError('template')
    return this.create(t.draft, as)
  }

  private require(id: string): Harness {
    const h = this.d.store.harness(id)
    if (!h) throw new NotFoundError('harness')
    return h
  }

  private projectsOf(harnessId: string): string[] {
    return [...this.d.store.projects.values()]
      .filter((p) => p.harnesses?.some((a) => a.harnessId === harnessId))
      .map((p) => p.id)
  }

  private detail(h: Harness): HarnessDetail {
    return toHarnessDetail(h, this.projectsOf(h.id), detectConflicts(h.rules))
  }
}
