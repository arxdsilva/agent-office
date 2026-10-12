// The full-window card shown when the 3D view can't start (low-spec plan §2.4, J9). It offers to
// turn hardware acceleration off: main relaunches the app when that setting changes.
import { GFX_COPY } from '../../app/graphics-copy.ts'
import type { OfficeGateway } from '../../ports.ts'
import { byId } from './el.ts'

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
  card.hidden = false
  btn.focus()
}
