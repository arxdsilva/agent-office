// Settings → Projects: the pure flow of the "Import Claude sessions into memory automatically"
// checkbox (docs/projects.md §8b). Turning it on needs a confirm; turning it off asks whether to
// keep or remove what was imported. The DOM adapter only renders dialogs and applies the outcome.
// `autoImportApprovedAt` is main-only: the renderer's patch only ever carries the boolean.

export type AutoImportDialog = 'confirm-on' | 'confirm-off'
export type AutoImportChoice = 'on-ok' | 'on-cancel' | 'off-keep' | 'off-remove' | 'off-dismiss'

/** The checkbox changed: which dialog opens, and what the box shows until the user decides. */
export function autoImportToggled(checked: boolean): {
  dialog: AutoImportDialog
  checked: boolean
} {
  return checked
    ? { dialog: 'confirm-on', checked: false }
    : { dialog: 'confirm-off', checked: true }
}

export interface AutoImportOutcome {
  /** Saved through the normal settings patch; absent when nothing changes. */
  patch?: { autoImportHistory: boolean }
  /** Also call `projects.removeImported()` (after the patch, so no new items appear). */
  removeImported: boolean
  /** What the checkbox shows afterwards. */
  checked: boolean
}

export function autoImportOutcome(choice: AutoImportChoice): AutoImportOutcome {
  switch (choice) {
    case 'on-ok':
      return { patch: { autoImportHistory: true }, removeImported: false, checked: true }
    case 'on-cancel':
      return { removeImported: false, checked: false }
    case 'off-keep':
      return { patch: { autoImportHistory: false }, removeImported: false, checked: false }
    case 'off-remove':
      return { patch: { autoImportHistory: false }, removeImported: true, checked: false }
    case 'off-dismiss':
      return { removeImported: false, checked: true }
  }
}
