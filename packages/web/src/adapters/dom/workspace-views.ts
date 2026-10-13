// The workspace DOM adapters, built from the static shell in index.html, plus the global keys.
import type { WorkspaceViews } from '../../workspace-ports.ts'
import { DomContextInspector } from './context-inspector.ts'
import { DomDashboard } from './dashboard.ts'
import { DomHandoff } from './handoff.ts'
import { DomHarnessBuilder } from './harness-builder.ts'
import { DomMemoryBrowser } from './memory-browser.ts'
import { DomNewProject } from './new-project.ts'
import { DomOverview } from './overview.ts'
import { DomPalette, keyIntent } from './palette.ts'
import { DomSessionVault } from './session-vault.ts'
import { DomShell } from './shell.ts'

export function createWorkspaceViews(doc: Document = document): WorkspaceViews {
  return {
    shell: new DomShell(doc),
    overview: new DomOverview(doc),
    dashboard: new DomDashboard(doc),
    sessions: new DomSessionVault(doc),
    memory: new DomMemoryBrowser(doc),
    inspector: new DomContextInspector(doc),
    palette: new DomPalette(doc),
    newProject: new DomNewProject(doc),
    handoff: new DomHandoff(doc),
    harness: new DomHarnessBuilder(doc),
  }
}

export interface WorkspaceKeyTarget {
  togglePalette(): void
  /** Returns true when it closed something. */
  escape(): boolean
}

const OWN_DIALOGS = new Set(['palette', 'np-dialog', 'ho-dialog', 'harness', 'hb-confirm'])

/** Ctrl/Cmd+K → palette, Esc → controller.escape(). Returns a function that removes the listener. */
export function installWorkspaceKeys(doc: Document, ctl: WorkspaceKeyTarget): () => void {
  const onKey = (e: KeyboardEvent): void => {
    const foreign = [...doc.querySelectorAll('dialog[open]')].some((d) => !OWN_DIALOGS.has(d.id))
    const intent = keyIntent({
      key: e.key,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      isComposing: e.isComposing,
      foreignDialogOpen: foreign,
    })
    if (intent === 'toggle-palette') {
      e.preventDefault()
      ctl.togglePalette()
    } else if (intent === 'escape') {
      // preventDefault stops the dialog's native cancel so the controller stays the single owner.
      if (ctl.escape()) e.preventDefault()
    }
  }
  doc.addEventListener('keydown', onKey)
  return () => doc.removeEventListener('keydown', onKey)
}
