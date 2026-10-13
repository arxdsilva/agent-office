import {
  MEMORY_SCOPES,
  MEMORY_STATES,
  type MemoryScope,
  type MemoryState,
} from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import {
  ACTIONS,
  assertAuthorized,
  authorize,
  type Action,
  type Principal,
  type Resource,
} from './authz.ts'
import { ForbiddenError } from './errors.ts'
import type { Project } from './project.ts'

const OWN = 'prj_own000000000'
const OTHER = 'prj_other0000000'

function project(id: string, over: Partial<Project['policy']> = {}): Project {
  return {
    id,
    name: id,
    color: '#000000',
    createdAt: 0,
    repos: [],
    policy: {
      providers: { codex: 'read-propose', cursor: 'read', gemini: 'none' },
      scopes: ['global', 'project'],
      sessionExcerpts: false,
      ...over,
    },
  }
}

const user: Principal = { kind: 'user' }
const mcp = (provider: string, access: 'read' | 'read-propose', projectId = OWN): Principal => ({
  kind: 'mcp',
  projectId,
  sessionId: 'ses_a',
  provider,
  tokenId: 'tok_a',
  access,
})
const runtime = (provider: string, projectId = OWN): Principal => ({
  kind: 'runtime',
  provider,
  projectId,
})

const PRINCIPALS: [string, Principal][] = [
  ['mcp read-propose', mcp('codex', 'read-propose')],
  ['mcp read', mcp('cursor', 'read')],
  ['mcp token read-propose, policy read', mcp('cursor', 'read-propose')],
  ['mcp policy none', mcp('gemini', 'read-propose')],
  ['mcp provider not in policy', mcp('copilot', 'read')],
  ['runtime', runtime('codex')],
  ['runtime policy none', runtime('gemini')],
]

const mem = (projectId: string | null, scope: MemoryScope, state: MemoryState): Resource => ({
  kind: 'memory',
  projectId,
  scope,
  state,
})

describe('authorize — explicit rows of docs/projects.md §2', () => {
  const own = project(OWN)
  const rows: [string, Principal, Action, Resource, Project | undefined, boolean][] = [
    [
      'user reads anything',
      user,
      'memory.read',
      mem(OTHER, 'project', 'rejected'),
      project(OTHER),
      true,
    ],
    ['user approves', user, 'memory.review', mem(OWN, 'project', 'pending'), own, true],
    ['user sets policy', user, 'project.manage', { kind: 'project', projectId: OWN }, own, true],
    ['user reads chat', user, 'chat.read', { kind: 'session', projectId: null }, undefined, true],
    [
      'mcp reads approved own',
      mcp('codex', 'read-propose'),
      'memory.read',
      mem(OWN, 'project', 'approved'),
      own,
      true,
    ],
    [
      'mcp reads approved own session-scope',
      mcp('codex', 'read'),
      'memory.read',
      mem(OWN, 'session', 'approved'),
      project(OWN, { providers: { codex: 'read' } }),
      true,
    ],
    [
      'mcp pending denied',
      mcp('codex', 'read-propose'),
      'memory.read',
      mem(OWN, 'project', 'pending'),
      own,
      false,
    ],
    [
      'mcp rejected denied',
      mcp('codex', 'read-propose'),
      'memory.read',
      mem(OWN, 'project', 'rejected'),
      own,
      false,
    ],
    [
      'mcp superseded denied',
      mcp('codex', 'read-propose'),
      'memory.read',
      mem(OWN, 'project', 'superseded'),
      own,
      false,
    ],
    [
      'mcp other project denied',
      mcp('codex', 'read-propose'),
      'memory.read',
      mem(OTHER, 'project', 'approved'),
      project(OTHER),
      false,
    ],
    [
      'mcp other project via own project arg denied',
      mcp('codex', 'read-propose'),
      'memory.read',
      mem(OTHER, 'project', 'approved'),
      own,
      false,
    ],
    [
      'mcp project arg mismatch denied',
      mcp('codex', 'read-propose'),
      'memory.read',
      mem(OWN, 'project', 'approved'),
      project(OTHER),
      false,
    ],
    [
      'mcp global listed',
      mcp('codex', 'read'),
      'memory.read',
      mem(null, 'global', 'approved'),
      own,
      true,
    ],
    [
      'mcp workspace not listed',
      mcp('codex', 'read'),
      'memory.read',
      mem(null, 'workspace', 'approved'),
      own,
      false,
    ],
    [
      'mcp workspace listed',
      mcp('codex', 'read'),
      'memory.read',
      mem(null, 'workspace', 'approved'),
      project(OWN, { scopes: ['workspace'] }),
      true,
    ],
    [
      'mcp global not listed',
      mcp('codex', 'read'),
      'memory.read',
      mem(null, 'global', 'approved'),
      project(OWN, { scopes: [] }),
      false,
    ],
    [
      'mcp unassigned session memory never',
      mcp('codex', 'read'),
      'memory.read',
      mem(null, 'session', 'approved'),
      project(OWN, { scopes: [...MEMORY_SCOPES] }),
      false,
    ],
    [
      'mcp summaries off',
      mcp('codex', 'read'),
      'summary.read',
      { kind: 'summary', projectId: OWN },
      own,
      false,
    ],
    [
      'mcp summaries on',
      mcp('codex', 'read'),
      'summary.read',
      { kind: 'summary', projectId: OWN },
      project(OWN, { sessionExcerpts: true }),
      true,
    ],
    [
      'mcp other summaries',
      mcp('codex', 'read'),
      'summary.read',
      { kind: 'summary', projectId: OTHER },
      project(OWN, { sessionExcerpts: true }),
      false,
    ],
    [
      'mcp chat never',
      mcp('codex', 'read-propose'),
      'chat.read',
      { kind: 'session', projectId: OWN },
      own,
      false,
    ],
    [
      'mcp transcript never',
      mcp('codex', 'read-propose'),
      'transcript.read',
      { kind: 'session', projectId: OWN },
      own,
      false,
    ],
    [
      'mcp propose own',
      mcp('codex', 'read-propose'),
      'memory.propose',
      mem(OWN, 'project', 'pending'),
      own,
      true,
    ],
    [
      'mcp propose read-only',
      mcp('cursor', 'read'),
      'memory.propose',
      mem(OWN, 'project', 'pending'),
      own,
      false,
    ],
    [
      'mcp propose token > policy',
      mcp('cursor', 'read-propose'),
      'memory.propose',
      mem(OWN, 'project', 'pending'),
      own,
      false,
    ],
    [
      'mcp propose other project',
      mcp('codex', 'read-propose'),
      'memory.propose',
      mem(OTHER, 'project', 'pending'),
      own,
      false,
    ],
    [
      'mcp propose as approved',
      mcp('codex', 'read-propose'),
      'memory.propose',
      mem(OWN, 'project', 'approved'),
      own,
      false,
    ],
    [
      'mcp propose global',
      mcp('codex', 'read-propose'),
      'memory.propose',
      mem(null, 'global', 'pending'),
      own,
      false,
    ],
    [
      'mcp policy none reads nothing',
      mcp('gemini', 'read-propose'),
      'memory.read',
      mem(OWN, 'project', 'approved'),
      own,
      false,
    ],
    [
      'mcp approve never',
      mcp('codex', 'read-propose'),
      'memory.review',
      mem(OWN, 'project', 'pending'),
      own,
      false,
    ],
    [
      'mcp assign never',
      mcp('codex', 'read-propose'),
      'session.assign',
      { kind: 'session', projectId: OWN },
      own,
      false,
    ],
    [
      'mcp manage never',
      mcp('codex', 'read-propose'),
      'project.manage',
      { kind: 'project', projectId: OWN },
      own,
      false,
    ],
    [
      'mcp reads own project',
      mcp('codex', 'read'),
      'project.read',
      { kind: 'project', projectId: OWN },
      own,
      true,
    ],
    [
      'mcp reads other project',
      mcp('codex', 'read'),
      'project.read',
      { kind: 'project', projectId: OTHER },
      project(OTHER),
      false,
    ],
    [
      'mcp archived project',
      mcp('codex', 'read'),
      'memory.read',
      mem(OWN, 'project', 'approved'),
      { ...own, archivedAt: 1 },
      false,
    ],
    [
      'mcp missing project',
      mcp('codex', 'read'),
      'memory.read',
      mem(OWN, 'project', 'approved'),
      undefined,
      false,
    ],
    [
      'runtime reads approved own',
      runtime('codex'),
      'memory.read',
      mem(OWN, 'project', 'approved'),
      own,
      true,
    ],
    [
      'runtime cannot propose',
      runtime('codex'),
      'memory.propose',
      mem(OWN, 'project', 'pending'),
      own,
      false,
    ],
    [
      'runtime policy none',
      runtime('gemini'),
      'memory.read',
      mem(OWN, 'project', 'approved'),
      own,
      false,
    ],
    [
      'runtime search never',
      runtime('codex'),
      'search',
      { kind: 'project', projectId: OWN },
      own,
      false,
    ],
  ]
  it.each(rows)('%s', (_name, p, action, resource, proj, ok) => {
    expect(authorize(p, action, resource, proj).ok).toBe(ok)
  })
})

describe('authorize — exhaustive invariants (principal × action × scope × state × own/other)', () => {
  const policies = [
    project(OWN),
    project(OWN, { scopes: [...MEMORY_SCOPES], sessionExcerpts: true }),
  ]
  const cases: {
    name: string
    p: Principal
    a: Action
    r: Resource
    proj: Project
    ok: boolean
  }[] = []
  for (const proj of policies)
    for (const [pname, p] of PRINCIPALS)
      for (const a of ACTIONS)
        for (const scope of MEMORY_SCOPES)
          for (const state of MEMORY_STATES)
            for (const where of [OWN, OTHER, null]) {
              const r = mem(where, scope, state)
              cases.push({
                name: `${pname} ${a} ${scope} ${state} ${where}`,
                p,
                a,
                r,
                proj,
                ok: authorize(p, a, r, proj).ok,
              })
            }

  it('covers every combination', () => {
    expect(cases.length).toBe(2 * PRINCIPALS.length * ACTIONS.length * 4 * 4 * 3)
  })

  it('non-user principals never touch pending/rejected/superseded except proposing pending', () => {
    for (const k of cases)
      if (k.r.kind === 'memory' && k.r.state !== 'approved' && k.ok)
        expect([k.a, k.r.state, k.name]).toEqual(['memory.propose', 'pending', k.name])
  })

  it('non-user principals never reach another project', () => {
    for (const k of cases)
      if (k.r.kind === 'memory' && k.r.projectId === OTHER) expect(k.ok, k.name).toBe(false)
  })

  it('only these actions are ever allowed for non-user principals', () => {
    const allowed = new Set(cases.filter((k) => k.ok).map((k) => k.a))
    expect([...allowed].sort()).toEqual(['memory.propose', 'memory.read'])
  })

  it('policy none and unlisted providers deny everything', () => {
    for (const k of cases)
      if (k.name.includes('policy none') || k.name.includes('not in policy'))
        expect(k.ok, k.name).toBe(false)
  })

  it('only read-propose (token and policy) may propose; runtime never', () => {
    for (const k of cases)
      if (k.a === 'memory.propose' && k.ok)
        expect(k.name.startsWith('mcp read-propose ')).toBe(true)
  })

  it('project-less memory reaches agents only for listed global/workspace scopes', () => {
    for (const k of cases)
      if (k.r.kind === 'memory' && k.r.projectId === null && k.ok) {
        expect(['global', 'workspace']).toContain(k.r.scope)
        expect(k.proj.policy.scopes).toContain(k.r.scope)
      }
  })

  it('the user may do everything', () => {
    for (const a of ACTIONS)
      expect(authorize(user, a, mem(OTHER, 'project', 'pending'), undefined).ok).toBe(true)
  })

  it('assertAuthorized throws ForbiddenError without detail', () => {
    expect(() =>
      assertAuthorized(
        mcp('codex', 'read'),
        'chat.read',
        { kind: 'session', projectId: OWN },
        project(OWN),
      ),
    ).toThrow(ForbiddenError)
    expect(() =>
      assertAuthorized(user, 'chat.read', { kind: 'session', projectId: OWN }, undefined),
    ).not.toThrow()
  })
})
