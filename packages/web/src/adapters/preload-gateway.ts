import type { OfficeGateway } from '../ports.ts'

/** The bridge the preload script exposes on window (see packages/desktop/src/preload). */
export function preloadGateway(win: { agentOffice?: OfficeGateway } = window as never): OfficeGateway {
  if (!win.agentOffice) throw new Error('agent-office must run inside the desktop app (preload bridge missing)')
  return win.agentOffice
}
