// Night City dialogs, created here (no index.html edits): the settings panel `#special-settings`
// (camera, atmosphere, rain, reduced motion, audio + mute; writes `settings.special`), the first-
// time intro `#special-intro`. Text through textContent only.
import type { SpecialSettings } from '@agent-office/shared'
import { el } from '../../../adapters/dom/el.ts'
import { SPECIAL_COPY } from '../../../app/special/copy.ts'

export class SpecialSettingsPanel {
  readonly dialog = el('dialog', undefined, 'nc-dialog nc-card')
  private fields = new Map<string, HTMLInputElement | HTMLSelectElement>()
  onChange: (patch: Partial<SpecialSettings>) => void = () => {}
  private current: SpecialSettings | null = null

  constructor(parent: HTMLElement) {
    this.dialog.id = 'special-settings'
    this.dialog.setAttribute('aria-labelledby', 'special-settings-title')
    const h = el('h2', SPECIAL_COPY.settings.title)
    h.id = 'special-settings-title'
    const form = el('form')
    form.method = 'dialog'
    const select = (name: string, label: string, options: [string, string][]) => {
      const l = el('label', undefined, 'nc-field')
      const s = el('select')
      s.name = name
      for (const [v, t] of options) {
        const o = el('option', t)
        o.value = v
        s.append(o)
      }
      l.append(el('span', label), s)
      this.fields.set(name, s)
      return l
    }
    const check = (name: string, label: string) => {
      const l = el('label', undefined, 'nc-field nc-check')
      const i = el('input')
      i.type = 'checkbox'
      i.name = name
      l.append(i, el('span', label))
      this.fields.set(name, i)
      return l
    }
    const range = (name: string, label: string) => {
      const l = el('label', undefined, 'nc-field')
      const i = el('input')
      i.type = 'range'
      i.min = '0'
      i.max = '1'
      i.step = '0.05'
      i.name = name
      l.append(el('span', label), i)
      this.fields.set(name, i)
      return l
    }
    const C = SPECIAL_COPY.settings
    const audio = el('fieldset', undefined, 'nc-audio')
    audio.append(
      el('legend', C.audio),
      range('master', C.master),
      range('effects', C.effects),
      range('ambient', C.ambient),
      check('muted', C.mute),
    )
    const close = el('button', C.close, 'nc-btn')
    close.value = 'close'
    close.dataset.action = 'close'
    form.append(
      select('camera', C.camera, [
        ['third', SPECIAL_COPY.camera.third],
        ['first', SPECIAL_COPY.camera.first],
        ['overview', SPECIAL_COPY.camera.overview],
      ]),
      select('atmosphere', C.atmosphere, [
        ['low', C.atmosphereLevels.low],
        ['medium', C.atmosphereLevels.medium],
        ['high', C.atmosphereLevels.high],
      ]),
      check('rain', C.rain),
      check('reducedMotion', C.reducedMotion),
      audio,
      close,
    )
    form.addEventListener('change', () => this.emit())
    this.dialog.addEventListener('keydown', (e) => e.stopPropagation())
    this.dialog.append(h, form)
    parent.append(this.dialog)
  }

  private emit(): void {
    if (!this.current) return
    const v = (n: string) => this.fields.get(n)!
    const num = (n: string) => Number((v(n) as HTMLInputElement).value)
    const on = (n: string) => (v(n) as HTMLInputElement).checked
    this.onChange({
      camera: v('camera').value as SpecialSettings['camera'],
      atmosphere: v('atmosphere').value as SpecialSettings['atmosphere'],
      rain: on('rain'),
      reducedMotion: on('reducedMotion'),
      audio: {
        master: num('master'),
        effects: num('effects'),
        ambient: num('ambient'),
        muted: on('muted'),
      },
    })
  }

  render(s: SpecialSettings): void {
    this.current = s
    const set = (n: string, value: string | boolean) => {
      const f = this.fields.get(n)!
      if (typeof value === 'boolean') (f as HTMLInputElement).checked = value
      else f.value = value
    }
    set('camera', s.camera)
    set('atmosphere', s.atmosphere)
    set('rain', s.rain)
    set('reducedMotion', s.reducedMotion)
    set('master', String(s.audio.master))
    set('effects', String(s.audio.effects))
    set('ambient', String(s.audio.ambient))
    set('muted', s.audio.muted)
  }

  open(): void {
    if (!this.dialog.open) this.dialog.show()
  }

  close(): void {
    if (this.dialog.open) this.dialog.close()
  }

  get isOpen(): boolean {
    return this.dialog.open
  }

  dispose(): void {
    this.close()
    this.dialog.remove()
  }
}

/** The first-time explanation (`special.introSeen`). */
export class SpecialIntro {
  readonly dialog = el('dialog', undefined, 'nc-dialog nc-card nc-intro')
  onContinue: () => void = () => {}
  onBack: () => void = () => {}

  constructor(parent: HTMLElement) {
    this.dialog.id = 'special-intro'
    this.dialog.setAttribute('aria-labelledby', 'special-intro-title')
    const h = el('h2', SPECIAL_COPY.intro.title)
    h.id = 'special-intro-title'
    const go = el('button', SPECIAL_COPY.intro.continue, 'nc-btn nc-primary')
    go.type = 'button'
    go.dataset.action = 'continue'
    const back = el('button', SPECIAL_COPY.intro.back, 'nc-btn')
    back.type = 'button'
    back.dataset.action = 'back'
    go.addEventListener('click', () => (this.dialog.close(), this.onContinue()))
    back.addEventListener('click', () => (this.dialog.close(), this.onBack()))
    const row = el('div', undefined, 'nc-actions')
    row.append(back, go)
    this.dialog.append(h, el('p', SPECIAL_COPY.intro.body), row)
    this.dialog.addEventListener('keydown', (e) => e.stopPropagation())
    parent.append(this.dialog)
  }

  open(): void {
    if (!this.dialog.open) this.dialog.showModal()
  }

  get isOpen(): boolean {
    return this.dialog.open
  }

  dispose(): void {
    if (this.dialog.open) this.dialog.close()
    this.dialog.remove()
  }
}
