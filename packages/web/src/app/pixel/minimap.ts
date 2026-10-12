// Minimap (plan §9): one pixel per tile, agents as dots in status colours, the player marker.
import { STATUS_COLORS, type AgentStatus } from '@agent-office/shared'
import type { Vec2 } from '../office-types.ts'
import { toTile, type Projection } from './project.ts'
import type { MinimapVM } from './types.ts'

export function minimapVM(
  proj: Projection,
  agents: readonly { id: string; pos: Vec2; status: AgentStatus }[],
  player?: Vec2,
): MinimapVM {
  const vm: MinimapVM = {
    widthTiles: proj.widthTiles,
    heightTiles: proj.heightTiles,
    dots: [...agents]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((a) => ({ id: a.id, ...toTile(a.pos, proj), color: STATUS_COLORS[a.status] })),
  }
  if (player) vm.player = toTile(player, proj)
  return vm
}
