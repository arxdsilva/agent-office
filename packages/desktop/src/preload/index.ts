// Sandboxed preload: exposes exactly the typed AgentOfficeApi; ipcRenderer itself never reaches the page.
import type {
  AgentOfficeApi,
  ConnectionInfo,
  PowerState,
  ServerMessage,
} from '@agent-office/shared'
import { IPC } from '@agent-office/shared/ipc'
import { contextBridge, ipcRenderer } from 'electron'

function listen<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: AgentOfficeApi = {
  ready: () => ipcRenderer.invoke(IPC.ready),
  onMessage: (cb) => listen<ServerMessage[]>(IPC.push, (batch) => batch.forEach(cb)),
  onSelect: (cb) => listen(IPC.select, cb),
  sendMessage: (agentId, text, opts) =>
    ipcRenderer.invoke(IPC.send, {
      agentId,
      text,
      ...(opts?.context?.length ? { context: opts.context } : {}),
      ...(opts?.use?.length ? { use: opts.use } : {}),
    }),
  context: {
    pick: (kind) => ipcRenderer.invoke(IPC.ctxPick, kind),
  },
  sessions: {
    start: (args) => ipcRenderer.invoke(IPC.sessStart, args),
    setMode: (agentId, mode) => ipcRenderer.invoke(IPC.sessMode, { agentId, mode }),
    setModel: (agentId, model) => ipcRenderer.invoke(IPC.sessModel, { agentId, model }),
    models: (agentId) => ipcRenderer.invoke(IPC.sessModels, agentId),
    interrupt: (agentId) => ipcRenderer.invoke(IPC.sessInterrupt, { agentId }),
    stop: (agentId) => ipcRenderer.invoke(IPC.sessStop, { agentId }),
    answer: (agentId, requestId, decision, answers) =>
      ipcRenderer.invoke(IPC.sessAnswer, {
        agentId,
        requestId,
        decision,
        ...(answers ? { answers } : {}),
      }),
    setModeId: (agentId, modeId) => ipcRenderer.invoke(IPC.sessModeId, { agentId, modeId }),
  },
  projects: {
    overview: () => ipcRenderer.invoke(IPC.prjOverview),
    list: () => ipcRenderer.invoke(IPC.prjList),
    dashboard: (projectId) => ipcRenderer.invoke(IPC.prjDashboard, { projectId }),
    create: (args) => ipcRenderer.invoke(IPC.prjCreate, args),
    update: (args) => ipcRenderer.invoke(IPC.prjUpdate, args),
    addRepos: (projectId, folders) => ipcRenderer.invoke(IPC.prjAddRepos, { projectId, folders }),
    removeRepo: (projectId, repo) => ipcRenderer.invoke(IPC.prjRemoveRepo, { projectId, repo }),
    sessions: (args) => ipcRenderer.invoke(IPC.prjSessions, args),
    messages: (args) => ipcRenderer.invoke(IPC.prjMessages, args),
    assign: (sessionId, projectId) => ipcRenderer.invoke(IPC.prjAssign, { sessionId, projectId }),
    memories: (args) => ipcRenderer.invoke(IPC.prjMemories, args),
    createMemory: (draft) => ipcRenderer.invoke(IPC.prjMemoryCreate, draft),
    reviewMemory: (memoryId, action) =>
      ipcRenderer.invoke(IPC.prjMemoryReview, { memoryId, action }),
    editMemory: (args) => ipcRenderer.invoke(IPC.prjMemoryEdit, args),
    supersedeMemory: (memoryId, replacement) =>
      ipcRenderer.invoke(IPC.prjMemorySupersede, { memoryId, replacement }),
    mergeMemories: (memoryIds, into) => ipcRenderer.invoke(IPC.prjMemoryMerge, { memoryIds, into }),
    contextPreview: (args) => ipcRenderer.invoke(IPC.prjContextPreview, args),
    inspect: (agentId) => ipcRenderer.invoke(IPC.prjInspect, { agentId }),
    prepareHandoff: (args) => ipcRenderer.invoke(IPC.prjHandoffPrepare, args),
    updateHandoff: (args) => ipcRenderer.invoke(IPC.prjHandoffUpdate, args),
    launchHandoff: (handoffId) => ipcRenderer.invoke(IPC.prjHandoffLaunch, { handoffId }),
    search: (args) => ipcRenderer.invoke(IPC.prjSearch, args),
    tasks: (projectId) => ipcRenderer.invoke(IPC.prjTasks, projectId),
    createTask: (args) => ipcRenderer.invoke(IPC.prjTaskCreate, args),
    updateTask: (args) => ipcRenderer.invoke(IPC.prjTaskUpdate, args),
    importHistory: (args) => ipcRenderer.invoke(IPC.prjImportHistory, args ?? {}),
    resumeSession: (sessionId) => ipcRenderer.invoke(IPC.prjResume, sessionId),
    removeImported: (projectId) => ipcRenderer.invoke(IPC.prjRemoveImported, projectId),
    importStatus: () => ipcRenderer.invoke(IPC.prjImportStatus),
    onPush: (cb) => listen(IPC.prjPush, cb),
    harness: {
      list: () => ipcRenderer.invoke(IPC.hrnList),
      get: (harnessId) => ipcRenderer.invoke(IPC.hrnGet, { harnessId }),
      versions: (harnessId) => ipcRenderer.invoke(IPC.hrnVersions, { harnessId }),
      create: (draft) => ipcRenderer.invoke(IPC.hrnCreate, draft),
      update: (args) => ipcRenderer.invoke(IPC.hrnUpdate, args),
      publish: (harnessId) => ipcRenderer.invoke(IPC.hrnPublish, { harnessId }),
      archive: (harnessId) => ipcRenderer.invoke(IPC.hrnArchive, { harnessId }),
      attach: (projectId, harnessId) => ipcRenderer.invoke(IPC.hrnAttach, { projectId, harnessId }),
      detach: (projectId, harnessId) => ipcRenderer.invoke(IPC.hrnDetach, { projectId, harnessId }),
      templates: () => ipcRenderer.invoke(IPC.hrnTemplates),
      createFromTemplate: (templateId) => ipcRenderer.invoke(IPC.hrnFromTemplate, { templateId }),
      importDetect: (projectId) => ipcRenderer.invoke(IPC.hrnImportDetect, { projectId }),
      importPreview: (args) => ipcRenderer.invoke(IPC.hrnImportPreview, args),
      importCommit: (args) => ipcRenderer.invoke(IPC.hrnImportCommit, args),
      coverage: (projectId, provider) =>
        ipcRenderer.invoke(IPC.hrnCoverage, { projectId, provider }),
      inspect: (agentId) => ipcRenderer.invoke(IPC.hrnInspect, { agentId }),
      runGates: (args) => ipcRenderer.invoke(IPC.hrnRunGates, args),
      cancelGates: (agentId) => ipcRenderer.invoke(IPC.hrnCancelGates, { agentId }),
      badges: () => ipcRenderer.invoke(IPC.hrnBadges),
      reorder: (projectId, harnessIds) =>
        ipcRenderer.invoke(IPC.hrnReorder, { projectId, harnessIds }),
      flow: (agentId) => ipcRenderer.invoke(IPC.hrnFlow, { agentId }),
      flowApprove: (args) => ipcRenderer.invoke(IPC.hrnFlowApprove, args),
      flowMarkDone: (args) => ipcRenderer.invoke(IPC.hrnFlowMarkDone, args),
      flowSkip: (args) => ipcRenderer.invoke(IPC.hrnFlowSkip, args),
      flowReopen: (args) => ipcRenderer.invoke(IPC.hrnFlowReopen, args),
    },
  },
  providers: {
    list: () => ipcRenderer.invoke(IPC.provList),
    refresh: (provider) => ipcRenderer.invoke(IPC.provRefresh, provider ? { provider } : {}),
    setEnabled: (provider, enabled) => ipcRenderer.invoke(IPC.provEnable, { provider, enabled }),
    models: (provider) => ipcRenderer.invoke(IPC.provModels, { provider }),
    installHooks: (provider) => ipcRenderer.invoke(IPC.provHooksInstall, { provider }),
    removeHooks: (provider) => ipcRenderer.invoke(IPC.provHooksRemove, { provider }),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
  },
  hook: {
    status: () => ipcRenderer.invoke(IPC.hookStatus),
    install: () => ipcRenderer.invoke(IPC.hookInstall),
    uninstall: () => ipcRenderer.invoke(IPC.hookUninstall),
  },
  app: {
    version: () => ipcRenderer.invoke(IPC.version),
    onBanner: (cb) => listen(IPC.banner, cb),
    onOpenSettings: (cb) => listen(IPC.openSettings, () => cb()),
    copyText: (text) => ipcRenderer.invoke(IPC.copyText, text),
    onOpenConnect: (cb) => listen(IPC.openConnect, () => cb()),
    onPower: (cb) => listen<PowerState>(IPC.appPower, cb),
    onWindowVisibility: (cb) => listen<boolean>(IPC.appVisibility, cb),
    power: () => ipcRenderer.invoke(IPC.appPowerGet),
  },
  connections: {
    info: () => ipcRenderer.invoke(IPC.connInfo),
    onChange: (cb) => listen<ConnectionInfo>(IPC.connChanged, cb),
    test: () => ipcRenderer.invoke(IPC.connTest),
  },
  updates: {
    check: () => ipcRenderer.invoke(IPC.updateCheck),
    install: () => ipcRenderer.invoke(IPC.updateInstall),
    onState: (cb) => listen(IPC.updateState, cb),
  },
}

contextBridge.exposeInMainWorld('agentOffice', api)
