import type { Note, Notifier } from '@agent-office/core'
import { Notification } from 'electron'

/** Notifier port → native notifications. Clicking one focuses that agent's chat. */
export class ElectronNotifier implements Notifier {
  constructor(private onClick: (agentId: string) => void) {}

  notify(note: Note): void {
    if (!Notification.isSupported()) return
    const n = new Notification({ title: note.title, body: note.body })
    n.on('click', () => this.onClick(note.agentId))
    n.show()
  }
}
