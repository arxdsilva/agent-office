import { SessionStartError } from '@agent-office/core'
import { ManualScheduler } from '@agent-office/core/testing'
import { DEFAULT_SETTINGS, IPC, type ProjectMessage } from '@agent-office/shared'
import { describe, expect, it, vi } from 'vitest'
import { createIpcHandlers, createProjectPushBridge, type IpcPorts } from './ipc-api.ts'

const PRJ = 'prj_abcdefghij'
const HRN = 'hrn_abcdefghij'
const SECRET = 'SECRET-xyz'

const draft = { name: 'Team rules', description: '', rules: [], gates: [] }

function setup(startImpl?: () => Promise<string>) {
  const harness = {
    list: vi.fn(() => [{ id: HRN }]),
    get: vi.fn((_id: string) => ({ id: HRN })),
    versions: vi.fn((_id: string) => [{ id: HRN }]),
    create: vi.fn(async (_d: unknown) => ({ id: HRN })),
    update: vi.fn(async (_id: string, _d: unknown) => ({ id: HRN })),
    publish: vi.fn(async (_id: string) => ({ id: HRN })),
    archive: vi.fn(async (_id: string) => ({ id: HRN })),
    attach: vi.fn(async (_p: string, _h: string) => []),
    detach: vi.fn(async (_p: string, _h: string) => []),
    attached: vi.fn(() => []),
    templates: vi.fn(() => []),
    createFromTemplate: vi.fn(async (_t: string) => ({ id: HRN })),
  }
  const harnessImport = {
    detect: vi.fn(async (_p: string) => []),
    preview: vi.fn(async (_o: unknown) => ({ previewId: 'prv_abcdefgh' })),
    commit: vi.fn(async (_o: unknown) => ({ id: HRN })),
  }
  const policy = {
    preview: vi.fn((_p: string, _prov: string) => ({ ok: true })),
    inspect: vi.fn((_a: string) => ({ events: [{ summary: 'ok' }] })),
    badges: vi.fn(() => []),
  }
  const validation = {
    run: vi.fn(async (_o: unknown) => []),
    cancel: vi.fn((_a: string) => {}),
    results: vi.fn(() => []),
  }
  const sessions = {
    start: vi.fn(
      startImpl ??
        (async () => {
          throw new SessionStartError('harness')
        }),
    ),
  }
  const context = {
    pick: vi.fn(),
    resolve: (ref: string) =>
      ref === 'ctx_aaaaaaaaaaaa'
        ? { path: '/tmp/x', kind: 'folder' as const, label: 'x', hint: '~' }
        : undefined,
    exists: () => true,
  }
  const ports = {
    query: {
      snapshot: () => ({ agents: [], messages: [] }),
      agents: () => [],
      watch: () => () => {},
    },
    chat: {},
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
    projects: { harness, harnessImport, policy, validation },
  } as unknown as IpcPorts
  return { h: createIpcHandlers(ports), harness, harnessImport, policy, validation }
}

describe('hrn:* handlers', () => {
  it('route each channel to its service with validated args', async () => {
    const { h, harness, harnessImport, policy, validation } = setup()
    expect(await h[IPC.hrnList]!()).toEqual([{ id: HRN }])
    await h[IPC.hrnGet]!({ harnessId: HRN })
    await h[IPC.hrnVersions]!({ harnessId: HRN })
    await h[IPC.hrnCreate]!(draft)
    await h[IPC.hrnUpdate]!({ harnessId: HRN, draft })
    await h[IPC.hrnPublish]!({ harnessId: HRN })
    await h[IPC.hrnArchive]!({ harnessId: HRN })
    await h[IPC.hrnAttach]!({ projectId: PRJ, harnessId: HRN })
    await h[IPC.hrnDetach]!({ projectId: PRJ, harnessId: HRN })
    await h[IPC.hrnTemplates]!()
    await h[IPC.hrnFromTemplate]!({ templateId: 'strict-ts' })
    expect(harness.get).toHaveBeenCalledWith(HRN)
    expect(harness.versions).toHaveBeenCalledWith(HRN)
    expect(harness.create).toHaveBeenCalledOnce()
    expect(harness.update.mock.calls[0]![0]).toBe(HRN)
    expect(harness.publish).toHaveBeenCalledWith(HRN)
    expect(harness.archive).toHaveBeenCalledWith(HRN)
    expect(harness.attach).toHaveBeenCalledWith(PRJ, HRN)
    expect(harness.detach).toHaveBeenCalledWith(PRJ, HRN)
    expect(harness.createFromTemplate).toHaveBeenCalledWith('strict-ts')

    await h[IPC.hrnImportDetect]!({ projectId: PRJ })
    await h[IPC.hrnImportPreview]!({ projectId: PRJ, paths: ['CLAUDE.md'] })
    await h[IPC.hrnImportPreview]!({ projectId: PRJ })
    await h[IPC.hrnImportCommit]!({
      previewId: 'prv_abcdefgh',
      name: 'Imported',
      selected: ['cand_1'],
    })
    expect(harnessImport.detect).toHaveBeenCalledWith(PRJ)
    expect(harnessImport.preview).toHaveBeenNthCalledWith(1, {
      projectId: PRJ,
      paths: ['CLAUDE.md'],
    })
    expect(harnessImport.preview).toHaveBeenNthCalledWith(2, { projectId: PRJ })
    expect(harnessImport.commit).toHaveBeenCalledOnce()

    await h[IPC.hrnCoverage]!({ projectId: PRJ, provider: 'claude-code' })
    await h[IPC.hrnInspect]!({ agentId: 'cc:1' })
    await h[IPC.hrnBadges]!()
    expect(policy.preview).toHaveBeenCalledWith(PRJ, 'claude-code')
    expect(policy.inspect).toHaveBeenCalledWith('cc:1')

    await h[IPC.hrnRunGates]!({ agentId: 'cc:1', gateIds: ['gat_abcdef'] })
    await h[IPC.hrnRunGates]!({ agentId: 'cc:1' })
    await h[IPC.hrnCancelGates]!({ agentId: 'cc:1' })
    expect(validation.run).toHaveBeenNthCalledWith(1, { agentId: 'cc:1', gateIds: ['gat_abcdef'] })
    expect(validation.run).toHaveBeenNthCalledWith(2, { agentId: 'cc:1' })
    expect(validation.cancel).toHaveBeenCalledWith('cc:1')
  })

  it('reject bad args before reaching any service', async () => {
    const { h, harness, harnessImport, policy, validation } = setup()
    const bad: [string, unknown][] = [
      [IPC.hrnGet, { harnessId: 'nope' }],
      [IPC.hrnVersions, {}],
      [IPC.hrnCreate, { name: '' }],
      [IPC.hrnUpdate, { harnessId: HRN }],
      [IPC.hrnPublish, { harnessId: 1 }],
      [IPC.hrnArchive, null],
      [IPC.hrnAttach, { projectId: 'x', harnessId: HRN }],
      [IPC.hrnDetach, { projectId: PRJ }],
      [IPC.hrnFromTemplate, { templateId: '../etc' }],
      [IPC.hrnImportDetect, { projectId: '/abs/path' }],
      [IPC.hrnImportPreview, { projectId: PRJ, paths: [''] }],
      [IPC.hrnImportCommit, { previewId: 'x', name: 'n', selected: [] }],
      [IPC.hrnCoverage, { projectId: PRJ, provider: 'nope' }],
      [IPC.hrnInspect, { agentId: '' }],
      [IPC.hrnRunGates, { agentId: 'cc:1', gateIds: ['bad'] }],
      [IPC.hrnCancelGates, {}],
    ]
    for (const [channel, args] of bad)
      await expect(h[channel]!(args), channel).rejects.toThrow('invalid request')
    for (const svc of [harness, harnessImport, policy, validation])
      for (const fn of Object.values(svc)) expect(fn).not.toHaveBeenCalled()
  })

  it('maps service errors to safe messages', async () => {
    const { h, harness } = setup()
    harness.get.mockImplementation(() => {
      throw new Error(`boom ${SECRET} /Users/me/x`)
    })
    await expect(h[IPC.hrnGet]!({ harnessId: HRN })).rejects.toThrow('request failed')
  })

  it('returns only what the port returns (no raw input leaks)', async () => {
    const { h, harness } = setup()
    // The raw tool input lives elsewhere in the service; the port exposes only the summary.
    harness.get.mockImplementation(() => ({ id: HRN, rawInput: undefined }))
    const out = await h[IPC.hrnInspect]!({ agentId: 'cc:1' })
    expect(JSON.stringify(out)).toContain('"summary":"ok"')
    expect(JSON.stringify(out)).not.toContain(SECRET)
  })
})

describe('sess:start with a harness refusal', () => {
  it("maps SessionStartError 'harness' to StartResult code harness", async () => {
    const { h } = setup()
    expect(await h[IPC.sessStart]!({ folder: 'ctx_aaaaaaaaaaaa', text: 'hi' })).toMatchObject({
      ok: false,
      code: 'harness',
    })
  })
})

describe('project push bridge and harness messages', () => {
  it('passes harness messages through unchanged', () => {
    const scheduler = new ManualScheduler()
    let emit: (m: ProjectMessage) => void = () => {}
    const sent: unknown[] = []
    createProjectPushBridge(
      { watch: (fn: (m: ProjectMessage) => void) => ((emit = fn), () => {}) },
      (_c, m) => sent.push(m),
      scheduler,
    )
    const m: ProjectMessage = { type: 'harness', harnessId: HRN, projectId: PRJ }
    emit(m)
    scheduler.fireTimers()
    expect(sent).toEqual([m])
  })
})
