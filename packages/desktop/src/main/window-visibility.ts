// Reports the main window hidden/minimized or shown/restored to the renderer (power saver: pause
// rendering while hidden). Page visibility isn't reliable on every platform, so main says it too.
import { IPC } from '@agent-office/shared'

type VisibilityEvent = 'hide' | 'minimize' | 'show' | 'restore'

/** The slice of BrowserWindow this needs. */
export interface VisibilityEmitter {
  on(event: VisibilityEvent, fn: () => void): unknown
  removeListener(event: VisibilityEvent, fn: () => void): unknown
}

/** Returns an unbind function. */
export function bindWindowVisibility(
  win: VisibilityEmitter,
  send: (channel: string, visible: boolean) => void,
): () => void {
  const hidden = () => send(IPC.appVisibility, false)
  const visible = () => send(IPC.appVisibility, true)
  const handlers: [VisibilityEvent, () => void][] = [
    ['hide', hidden],
    ['minimize', hidden],
    ['show', visible],
    ['restore', visible],
  ]
  for (const [e, fn] of handlers) win.on(e, fn)
  return () => {
    for (const [e, fn] of handlers) win.removeListener(e, fn)
  }
}
