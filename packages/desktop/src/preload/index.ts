// Sandboxed preload: exposes exactly the typed AgentOfficeApi; ipcRenderer itself never reaches the page.
import type { AgentOfficeApi, ConnectionInfo, ServerMessage } from '@agent-office/shared'
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
    answer: (agentId, requestId, decision) =>
      ipcRenderer.invoke(IPC.sessAnswer, { agentId, requestId, decision }),
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
