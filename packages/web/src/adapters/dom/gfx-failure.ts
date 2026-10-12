// The full-window card shown when the 3D view can't start (low-spec plan §2.4, J9). It offers to
// turn hardware acceleration off: main relaunches the app when that setting changes.
import { GFX_COPY } from '../../app/graphics-copy.ts'
import { PIXEL_COPY } from '../../app/pixel-copy.ts'
import type { OfficeGateway } from '../../ports.ts'
import { byId, el } from './el.ts'

const F = GFX_COPY.failure

/** Replaces the stage and the loading screen with the failure card. */
export function showGfxFailure(gateway: OfficeGateway | null, error: unknown): void {
  byId('loading').hidden = true
  byId('stage').hidden = true
  const card = byId('gfx-failure')
  byId('gfx-f-title').textContent = F.title
  byId('gfx-f-body').textContent = F.body
  const details = byId('gfx-f-details')
  details.querySelector('summary')!.textContent = F.details
  byId('gfx-f-error').textContent = error instanceof Error ? error.message : String(error)

  const btn = byId<HTMLButtonElement>('gfx-f-software')
  btn.textContent = F.software
  btn.hidden = !gateway
  const status = byId('gfx-f-status')
  btn.onclick = async () => {
    if (!gateway) return
    btn.disabled = true
    status.textContent = ''
    try {
      await gateway.settings.set({ hardwareAcceleration: false })
    } catch (e) {
      btn.disabled = false
      status.textContent = e instanceof Error ? e.message : String(e)
    }
  }
  pixelButton(gateway, btn, status)
  card.hidden = false
  btn.focus()
}

/**
 * "Switch to 2D RPG" (2D plan §15): the Canvas2D view needs no WebGL. Saves `viewMode: 'pixel'`
 * and reloads the renderer, which then starts in 2D. Added next to the software-rendering button.
 */
function pixelButton(
  gateway: OfficeGateway | null,
  next: HTMLButtonElement,
  status: HTMLElement,
): void {
  let b = document.getElementById('gfx-f-pixel') as HTMLButtonElement | null
  if (!b) {
    b = el('button', PIXEL_COPY.noWebgl, 'btn')
    b.id = 'gfx-f-pixel'
    b.type = 'button'
    next.after(' ', b)
  }
  b.hidden = !gateway
  const button = b
  button.onclick = async () => {
    if (!gateway) return
    button.disabled = true
    status.textContent = ''
    try {
      await gateway.settings.set({ viewMode: 'pixel' })
      location.reload()
    } catch (e) {
      button.disabled = false
      status.textContent = e instanceof Error ? e.message : String(e)
    }
  }
}
