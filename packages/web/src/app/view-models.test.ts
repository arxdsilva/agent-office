import { DEFAULT_SETTINGS, type Agent, type ChatMessage } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { applyMessage, emptyState } from './state.ts'
import { activityLabel, hudVM, panelVM, settingsVM } from './view-models.ts'

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'a',
  name: 'Ada',
  provider: 'claude-code',
  topic: 'Refactor auth',
  model: 'claude-opus-5-5',
  kind: 'main',
  status: 'tool',
  tool: 'Bash',
  text: 'npm test',
  source: 'claude-code',
  since: 0,
  lastSeen: 50_000,
  interactive: true,
  unread: 0,
  ...over,
})
const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: 'm',
  agentId: 'a',
  from: 'user',
  text: 'hi',
  ts: 1,
  state: 'queued',
  ...over,
})
const stateWith = (agents: Agent[], messages: ChatMessage[] = []) =>
  applyMessage(emptyState(), { type: 'snapshot', agents, messages })

describe('panelVM', () => {
  it('describes the agent, its activity and thread', () => {
    const s = stateWith(
      [agent()],
      [
        msg({ id: 'm1', state: 'replied' }),
        msg({ id: 'm2', from: 'agent', text: 'done', state: 'replied' }),
      ],
    )
    const vm = panelVM(s, 'a', 60_000)!
    expect(vm).toMatchObject({
      id: 'a',
      present: true,
      name: 'Ada',
      subtitle: 'main · claude-code · claude-opus-5-5',
    })
    expect(vm.meta).toEqual([
      ['Topic', 'Refactor auth'],
      ['Status', 'tool (Bash)'],
      ['Activity', 'npm test'],
      ['Active', 'for 1m'],
      ['Last seen', '10s ago'],
    ])
    expect(vm.thread).toEqual([
      { id: 'm1', from: 'user', text: 'hi', stateLabel: '✓✓ replied' },
      { id: 'm2', from: 'agent', text: 'done' },
    ])
  })

  it('links the parent and handles agents that left', () => {
    const s = stateWith([agent({ id: 'p', name: 'Parent' }), agent({ id: 'c', parentId: 'p' })])
    expect(panelVM(s, 'c', 0)!.parent).toEqual({ id: 'p', name: 'Parent' })
    expect(panelVM(s, 'gone', 0)).toMatchObject({
      present: false,
      name: 'This agent has left the office',
    })
  })

  it('explains message delivery, offering the hook install for unconnected Claude Code sessions', () => {
    expect(panelVM(stateWith([agent({ interactive: false })]), 'a', 0)!.hint).toEqual({
      text: 'Not connected: this session cannot read messages until the Claude Code hook is installed.',
      action: 'install-hook',
    })
    expect(panelVM(stateWith([agent({ status: 'waiting' })]), 'a', 0)!.hint?.text).toMatch(
      /next prompt/,
    )
    expect(panelVM(stateWith([agent()]), 'a', 0)!.hint?.text).toMatch(/current turn ends/)
    expect(
      panelVM(stateWith([agent({ provider: 'langgraph', interactive: false })]), 'a', 0)!.hint
        ?.text,
    ).toMatch(/Inbox API/)
    expect(panelVM(stateWith([agent({ provider: 'langgraph' })]), 'a', 0)!.hint).toBeNull()
  })
})

describe('activityLabel', () => {
  it('says where the agent is and what it is doing', () => {
    expect(activityLabel('arriving')).toBe('Arriving')
    expect(activityLabel('leaving')).toBe('Leaving')
    expect(activityLabel('kitchen')).toBe('Getting coffee')
    expect(activityLabel('lounge')).toBe('Relaxing in the lounge')
    expect(activityLabel('cafe')).toBe('Taking a break at the cafe')
    expect(activityLabel('pingpong')).toBe('Playing ping-pong')
    expect(activityLabel('desk-work')).toBe('Working at their desk')
    expect(activityLabel('desk-think')).toBe('Thinking at their desk')
    expect(activityLabel('desk-error')).toBe('Stuck on an error at their desk')
    expect(activityLabel('desk-idle')).toBe('Idle at their desk')
    expect(activityLabel('desk-work', { room: 'pod-3' })).toBe('Working at their desk in pod 3')
  })

  it('names meeting rooms and booths, and counts the team', () => {
    expect(activityLabel('meeting', { room: 'meeting-A', subagents: 2 })).toBe(
      'In meeting room A with 2 subagents',
    )
    expect(activityLabel('meeting', { room: 'meeting-B', subagents: 1 })).toBe(
      'In meeting room B with 1 subagent',
    )
    expect(activityLabel('meeting', { room: 'meeting-A', with: 'Ada' })).toBe(
      "In meeting room A with Ada's team",
    )
    expect(activityLabel('meeting')).toBe('In a meeting')
    expect(activityLabel('booth', { room: 'booth-3' })).toBe('Waiting for you in booth 3')
    expect(activityLabel('booth')).toBe('Waiting for you in a phone booth')
  })
})

describe('panelVM activity', () => {
  it('adds an activity line only when the director knows the activity', () => {
    const s = stateWith([agent()])
    expect(panelVM(s, 'a', 0).activity).toBeUndefined()
    const vm = panelVM(s, 'a', 0, { activity: 'booth', room: 'booth-3' })
    expect(vm.activity).toBe('Waiting for you in booth 3')
    expect(vm.meta[2]).toEqual(['Now', 'Waiting for you in booth 3'])
    expect(panelVM(s, 'gone', 0, { activity: 'leaving' }).activity).toBeUndefined()
  })
})

describe('hudVM', () => {
  it('counts agents per status', () => {
    const vm = hudVM(
      stateWith([
        agent(),
        agent({ id: 'b', status: 'waiting' }),
        agent({ id: 'c', status: 'tool' }),
      ]),
    )
    expect(vm.count).toBe('3 agents')
    expect(vm.statuses.find((s) => s.status === 'tool')).toMatchObject({
      count: 2,
      color: '#f5a524',
    })
    expect(hudVM(stateWith([agent()])).count).toBe('1 agent')
  })
})

describe('settingsVM', () => {
  const base = {
    settings: DEFAULT_SETTINGS,
    hook: 'not-installed' as const,
    version: '1.0.0',
    update: { policy: 'auto' as const, status: 'idle' as const },
  }

  it('offers the right hook action', () => {
    expect(settingsVM(base).hook).toEqual({ label: 'Not installed', action: 'install' })
    expect(settingsVM({ ...base, hook: 'installed' }).hook).toEqual({
      label: 'Installed ✓',
      action: 'uninstall',
    })
    expect(settingsVM({ ...base, hook: 'outdated' }).hook).toEqual({
      label: 'Needs repair (app moved or updated)',
      action: 'install',
    })
  })

  it('describes update state and action per policy', () => {
    expect(settingsVM(base).update).toEqual({ label: 'Not checked yet', action: 'check' })
    expect(
      settingsVM({ ...base, update: { policy: 'auto', status: 'ready', version: '2.0.0' } }).update,
    ).toEqual({
      label: 'Version 2.0.0 is ready',
      action: 'install',
    })
    expect(
      settingsVM({
        ...base,
        update: { policy: 'notify-only', status: 'available', version: '2.0.0', url: 'https://x' },
      }).update,
    ).toEqual({
      label: 'Version 2.0.0 is available',
      action: 'download',
      url: 'https://x',
    })
    expect(settingsVM({ ...base, update: { policy: 'off', status: 'idle' } }).update).toEqual({
      label: 'Updates are off in development builds',
      action: null,
    })
    expect(
      settingsVM({ ...base, update: { policy: 'auto', status: 'error', error: 'offline' } }).update
        .label,
    ).toBe('Update check failed: offline')
    expect(
      settingsVM({ ...base, update: { policy: 'auto', status: 'up-to-date' } }).update.label,
    ).toBe('Up to date')
    expect(settingsVM({ ...base, update: { policy: 'auto', status: 'checking' } }).update).toEqual({
      label: 'Checking…',
      action: null,
    })
    expect(
      settingsVM({ ...base, update: { policy: 'auto', status: 'downloading', version: '2' } })
        .update.action,
    ).toBeNull()
  })

  it('passes settings and version through', () => {
    expect(settingsVM(base)).toMatchObject({
      port: 4317,
      notifications: true,
      launchAtLogin: false,
      claudeAdapter: true,
      autoUpdate: true,
      version: 'v1.0.0',
      graphicsQuality: 'auto',
    })
    expect(
      settingsVM({ ...base, settings: { ...DEFAULT_SETTINGS, graphicsQuality: 'ultra' } })
        .graphicsQuality,
    ).toBe('ultra')
  })
})
