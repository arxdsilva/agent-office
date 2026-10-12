import { COPY } from '../../app/connect-copy.ts'
import type {
  ConnectTab,
  ConnectVM,
  Pill,
  ProviderCardVM,
  SnippetLang,
} from '../../app/connect-types.ts'
import type { ConnectView, ProviderAction } from '../../ports.ts'
import { byId, el } from './el.ts'

const TABS: ConnectTab[] = ['claude', 'providers', 'http', 'demo', 'connected']
const LANGS: SnippetLang[] = ['curl', 'python', 'js']
/** Remembers the last snippet language (per viewer; read back in main.ts). */
export const SNIPPET_LANG_KEY = 'agent-office.snippetLang'
const FLASH_MS = 1_500
const STATE_WORD: Record<Pill['tone'], string> = {
  ok: 'connected',
  warn: 'attention',
  off: 'off',
  error: 'error',
  pending: 'pending',
}
const isHttps = (u: string) => {
  try {
    return new URL(u).protocol === 'https:'
  } catch {
    return false
  }
}

type CopyTarget = 'endpoint' | 'snippet'

const setPill = (node: HTMLElement, p: Pill) => {
  node.textContent = p.text
  node.className = `pill ${p.tone}`
}

const button = (text: string, className = 'btn', id?: string) => {
  const b = el('button', text, className)
  b.type = 'button'
  if (id) b.id = id
  return b
}

/** An https link opened outside the app by main's window-open handler (https only). */
const extLink = (text: string, href: string) => {
  const a = el('a', text)
  a.href = href
  a.target = '_blank'
  a.rel = 'noopener'
  return a
}

/** A labelled checkbox switch plus the "Controlled by …" note. */
function toggle(id: string, label: string) {
  const input = el('input')
  input.type = 'checkbox'
  input.id = id
  const row = el('label', undefined, 'row')
  row.append(input, ' ', label)
  const note = el('p', undefined, 'muted small')
  return { row, input, note }
}

/** ConnectView port → `<dialog id="connect">`: tab rail + four panels, built once, updated in place. */
export class DomConnectPanel implements ConnectView {
  private dialog = byId<HTMLDialogElement>('connect')
  private vm: ConnectVM | null = null
  private tabButtons = new Map<ConnectTab, HTMLButtonElement>()
  private panels = new Map<ConnectTab, HTMLElement>()
  private flashTimers = new Map<CopyTarget, ReturnType<typeof setTimeout>>()

  private fns = {
    close: () => {},
    tab: (_t: ConnectTab) => {},
    toggle: (_k: 'claudeAdapter' | 'mock', _on: boolean): void | Promise<void> => {},
    hook: (_a: 'install' | 'uninstall'): void | Promise<void> => {},
    port: (_p: number): void | Promise<void> => {},
    lang: (_l: SnippetLang) => {},
    copy: (_text: string, _t: CopyTarget): void | Promise<void> => {},
    test: (): void | Promise<void> => {},
    goTo: (_p: string) => {},
    provider: (_a: ProviderAction): void | Promise<void> => {},
  }

  // Claude Code
  private claudePill = el('span')
  private claudeToggle = toggle('c-claude-toggle', COPY.claude.step1)
  private folder = el('p', undefined, 'small')
  private hookLabel = el('strong')
  private hookBtn = button('', 'btn', 'c-hook-btn')
  private verified = el('p', undefined, 'small')
  private idle = el('p', undefined, 'muted small')
  // Any framework
  private httpPill = el('span')
  private endpoint = el('code')
  private auth = el('p', undefined, 'muted small')
  private busyBox = el('form', undefined, 'busy-box')
  private busyHelp = el('span')
  private portInput = el('input')
  private langButtons = new Map<SnippetLang, HTMLButtonElement>()
  private copyEndpoint = button(COPY.http.copy, 'btn', 'c-copy-endpoint')
  private copySnippet = button(COPY.http.copy, 'btn', 'c-copy-snippet')
  private code = el('code')
  private snippetNote = el('p', undefined, 'muted small')
  private live = el('span')
  // Providers
  private provList = el('div', undefined, 'prov-cards')
  private provKey = ''
  // Demo
  private demoPill = el('span')
  private demoToggle = toggle('c-demo-toggle', COPY.demo.toggle)
  // Connected
  private connectedCount = el('span', undefined, 'muted')
  private rows = el('ul', undefined, 'c-rows')
  private rowsKey = ''
  /** Toggles waiting for their settings write: re-renders keep the user's choice meanwhile. */
  private pending = new Set<'claudeAdapter' | 'mock'>()

  constructor() {
    byId('connect-title').textContent = COPY.panel.title
    byId('connect-sub').textContent = COPY.panel.subtitle
    byId('connect-close').addEventListener('click', () => this.close())
    this.dialog.addEventListener('close', () => this.fns.close())
    // Typing in the panel must not trigger scene shortcuts (F = walk, E = talk).
    this.dialog.addEventListener('keydown', (e) => e.stopPropagation())
    this.buildTabs()
    this.panels.set('claude', this.buildClaude())
    this.panels.set('providers', this.buildProviders())
    this.panels.set('http', this.buildHttp())
    this.panels.set('demo', this.buildDemo())
    this.panels.set('connected', this.buildConnected())
    byId('connect-panels').replaceChildren(...this.panels.values())
  }

  onClose(fn: () => void) {
    this.fns.close = fn
  }
  onTab(fn: (t: ConnectTab) => void) {
    this.fns.tab = fn
  }
  onToggle(fn: (key: 'claudeAdapter' | 'mock', on: boolean) => void | Promise<void>) {
    this.fns.toggle = fn
  }
  onHookAction(fn: (a: 'install' | 'uninstall') => void | Promise<void>) {
    this.fns.hook = fn
  }
  onPort(fn: (port: number) => void | Promise<void>) {
    this.fns.port = fn
  }
  onSnippetLang(fn: (l: SnippetLang) => void) {
    this.fns.lang = fn
  }
  onCopy(fn: (text: string, target: CopyTarget) => void | Promise<void>) {
    this.fns.copy = fn
  }
  onTest(fn: () => void | Promise<void>) {
    this.fns.test = fn
  }
  onGoToWing(fn: (provider: string) => void) {
    this.fns.goTo = fn
  }

  onProviderAction(fn: (a: ProviderAction) => void | Promise<void>) {
    this.fns.provider = fn
  }

  isOpen(): boolean {
    return this.dialog.open
  }

  open(vm: ConnectVM): void {
    this.render(vm)
    if (!this.dialog.open) this.dialog.showModal()
    this.tabButtons.get(vm.tab)?.focus()
  }

  close(): void {
    if (this.dialog.open) this.dialog.close()
  }

  showError(message: string | null): void {
    byId('connect-error').textContent = message ?? ''
  }

  flashCopied(target: CopyTarget): void {
    const btn = target === 'endpoint' ? this.copyEndpoint : this.copySnippet
    btn.textContent = COPY.http.copied
    clearTimeout(this.flashTimers.get(target))
    this.flashTimers.set(
      target,
      setTimeout(() => (btn.textContent = COPY.http.copy), FLASH_MS),
    )
  }

  render(vm: ConnectVM): void {
    this.vm = vm
    for (const t of vm.tabs) {
      const b = this.tabButtons.get(t.id)!
      const active = t.id === vm.tab
      b.querySelector('.tab-label')!.textContent = t.label
      b.querySelector('.tab-dot')!.className = `tab-dot ${t.tone}`
      b.setAttribute('aria-selected', String(active))
      b.tabIndex = active ? 0 : -1
      this.panels.get(t.id)!.hidden = !active
    }
    this.renderClaude(vm.claude)
    this.renderProviders(vm.providers.cards)
    this.renderHttp(vm.http)
    this.renderDemo(vm.demo)
    this.renderConnected(vm.connected)
  }

  // ---------------------------------------------------------------------------------------------

  private flip(key: 'claudeAdapter' | 'mock', on: boolean): void {
    this.pending.add(key)
    void Promise.resolve(this.fns.toggle(key, on)).finally(() => {
      this.pending.delete(key)
      if (this.vm) this.render(this.vm)
    })
  }

  private buildTabs(): void {
    const rail = byId('connect-tabs')
    for (const id of TABS) {
      const b = button('', 'tab')
      b.id = `c-tab-${id}`
      b.setAttribute('role', 'tab')
      b.setAttribute('aria-controls', `c-panel-${id}`)
      const dot = el('span', undefined, 'tab-dot')
      dot.setAttribute('aria-hidden', 'true')
      b.append(dot, el('span', COPY.panel.tabs[id], 'tab-label'))
      b.addEventListener('click', () => this.fns.tab(id))
      this.tabButtons.set(id, b)
      rail.append(b)
    }
    rail.addEventListener('keydown', (e) => {
      if (!this.vm || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
      e.preventDefault()
      const i = TABS.indexOf(this.vm.tab)
      const next = TABS[(i + (e.key === 'ArrowDown' ? 1 : TABS.length - 1)) % TABS.length]!
      this.fns.tab(next)
      this.tabButtons.get(next)!.focus()
    })
  }

  private section(id: ConnectTab, title: string, pill: HTMLElement): HTMLElement {
    const s = el('section', undefined, 'connect-panel')
    s.id = `c-panel-${id}`
    s.setAttribute('role', 'tabpanel')
    s.setAttribute('aria-labelledby', `c-tab-${id}`)
    s.hidden = true
    const head = el('div', undefined, 'connect-head')
    head.append(el('h3', title), pill)
    s.append(head)
    return s
  }

  private buildClaude(): HTMLElement {
    this.claudePill.id = 'c-claude-pill'
    const s = this.section('claude', COPY.panel.tabs.claude, this.claudePill)
    const t = this.claudeToggle
    t.input.addEventListener('change', () => this.flip('claudeAdapter', t.input.checked))
    const step1 = el('div', undefined, 'step')
    step1.append(
      el('span', '1', 'step-n'),
      t.row,
      el('p', COPY.claude.step1Help, 'muted small'),
      t.note,
      this.folder,
    )
    this.hookBtn.addEventListener('click', () => {
      if (this.vm) void this.fns.hook(this.vm.claude.hook.action)
    })
    const hookRow = el('p', undefined, 'row')
    hookRow.append(el('span', COPY.claude.step2), this.hookLabel, this.hookBtn)
    const step2 = el('div', undefined, 'step')
    step2.append(
      el('span', '2', 'step-n'),
      hookRow,
      el('p', COPY.claude.step2Help, 'muted small'),
      this.verified,
    )
    this.verified.setAttribute('aria-live', 'polite')
    s.append(step1, step2, this.idle)
    return s
  }

  private renderClaude(c: ConnectVM['claude']): void {
    setPill(this.claudePill, c.pill)
    const t = this.claudeToggle
    if (!this.pending.has('claudeAdapter')) t.input.checked = c.toggle.on
    t.input.disabled = !!c.toggle.disabledNote
    t.note.textContent = c.toggle.disabledNote ?? ''
    t.note.hidden = !c.toggle.disabledNote
    this.folder.className = `small ${c.folder.ok ? 'ok' : 'warn'}`
    this.folder.replaceChildren(
      c.folder.ok ? c.folder.text : extLink(c.folder.text, COPY.claude.docsUrl),
    )
    this.hookLabel.textContent = c.hook.label
    this.hookBtn.textContent = c.hook.button
    this.verified.hidden = !c.verified
    if (c.verified) setPill(this.verified, c.verified)
    this.idle.hidden = !c.idleNote
    this.idle.textContent = c.idleNote ?? ''
  }

  private buildProviders(): HTMLElement {
    const s = this.section('providers', COPY.providers.heading, el('span'))
    const all = button(COPY.providers.checkAll, 'btn', 'c-prov-refresh-all')
    all.dataset.action = 'refresh'
    all.addEventListener('click', () => void this.fns.provider({ kind: 'refresh' }))
    this.provList.id = 'c-prov-list'
    s.querySelector('.connect-head')!.replaceChildren(el('h3', COPY.providers.heading), all)
    s.append(this.provList)
    return s
  }

  private renderProviders(cards: ProviderCardVM[]): void {
    const key = JSON.stringify(cards)
    if (key === this.provKey) return
    this.provKey = key
    // Keep keyboard focus on the same control across a rebuild.
    const a = document.activeElement as HTMLElement | null
    const focusKey =
      a && this.provList.contains(a) ? `${a.closest('article')?.id}|${a.dataset.action}` : ''
    this.provList.replaceChildren(...cards.map((c) => this.providerCard(c)))
    if (focusKey) {
      const [id, act] = focusKey.split('|')
      this.provList.querySelector<HTMLElement>(`[id="${id}"] [data-action="${act}"]`)?.focus()
    }
  }

  private providerCard(c: ProviderCardVM): HTMLElement {
    const card = el('article', undefined, 'prov-card')
    card.id = `c-prov-${c.id}`
    card.dataset.state = STATE_WORD[c.pill.tone]
    const act = (a: ProviderAction) => () => void this.fns.provider(a)
    const head = el('div', undefined, 'prov-head')
    head.append(el('strong', c.label), el('span', c.pill.text, `pill ${c.pill.tone}`))
    card.append(head)
    if (c.version) card.append(el('p', c.version, 'muted small prov-version'))
    card.append(el('p', c.integration, 'small prov-integration'))
    if (c.sessions) card.append(el('p', c.sessions, 'small prov-sessions'))
    for (const [label, caps, cls] of [
      ['Managed:', c.managedCaps, 'managed'],
      ['Observed:', c.observedCaps, 'observed'],
    ] as const) {
      if (!caps.length) continue
      const row = el('ul', undefined, `prov-chips ${cls}`)
      row.setAttribute('aria-label', label)
      row.append(el('li', label, 'prov-chips-l muted'))
      for (const cap of caps) row.append(el('li', cap, 'chip'))
      card.append(row)
    }
    if (c.hint) card.append(el('p', c.hint, 'muted small prov-hint'))
    if (c.toggle) {
      const input = el('input')
      input.type = 'checkbox'
      input.checked = c.toggle.on
      input.dataset.action = 'toggle'
      input.setAttribute('aria-label', `Enable ${c.label}`)
      input.addEventListener('change', () =>
        this.fns.provider({ kind: 'toggle', id: c.id, on: input.checked }),
      )
      const row = el('label', undefined, 'row')
      row.append(input, ` ${COPY.providers.enable}`)
      card.append(row)
    }
    if (c.hooks) {
      const h = c.hooks
      const b = button(h.button)
      b.dataset.action = 'hooks'
      b.addEventListener('click', act({ kind: 'hooks', id: c.id, action: h.action }))
      const row = el('p', undefined, 'row prov-hooks')
      row.append(
        el('span', 'Hooks', 'muted'),
        el('span', h.status.text, `pill ${h.status.tone}`),
        b,
      )
      card.append(row)
    }
    const actions = el('div', undefined, 'row prov-actions')
    const refresh = button(COPY.providers.check)
    refresh.dataset.action = 'refresh'
    refresh.addEventListener('click', act({ kind: 'refresh', id: c.id }))
    actions.append(refresh)
    if (c.canStart) {
      const start = button(COPY.providers.start, 'btn primary')
      start.dataset.action = 'start'
      start.addEventListener('click', act({ kind: 'start', id: c.id }))
      actions.append(start)
    }
    if (isHttps(c.docsUrl)) actions.append(extLink(COPY.providers.docs, c.docsUrl))
    card.append(actions)
    return card
  }

  private buildHttp(): HTMLElement {
    this.httpPill.id = 'c-http-pill'
    const s = this.section('http', COPY.panel.tabs.http, this.httpPill)

    this.copyEndpoint.addEventListener('click', () => {
      if (this.vm) void this.fns.copy(this.vm.http.endpoint, 'endpoint')
    })
    const endpoint = el('p', undefined, 'row')
    endpoint.append(el('span', COPY.http.endpoint, 'muted'), this.endpoint, this.copyEndpoint)

    this.portInput.type = 'number'
    this.portInput.id = 'c-port'
    this.portInput.min = '1024'
    this.portInput.max = '65535'
    const apply = el('button', COPY.http.apply, 'btn')
    apply.type = 'submit'
    this.busyBox.append(this.busyHelp, this.portInput, apply)
    this.busyBox.addEventListener('submit', (e) => {
      e.preventDefault()
      void this.fns.port(Number(this.portInput.value))
    })

    const langs = el('div', undefined, 'langs')
    for (const l of LANGS) {
      const b = button(COPY.http.langs[l], 'lang')
      b.dataset.lang = l
      b.addEventListener('click', () => {
        try {
          localStorage.setItem(SNIPPET_LANG_KEY, l)
        } catch {
          // Storage may be unavailable; the choice just isn't remembered.
        }
        this.fns.lang(l)
      })
      this.langButtons.set(l, b)
      langs.append(b)
    }
    this.copySnippet.addEventListener('click', () => {
      if (this.vm) void this.fns.copy(this.vm.http.snippet, 'snippet')
    })
    const langRow = el('div', undefined, 'row')
    langRow.append(langs, this.copySnippet)
    const pre = el('pre', undefined, 'snippet')
    pre.append(this.code)

    const test = button(COPY.http.test, 'btn', 'c-test')
    test.addEventListener('click', () => void this.fns.test())
    this.live.id = 'c-http-live'
    this.live.setAttribute('aria-live', 'polite')
    const testRow = el('p', undefined, 'row')
    testRow.append(test, this.live)

    s.append(
      endpoint,
      this.auth,
      el('p', COPY.http.fields, 'muted small'),
      this.busyBox,
      langRow,
      pre,
      this.snippetNote,
      testRow,
      el('p', undefined, 'small'),
    )
    s.lastElementChild!.append(extLink(COPY.http.next, COPY.http.readmeUrl))
    return s
  }

  private renderHttp(h: ConnectVM['http']): void {
    setPill(this.httpPill, h.pill)
    this.endpoint.textContent = h.endpoint
    this.auth.textContent = COPY.http.auth(h.tokenFile)
    this.busyBox.hidden = !h.portBusy
    if (h.portBusy) {
      this.busyHelp.textContent = COPY.http.busyHelp(h.portBusy.port)
      if (document.activeElement !== this.portInput && !this.portInput.value)
        this.portInput.value = String(h.portBusy.port)
    }
    for (const [l, b] of this.langButtons) b.setAttribute('aria-pressed', String(l === h.lang))
    this.code.textContent = h.snippet
    this.snippetNote.hidden = !h.snippetNote
    this.snippetNote.textContent = h.snippetNote ?? ''
    setPill(this.live, h.live)
  }

  private buildDemo(): HTMLElement {
    this.demoPill.id = 'c-demo-pill'
    const s = this.section('demo', COPY.panel.tabs.demo, this.demoPill)
    const t = this.demoToggle
    t.input.addEventListener('change', () => this.flip('mock', t.input.checked))
    s.append(el('p', COPY.demo.body), t.row, t.note, el('p', COPY.demo.help, 'muted small'))
    return s
  }

  private renderDemo(d: ConnectVM['demo']): void {
    setPill(this.demoPill, d.pill)
    const t = this.demoToggle
    if (!this.pending.has('mock')) t.input.checked = d.toggle.on
    t.input.disabled = !!d.toggle.disabledNote
    t.note.textContent = d.toggle.disabledNote ?? ''
    t.note.hidden = !d.toggle.disabledNote
  }

  private buildConnected(): HTMLElement {
    const s = this.section('connected', COPY.panel.tabs.connected, this.connectedCount)
    this.rows.id = 'c-rows'
    s.append(this.rows)
    return s
  }

  private renderConnected(c: ConnectVM['connected']): void {
    this.connectedCount.textContent = COPY.connected.count(c.rows.length)
    const key = JSON.stringify(c.rows)
    if (key === this.rowsKey) return
    this.rowsKey = key
    if (!c.rows.length) {
      const li = el('li', undefined, 'none')
      li.append(el('p', COPY.connected.none))
      for (const t of ['claude', 'http', 'demo'] as const) {
        const b = button(COPY.panel.tabs[t], 'btn')
        b.addEventListener('click', () => this.fns.tab(t))
        li.append(b, ' ')
      }
      return void this.rows.replaceChildren(li)
    }
    this.rows.replaceChildren(
      ...c.rows.map((r) => {
        const li = el('li', undefined, 'c-row')
        li.dataset.provider = r.provider
        const dots = el('span', undefined, 'dots')
        dots.setAttribute('aria-hidden', 'true')
        for (const color of r.dots) {
          const d = el('span', undefined, 'swatch')
          d.style.background = color
          dots.append(d)
        }
        const go = button(COPY.connected.goTo, 'btn')
        go.addEventListener('click', () => this.fns.goTo(r.provider))
        li.append(
          el('strong', r.provider),
          el('span', COPY.connected.agents(r.count)),
          dots,
          el('span', r.via),
          el('span', r.lastSeen, 'muted'),
          go,
        )
        return li
      }),
    )
  }
}
