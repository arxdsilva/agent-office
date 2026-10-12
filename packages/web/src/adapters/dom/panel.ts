import { MAX_MESSAGE_CHARS, type Agent, type ChatMessage } from '@agent-office/shared'
import type { SendResult } from './api.ts'
import type { OfficeState } from './socket.ts'

const STATE_ICON: Record<ChatMessage['state'], string> = {
  queued: '⏳ queued',
  delivered: '✓ delivered',
  replied: '✓✓ replied',
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

/** DOM text only via textContent / createElement (PRIVACY_SECURITY rule). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const e = document.createElement(tag)
  if (text !== undefined) e.textContent = text
  if (className) e.className = className
  return e
}

function hintFor(a: Agent): (string | HTMLElement)[] | null {
  if (a.provider === 'claude-code') {
    if (!a.interactive) {
      return [
        'Not connected. Run ',
        el('code', 'make install-hook'),
        ' so this session can read messages.',
      ]
    }
    if (a.status === 'waiting' || a.status === 'idle') {
      return [
        'This session is idle: messages are delivered when you next prompt it in Claude Code.',
      ]
    }
    return ['Messages are delivered when the current turn ends.']
  }
  if (!a.interactive) return ["This agent isn't reading its inbox. See README → Inbox API."]
  return null
}

/** Side panel: agent details and the chat thread. */
export class Panel {
  agentId: string | null = null
  onClose: () => void = () => {}
  onSelectParent: (id: string) => void = () => {}
  private root = $<HTMLElement>('panel')
  private input = $<HTMLTextAreaElement>('p-input')
  private error = $<HTMLElement>('p-error')
  private counter = $<HTMLElement>('p-counter')
  private renderedThread = ''

  constructor(private send: (agentId: string, text: string) => Promise<SendResult>) {
    $('p-close').addEventListener('click', () => this.close())
    $('p-form').addEventListener('submit', (e) => {
      e.preventDefault()
      void this.submit()
    })
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation() // typing must not trigger scene shortcuts
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void this.submit()
      }
      if (e.key === 'Escape') this.close()
    })
    this.input.addEventListener('input', () => {
      this.counter.textContent = `${this.input.value.length}/${MAX_MESSAGE_CHARS}`
    })
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }

  open(agentId: string, state: OfficeState): void {
    this.agentId = agentId
    this.root.hidden = false
    this.renderedThread = ''
    this.error.textContent = ''
    this.render(state)
    this.input.focus()
  }

  close(): void {
    if (!this.agentId) return
    this.agentId = null
    this.root.hidden = true
    this.onClose()
  }

  render(state: OfficeState, now = Date.now()): void {
    if (!this.agentId) return
    const a = state.agents.get(this.agentId)
    if (!a) {
      $('p-sub').textContent = 'This agent has left the office.'
      return
    }
    $('p-name').textContent = a.name
    $('p-sub').textContent = [a.kind, a.provider, a.model].filter(Boolean).join(' · ')

    const meta = $('p-meta')
    const rows: [string, string | HTMLElement][] = [
      ['Topic', a.topic],
      ['Status', a.status + (a.tool ? ` (${a.tool})` : '')],
      ['Activity', a.text || '—'],
      ['Active', `for ${ago(a.since, now).replace(' ago', '')}`],
      ['Last seen', ago(a.lastSeen, now)],
    ]
    if (a.parentId) {
      const parent = state.agents.get(a.parentId)
      const btn = el('button', parent?.name ?? a.parentId)
      btn.type = 'button'
      btn.addEventListener('click', () => this.onSelectParent(a.parentId!))
      rows.push(['Parent', btn])
    }
    meta.replaceChildren(
      ...rows.flatMap(([k, v]) => [el('dt', k), typeof v === 'string' ? el('dd', v) : wrap(v)]),
    )

    const hint = $('p-hint')
    const parts = hintFor(a)
    hint.hidden = !parts
    hint.replaceChildren(...(parts ?? []))

    const thread = state.messages.get(a.id) ?? []
    const key = JSON.stringify(thread.map((m) => [m.id, m.state]))
    if (key === this.renderedThread) return
    this.renderedThread = key
    const list = $('p-thread')
    if (thread.length === 0) {
      list.replaceChildren(el('li', 'No messages yet. Say hi 👋', 'empty'))
      return
    }
    list.replaceChildren(
      ...thread.map((m) => {
        const li = el('li', m.text, m.from)
        if (m.from === 'user') li.append(el('span', STATE_ICON[m.state], 'state'))
        return li
      }),
    )
    list.scrollTop = list.scrollHeight
  }

  private async submit(): Promise<void> {
    const text = this.input.value.trim()
    if (!text || !this.agentId) return
    this.error.textContent = ''
    const res = await this.send(this.agentId, text)
    if (res.ok) {
      this.input.value = ''
      this.counter.textContent = `0/${MAX_MESSAGE_CHARS}`
    } else {
      this.error.textContent = res.error
    }
  }
}

function wrap(child: HTMLElement): HTMLElement {
  const dd = el('dd')
  dd.append(child)
  return dd
}
