import { EventEmitter } from 'node:events'
import { IPC } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { bindWindowVisibility } from './window-visibility.ts'

// The renderer pauses while the window is hidden or minimized (power saver). Page visibility isn't
// reliable everywhere, so main reports it from the BrowserWindow's own events.
describe('bindWindowVisibility', () => {
  it('reports hide/minimize as hidden and show/restore as visible', () => {
    const win = new EventEmitter()
    const sent: [string, unknown][] = []
    bindWindowVisibility(win, (c, v) => sent.push([c, v]))
    win.emit('hide')
    win.emit('show')
    win.emit('minimize')
    win.emit('restore')
    expect(sent).toEqual([
      [IPC.appVisibility, false],
      [IPC.appVisibility, true],
      [IPC.appVisibility, false],
      [IPC.appVisibility, true],
    ])
  })

  it('stops reporting after unbinding', () => {
    const win = new EventEmitter()
    const sent: unknown[] = []
    const stop = bindWindowVisibility(win, (_c, v) => sent.push(v))
    stop()
    win.emit('hide')
    expect(sent).toEqual([])
  })
})
