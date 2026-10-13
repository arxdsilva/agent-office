import {
  MAX_MESSAGE_CHARS,
  type ContextChip,
  type PermissionDecision,
  type PermissionMode,
} from '@agent-office/shared'
import { COPY } from '../../app/connect-copy.ts'
import { SESSION_COPY } from '../../app/session-copy.ts'
import {
  CHROME_ID,
  type ComposerChipVM,
  type ComposerVM,
  type PermissionCardVM,
  type SessionHeaderVM,
  type UseMenuVM,
} from '../../app/session-types.ts'
import { HARNESS_COPY } from '../../app/workspace/harness-copy.ts'
import type { HarnessTabVM } from '../../app/harness-inspector-vm.ts'
import type { PanelVM } from '../../app/view-models.ts'
import type { CapabilityRef, PanelView } from '../../ports.ts'
import { byId, el } from './el.ts'
import { openMenu, type MenuGroup } from './menu.ts'

const LOADING_MODELS = SESSION_COPY.loadingModels

const chipIcon = (kind: ContextChip['kind'], key?: string) =>
  kind === 'folder' ? '📁' : kind === 'file' ? '📄' : key === CHROME_ID ? '🌐' : '🔌'

/** Composer chips with a ✕ each; a warn chip follows the chip it belongs to. */
export function renderComposerChips(
  root: HTMLElement,
  chips: ComposerChipVM[],
  onRemove: (key: string) => void,
  disabled = false,
): void {
  root.hidden = chips.length === 0
  root.replaceChildren(
    ...chips.flatMap((c) => {
      const li = el('li', `${chipIcon(c.kind, c.key)} ${c.label}`, 'chip composer-chip')
      if (c.hint) li.title = c.hint
      li.dataset.key = c.key
      const x = el('button', '✕', 'chip-x')
      x.type = 'button'
      x.disabled = disabled
      x.setAttribute('aria-label', `✕ ${c.label}`)
      x.addEventListener('click', () => onRemove(c.key))
      li.append(x)
      if (!c.warn) return [li]
      return [li, el('li', `⚠ ${c.warn}`, 'chip composer-chip warn')]
    }),
  )
}

/** The + Context menu. */
export function contextMenuGroups(): MenuGroup[] {
  const c = SESSION_COPY.composer
  return [
    {
      items: [
        { id: 'files', label: c.addFiles },
        { id: 'folder', label: c.addFolder },
      ],
    },
  ]
}

/** The Use… menu groups, with seen/not-seen dots. */
export function useMenuGroups(vm: UseMenuVM): MenuGroup[] {
  const c = SESSION_COPY.composer
  return vm.groups.map((g) => ({
    label: g.label,
    items: g.entries.map((e) => ({
      id: e.id,
      label: e.label,
      checked: e.selected,
      dot: { on: e.seen, title: e.seen ? c.useSeen : c.useUnseen },
    })),
  }))
}

export const useMenuSearchable = (vm: UseMenuVM) =>
  vm.groups.reduce((n, g) => n + g.entries.length, 0) > 8

/** PanelView port → the chat side panel. */
export class DomPanel implements PanelView {
  private root = byId<HTMLElement>('panel')
  private input = byId<HTMLTextAreaElement>('p-input')
  private error = byId<HTMLElement>('p-error')
  private counter = byId<HTMLElement>('p-counter')
  private sendBtn = byId<HTMLButtonElement>('p-send')
  private ctxBtn = byId<HTMLButtonElement>('p-add-context')
  private useBtn = byId<HTMLButtonElement>('p-use')
  private stopDialog = byId<HTMLDialogElement>('p-stop-confirm')
  private renderedThread = ''
  private renderedSession = ''
  private renderedPerm = ''
  private renderedChips = ''
  private session: SessionHeaderVM | null = null
  private sendFn: (text: string) => void | Promise<void> = () => {}
  private closeFn: () => void = () => {}
  private parentFn: (id: string) => void = () => {}
  private installFn: () => void | Promise<void> = () => {}
  private connectFn: () => void = () => {}
  private modeFn: (mode: PermissionMode) => void | Promise<void> = () => {}
  private modelFn: (model: string) => void | Promise<void> = () => {}
  private interruptFn: () => void | Promise<void> = () => {}
  private stopFn: () => void | Promise<void> = () => {}
  private answerFn: (id: string, d: PermissionDecision) => void | Promise<void> = () => {}
  private pickFn: (kind: 'files' | 'folder') => void | Promise<void> = () => {}
  private removeFn: (key: string) => void = () => {}
  private openUseFn: () => UseMenuVM = () => ({ groups: [] })
  private toggleUseFn: (id: string) => void = () => {}
  private draftFn: (text: string) => void = () => {}
  private tabFn: (tab: 'details' | 'harness') => void = () => {}
  private harnessFn: (a: 'run-gates' | 'cancel-gates' | 'open-harnesses') => void = () => {}
  private renderedHarness = ''

  constructor() {
    byId('p-close').addEventListener('click', () => this.closeFn())
    byId('p-tab-details').textContent = HARNESS_COPY.tab.details
    byId('p-tab-harness').textContent = HARNESS_COPY.tab.harness
    byId('p-tab-details').addEventListener('click', () => this.tabFn('details'))
    byId('p-tab-harness').addEventListener('click', () => this.tabFn('harness'))
    byId('p-form').addEventListener('submit', (e) => {
      e.preventDefault()
      this.submit()
    })
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation() // typing must not trigger scene shortcuts
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        this.submit()
      }
      if (e.key === 'Escape') this.closeFn()
    })
    this.input.addEventListener('input', () => {
      this.updateCounter()
      this.draftFn(this.input.value)
    })
    const c = SESSION_COPY.composer
    this.ctxBtn.textContent = `${c.addContext} ▾`
    this.useBtn.textContent = `${c.use} ▾`
    this.ctxBtn.addEventListener('click', () =>
      openMenu(this.ctxBtn, contextMenuGroups(), (k) => void this.pickFn(k as 'files' | 'folder'), {
        label: c.addContext,
      }),
    )
    this.useBtn.addEventListener('click', () => {
      const vm = this.openUseFn()
      openMenu(this.useBtn, useMenuGroups(vm), (id) => this.toggleUseFn(id), {
        role: 'menuitemcheckbox',
        searchable: useMenuSearchable(vm),
        label: c.use,
      })
    })
    byId('p-stop-text').textContent = SESSION_COPY.stopConfirm
    byId('p-stop-ok').textContent = SESSION_COPY.stop
    byId('p-stop-cancel').textContent = SESSION_COPY.quit.cancel
    byId('p-stop-cancel').addEventListener('click', () => this.stopDialog.close())
    byId('p-stop-ok').addEventListener('click', () => {
      this.stopDialog.close()
      void this.stopFn()
    })
    this.stopDialog.addEventListener('keydown', (e) => e.stopPropagation())
  }

  onSend(fn: (text: string) => void | Promise<void>) {
    this.sendFn = fn
  }
  onClose(fn: () => void) {
    this.closeFn = fn
  }
  onSelectParent(fn: (id: string) => void) {
    this.parentFn = fn
  }
  onInstallHook(fn: () => void | Promise<void>) {
    this.installFn = fn
  }
  onOpenConnect(fn: () => void) {
    this.connectFn = fn
  }
  onSetMode(fn: (mode: PermissionMode) => void | Promise<void>) {
    this.modeFn = fn
  }
  onSetModel(fn: (model: string) => void | Promise<void>) {
    this.modelFn = fn
  }
  onInterrupt(fn: () => void | Promise<void>) {
    this.interruptFn = fn
  }
  onStop(fn: () => void | Promise<void>) {
    this.stopFn = fn
  }
  onAnswer(fn: (requestId: string, decision: PermissionDecision) => void | Promise<void>) {
    this.answerFn = fn
  }
  onPickContext(fn: (kind: 'files' | 'folder') => void | Promise<void>) {
    this.pickFn = fn
  }
  onRemoveChip(fn: (key: string) => void) {
    this.removeFn = fn
  }
  onOpenUse(fn: () => UseMenuVM) {
    this.openUseFn = fn
  }
  onToggleUse(fn: (id: string) => void) {
    this.toggleUseFn = fn
  }
  onDraft(fn: (text: string) => void) {
    this.draftFn = fn
  }
  onTab(fn: (tab: 'details' | 'harness') => void) {
    this.tabFn = fn
  }
  onHarnessAction(fn: (a: 'run-gates' | 'cancel-gates' | 'open-harnesses') => void) {
    this.harnessFn = fn
  }
  private pickCapFn: (ref: CapabilityRef) => void = () => {}
  onPickCapability(fn: (ref: CapabilityRef) => void) {
    this.pickCapFn = fn
  }

  open(vm: PanelVM): void {
    this.root.hidden = false
    this.renderedThread = ''
    this.renderedSession = ''
    this.renderedPerm = ''
    this.renderedChips = ''
    this.error.textContent = ''
    this.input.value = vm.draftText
    this.updateCounter()
    this.render(vm)
    if (!vm.composer.disabled) this.input.focus()
  }

  close(): void {
    this.root.hidden = true
    if (this.stopDialog.open) this.stopDialog.close()
  }

  showError(message: string): void {
    this.error.textContent = message
  }

  clearInput(): void {
    this.input.value = ''
    this.error.textContent = ''
    this.updateCounter()
  }

  render(vm: PanelVM): void {
    if (this.root.hidden) return
    byId('p-name').textContent = vm.name
    byId('p-sub').textContent = vm.subtitle
    const badge = byId('p-badge')
    badge.hidden = !vm.session?.managed
    badge.textContent = SESSION_COPY.managedBadge

    const rows: HTMLElement[] = vm.meta.flatMap(([k, v]) => [el('dt', k), el('dd', v)])
    if (vm.parent) {
      const btn = el('button', vm.parent.name)
      btn.type = 'button'
      const parentId = vm.parent.id
      btn.addEventListener('click', () => this.parentFn(parentId))
      const dd = el('dd')
      dd.append(btn)
      rows.push(el('dt', 'Parent'), dd)
    }
    if (vm.children?.length) {
      const dd = el('dd', undefined, 'p-children')
      for (const c of vm.children) {
        const btn = el('button', c.name)
        btn.type = 'button'
        btn.dataset.agentId = c.id
        btn.addEventListener('click', () => this.parentFn(c.id))
        dd.append(btn)
      }
      rows.push(el('dt', 'Subagents'), dd)
    }
    byId('p-meta').replaceChildren(...rows)
    renderChips(byId('p-used'), vm.used, panelProvider(vm), (ref) => this.pickCapFn(ref))
    this.renderTabs(vm)
    this.renderHint(vm)
    this.renderSession(vm.session)
    this.renderPermission(vm.permission)
    this.renderComposer(vm.composer)
    this.renderThread(vm)
  }

  /** Details | Harness: the strip, the active tab (CSS hides the details column) and the Inspector. */
  private renderTabs(vm: PanelVM): void {
    const t = vm.tabs
    byId('p-tabs').hidden = !t?.show
    const active = t?.show ? t.active : 'details'
    this.root.dataset.tab = active
    for (const id of ['details', 'harness'] as const) {
      const b = byId(`p-tab-${id}`)
      b.setAttribute('aria-selected', String(active === id))
      b.tabIndex = active === id ? 0 : -1
    }
    if (t?.badge) byId('p-tab-harness').dataset.badge = t.badge
    else delete byId('p-tab-harness').dataset.badge
    const sec = byId('p-harness')
    sec.hidden = active !== 'harness' || !vm.harness
    if (sec.hidden) return
    const key = JSON.stringify(vm.harness)
    if (key === this.renderedHarness) return
    this.renderedHarness = key
    sec.replaceChildren(...this.harnessBlocks(vm.harness!))
  }

  private harnessBlocks(h: HarnessTabVM): HTMLElement[] {
    const manage = el('button', h.labels.open, 'btn small')
    manage.type = 'button'
    manage.dataset.action = 'open-harnesses'
    manage.addEventListener('click', () => this.harnessFn('open-harnesses'))
    if (h.state !== 'ready') return [el('p', h.message, 'muted hb-empty'), manage]
    const out: HTMLElement[] = []
    const applied = el('div', undefined, 'ih-applied')
    applied.append(el('h3', h.labels.applied))
    const names = el('ul', undefined, 'chips')
    for (const n of h.applied) names.append(el('li', n, 'chip'))
    applied.append(names)
    out.push(applied)
    if (h.coverage) {
      const cov = el('div', undefined, 'ih-coverage')
      cov.append(el('h3', h.labels.coverage))
      const ul = el('ul', undefined, 'hb-coverage')
      for (const r of h.coverage.rows) {
        const li = el('li', undefined, `hb-cov tone-${r.tone}`)
        li.dataset.capability = r.capability
        li.dataset.level = r.level
        li.title = r.reason
        li.append(el('span', r.label, 'hb-cov-label'), el('span', r.word, `badge-t tone-${r.tone}`))
        ul.append(li)
      }
      cov.append(ul)
      out.push(cov)
    }
    const status = el('div', undefined, 'ih-status')
    const comp = el('span', h.completion.text, `badge-t tone-${h.completion.tone}`)
    comp.dataset.role = 'completion'
    const ver = el('span', h.verification.text, `badge-t tone-${h.verification.tone}`)
    ver.dataset.role = 'verification'
    status.append(comp, ver)
    if (h.retries) status.append(el('span', h.retries, 'muted small'))
    out.push(status)
    const counts = el('p', h.countsLine, 'ih-counts')
    counts.dataset.role = 'counts'
    out.push(el('h3', h.labels.activity), counts)
    out.push(el('h3', h.labels.gates))
    if (!h.gates.length) out.push(el('p', h.gatesEmpty, 'muted'))
    const gl = el('ul', undefined, 'ih-gates')
    for (const g of h.gates) {
      const li = el('li', undefined, `ih-gate tone-${g.tone}`)
      li.dataset.gateId = g.id
      li.append(
        el('span', g.mark, 'ih-mark'),
        el('strong', ` ${g.name} `),
        el('code', g.command),
        el('span', ` ${g.statusLabel}`, 'muted small'),
      )
      if (g.tail) {
        const d = el('details')
        d.append(el('summary', 'Output'), el('pre', g.tail))
        li.append(d)
      }
      gl.append(li)
    }
    out.push(gl)
    if (h.pinWarning) out.push(el('p', h.pinWarning, 'tone-warn'))
    const run = el('button', h.run.label, 'btn small primary')
    run.type = 'button'
    run.dataset.action = h.run.action
    run.disabled = !h.run.enabled
    if (h.run.hint) run.title = h.run.hint
    run.addEventListener('click', () => this.harnessFn(h.run.action))
    out.push(run)
    out.push(el('h3', h.labels.denied))
    if (!h.denied.length) out.push(el('p', h.deniedEmpty, 'muted'))
    const dl = el('ul', undefined, 'ih-denied')
    for (const d of h.denied) {
      const li = el('li', undefined, 'ih-deny')
      li.dataset.eventId = d.id
      li.append(
        el('strong', d.tool),
        el('span', ` ${d.summary}`),
        el(
          'span',
          ` ${d.ruleNames.map((n) => HARNESS_COPY.tab.rule(n)).join(' · ')}`,
          'muted small',
        ),
      )
      dl.append(li)
    }
    out.push(dl, manage)
    return out
  }

  private renderHint(vm: PanelVM): void {
    const hint = byId('p-hint')
    hint.hidden = !vm.hint
    hint.replaceChildren()
    if (!vm.hint) return
    hint.append(el('span', vm.hint.text))
    if (vm.hint.action === 'install-hook') {
      const btn = el('button', vm.hint.label ?? SESSION_COPY.hint.install, 'btn')
      btn.type = 'button'
      btn.addEventListener('click', () => void this.installFn())
      hint.append(btn)
    }
    if (vm.hint.action === 'open-parent' && vm.parent) {
      const parentId = vm.parent.id
      const btn = el('button', vm.hint.label ?? SESSION_COPY.hint.openParent, 'btn')
      btn.type = 'button'
      btn.addEventListener('click', () => this.parentFn(parentId))
      hint.append(btn)
    }
    if (vm.hint.action === 'open-connect') {
      const btn = el('button', COPY.hint.howTo, 'link')
      btn.type = 'button'
      btn.addEventListener('click', () => this.connectFn())
      hint.append(' ', btn)
    }
  }

  /** Mode and model pills (menus when managed), Interrupt and Stop. */
  private renderSession(s: SessionHeaderVM | null): void {
    const key = JSON.stringify(s)
    if (key === this.renderedSession) return
    this.renderedSession = key
    this.session = s
    const bar = byId('p-session')
    bar.hidden = !s
    if (!s) return bar.replaceChildren()
    const pill = (text: string, kind: 'mode' | 'model') => {
      if (!s.managed) {
        const span = el('span', text, `pill session-pill ${kind}`)
        span.setAttribute('aria-disabled', 'true')
        span.dataset.kind = kind
        if (s.readOnlyNote) span.title = s.readOnlyNote
        return span
      }
      const btn = el('button', `${text} ▾`, `pill session-pill ${kind}`)
      btn.type = 'button'
      btn.dataset.kind = kind
      btn.setAttribute('aria-haspopup', 'menu')
      btn.addEventListener('click', () =>
        kind === 'mode' ? this.modeMenu(btn) : this.modelMenu(btn),
      )
      return btn
    }
    const left = el('div', undefined, 'session-pills')
    left.append(pill(s.mode.text, 'mode'), pill(s.model.text, 'model'))
    if (s.readOnlyNote) {
      const note = el('span', 'ⓘ', 'muted session-note')
      note.title = s.readOnlyNote
      note.setAttribute('aria-label', s.readOnlyNote)
      note.setAttribute('role', 'note')
      left.append(note)
    }
    const right = el('div', undefined, 'session-actions')
    if (s.canInterrupt) {
      const b = el('button', SESSION_COPY.interrupt, 'btn small')
      b.type = 'button'
      b.id = 'p-interrupt'
      b.addEventListener('click', () => void this.interruptFn())
      right.append(b)
    }
    if (s.canStop) {
      const b = el('button', SESSION_COPY.stop, 'btn small danger')
      b.type = 'button'
      b.id = 'p-stop'
      b.addEventListener('click', () => this.stopDialog.showModal())
      right.append(b)
    }
    bar.replaceChildren(left, right)
  }

  private modeMenu(anchor: HTMLElement): void {
    const s = this.session
    if (!s) return
    openMenu(
      anchor,
      [
        {
          items: s.modes.map((m) => ({
            id: m.id,
            label: `${m.icon} ${m.label}`,
            desc: m.desc,
            checked: m.checked,
          })),
        },
      ],
      (id) => void this.modeFn(id as PermissionMode),
      { role: 'menuitemradio' },
    )
  }

  private modelMenu(anchor: HTMLElement): void {
    const s = this.session
    if (!s) return
    const items = s.models.length
      ? s.models.map((m) => ({
          id: m.id,
          label: m.label,
          ...(m.description && { desc: m.description }),
          checked: m.checked,
        }))
      : [{ id: '', label: LOADING_MODELS, disabled: true }]
    openMenu(anchor, [{ items }], (id) => void this.modelFn(id), { role: 'menuitemradio' })
  }

  private renderPermission(p: PermissionCardVM | null): void {
    const key = JSON.stringify(p)
    if (key === this.renderedPerm) return
    this.renderedPerm = key
    const card = byId('p-perm')
    card.hidden = !p
    if (!p) return card.replaceChildren()
    const c = SESSION_COPY.permission
    const title = el('h3', c.title, 'perm-title')
    title.id = 'p-perm-title'
    const what = el('p', `⌘ ${p.request.tool} · ${p.request.summary}`, 'perm-what')
    const rows: HTMLElement[] = [title, what]
    if (p.request.rule)
      rows.push(el('p', HARNESS_COPY.tab.askedBy(p.request.rule.name), 'muted perm-rule'))
    if (p.request.where)
      rows.push(el('p', SESSION_COPY.permission.where(p.request.where), 'muted perm-where'))
    const actions = el('div', undefined, 'perm-actions')
    const button = (label: string, d: PermissionDecision, cls: string) => {
      const b = el('button', label, `btn small ${cls}`)
      b.type = 'button'
      b.dataset.decision = d
      b.addEventListener('click', () => void this.answerFn(p.request.id, d))
      return b
    }
    actions.append(
      button(c.allowOnce, 'allow', 'primary'),
      button(p.allowSessionLabel, 'allow-session', ''),
      button(c.deny, 'deny', 'danger'),
    )
    if (p.counter) actions.append(el('span', p.counter, 'muted perm-counter'))
    rows.push(actions)
    card.replaceChildren(...rows)
  }

  private renderComposer(c: ComposerVM): void {
    this.input.disabled = c.disabled
    this.input.placeholder = c.placeholder
    this.sendBtn.disabled = c.disabled
    this.ctxBtn.disabled = !c.canAddContext
    this.useBtn.disabled = !c.canAddUse
    const key = JSON.stringify(c.chips)
    if (key === this.renderedChips) return
    this.renderedChips = key
    renderComposerChips(byId('p-chips'), c.chips, (k) => this.removeFn(k))
  }

  private renderThread(vm: PanelVM): void {
    const key = JSON.stringify(vm.thread.map((m) => [m.id, m.from, m.stateLabel, m.context]))
    if (key === this.renderedThread) return
    this.renderedThread = key
    const list = byId('p-thread')
    if (vm.thread.length === 0) {
      list.replaceChildren(el('li', vm.present ? 'No messages yet. Say hi 👋' : '', 'empty'))
      return
    }
    list.replaceChildren(
      ...vm.thread.map((m) => {
        const li = el('li', m.text, m.from)
        if (m.stateLabel) li.append(el('span', m.stateLabel, 'state'))
        if (m.context?.length) {
          const chips = el('ul', undefined, 'msg-chips')
          for (const c of m.context) {
            const chip = el('li', `${chipIcon(c.kind)} ${c.label}`, 'chip')
            if (c.hint) chip.title = c.hint
            chips.append(chip)
          }
          li.append(chips)
        }
        return li
      }),
    )
    list.scrollTop = list.scrollHeight
  }

  private updateCounter(): void {
    this.counter.textContent = `${this.input.value.length}/${MAX_MESSAGE_CHARS}`
  }

  private submit(): void {
    const text = this.input.value.trim()
    if (text && !this.input.disabled) void this.sendFn(text)
  }
}

/** "Connections used" / "Skills & rules used" rows of colored chips with use counts. */
function renderChips(
  root: HTMLElement,
  used: PanelVM['used'],
  provider: string,
  pick: (ref: CapabilityRef) => void,
): void {
  root.hidden = !used
  if (!used) return root.replaceChildren()
  const group = (title: string, chips: NonNullable<PanelVM['used']>['adapters']) => {
    if (!chips.length) return []
    const list = el('ul', undefined, 'chips')
    for (const c of chips) {
      const li = el('li')
      // A chip opens the same as a Library row: camera to the surface + Capability panel (L9).
      const btn = el('button', `${c.label} · ${c.count}`, 'chip')
      btn.type = 'button'
      btn.style.setProperty('--chip', c.color)
      btn.dataset.capabilityId = c.id
      btn.addEventListener('click', () => pick({ provider, id: c.id }))
      li.append(btn)
      list.append(li)
    }
    return [el('h3', title), list]
  }
  root.replaceChildren(
    ...group('Connections used', used.adapters),
    ...group('Skills & rules used', used.library),
  )
}

/** The agent's provider for chip refs (`PanelVM.provider`); empty → the controller fills it in. */
function panelProvider(vm: PanelVM): string {
  return (vm as PanelVM & { provider?: string }).provider ?? ''
}
