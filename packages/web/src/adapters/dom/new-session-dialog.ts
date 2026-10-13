import { PERMISSION_MODES, type PermissionMode, type ProviderId } from '@agent-office/shared'
import { SESSION_COPY } from '../../app/session-copy.ts'
import type { NewSessionVM, UseMenuVM } from '../../app/session-types.ts'
import type { NewSessionView } from '../../ports.ts'
import { byId, el } from './el.ts'
import { openMenu } from './menu.ts'
import {
  contextMenuGroups,
  renderComposerChips,
  useMenuGroups,
  useMenuSearchable,
} from './panel.ts'

type Patch = Parameters<Parameters<NewSessionView['onChange']>[0]>[0]

/** NewSessionView port → `<dialog id="new-session">` (plan §2.4). */
export class DomNewSession implements NewSessionView {
  private dialog = byId<HTMLDialogElement>('new-session')
  private name = byId<HTMLInputElement>('ns-name')
  private provider = byId<HTMLSelectElement>('ns-provider')
  private project = byId<HTMLSelectElement>('ns-project')
  private projectKey = ''
  private model = byId<HTMLSelectElement>('ns-model')
  private mode = byId<HTMLSelectElement>('ns-mode')
  private chrome = byId<HTMLInputElement>('ns-chrome')
  private text = byId<HTMLTextAreaElement>('ns-text')
  private start = byId<HTMLButtonElement>('ns-start')
  private ctxBtn = byId<HTMLButtonElement>('ns-add-context')
  private useBtn = byId<HTMLButtonElement>('ns-use')
  private optionsKey = ''
  private providerKey = ''
  private folderFn: () => void | Promise<void> = () => {}
  private extraFn: () => void | Promise<void> = () => {}
  private removeExtraFn: (key: string) => void = () => {}
  private pickFn: (kind: 'files' | 'folder') => void | Promise<void> = () => {}
  private removeChipFn: (key: string) => void = () => {}
  private openUseFn: () => UseMenuVM = () => ({ groups: [] })
  private toggleUseFn: (id: string) => void = () => {}
  private changeFn: (patch: Patch) => void = () => {}
  private startFn: () => void | Promise<void> = () => {}
  private closeFn: () => void = () => {}

  constructor() {
    const c = SESSION_COPY.newSession
    const text: [string, string][] = [
      ['ns-title', c.title],
      ['ns-folder-l', c.folder],
      ['ns-choose', c.choose],
      ['ns-name-l', c.name],
      ['ns-provider-l', 'Provider'],
      ['ns-project-l', c.project],
      ['ns-model-l', c.model],
      ['ns-mode-l', c.mode],
      ['ns-extra-l', c.extra],
      ['ns-add-extra', c.addFolder],
      ['ns-chrome-l', c.chrome],
      ['ns-text-l', c.first],
      ['ns-cancel', c.cancel],
      ['ns-start', c.start],
      ['ns-footer', c.footer],
      ['ns-add-context', `${SESSION_COPY.composer.addContext} ▾`],
      ['ns-use', `${SESSION_COPY.composer.use} ▾`],
    ]
    for (const [id, t] of text) byId(id).textContent = t
    // Keyboard input in the dialog must not reach the scene.
    this.dialog.addEventListener('keydown', (e) => e.stopPropagation())
    this.dialog.addEventListener('close', () => this.closeFn())
    byId('ns-close').addEventListener('click', () => this.close())
    byId('ns-cancel').addEventListener('click', () => this.close())
    byId('ns-choose').addEventListener('click', () => void this.folderFn())
    byId('ns-add-extra').addEventListener('click', () => void this.extraFn())
    byId('ns-form').addEventListener('submit', (e) => {
      e.preventDefault()
      if (!this.start.disabled) void this.startFn()
    })
    this.name.addEventListener('input', () => this.changeFn({ name: this.name.value }))
    this.text.addEventListener('input', () => this.changeFn({ text: this.text.value }))
    this.model.addEventListener('change', () => this.changeFn({ model: this.model.value }))
    this.mode.addEventListener('change', () => {
      const m = this.mode.value as PermissionMode
      if (PERMISSION_MODES.includes(m)) this.changeFn({ mode: m })
      else this.changeFn({ modeId: this.mode.value })
    })
    this.project.addEventListener('change', () => this.changeFn({ projectId: this.project.value }))
    this.provider.addEventListener('change', () =>
      this.changeFn({ provider: this.provider.value as ProviderId }),
    )
    this.chrome.addEventListener('change', () => this.changeFn({ chrome: this.chrome.checked }))
    this.ctxBtn.addEventListener('click', () =>
      openMenu(this.ctxBtn, contextMenuGroups(), (k) => void this.pickFn(k as 'files' | 'folder')),
    )
    this.useBtn.addEventListener('click', () => {
      const vm = this.openUseFn()
      openMenu(this.useBtn, useMenuGroups(vm), (id) => this.toggleUseFn(id), {
        role: 'menuitemcheckbox',
        searchable: useMenuSearchable(vm),
      })
    })
  }

  onPickFolder(fn: () => void | Promise<void>) {
    this.folderFn = fn
  }
  onAddExtraFolder(fn: () => void | Promise<void>) {
    this.extraFn = fn
  }
  onRemoveExtraFolder(fn: (key: string) => void) {
    this.removeExtraFn = fn
  }
  onPickContext(fn: (kind: 'files' | 'folder') => void | Promise<void>) {
    this.pickFn = fn
  }
  onRemoveChip(fn: (key: string) => void) {
    this.removeChipFn = fn
  }
  onOpenUse(fn: () => UseMenuVM) {
    this.openUseFn = fn
  }
  onToggleUse(fn: (id: string) => void) {
    this.toggleUseFn = fn
  }
  onChange(fn: (patch: Patch) => void) {
    this.changeFn = fn
  }
  onStart(fn: () => void | Promise<void>) {
    this.startFn = fn
  }
  onClose(fn: () => void) {
    this.closeFn = fn
  }

  isOpen(): boolean {
    return this.dialog.open
  }

  open(vm: NewSessionVM): void {
    this.optionsKey = ''
    this.name.value = vm.name
    this.text.value = vm.text
    this.render(vm)
    if (!this.dialog.open) this.dialog.showModal()
    byId<HTMLButtonElement>('ns-choose').focus()
  }

  close(): void {
    if (this.dialog.open) this.dialog.close()
  }

  render(vm: NewSessionVM): void {
    const folder = byId('ns-folder')
    folder.textContent = vm.folder?.hint ?? '—'
    folder.title = vm.folder?.hint ?? ''
    if (document.activeElement !== this.name && this.name.value !== vm.name)
      this.name.value = vm.name
    this.name.placeholder = vm.namePlaceholder
    if (document.activeElement !== this.text && this.text.value !== vm.text)
      this.text.value = vm.text

    const pkey = JSON.stringify(vm.providers)
    if (pkey !== this.providerKey) {
      this.providerKey = pkey
      this.provider.replaceChildren(
        ...vm.providers.map((p) => {
          const o = el('option', p.label)
          o.value = p.id
          o.selected = p.selected
          return o
        }),
      )
    }
    const projects = vm.projects ?? []
    const prkey = JSON.stringify(projects)
    if (prkey !== this.projectKey) {
      this.projectKey = prkey
      this.project.replaceChildren(
        ...projects.map((p) => {
          const o = el('option', p.label)
          o.value = p.id
          o.selected = p.selected
          return o
        }),
      )
    }
    this.project.hidden = projects.length === 0
    byId('ns-project-l').hidden = projects.length === 0
    byId('ns-title').textContent = vm.title
    const multi = vm.providers.length > 1
    this.provider.hidden = !multi
    byId('ns-provider-l').hidden = !multi

    const key = JSON.stringify([vm.models, vm.modes])
    if (key !== this.optionsKey) {
      this.optionsKey = key
      this.model.replaceChildren(
        ...vm.models.map((m) => {
          const o = el('option', m.label)
          o.value = m.id
          o.selected = m.selected
          if (m.description) o.title = m.description
          return o
        }),
      )
      this.mode.replaceChildren(
        ...vm.modes.map((m) => {
          const o = el('option', `${m.dangerous ? '⚠ ' : ''}${m.icon} ${m.label}`)
          o.value = m.id
          o.disabled = !!m.disabled
          o.selected = m.checked
          o.title = m.desc
          return o
        }),
      )
    }
    this.chrome.checked = vm.chrome.checked
    byId('ns-chrome-row').hidden = !vm.chrome.available

    renderComposerChips(
      byId('ns-extra'),
      vm.extraFolders.map((f) => ({ kind: 'folder', ...f })),
      (k) => this.removeExtraFn(k),
      vm.starting,
    )
    byId('ns-extra').hidden = false
    renderComposerChips(
      byId('ns-chips'),
      vm.composer.chips,
      (k) => this.removeChipFn(k),
      vm.starting,
    )
    this.ctxBtn.hidden = !vm.attachAvailable
    this.ctxBtn.disabled = !vm.composer.canAddContext
    this.useBtn.disabled = !vm.composer.canAddUse
    this.text.placeholder = vm.composer.placeholder

    const s = SESSION_COPY.newSession
    this.start.disabled = !vm.canStart
    this.start.textContent = vm.starting ? s.starting : s.start
    byId('ns-error').textContent = vm.error ?? vm.limit ?? ''
  }
}
