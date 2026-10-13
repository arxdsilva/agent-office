// The Night City failure card (`#special-failure`): shown when the mode can't start (no WebGL 2,
// the lazy chunk failed, `?forceSpecialFail=1`). Offers Classic 3D and 2D RPG; sessions and agents
// are untouched. Diagnostics are safe: the error's first line without paths or URLs. Statically
// imported by main.ts (tiny, DOM only) so it works even when the Night City chunk can't load.
import type { ViewMode } from '@agent-office/shared'
import { el } from '../adapters/dom/el.ts'
import { SPECIAL_COPY } from '../app/special/copy.ts'

/** The error's first line, with paths and URLs removed, at most 120 characters. */
export function safeDiagnostic(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  return raw
    .split('\n')[0]!
    .replace(/[a-z]+:\/\/\S+/gi, '…')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s:]+/g, '…')
    .slice(0, 120)
}

/** Shows (or refreshes) the card; `pick` switches the view mode (settings). */
export function showSpecialFailure(err: unknown, pick: (mode: ViewMode) => void): HTMLElement {
  document.getElementById('special-failure')?.remove()
  const card = el('section', undefined, 'nc-card nc-failure')
  card.id = 'special-failure'
  card.setAttribute('role', 'alertdialog')
  card.setAttribute('aria-labelledby', 'special-failure-title')
  const h = el('h2', SPECIAL_COPY.failure.title)
  h.id = 'special-failure-title'
  const row = el('div', undefined, 'nc-actions')
  for (const [mode, label] of [
    ['3d', SPECIAL_COPY.failure.classic],
    ['pixel', SPECIAL_COPY.failure.rpg],
  ] as const) {
    const b = el('button', label, mode === '3d' ? 'nc-btn nc-primary' : 'nc-btn')
    b.type = 'button'
    b.dataset.mode = mode
    b.addEventListener('click', () => {
      card.remove()
      pick(mode)
    })
    row.append(b)
  }
  const diag = el('p', safeDiagnostic(err), 'nc-muted nc-diag')
  card.append(h, el('p', SPECIAL_COPY.failure.body), row, diag)
  document.body.append(card)
  return card
}

/**
 * Test seam: `?forceSpecialFail=1`; with `?debug=1` also `window.__aoForceSpecialFail = true` or
 * localStorage `ao.forceSpecialFail=1`.
 */
export function forcedSpecialFailure(): boolean {
  const q = new URLSearchParams(location.search)
  if (q.get('forceSpecialFail') === '1') return true
  if (q.get('debug') !== '1') return false
  if ((window as unknown as { __aoForceSpecialFail?: boolean }).__aoForceSpecialFail === true)
    return true
  try {
    return localStorage.getItem('ao.forceSpecialFail') === '1'
  } catch {
    return false
  }
}
