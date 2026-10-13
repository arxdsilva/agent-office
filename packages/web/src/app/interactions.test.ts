// The semantic interaction registry (docs/special-3d/interaction-contract.md): one hit kind → one
// existing command (workspace action, dialogue, or panel), the same in every view mode.
import { describe, expect, it } from 'vitest'
import { INTERACTION_KINDS, type InteractionHit } from './office-types.ts'
import { interactionAction, interactionPrompt, parseInteractAnchor } from './interactions.ts'

const hit = (
  kind: InteractionHit['kind'],
  extra: Partial<InteractionHit> = {},
): InteractionHit => ({
  kind,
  anchor: `interact:${kind}:0`,
  ...extra,
})

describe('interactionAction', () => {
  it('maps the Project Directory to the directory dialogue (same as the 2D reception desk)', () => {
    expect(interactionAction(hit('project-directory'), { projectId: null })).toEqual({
      kind: 'dialogue',
      target: { kind: 'object', object: 'project-directory' },
    })
  })

  it('maps the command display to the selected project dashboard, else the overview', () => {
    expect(interactionAction(hit('command-display'), { projectId: 'p1' })).toEqual({
      kind: 'workspace',
      action: { type: 'open-project', projectId: 'p1' },
    })
    expect(interactionAction(hit('command-display'), { projectId: null })).toEqual({
      kind: 'workspace',
      action: { type: 'open-overview' },
    })
  })

  it('maps project terminals to memory, context, sessions and handoffs of the selected project', () => {
    const ctx = { projectId: 'p1' }
    expect(interactionAction(hit('memory-terminal'), ctx)).toEqual({
      kind: 'workspace',
      action: { type: 'open-memory', projectId: 'p1' },
    })
    expect(interactionAction(hit('context-console', { agentId: 'a1' }), ctx)).toEqual({
      kind: 'workspace',
      action: { type: 'inspect-context', projectId: 'p1', agentId: 'a1' },
    })
    expect(interactionAction(hit('archive-terminal'), ctx)).toEqual({
      kind: 'workspace',
      action: { type: 'open-sessions', projectId: 'p1' },
    })
    expect(interactionAction(hit('handoff-platform'), ctx)).toEqual({
      kind: 'workspace',
      action: { type: 'prepare-handoff', projectId: 'p1' },
    })
  })

  it('without a project, terminals open the global views and the handoff opens the sessions', () => {
    const ctx = { projectId: null }
    expect(interactionAction(hit('memory-terminal'), ctx)).toEqual({
      kind: 'workspace',
      action: { type: 'open-memory' },
    })
    expect(interactionAction(hit('context-console'), ctx)).toEqual({
      kind: 'workspace',
      action: { type: 'inspect-context' },
    })
    expect(interactionAction(hit('handoff-platform'), ctx)).toEqual({
      kind: 'workspace',
      action: { type: 'open-sessions' },
    })
  })

  it('maps a workstation to its agent panel, a station to its capability and a terminal to Connect', () => {
    expect(
      interactionAction(hit('agent-workstation', { agentId: 'a1' }), { projectId: null }),
    ).toEqual({ kind: 'panel', panel: 'agent', id: 'a1' })
    expect(interactionAction(hit('agent-workstation'), { projectId: null })).toBeNull()
    expect(
      interactionAction(hit('capability-station', { provider: 'claude-code', capability: 'web' }), {
        projectId: null,
      }),
    ).toEqual({ kind: 'panel', panel: 'capability', id: 'web', provider: 'claude-code' })
    expect(interactionAction(hit('capability-station'), { projectId: null })).toBeNull()
    expect(
      interactionAction(hit('provider-terminal', { provider: 'codex' }), { projectId: null }),
    ).toEqual({ kind: 'panel', panel: 'connect', provider: 'codex' })
    expect(interactionAction(hit('provider-terminal'), { projectId: null })).toEqual({
      kind: 'panel',
      panel: 'connect',
    })
  })

  it('has a command and a prompt for every kind (exhaustive)', () => {
    for (const kind of INTERACTION_KINDS) {
      const full = hit(kind, { agentId: 'a', provider: 'p', capability: 'c' })
      expect(interactionAction(full, { projectId: 'p1' })).not.toBeNull()
      expect(interactionPrompt(kind)).toMatch(/^E: /)
    }
  })
})

describe('parseInteractAnchor', () => {
  it('reads interact:<kind>:<n>, with or without a placement prefix', () => {
    expect(parseInteractAnchor('interact:memory-terminal:2')).toEqual({
      kind: 'memory-terminal',
      n: 2,
    })
    expect(parseInteractAnchor('hq-atrium/interact:project-directory:0')).toEqual({
      kind: 'project-directory',
      n: 0,
    })
  })

  it('rejects other anchors and unknown kinds', () => {
    expect(parseInteractAnchor('seat:desk:1:0')).toBeNull()
    expect(parseInteractAnchor('interact:coffee:0')).toBeNull()
    expect(parseInteractAnchor('interact:memory-terminal:x')).toBeNull()
  })
})
