// SessionVaultView port → `#ws-sessions`: every session across providers, grouped by project,
// with searchable messages, assignment suggestions and the two "keep going" buttons.
import { MEMORY_KINDS, type MemoryKind } from '@agent-office/shared'
import { WS_COPY } from '../../app/workspace/workspace-copy.ts'
import type {
  SessionDetailVM,
  SessionMessageVM,
  SessionRowVM,
  SessionsVM,
} from '../../app/workspace/types.ts'
import type { SessionVaultView } from '../../workspace-ports.ts'
import { el } from './el.ts'
import {
  Signal,
  activatable,
  badge,
  chip,
  dot,
  need,
  notice,
  setText,
  syncInput,
  textButton,
  vmButton,
} from './ws-kit.ts'

export class DomSessionVault implements SessionVaultView {
  private search = new Signal<[string]>()
  private scope = new Signal<[string]>()
  private select = new Signal<[string]>()
  private assign = new Signal<[string, string | null]>()
  private cont = new Signal<[string]>()
  private resume = new Signal<[string]>()
  private more = new Signal<[string]>()
  private saveMemory = new Signal<[string, string, { title: string; kind: MemoryKind }]>()
  private importer = new Signal()

  private root: HTMLElement
  private heading = el('h1', undefined, 'pane-title')
  private input = el('input', undefined, 'search-input')
  private scopes = el('div', undefined, 'filters')
  private list = el('div', undefined, 'sv-groups')
  private detail = el('div', undefined, 'sv-detail-body')
  private status = el('div', undefined, 'sv-status')
  private importBtn = el('button', undefined, 'btn small')
  private importLine = el('div', undefined, 'sv-notice muted small')
  private noticeBox = el('div', undefined, 'sv-notice')
  private lastHighlight = ''

  constructor(doc: Document) {
    this.root = need(doc, 'ws-sessions')
    this.list.id = 'sv-list'
    this.input.id = 'sv-search'
    this.input.type = 'search'
    this.input.autocomplete = 'off'
    this.input.spellcheck = false
    this.input.addEventListener('input', () => this.search.emit(this.input.value))
    this.scopes.setAttribute('role', 'group')

    const left = el('aside', undefined, 'sv-left card')
    this.importBtn.id = 'sv-import'
    this.importBtn.type = 'button'
    this.importBtn.addEventListener('click', () => this.importer.emit())
    this.importLine.id = 'sv-import-status'
    this.importLine.setAttribute('role', 'status')
    this.noticeBox.id = 'sv-notice'
    left.append(
      this.heading,
      this.input,
      this.scopes,
      this.importBtn,
      this.importLine,
      this.noticeBox,
      this.status,
      this.list,
    )
    const right = el('section', undefined, 'sv-right card')
    right.append(this.detail)
    const inner = el('div', undefined, 'ws-inner split')
    inner.append(left, right)
    this.root.replaceChildren(inner)
  }

  onSearch(fn: (q: string) => void): void {
    this.search.on(fn)
  }
  onScope(fn: (s: string) => void): void {
    this.scope.on(fn)
  }
  onSelect(fn: (id: string) => void): void {
    this.select.on(fn)
  }
  onAssign(fn: (sessionId: string, projectId: string | null) => void): void {
    this.assign.on(fn)
  }
  onContinue(fn: (id: string) => void): void {
    this.cont.on(fn)
  }
  onResume(fn: (id: string) => void): void {
    this.resume.on(fn)
  }
  onLoadMore(fn: (id: string) => void): void {
    this.more.on(fn)
  }
  onSaveMemory(
    fn: (sessionId: string, messageId: string, f: { title: string; kind: MemoryKind }) => void,
  ): void {
    this.saveMemory.on(fn)
  }
  onImport(fn: () => void): void {
    this.importer.on(fn)
  }

  render(vm: SessionsVM): void {
    setText(this.heading, vm.heading)
    this.input.placeholder = vm.searchPlaceholder
    this.input.setAttribute('aria-label', vm.searchPlaceholder)
    syncInput(this.input, vm.query)

    this.scopes.replaceChildren(
      ...vm.scopes.map((s) => {
        const b = el('button', s.label, `filter${s.active ? ' active' : ''}`)
        b.type = 'button'
        b.dataset.scope = s.key
        b.setAttribute('aria-pressed', String(s.active))
        b.addEventListener('click', () => this.scope.emit(s.key))
        return b
      }),
    )
    setText(this.importBtn, vm.importHistory.label)
    this.importBtn.disabled = !vm.importHistory.enabled
    this.importBtn.title = vm.importHistory.hint ?? ''
    setText(this.importLine, vm.importStatus ?? '')
    this.importLine.hidden = !vm.importStatus
    this.noticeBox.replaceChildren(...(vm.notice ? [notice(vm.notice, 'info')] : []))
    const st: Node[] = []
    if (vm.error) st.push(notice(vm.error, 'error'))
    if (vm.loading) st.push(notice('Loading…', 'info'))
    this.status.replaceChildren(...st)

    if (!vm.groups.length) this.list.replaceChildren(el('p', vm.empty, 'sec-empty muted'))
    else
      this.list.replaceChildren(
        ...vm.groups.map((g) => {
          const sec = el('section', undefined, 'sv-group')
          sec.dataset.group = g.key
          sec.append(el('h2', g.heading, 'group-title'))
          const ul = el('ul', undefined, 'rows')
          for (const r of g.rows) ul.append(this.sessionRow(r))
          sec.append(ul)
          return sec
        }),
      )
    this.renderDetail(vm)
  }

  private sessionRow(r: SessionRowVM): HTMLLIElement {
    const li = el('li', undefined, `row session-row${r.selected ? ' selected' : ''}`)
    li.dataset.sessionId = r.id
    if (r.selected) li.setAttribute('aria-current', 'true')
    const main = el('div', undefined, 'row-main')
    const title = el('div', undefined, 'row-title')
    title.append(
      dot(r.stateLabel.toLowerCase().includes('active') ? 'good' : 'neutral'),
      el('span', r.title),
    )
    const meta = el('div', undefined, 'row-detail muted')
    meta.append(
      chip(r.provider, 'provider'),
      el('span', `${r.stateLabel} · ${r.originLabel} · ${r.when}`),
    )
    main.append(title, meta)
    li.append(main)
    if (r.unassigned) li.append(badge('No project', 'warn'))
    activatable(li, () => this.select.emit(r.id))
    return li
  }

  private renderDetail(vm: SessionsVM): void {
    const d = vm.detail
    if (!d) {
      this.detail.replaceChildren(el('p', vm.detailEmpty, 'sec-empty muted'))
      return
    }
    const head = el('header', undefined, 'sv-head')
    const t = el('div', undefined, 'sv-titles')
    t.append(el('h2', d.title, 'sec-title'))
    const sub = el('p', undefined, 'muted sv-sub')
    sub.append(chip(d.provider, 'provider'))
    sub.append(el('span', d.projectName ? ` ${d.projectName}` : ' No project'))
    if (d.assignedByLabel) sub.append(el('span', ` · ${d.assignedByLabel}`))
    if (d.continuedFrom) sub.append(el('span', ` · ${d.continuedFrom}`))
    t.append(sub)
    const btns = el('div', undefined, 'sv-actions')
    const cont = vmButton(d.continueWith, 'primary', () => this.cont.emit(d.id), 'sv-continue')
    const res = vmButton(d.resume, 'secondary', () => this.resume.emit(d.id), 'sv-resume')
    res.disabled = !d.resume.enabled
    btns.append(cont, res)
    head.append(t, btns)

    const parts: Node[] = [head]
    if (d.resume.hint) parts.push(el('p', d.resume.hint, 'hint-line muted'))
    if (d.summary) {
      const s = el('div', undefined, 'summary-box')
      s.append(el('p', d.summary.text), el('span', d.summary.sourceLabel, 'summary-src muted'))
      parts.push(s)
    }
    parts.push(...this.assignBlock(d))

    const msgs = el('ol', undefined, 'sv-messages')
    msgs.id = 'sv-messages'
    if (!d.messages.length) msgs.append(el('li', d.messagesEmpty, 'sec-empty muted'))
    for (const m of d.messages) msgs.append(this.message(m, d.id))
    parts.push(msgs)
    if (d.moreMessages)
      parts.push(
        textButton('Load more messages', 'secondary', () => this.more.emit(d.id), 'sv-more'),
      )
    this.detail.replaceChildren(...parts)

    const hl = d.messages.find((m) => m.highlighted)?.id ?? ''
    if (hl && hl !== this.lastHighlight)
      msgs
        .querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(hl)}"]`)
        ?.scrollIntoView?.({ block: 'center' })
    this.lastHighlight = hl
  }

  private assignBlock(d: SessionDetailVM): Node[] {
    const out: Node[] = []
    if (d.suggestions.length) {
      const box = el('div', undefined, 'suggest')
      box.append(el('h3', 'Suggested projects', 'mini-h'))
      for (const s of d.suggestions) {
        const row = el('div', undefined, 'suggest-row')
        const label = el('span', undefined, 'suggest-label')
        label.append(
          el('strong', s.name),
          el('span', ` ${s.rule}`, 'muted'),
          badge(
            s.confidence === 'high' ? 'High confidence' : 'Low confidence',
            s.confidence === 'high' ? 'good' : 'neutral',
          ),
        )
        row.append(
          label,
          vmButton(s.assign, 'small', () => this.assign.emit(d.id, s.projectId)),
        )
        box.append(row)
      }
      out.push(box)
    }
    if (d.assignOptions.length) {
      const row = el('div', undefined, 'assign-row')
      const sel = el('select', undefined, 'select')
      sel.id = 'sv-assign'
      sel.setAttribute('aria-label', 'Assign to a project')
      d.assignOptions.forEach((o, i) => {
        const opt = el('option', o.name)
        opt.value = String(i)
        opt.selected = o.current
        sel.append(opt)
      })
      const go = textButton(
        'Assign',
        'small',
        () => {
          const o = d.assignOptions[Number(sel.value)]
          if (o) this.assign.emit(d.id, o.projectId)
        },
        'sv-assign-btn',
      )
      row.append(el('label', 'Project', 'muted'), sel, go)
      out.push(row)
    }
    return out
  }

  private message(m: SessionMessageVM, sessionId: string): HTMLLIElement {
    const li = el('li', undefined, `msg msg-${m.role}${m.highlighted ? ' highlighted' : ''}`)
    li.dataset.msgId = m.id
    const head = el('div', undefined, 'msg-head')
    head.append(
      el('strong', m.roleLabel),
      el('span', m.when, 'muted'),
      badge(m.sourceBadge, 'neutral'),
    )
    li.append(head, el('p', m.text, 'msg-text'))
    if (m.tools.length) {
      const tools = el('div', undefined, 'msg-tools')
      for (const t of m.tools) tools.append(chip(t, 'tool'))
      li.append(tools)
    }
    const save = textButton(m.save.label, 'small msg-save', () => {}, undefined)
    save.addEventListener('click', () => {
      save.hidden = true
      li.append(this.saveForm(m, sessionId, save))
    })
    li.append(save)
    return li
  }

  /** The small inline form: title (first 80 chars), kind `note`. Scope is decided by the controller. */
  private saveForm(m: SessionMessageVM, sessionId: string, openBtn: HTMLElement): HTMLFormElement {
    const S = WS_COPY.sessions
    const f = el('form', undefined, 'msg-save-form')
    const title = el('input', undefined, 'search-input')
    title.type = 'text'
    title.maxLength = 120
    title.value = m.save.defaultTitle
    title.setAttribute('aria-label', S.saveMemoryTitle)
    const kind = el('select', undefined, 'select')
    kind.setAttribute('aria-label', S.saveMemoryKind)
    for (const k of MEMORY_KINDS) {
      const o = el('option', k)
      o.value = k
      o.selected = k === 'note'
      kind.append(o)
    }
    const submit = el('button', S.saveMemorySubmit, 'btn small primary msg-save-submit')
    submit.type = 'submit'
    const cancel = textButton(S.saveMemoryCancel, 'small', () => close(), undefined)
    const close = (): void => {
      f.remove()
      openBtn.hidden = false
    }
    f.append(title, kind, submit, cancel)
    f.addEventListener('submit', (e) => {
      e.preventDefault()
      if (!title.value.trim()) return
      this.saveMemory.emit(sessionId, m.id, { title: title.value, kind: kind.value as MemoryKind })
      close()
    })
    return f
  }
}
