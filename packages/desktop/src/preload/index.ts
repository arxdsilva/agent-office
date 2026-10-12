// Sandboxed preload: exposes exactly the typed AgentOfficeApi; ipcRenderer itself never reaches the page.
import { IPC, type AgentOfficeApi, type ServerMessage } from '@agent-office/shared'
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
  sendMessage: (agentId, text) => ipcRenderer.invoke(IPC.send, { agentId, text }),
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
  },
  updates: {
    check: () => ipcRenderer.invoke(IPC.updateCheck),
    install: () => ipcRenderer.invoke(IPC.updateInstall),
    onState: (cb) => listen(IPC.updateState, cb),
  },
}

contextBridge.exposeInMainWorld('agentOffice', api)
