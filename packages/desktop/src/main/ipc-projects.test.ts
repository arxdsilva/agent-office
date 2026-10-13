import {
  ForbiddenError,
  NotFoundError,
  SessionStartError,
  ValidationError,
} from '@agent-office/core'
import { ManualScheduler } from '@agent-office/core/testing'
import { DEFAULT_SETTINGS, IPC, type ProjectMessage } from '@agent-office/shared'
import { describe, expect, it, vi } from 'vitest'
import { createIpcHandlers, createProjectPushBridge, safeError, type IpcPorts } from './ipc-api.ts'

const PRJ = 'prj_abcdefghij'
const REPO = 'rp_abcdefghij'
const TASK = 'tsk_abcdefghij'
const SES = 'ses_abcdefghij'
const FOLDER = 'ctx_aaaaaaaaaaaa'
const ABS = '/Users/me/code/shop-api'

function setup(over: { startWithContext?: () => Promise<string> } = {}) {
  const projects = {
    catalog: {
      list: vi.fn(() => []),
      create: vi.fn(async () => ({ id: PRJ })),
      addRepos: vi.fn(async () => ({ id: PRJ })),
      removeRepo: vi.fn(async () => ({ id: PRJ })),
      update: vi.fn(async () => ({ id: PRJ })),
    },
    repos: { repoPath: vi.fn((_p: string, r: string) => (r === REPO ? ABS : undefined)) },
    sessions: {
      list: vi.fn(() => []),
      messages: vi.fn(async () => ({ messages: [], more: false })),
    },
    assignment: { assign: vi.fn(async () => ({})) },
    memory: {
      list: vi.fn(() => []),
      create: vi.fn(async () => ({})),
      review: vi.fn(async () => ({})),
    },
    context: { preview: vi.fn(), inspect: vi.fn(() => ({})) },
    handoffs: {
      launch: vi.fn(async () => ({ agentId: 'codex:1' })),
      startWithContext: vi.fn(over.startWithContext ?? (async () => 'cc:ctx')),
    },
    workspace: { overview: vi.fn(() => ({})), dashboard: vi.fn(() => ({})), watch: vi.fn() },
    search: { search: vi.fn(async () => []) },
    tasks: {
      list: vi.fn(() => []),
      create: vi.fn(async () => ({ id: TASK })),
      setState: vi.fn(async () => ({ id: TASK, state: 'doing' })),
      addEvidence: vi.fn(async () => ({ id: TASK, state: 'doing', evidence: ['user-confirmed'] })),
    },
    history: {
      importHistory: vi.fn(async () => ({ imported: 2, skipped: 1 })),
      resume: vi.fn(async () => ({ agentId: 'cc:resumed' })),
    },
  }
  const sessions = { start: vi.fn(async (_o: unknown) => 'cc:s1') }
  const context = {
    pick: vi.fn(),
    resolve: (ref: string) =>
      ref === FOLDER
        ? { path: ABS, kind: 'folder' as const, label: 'shop-api', hint: '~' }
        : undefined,
    exists: () => true,
  }
  const ports = {
    query: {
      snapshot: () => ({ agents: [], messages: [] }),
      agents: () => [],
      agent: () => undefined,
      watch: () => () => {},
    },
    chat: { send: vi.fn(), history: () => [] },
    settings: { get: async () => DEFAULT_SETTINGS, update: vi.fn() },
    hooks: {},
    updates: {},
    version: '0',
    connections: {},
    copyText: () => {},
    onHookChanged: () => {},
    onReady: () => {},
    sessions,
    context,
    projects,
  } as unknown as IpcPorts
  return { h: createIpcHandlers(ports), projects, sessions }
}

describe('prj:* handlers', () => {
  it('resolve ctx_ folders to absolute paths in main before calling core', async () => {
    const { h, projects } = setup()
    await h[IPC.prjCreate]!({ name: 'Shop', folders: [FOLDER] })
    expect(projects.catalog.create).toHaveBeenCalledWith({ name: 'Shop', folders: [ABS] })
    await h[IPC.prjAddRepos]!({ projectId: PRJ, folders: [FOLDER] })
    expect(projects.catalog.addRepos).toHaveBeenCalledWith(PRJ, [ABS])
  })

  it('refuse typed paths and unknown refs', async () => {
    const { h, projects } = setup()
    await expect(h[IPC.prjCreate]!({ name: 'x', folders: [ABS] })).rejects.toThrow(
      'invalid request',
    )
    await expect(h[IPC.prjCreate]!({ name: 'x', folders: ['ctx_bbbbbbbbbbbb'] })).rejects.toThrow(
      'invalid context',
    )
    expect(projects.catalog.create).not.toHaveBeenCalled()
  })

  it('validate every payload', async () => {
    const { h } = setup()
    await expect(h[IPC.prjDashboard]!({ projectId: 'nope' })).rejects.toThrow('invalid request')
    await expect(
      h[IPC.prjMemoryReview]!({ memoryId: 'mem_abcdefghij', action: 'zap' }),
    ).rejects.toThrow('invalid request')
    await expect(h[IPC.prjSearch]!({ query: '' })).rejects.toThrow('invalid request')
  })

  it('route the read and write channels to the core services', async () => {
    const { h, projects } = setup()
    await h[IPC.prjList]!()
    await h[IPC.prjOverview]!()
    await h[IPC.prjDashboard]!({ projectId: PRJ })
    await h[IPC.prjAssign]!({ sessionId: 'ses_abcdefghij', projectId: null })
    await h[IPC.prjMemoryReview]!({ memoryId: 'mem_abcdefghij', action: 'approve' })
    await h[IPC.prjSearch]!({ query: 'auth' })
    await h[IPC.prjMessages]!({ sessionId: 'ses_abcdefghij' })
    expect(projects.workspace.dashboard).toHaveBeenCalledWith(PRJ)
    expect(projects.assignment.assign).toHaveBeenCalledWith('ses_abcdefghij', null)
    expect(projects.memory.review).toHaveBeenCalledWith('mem_abcdefghij', 'approve')
    expect(projects.sessions.messages).toHaveBeenCalledWith({
      sessionId: 'ses_abcdefghij',
      limit: 50,
    })
  })

  it('map core errors to safe messages', () => {
    expect(safeError(new ForbiddenError()).message).toBe('forbidden')
    expect(safeError(new NotFoundError('/secret/path')).message).toBe('not found')
    expect(safeError(new ValidationError('bad /Users/me/code/x here')).message).toBe(
      'bad [path] here',
    )
    const boom = safeError(new Error('ENOENT /Users/me/.ssh/id_rsa'))
    expect(boom.message).toBe('request failed')
  })

  it('never leak a path or stack from a failing service', async () => {
    const { h, projects } = setup()
    projects.catalog.update.mockRejectedValueOnce(new Error('EACCES /Users/me/vault/key'))
    const err = await Promise.resolve(h[IPC.prjUpdate]!({ projectId: PRJ, name: 'n' })).catch(
      (e: Error) => e,
    )
    expect((err as Error).message).toBe('request failed')
  })

  it('launch handoff returns a StartResult', async () => {
    const { h, projects } = setup()
    expect(await h[IPC.prjHandoffLaunch]!({ handoffId: 'hof_abcdefghij' })).toEqual({
      ok: true,
      agentId: 'codex:1',
    })
    projects.handoffs.launch.mockRejectedValueOnce(
      Object.assign(new SessionStartError('limit'), { message: 'too many' }),
    )
    expect(await h[IPC.prjHandoffLaunch]!({ handoffId: 'hof_abcdefghij' })).toEqual({
      ok: false,
      code: 'limit',
      error: 'too many',
    })
    projects.handoffs.launch.mockRejectedValueOnce(new ForbiddenError())
    await expect(h[IPC.prjHandoffLaunch]!({ handoffId: 'hof_abcdefghij' })).rejects.toThrow(
      'forbidden',
    )
  })
})

describe('prj:* tasks, history import and resume', () => {
  it('tasks: list and create validate the payload and call TaskService', async () => {
    const { h, projects } = setup()
    await h[IPC.prjTasks]!(PRJ)
    expect(projects.tasks.list).toHaveBeenCalledWith(PRJ)
    await expect(h[IPC.prjTasks]!({ projectId: PRJ })).rejects.toThrow('invalid request')
    await h[IPC.prjTaskCreate]!({ projectId: PRJ, title: ' Ship it ', sessionId: SES })
    expect(projects.tasks.create).toHaveBeenCalledWith(PRJ, 'Ship it', { sessionId: SES })
    await h[IPC.prjTaskCreate]!({ projectId: PRJ, title: 'No session' })
    expect(projects.tasks.create).toHaveBeenLastCalledWith(PRJ, 'No session', {})
    for (const bad of [
      { projectId: PRJ, title: '   ' },
      { projectId: PRJ, title: 'x'.repeat(121) },
      {},
    ])
      await expect(h[IPC.prjTaskCreate]!(bad)).rejects.toThrow('invalid request')
  })

  it('tasks: update applies a state, confirm evidence, or both; needs one of them', async () => {
    const { h, projects } = setup()
    await h[IPC.prjTaskUpdate]!({ taskId: TASK, state: 'doing' })
    expect(projects.tasks.setState).toHaveBeenCalledWith(TASK, 'doing')
    expect(projects.tasks.addEvidence).not.toHaveBeenCalled()
    await h[IPC.prjTaskUpdate]!({ taskId: TASK, confirm: true })
    expect(projects.tasks.addEvidence).toHaveBeenCalledWith(TASK, { level: 'user-confirmed' })
    projects.tasks.setState.mockClear()
    await h[IPC.prjTaskUpdate]!({ taskId: TASK, state: 'done', confirm: true })
    expect(projects.tasks.setState).toHaveBeenCalledWith(TASK, 'done')
    for (const bad of [
      { taskId: TASK },
      { taskId: TASK, state: 'zap' },
      { taskId: TASK, confirm: false },
    ])
      await expect(h[IPC.prjTaskUpdate]!(bad)).rejects.toThrow('invalid request')
  })

  it('tasks: service errors are mapped to safe messages', async () => {
    const { h, projects } = setup()
    projects.tasks.setState.mockRejectedValueOnce(new ForbiddenError())
    await expect(h[IPC.prjTaskUpdate]!({ taskId: TASK, state: 'done' })).rejects.toThrow(
      'forbidden',
    )
  })

  it('history import: defaults the limit, validates it, returns the counts', async () => {
    const { h, projects } = setup()
    expect(await h[IPC.prjImportHistory]!({})).toEqual({ imported: 2, skipped: 1 })
    expect(projects.history.importHistory).toHaveBeenCalledWith({ limit: 200 })
    await h[IPC.prjImportHistory]!({ limit: 20 })
    expect(projects.history.importHistory).toHaveBeenLastCalledWith({ limit: 20 })
    await expect(h[IPC.prjImportHistory]!({ limit: 9999 })).rejects.toThrow('invalid request')
    projects.history.importHistory.mockRejectedValueOnce(new Error('EACCES /Users/me/.claude'))
    await expect(h[IPC.prjImportHistory]!({})).rejects.toThrow('request failed')
  })

  it('resume returns a StartResult and maps start errors like a handoff launch', async () => {
    const { h, projects } = setup()
    expect(await h[IPC.prjResume]!(SES)).toEqual({ ok: true, agentId: 'cc:resumed' })
    expect(projects.history.resume).toHaveBeenCalledWith(SES)
    projects.history.resume.mockRejectedValueOnce(
      Object.assign(new SessionStartError('folder'), { message: 'gone' }),
    )
    expect(await h[IPC.prjResume]!(SES)).toEqual({ ok: false, code: 'folder', error: 'gone' })
    projects.history.resume.mockRejectedValueOnce(new NotFoundError('session'))
    await expect(h[IPC.prjResume]!(SES)).rejects.toThrow('not found')
    await expect(h[IPC.prjResume]!('nope')).rejects.toThrow('invalid request')
    await expect(h[IPC.prjResume]!({ sessionId: SES })).rejects.toThrow('invalid request')
  })
})

describe('sess:start with projects', () => {
  const text = 'go'

  it('resolves a repo to its directory in main and passes the project', async () => {
    const { h, sessions } = setup()
    expect(await h[IPC.sessStart]!({ repo: REPO, projectId: PRJ, text })).toEqual({
      ok: true,
      agentId: 'cc:s1',
    })
    expect(sessions.start).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: ABS, projectId: PRJ, name: 'shop-api' }),
    )
  })

  it('needs a project for a repo, and a known repo', async () => {
    const { h, sessions } = setup()
    expect(await h[IPC.sessStart]!({ repo: REPO, text })).toMatchObject({
      ok: false,
      error: 'choose a project',
    })
    expect(await h[IPC.sessStart]!({ repo: 'rp_zzzzzzzzzz', projectId: PRJ, text })).toMatchObject({
      ok: false,
      code: 'folder',
    })
    expect(sessions.start).not.toHaveBeenCalled()
  })

  it('starts through startWithContext when memories are kept', async () => {
    const { h, projects, sessions } = setup()
    const mem = 'mem_abcdefghij'
    expect(
      await h[IPC.sessStart]!({ folder: FOLDER, projectId: PRJ, context_memories: [mem], text }),
    ).toEqual({ ok: true, agentId: 'cc:ctx' })
    expect(projects.handoffs.startWithContext).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: ABS, projectId: PRJ }),
      [mem],
    )
    expect(sessions.start).not.toHaveBeenCalled()
  })

  it('keeps the plain folder path working', async () => {
    const { h, sessions } = setup()
    await h[IPC.sessStart]!({ folder: FOLDER, text })
    expect(sessions.start.mock.calls[0]![0] as object).not.toHaveProperty('projectId')
  })
})

describe('createProjectPushBridge', () => {
  it('coalesces snapshots within the window and keeps events', () => {
    const sched = new ManualScheduler()
    const sent: ProjectMessage[] = []
    let emit!: (m: ProjectMessage) => void
    const stop = createProjectPushBridge(
      { watch: (fn) => ((emit = fn), () => {}) },
      (_c, m) => sent.push(m),
      sched,
    )
    emit({ type: 'vault', status: 'encrypted' })
    emit({ type: 'vault', status: 'memory-only' })
    emit({ type: 'retrieval', projectId: PRJ, agentId: 'a', memoryIds: ['m1'] })
    emit({ type: 'retrieval', projectId: PRJ, agentId: 'a', memoryIds: ['m2'] })
    expect(sent).toHaveLength(0)
    sched.fireTimers()
    expect(sent.map((m) => m.type)).toEqual(['vault', 'retrieval', 'retrieval'])
    expect(sent[0]).toEqual({ type: 'vault', status: 'memory-only' })
    stop()
  })
})
