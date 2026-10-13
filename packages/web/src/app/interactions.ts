// The semantic interaction registry, shared by every view mode (docs/special-3d/interaction-contract
// .md): a hit on a world object (E within reach, or a click on its proxy) maps to one existing
// command. Pure: no business logic here, only which existing action the object stands for.
import { INTERACTION_KINDS, type InteractionHit, type InteractionKind } from './office-types.ts'
import type { InteractTarget } from './pixel/types.ts'
import type { WorkspaceAction } from './workspace/types.ts'

/** What the controller does for a hit: a workspace command, the dialogue box, or a side panel. */
export type InteractionCommand =
  | { kind: 'workspace'; action: WorkspaceAction }
  | { kind: 'dialogue'; target: InteractTarget }
  | { kind: 'panel'; panel: 'agent' | 'connect' | 'capability'; id?: string; provider?: string }

export interface InteractionContext {
  /** The selected project (the workspace's), or null for "All projects". */
  projectId: string | null
}

const project = (ctx: InteractionContext) => (ctx.projectId ? { projectId: ctx.projectId } : {})

/** The command for a hit; null when the object carries nothing to act on (an empty workstation). */
export function interactionAction(
  hit: InteractionHit,
  ctx: InteractionContext,
): InteractionCommand | null {
  switch (hit.kind) {
    case 'project-directory':
      return { kind: 'dialogue', target: { kind: 'object', object: 'project-directory' } }
    case 'command-display':
      return {
        kind: 'workspace',
        action: ctx.projectId
          ? { type: 'open-project', projectId: ctx.projectId }
          : { type: 'open-overview' },
      }
    case 'memory-terminal':
      return { kind: 'workspace', action: { type: 'open-memory', ...project(ctx) } }
    case 'context-console':
      return {
        kind: 'workspace',
        action: {
          type: 'inspect-context',
          ...project(ctx),
          ...(hit.agentId && { agentId: hit.agentId }),
        },
      }
    case 'archive-terminal':
      return { kind: 'workspace', action: { type: 'open-sessions', ...project(ctx) } }
    case 'handoff-platform':
      return {
        kind: 'workspace',
        action: ctx.projectId
          ? { type: 'prepare-handoff', projectId: ctx.projectId }
          : { type: 'open-sessions' },
      }
    case 'agent-workstation':
      return hit.agentId ? { kind: 'panel', panel: 'agent', id: hit.agentId } : null
    case 'capability-station':
      return hit.capability && hit.provider
        ? { kind: 'panel', panel: 'capability', id: hit.capability, provider: hit.provider }
        : null
    case 'provider-terminal':
      return { kind: 'panel', panel: 'connect', ...(hit.provider && { provider: hit.provider }) }
  }
}

const PROMPTS: Readonly<Record<InteractionKind, string>> = {
  'project-directory': 'E: Open Project Directory',
  'agent-workstation': 'E: Agent details',
  'command-display': 'E: Open Project Dashboard',
  'memory-terminal': 'E: Open Memory Vault',
  'context-console': 'E: Inspect context',
  'archive-terminal': 'E: Open Session Archive',
  'handoff-platform': 'E: Prepare a handoff',
  'capability-station': 'E: Open capability',
  'provider-terminal': 'E: Connect providers',
}

/** The HUD prompt shown while an object is within reach. */
export const interactionPrompt = (kind: InteractionKind): string => PROMPTS[kind]

const KINDS: ReadonlySet<string> = new Set(INTERACTION_KINDS)
const INTERACT = /(?:^|\/)interact:([a-z-]+):(\d+)$/

/** `interact:<kind>:<n>` (optionally `<placement>/…`) → kind and index; null otherwise. */
export function parseInteractAnchor(id: string): { kind: InteractionKind; n: number } | null {
  const m = INTERACT.exec(id)
  if (!m || !KINDS.has(m[1]!)) return null
  return { kind: m[1] as InteractionKind, n: Number(m[2]) }
}
