import type { WorkspaceState } from './state.ts'
import type { NewProjectVM } from './types.ts'
import { WS_COPY } from './workspace-copy.ts'

const N = WS_COPY.newProject

export function newProjectVM(s: WorkspaceState): NewProjectVM {
  const np = s.newProject
  const named = np.name.trim().length > 0
  return {
    open: np.open,
    heading: N.heading,
    name: np.name,
    namePlaceholder: N.namePlaceholder,
    folders: np.folders,
    addFolder: { id: 'add-folder', label: N.addFolder, enabled: np.folders.length < 8 },
    create: {
      id: 'create',
      label: N.create,
      enabled: named,
      hint: named ? undefined : N.needName,
    },
    error: s.error,
  }
}
