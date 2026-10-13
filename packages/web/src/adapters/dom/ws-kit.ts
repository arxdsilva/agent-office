// Tiny helpers shared by the workspace DOM adapters. Text goes through textContent only.
import type { ButtonVM, Tone, WorkspaceAction } from '../../app/workspace/types.ts'
import { el } from './el.ts'

/** A set of listeners; the ports register callbacks with `on` and the view fires them with `emit`. */
export class Signal<A extends unknown[] = []> {
  private fns: ((...a: A) => void)[] = []
  on(fn: (...a: A) => void): void {
    this.fns.push(fn)
  }
  emit(...a: A): void {
    for (const f of this.fns) f(...a)
  }
}

export function need<T extends HTMLElement>(doc: Document, id: string): T {
  const e = doc.getElementById(id)
  if (!e) throw new Error(`workspace: #${id} is missing from index.html`)
  return e as T
}

export const setText = (e: Element, text: string): void => {
  if (e.textContent !== text) e.textContent = text
}

/** Updates an input without fighting the user: skipped while it has focus and already differs. */
export function syncInput(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  if (input.value === value) return
  if (input.ownerDocument.activeElement === input) return
  input.value = value
}

export const toneClass = (t: Tone): string => `tone-${t}`

export function dot(tone: Tone, color?: string): HTMLSpanElement {
  const d = el('span', undefined, `dot-t ${toneClass(tone)}`)
  d.setAttribute('aria-hidden', 'true')
  if (color) d.style.background = color
  return d
}

export function chip(text: string, cls = ''): HTMLSpanElement {
  return el('span', text, `chip ${cls}`.trim())
}

export function badge(text: string, tone: Tone = 'neutral'): HTMLSpanElement {
  return el('span', text, `badge-t ${toneClass(tone)}`)
}

/** A button built from a ButtonVM: disabled state, hint as tooltip and a visible caveat. */
export function vmButton(
  vm: ButtonVM,
  cls: string,
  run: (a?: WorkspaceAction) => void,
  id?: string,
): HTMLButtonElement {
  const b = el('button', vm.label, `btn ${cls}`.trim())
  b.type = 'button'
  if (id) b.id = id
  b.dataset.action = vm.id
  b.disabled = !vm.enabled
  if (vm.hint) {
    b.title = vm.hint
    if (vm.enabled) b.setAttribute('aria-description', vm.hint)
  }
  // Buttons without an action (dialog buttons) still report the click to their owner.
  const a = vm.action
  b.addEventListener('click', () => run(a))
  return b
}

export function textButton(
  label: string,
  cls: string,
  onClick: () => void,
  id?: string,
): HTMLButtonElement {
  const b = el('button', label, `btn ${cls}`.trim())
  b.type = 'button'
  if (id) b.id = id
  b.addEventListener('click', onClick)
  return b
}

export function paneHeader(title: string, sub?: string): HTMLElement {
  const h = el('header', undefined, 'pane-head')
  h.append(el('h1', title, 'pane-title'))
  if (sub) h.append(el('p', sub, 'pane-sub muted'))
  return h
}

export function notice(text: string, kind: 'error' | 'info'): HTMLElement {
  const p = el('p', text, `notice ${kind}`)
  p.setAttribute('role', kind === 'error' ? 'alert' : 'status')
  return p
}

/** Makes a div/ li behave like a button for keyboard users. */
export function activatable(node: HTMLElement, run: () => void): void {
  node.tabIndex = 0
  node.setAttribute('role', 'button')
  node.addEventListener('click', run)
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      run()
    }
  })
}

export function openDialog(d: HTMLDialogElement, open: boolean): boolean {
  if (open && !d.open) {
    d.showModal()
    return true
  }
  if (!open && d.open) d.close()
  return false
}
