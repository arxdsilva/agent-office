// Pure view models: everything the DOM adapters show, computed from state. No DOM here.
import {
  AGENT_STATUSES,
  BATTERY_PRESETS,
  GRAPHICS_QUALITIES,
  PERMISSION_MODES,
  STATUS_COLORS,
  type Agent,
  type AgentStatus,
  type Capability,
  type CapabilityCategory,
  type ChatMessage,
  type ConnectionInfo,
  type ContextChip,
  type ContextRef,
  type GraphicsAdvanced,
  type GraphicsQuality,
  type HookStatus,
  type ModelOption,
  type PermissionMode,
  type PermissionRequestVM,
  type Settings,
  type StartResult,
  type TestEventResult,
  type UpdateState,
} from '@agent-office/shared'
import type { Chip } from './capability-vm.ts'
import { COPY } from './connect-copy.ts'
import { snippet } from './connect-snippets.ts'
import {
  TEST_AGENT_ID,
  type ConnectTab,
  type ConnectVM,
  type EmptyPhase,
  type EmptyStateVM,
  type HookActionVM,
  type Pill,
  type SnippetLang,
} from './connect-types.ts'
import { ago } from './format.ts'
import { GFX_COPY } from './graphics-copy.ts'
import type { Effective, GraphicsStats, Preset, Tier } from './graphics-types.ts'
import { PRESETS, resolvePreset } from './quality.ts'
import type { Activity } from './office-types.ts'
import { SESSION_COPY } from './session-copy.ts'
import {
  CHROME_ID,
  MAX_MANAGED,
  type ComposerChipVM,
  type ComposerVM,
  type Draft,
  type ModeOptionVM,
  type NewSessionForm,
  type NewSessionVM,
  type PermissionCardVM,
  type SessionHeaderVM,
  type UseMenuVM,
} from './session-types.ts'
import type { OfficeState } from './state.ts'

const STATE_LABEL: Record<ChatMessage['state'], string> = {
  queued: '⏳ queued',
  delivered: '✓ delivered',
  replied: '✓✓ replied',
}

export { ago } from './format.ts'

export interface Hint {
  text: string
  action?: 'install-hook' | 'open-connect' | 'open-parent'
  /** Button label for the action ("Install hook", "Repair hook", "Open parent"). */
  label?: string
}

const IDLE_DELIVERY = SESSION_COPY.hint.idleDelivery
const TURN_DELIVERY = SESSION_COPY.hint.turnDelivery

/** How (and whether) a message reaches this agent: the hint matrix of plan §2.5. */
export function hintFor(a: Agent, hook: HookStatus = 'not-installed'): Hint | null {
  const h = SESSION_COPY.hint
  if (a.managed) return null
  if (a.provider === 'claude-code') {
    if (a.parentId) return { text: h.subagent, action: 'open-parent', label: h.openParent }
    if (hook === 'not-installed')
      return { text: h.notInstalled, action: 'install-hook', label: h.install }
    if (hook === 'outdated') return { text: h.outdated, action: 'install-hook', label: h.repair }
    if (!a.interactive) return { text: h.waitingCheckIn }
    if (a.status === 'waiting' || a.status === 'idle') return { text: IDLE_DELIVERY }
    return { text: TURN_DELIVERY }
  }
  if (!a.interactive) return { text: COPY.hint.notReading, action: 'open-connect' }
  return null
}

/** What the director knows about an agent's whereabouts (from its intent and target anchor). */
export interface ActivityInfo {
  activity: Activity
  /** Room id from the anchor (`meeting-A`, `booth-3`, `pod-2`, …). */
  room?: string
  /** For a parent in a meeting: how many of its subagents are with it. */
  subagents?: number
  /** For a subagent in a meeting: the parent's name. */
  with?: string
  /** For connection-* / library-*: what the agent is using. */
  capability?: { label: string; category: CapabilityCategory; tool?: string }
}

const ROOM_SUFFIX = (room: string | undefined, prefix: string) =>
  room?.startsWith(prefix) ? room.slice(prefix.length) : undefined

const DESK_LABEL: Record<'desk-work' | 'desk-think' | 'desk-error' | 'desk-idle', string> = {
  'desk-work': 'Working at their desk',
  'desk-think': 'Thinking at their desk',
  'desk-error': 'Stuck on an error at their desk',
  'desk-idle': 'Idle at their desk',
}

/** Human-readable sentence for an activity, e.g. "In meeting room A with 2 subagents". */
export function activityLabel(
  activity: Activity,
  details: Omit<ActivityInfo, 'activity'> = {},
): string {
  switch (activity) {
    case 'arriving':
      return 'Arriving'
    case 'leaving':
      return 'Leaving'
    case 'kitchen':
      return 'Getting coffee'
    case 'lounge':
      return 'Relaxing in the lounge'
    case 'cafe':
      return 'Taking a break at the cafe'
    case 'pingpong':
      return 'Playing ping-pong'
    case 'meeting': {
      const room = ROOM_SUFFIX(details.room, 'meeting-')
      const where = room ? `In meeting room ${room}` : 'In a meeting'
      if (details.with) return `${where} with ${details.with}'s team`
      const n = details.subagents ?? 0
      return n > 0 ? `${where} with ${n} subagent${n === 1 ? '' : 's'}` : where
    }
    case 'connection-call': {
      const c = details.capability
      if (!c) return 'Calling an adapter'
      return c.tool ? `Calling ${c.label} (${c.tool})` : `Calling ${c.label}`
    }
    case 'connection-visit':
      return details.capability
        ? `Working at the ${details.capability.label} station`
        : 'Working in the Adapters room'
    case 'library-call': {
      const c = details.capability
      if (!c) return 'Consulting the library'
      return c.category === 'skill' ? `Consulting ${c.label} (skill)` : `Reading ${c.label}`
    }
    case 'library-visit':
      return details.capability
        ? `In the library reading ${details.capability.label}`
        : 'Reading in the library'
    case 'booth': {
      const booth = ROOM_SUFFIX(details.room, 'booth-')
      return `Waiting for you in ${booth ? `booth ${booth}` : 'a phone booth'}`
    }
    default: {
      const pod = ROOM_SUFFIX(details.room, 'pod-')
      return DESK_LABEL[activity] + (pod ? ` in pod ${pod}` : '')
    }
  }
}

export interface PanelVM {
  id: string
  /** The agent's provider (capability chip refs); '' once it left. */
  provider: string
  present: boolean
  name: string
  subtitle: string
  /** Where the agent is in the office and what it is doing there (when the director knows). */
  activity?: string
  meta: [string, string][]
  parent?: { id: string; name: string }
  hint: Hint | null
  thread: ThreadItemVM[]
  /** Connections, skills and rules this agent used this session (chips). */
  used?: UsedChips
  /** Mode/model pills and session controls (Claude Code and agents that report a mode). */
  session: SessionHeaderVM | null
  composer: ComposerVM
  /** The first pending permission request of a managed session. */
  permission: PermissionCardVM | null
  /** Draft text for this agent (restored into the input when the panel opens on it). */
  draftText: string
}

export interface ThreadItemVM {
  id: string
  from: ChatMessage['from']
  text: string
  stateLabel?: string
  /** Files, folders and tools sent with a user message (display only). */
  context?: ContextChip[]
}

/** What the panel needs beyond office state: hook status, session models, settings, draft. */
export interface PanelInput {
  hook?: HookStatus
  /** Models of the selected managed session (undefined while loading). */
  models?: ModelOption[]
  allowBypass?: boolean
  draft?: Draft
}

export interface UsedChips {
  adapters: Chip[]
  library: Chip[]
}

export function panelVM(
  state: OfficeState,
  id: string,
  now: number,
  info?: ActivityInfo,
  used?: UsedChips,
  input: PanelInput = {},
): PanelVM {
  const a = state.agents.get(id)
  const d = input.draft ?? EMPTY_DRAFT
  const caps = a ? (state.capabilities.get(a.provider) ?? []) : []
  const session = {
    composer: composerVM(a, d, caps),
    draftText: d.text,
  }
  if (!a)
    return {
      id,
      provider: '',
      present: false,
      name: 'This agent has left the office',
      subtitle: '',
      meta: [],
      hint: null,
      thread: [],
      session: null,
      permission: null,
      ...session,
    }
  const parent = a.parentId ? state.agents.get(a.parentId) : undefined
  const activity = info ? activityLabel(info.activity, info) : undefined
  return {
    id,
    provider: a.provider,
    present: true,
    name: a.name,
    subtitle: [a.kind, a.provider, a.model].filter(Boolean).join(' · '),
    ...(activity ? { activity } : {}),
    meta: [
      ['Topic', a.topic],
      ['Status', a.status + (a.tool ? ` (${a.tool})` : '')],
      ...(activity ? [['Now', activity] as [string, string]] : []),
      ['Activity', a.text || '—'],
      ['Active', `for ${ago(a.since, now).replace(' ago', '')}`],
      ['Last seen', ago(a.lastSeen, now)],
    ],
    ...(a.parentId ? { parent: { id: a.parentId, name: parent?.name ?? a.parentId } } : {}),
    hint: hintFor(a, input.hook),
    ...(used && (used.adapters.length || used.library.length) ? { used } : {}),
    thread: (state.messages.get(id) ?? []).map((m) => ({
      id: m.id,
      from: m.from,
      text: m.text,
      ...(m.from === 'user' ? { stateLabel: STATE_LABEL[m.state] } : {}),
      ...(m.context?.length ? { context: m.context } : {}),
    })),
    session: sessionHeaderVM(a, input.models, !!input.allowBypass),
    permission: a.managed ? permissionVM(state.permissions?.get(id) ?? []) : null,
    ...session,
  }
}

// ---------------------------------------------------------------------------------------------
// Managed sessions: header, composer, Use… menu, permission card, new-session dialog (plan §2.1–2.4)

const EMPTY_DRAFT: Draft = { text: '', context: [], use: [] }
const MAX_CONTEXT = 10
const MAX_USE = 5
const BUSY: AgentStatus[] = ['thinking', 'tool']

/** Before any session reported `supportedModels()` (plan §2.4; labels pending in SESSION_COPY). */
export const FALLBACK_MODELS: ModelOption[] = [
  { id: 'opus', label: SESSION_COPY.fallbackModels.opus },
  { id: 'sonnet', label: SESSION_COPY.fallbackModels.sonnet },
  { id: 'haiku', label: SESSION_COPY.fallbackModels.haiku },
]
/** Built-in tools offered in the Use… menu (`fs` is implicit). Labels pending in SESSION_COPY. */
const BUILTINS: { id: string; label: string }[] = [
  { id: 'shell', label: SESSION_COPY.builtins.shell },
  { id: 'web', label: SESSION_COPY.builtins.web },
  { id: 'subagents', label: SESSION_COPY.builtins.subagents },
]

const modeText = (m: PermissionMode | undefined) => {
  const c = m && SESSION_COPY.modes[m]
  return c ? `${c.icon} ${c.label}` : SESSION_COPY.modeUnknown
}

/** The mode menu's items; Bypass only when allowed in Settings. */
export function modeOptions(
  current: PermissionMode | undefined,
  allowBypass: boolean,
): ModeOptionVM[] {
  return PERMISSION_MODES.filter((m) => allowBypass || m !== 'bypassPermissions').map((id) => ({
    id,
    ...SESSION_COPY.modes[id],
    checked: id === (current ?? 'default'),
  }))
}

export function sessionHeaderVM(
  a: Agent,
  models: ModelOption[] | undefined,
  allowBypass: boolean,
): SessionHeaderVM | null {
  const m = a.managed
  if (!m && (a.parentId || (a.provider !== 'claude-code' && !a.permissionMode))) return null
  const modelId = m?.modelId
  const modelLabel = models?.find((o) => o.id === modelId)?.label ?? a.model ?? modelId
  const mode = modeText(m ? (a.permissionMode ?? 'default') : a.permissionMode)
  const model = modelLabel ? `✦ ${modelLabel}` : SESSION_COPY.modelUnknown
  if (!m)
    return {
      managed: false,
      mode: { text: mode, tone: 'off' },
      model: { text: model, tone: 'off' },
      modes: [],
      models: [],
      readOnlyNote: SESSION_COPY.readOnly,
      canInterrupt: false,
      canStop: false,
    }
  const live = m.phase === 'running'
  return {
    managed: true,
    mode: { text: mode, tone: 'ok' },
    model: { text: model, tone: 'ok' },
    modes: modeOptions(a.permissionMode, allowBypass),
    models: (models ?? []).map((o) => ({ ...o, checked: o.id === modelId })),
    canInterrupt: live && (BUSY.includes(a.status) || m.pending > 0),
    canStop: true,
  }
}

function useLabel(id: string, caps: Capability[]): string {
  if (id === CHROME_ID) return SESSION_COPY.composer.chrome
  const c = caps.find((x) => x.id === id)
  if (id.startsWith('skill:')) return SESSION_COPY.composer.useSkill(c?.label ?? id.slice(6))
  return c?.label ?? BUILTINS.find((b) => b.id === id)?.label ?? id
}

function chipsOf(d: Pick<Draft, 'context' | 'use'>, caps: Capability[], chromeOff: boolean) {
  return [
    ...d.context.map((r): ComposerChipVM => ({
      kind: r.kind,
      key: r.ref,
      label: r.label,
      hint: r.hint,
    })),
    ...d.use.map((id): ComposerChipVM => ({
      kind: 'capability',
      key: id,
      label: useLabel(id, caps),
      ...(id === CHROME_ID && chromeOff && { warn: SESSION_COPY.composer.chromeOff }),
    })),
  ]
}

/** The composer under the thread: chips, placeholder, and why it's disabled (plan §2.2). */
export function composerVM(a: Agent | undefined, d: Draft, caps: Capability[] = []): ComposerVM {
  const c = SESSION_COPY.composer
  const phase = a?.managed?.phase
  const reason = !a
    ? c.placeholder
    : a.parentId && !a.managed && a.provider === 'claude-code'
      ? c.subagent
      : phase === 'starting'
        ? c.starting
        : phase === 'ended'
          ? c.ended
          : null
  const disabled = !a || reason !== null
  return {
    chips: chipsOf(d, caps, !!a?.managed && !a.managed.chrome),
    disabled,
    placeholder: reason ?? c.placeholder,
    canAddContext: !disabled && d.context.length < MAX_CONTEXT,
    canAddUse: !disabled && d.use.length < MAX_USE,
  }
}

/** The Use… menu: Chrome pinned for Claude Code, then MCP servers, built-ins and skills. */
export function useMenuVM(
  caps: Capability[],
  provider: string,
  selected: string[],
  managedChrome?: boolean,
): UseMenuVM {
  const has = (id: string) => caps.some((c) => c.id === id)
  const entry = (id: string, seen: boolean) => ({
    id,
    label: useLabel(id, caps),
    seen,
    selected: selected.includes(id),
  })
  const g = SESSION_COPY.composer.groups
  const groups: UseMenuVM['groups'] = [
    {
      id: 'browser',
      label: g.browser,
      entries:
        provider === 'claude-code' ? [entry(CHROME_ID, has(CHROME_ID) || !!managedChrome)] : [],
    },
    {
      id: 'mcp',
      label: g.mcp,
      entries: caps
        .filter((c) => c.id.startsWith('mcp:') && c.id !== CHROME_ID)
        .map((c) => entry(c.id, true)),
    },
    { id: 'builtin', label: g.builtin, entries: BUILTINS.map((b) => entry(b.id, has(b.id))) },
    {
      id: 'skill',
      label: g.skill,
      entries: caps.filter((c) => c.id.startsWith('skill:')).map((c) => entry(c.id, true)),
    },
  ]
  return { groups: groups.filter((x) => x.entries.length) }
}

/** Adds or removes a tool; refuses a 6th. */
export function toggleUse(use: string[], id: string): { use: string[]; error?: string } {
  if (use.includes(id)) return { use: use.filter((u) => u !== id) }
  if (use.length >= MAX_USE) return { use, error: SESSION_COPY.composer.maxUse }
  return { use: [...use, id] }
}

/** Adds picked files/folders (the same ref once), at most 10. */
export function addContext(
  context: ContextRef[],
  picked: ContextRef[],
): { context: ContextRef[]; error?: string } {
  const fresh = picked.filter(
    (p, i) =>
      !context.some((c) => c.ref === p.ref) && picked.findIndex((q) => q.ref === p.ref) === i,
  )
  const room = MAX_CONTEXT - context.length
  const next = [...context, ...fresh.slice(0, Math.max(0, room))]
  return fresh.length > room
    ? { context: next, error: SESSION_COPY.composer.maxContext }
    : { context: next }
}

/** The permission card: one request at a time, with a counter when several wait. */
export function permissionVM(requests: PermissionRequestVM[]): PermissionCardVM | null {
  const request = requests[0]
  if (!request) return null
  return {
    request,
    ...(requests.length > 1 && {
      counter: SESSION_COPY.permission.counter(1, requests.length),
    }),
    allowSessionLabel: SESSION_COPY.permission.allowSession(request.tool),
  }
}

/** The new-session dialog (plan §2.4). `running` counts live managed sessions. */
export function newSessionVM(
  form: NewSessionForm,
  models: ModelOption[] | undefined,
  allowBypass: boolean,
  running: number,
  opts: { starting?: boolean; error?: string; caps?: Capability[] } = {},
): NewSessionVM {
  const ns = SESSION_COPY.newSession
  const starting = !!opts.starting
  const limit = running >= MAX_MANAGED ? ns.limit(running) : undefined
  const list = [{ id: '', label: ns.modelDefault }, ...(models?.length ? models : FALLBACK_MODELS)]
  const empty = { text: '', context: form.context, use: form.use }
  const composer = composerVM(undefined, empty, opts.caps)
  return {
    ...(form.folder && { folder: { label: form.folder.label, hint: form.folder.hint } }),
    name: form.name,
    namePlaceholder: form.folder?.label ?? '',
    models: list.map((m) => ({ ...m, selected: m.id === (form.model ?? '') })),
    modes: modeOptions(form.mode, allowBypass),
    extraFolders: form.extraFolders.map((f) => ({ key: f.ref, label: f.label, hint: f.hint })),
    chrome: { checked: form.chrome, available: true },
    text: form.text,
    composer: {
      ...composer,
      chips: chipsOf(form, opts.caps ?? [], !form.chrome),
      disabled: starting,
      placeholder: SESSION_COPY.composer.placeholder,
      canAddContext: !starting && form.context.length < MAX_CONTEXT,
      canAddUse: !starting && form.use.length < MAX_USE,
    },
    canStart: !!form.folder && !!form.text.trim() && !starting && !limit,
    starting,
    ...(opts.error && { error: opts.error }),
    ...(limit && { limit }),
  }
}

/** Inline error for a failed start (plan §12). */
export function startErrorText(r: Extract<StartResult, { ok: false }>, running: number): string {
  const e = SESSION_COPY.newSession.errors
  switch (r.code) {
    case 'auth':
      return e.auth
    case 'runtime':
      return e.runtime
    case 'folder':
      return e.folder
    case 'limit':
      return SESSION_COPY.newSession.limit(Math.max(running, MAX_MANAGED))
    default:
      return e.generic(r.error)
  }
}

export interface HudVM {
  count: string
  statuses: { status: AgentStatus; color: string; count: number }[]
  /** Controls help, or "No agents right now · [Connect…]" once the office is empty again. */
  hint: { text: string; action?: 'connect' }
}

const CONTROLS_HELP = 'Drag to orbit · WASD to move · scroll to zoom · click an agent to chat'

export function hudVM(state: OfficeState, phase?: EmptyPhase): HudVM {
  const counts = new Map<AgentStatus, number>()
  for (const a of state.agents.values()) counts.set(a.status, (counts.get(a.status) ?? 0) + 1)
  const n = state.agents.size
  return {
    count: `${n} agent${n === 1 ? '' : 's'}`,
    statuses: AGENT_STATUSES.map((status) => ({
      status,
      color: STATUS_COLORS[status],
      count: counts.get(status) ?? 0,
    })),
    hint:
      n === 0 && (phase === 'empty-again' || phase === 'dismissed')
        ? { text: COPY.hud.noAgents, action: 'connect' }
        : { text: CONTROLS_HELP },
  }
}

export interface SettingsVM {
  port: number
  notifications: boolean
  launchAtLogin: boolean
  claudeAdapter: boolean
  discoverCapabilities: boolean
  autoUpdate: boolean
  graphicsQuality: GraphicsQuality
  theme: Settings['theme']
  allowBypassPermissions: boolean
  version: string
  restartNote: boolean
  hook: HookActionVM
  update: { label: string; action: 'check' | 'install' | 'download' | null; url?: string }
  graphicsAdvanced: GraphicsAdvanced
  powerSaverBlur: boolean
  powerSaverHidden: boolean
  batteryPreset: Settings['batteryPreset']
  hardwareAcceleration: boolean
  /** False on macOS: turning acceleration off leaves no WebGL there. */
  showHardwareAcceleration: boolean
  /** Settings → Graphics derived texts and options (low-spec plan §2.1). */
  graphics: GraphicsVM
}

export function settingsVM(i: {
  settings: Settings
  hook: HookStatus
  version: string
  update: UpdateState
  restartNote?: boolean
  /** Live graphics facts (tier, Auto's current preset, stats, power); settings come from above. */
  graphics?: Omit<GraphicsInput, 'settings'>
  /** macOS has no software WebGL fallback, so the acceleration toggle is hidden there. */
  isMac?: boolean
}): SettingsVM {
  const hook = hookVM(i.hook)
  return {
    port: i.settings.port,
    notifications: i.settings.notifications,
    launchAtLogin: i.settings.launchAtLogin,
    claudeAdapter: i.settings.claudeAdapter,
    discoverCapabilities: i.settings.discoverCapabilities,
    autoUpdate: i.settings.autoUpdate,
    graphicsQuality: i.settings.graphicsQuality,
    theme: i.settings.theme,
    allowBypassPermissions: i.settings.allowBypassPermissions,
    version: `v${i.version}`,
    restartNote: !!i.restartNote,
    hook,
    update: updateVM(i.update),
    graphicsAdvanced: i.settings.graphicsAdvanced,
    powerSaverBlur: i.settings.powerSaverBlur,
    powerSaverHidden: i.settings.powerSaverHidden,
    batteryPreset: i.settings.batteryPreset,
    hardwareAcceleration: i.settings.hardwareAcceleration,
    showHardwareAcceleration: !i.isMac,
    graphics: graphicsVM({ ...i.graphics, settings: i.settings }),
  }
}

// ── Settings → Graphics (low-spec plan §2.1, §3) ────────────────────────────────────────────────
export interface GfxOption {
  value: string
  label: string
}

export interface GfxAdvancedRowVM {
  key: keyof GraphicsAdvanced
  label: string
  help?: string
  /** The current setting ('auto' or an override). */
  value: string
  /** First entry is `auto`, labelled "Auto · <what the preset gives>". */
  options: GfxOption[]
}

export interface GraphicsVM {
  quality: GraphicsQuality
  qualityOptions: { value: GraphicsQuality; label: string; help?: string }[]
  /** "Auto picked: Low (integrated GPU)" (`#s-gfx-auto-note`); null for a manual preset. */
  autoNote: string | null
  /** "62 fps · Low · GPU memory ≈ 140 MB · 1280×720" (`#s-gfx-now`); absent before a sample. */
  now?: string
  saverBlur: boolean
  saverHidden: boolean
  batteryPreset: (typeof BATTERY_PRESETS)[number]
  batteryOptions: GfxOption[]
  /** Any advanced override set. */
  custom: boolean
  /** "Advanced" or "Advanced (custom)" (the `<summary>`). */
  advancedSummary: string
  advanced: GfxAdvancedRowVM[]
  /** Per option, what 'auto' resolves to: "Auto · 30" (same text as `advanced[].options[0]`). */
  autoHints: Record<keyof GraphicsAdvanced, string>
  hardwareAcceleration: boolean
}

export interface GraphicsInput {
  settings: Settings
  /** Detected hardware tier (Auto's start and ceiling). */
  tier?: Tier
  /** The preset Auto runs now (the governor's). */
  autoPreset?: Preset
  stats?: GraphicsStats
  /** What the scene applies now (battery preset included). */
  effective?: Effective
  onBattery?: boolean
}

const V = GFX_COPY.values
const pct = (x: number) => `${Math.round(x * 100)}%`

/** Per option: its choices (besides auto) and how the preset's own value reads. */
const ADVANCED: {
  key: keyof GraphicsAdvanced
  label: string
  help?: string
  options: GfxOption[]
  auto: (p: Preset) => string
}[] = [
  {
    key: 'resolution',
    label: GFX_COPY.options.resolution,
    options: (['0.5', '0.67', '0.75', '1'] as const).map((v) => ({ value: v, label: pct(+v) })),
    auto: (p) => pct(PRESETS[p].resolutionScale),
  },
  {
    key: 'fps',
    label: GFX_COPY.options.fps,
    options: [
      { value: '30', label: '30' },
      { value: '60', label: '60' },
      { value: 'unlimited', label: V.unlimited },
    ],
    auto: (p) => String(PRESETS[p].fpsLimit ?? V.unlimited),
  },
  {
    key: 'shadows',
    label: GFX_COPY.options.shadows,
    options: [
      { value: 'off', label: V.off },
      { value: 'contact', label: V.contact },
      { value: 'full', label: V.full },
    ],
    auto: (p) => V[PRESETS[p].shadows],
  },
  {
    key: 'effects',
    label: GFX_COPY.options.effects,
    help: GFX_COPY.options.effectsHelp,
    options: [
      { value: 'off', label: V.off },
      { value: 'on', label: V.on },
    ],
    auto: (p) => (PRESETS[p].bloom ? V.on : V.off),
  },
  {
    key: 'characters',
    label: GFX_COPY.options.characters,
    options: (['low', 'medium', 'high'] as const).map((v) => ({ value: v, label: V[v] })),
    auto: (p) => V[PRESETS[p].characters],
  },
  {
    key: 'labels',
    label: GFX_COPY.options.labels,
    options: (['selected', 'nearby', 'all'] as const).map((v) => ({ value: v, label: V[v] })),
    auto: (p) => V[PRESETS[p].labels.mode],
  },
  {
    key: 'links',
    label: GFX_COPY.options.links,
    options: (['off', 'static', 'animated'] as const).map((v) => ({ value: v, label: V[v] })),
    auto: (p) => V[PRESETS[p].links],
  },
  {
    key: 'building',
    label: GFX_COPY.options.building,
    help: GFX_COPY.options.buildingHelp,
    options: (['low', 'medium', 'high'] as const).map((v) => ({ value: v, label: V[v] })),
    auto: (p) => V[PRESETS[p].building],
  },
]

export function graphicsVM(i: GraphicsInput): GraphicsVM {
  const s = i.settings
  const autoPreset = i.autoPreset ?? i.tier?.start ?? 'high'
  const battery = !!i.onBattery && s.batteryPreset !== 'off'
  const preset: Preset =
    i.effective?.preset ??
    (battery && s.batteryPreset !== 'off'
      ? s.batteryPreset
      : resolvePreset(s.graphicsQuality, autoPreset))
  const custom = Object.values(s.graphicsAdvanced).some((v) => v !== 'auto')
  let autoNote: string | null = null
  if (s.graphicsQuality === 'auto' && i.tier)
    autoNote =
      i.tier.why === 'software'
        ? GFX_COPY.softwareNote
        : GFX_COPY.autoPicked(GFX_COPY.presets[autoPreset], GFX_COPY.why[i.tier.why])
  const st = i.stats
  const advanced = ADVANCED.map((o) => ({
    key: o.key,
    label: o.label,
    ...(o.help && { help: o.help }),
    value: s.graphicsAdvanced[o.key],
    options: [{ value: 'auto', label: GFX_COPY.advanced.auto(o.auto(preset)) }, ...o.options],
  }))
  return {
    quality: s.graphicsQuality,
    qualityOptions: GRAPHICS_QUALITIES.map((q) => ({
      value: q,
      label: GFX_COPY.presets[q],
      ...(q !== 'auto' && { help: GFX_COPY.presetHelp[q] }),
    })),
    autoNote,
    ...(st && {
      now: GFX_COPY.now(
        Math.round(st.fps),
        GFX_COPY.presets[preset],
        Math.round(st.textureMB + st.geometryMB),
        st.width,
        st.height,
        battery,
      ),
    }),
    saverBlur: s.powerSaverBlur,
    saverHidden: s.powerSaverHidden,
    batteryPreset: s.batteryPreset,
    batteryOptions: BATTERY_PRESETS.map((b) => ({
      value: b,
      label: b === 'off' ? V.off : GFX_COPY.presets[b],
    })),
    custom,
    advancedSummary: custom
      ? `${GFX_COPY.advanced.title} ${GFX_COPY.advanced.custom}`
      : GFX_COPY.advanced.title,
    advanced,
    autoHints: Object.fromEntries(advanced.map((r) => [r.key, r.options[0]!.label])) as Record<
      keyof GraphicsAdvanced,
      string
    >,
    hardwareAcceleration: s.hardwareAcceleration,
  }
}

function updateVM(u: UpdateState): SettingsVM['update'] {
  if (u.policy === 'off') return { label: 'Updates are off in development builds', action: null }
  switch (u.status) {
    case 'checking':
      return { label: 'Checking…', action: null }
    case 'downloading':
      return { label: `Downloading ${u.version ?? 'update'}…`, action: null }
    case 'ready':
      return { label: `Version ${u.version} is ready`, action: 'install' }
    case 'available':
      return u.policy === 'notify-only'
        ? {
            label: `Version ${u.version} is available`,
            action: 'download',
            ...(u.url ? { url: u.url } : {}),
          }
        : { label: `Version ${u.version} is available`, action: null }
    case 'up-to-date':
      return { label: 'Up to date', action: 'check' }
    case 'error':
      return { label: `Update check failed: ${u.error ?? 'unknown error'}`, action: 'check' }
    default:
      return { label: 'Not checked yet', action: 'check' }
  }
}

/** The hook row in Settings and in Connect → Claude Code. */
export function hookVM(h: HookStatus): HookActionVM {
  const c = COPY.claude.hook
  if (h === 'installed') return { ...c.installed, action: 'uninstall' }
  if (h === 'outdated') return { ...c.outdated, action: 'install' }
  return { ...c.missing, action: 'install' }
}

// ---------------------------------------------------------------------------------------------
// Connect panel and empty state (plan §2.1–§2.2)

const pill = (text: string, tone: Pill['tone']): Pill => ({ text, tone })

function claudePill(c: ConnectionInfo['claude']): Pill {
  if (!c.enabled)
    return pill(c.override === 'off' ? COPY.claude.offOverride : COPY.claude.off, 'off')
  if (!c.projectsDirFound) return pill(COPY.claude.folderMissingPill, 'warn')
  if (c.activeSessions > 0) return pill(COPY.claude.sessions(c.activeSessions), 'ok')
  return pill(COPY.claude.noSessions, 'off')
}

function httpPill(a: ConnectionInfo['api']): Pill {
  if (a.listening) return pill(COPY.http.listening(a.host, a.port), 'ok')
  if (a.portBusy) return pill(COPY.http.busy(a.port), 'error')
  return pill(COPY.http.starting, 'pending')
}

function demoPill(m: ConnectionInfo['mock'], agents: number): Pill {
  if (m.override === 'on') return pill(COPY.demo.onOverride, 'ok')
  return m.enabled ? pill(COPY.demo.on(agents), 'ok') : pill(COPY.demo.off, 'off')
}

const agentsOf = (state: OfficeState) => [...state.agents.values()]

export interface ConnectInput {
  info: ConnectionInfo
  state: OfficeState
  tab: ConnectTab
  lang: SnippetLang
  now: number
  /** Newest non-test provider seen over HTTP this session (survives its agents leaving). */
  lastHttp?: { provider: string; ts: number }
  /** Result of the last "Send a test agent". */
  test?: TestEventResult
  /** Adds the PowerShell note to the curl snippet. */
  isWindows?: boolean
}

export function connectVM(i: ConnectInput): ConnectVM {
  const { info, now } = i
  const agents = agentsOf(i.state)
  const claudeAgents = agents.filter((a) => a.provider === 'claude-code')

  const claudeOverride = info.claude.override
  const verified = (): Pill | undefined => {
    if (info.hook === 'not-installed') return undefined
    const reading = claudeAgents.filter((a) => a.interactive)
    if (!reading.length) return pill(COPY.claude.notVerified, 'pending')
    const last = Math.max(...reading.map((a) => a.lastSeen))
    return pill(COPY.claude.verified(ago(last, now)), 'ok')
  }
  const v = verified()
  const claude: ConnectVM['claude'] = {
    pill: claudePill(info.claude),
    toggle: {
      on: info.claude.enabled,
      ...(claudeOverride && {
        disabledNote:
          claudeOverride === 'on' ? COPY.claude.onOverrideNote : COPY.claude.offOverrideNote,
      }),
    },
    folder: info.claude.projectsDirFound
      ? { ok: true, text: COPY.claude.folderFound(info.claude.projectsDir) }
      : { ok: false, text: COPY.claude.folderMissing(info.claude.projectsDir) },
    hook: hookVM(info.hook),
    ...(v && { verified: v }),
    ...(info.claude.enabled &&
      info.claude.activeSessions > 0 &&
      !claudeAgents.length && { idleNote: COPY.claude.idle }),
  }

  const live = (): Pill => {
    if (i.test)
      return i.test.ok
        ? pill(COPY.http.testOk, 'ok')
        : pill(COPY.http.testFailed(i.test.error), 'error')
    if (i.lastHttp)
      return pill(COPY.http.received(i.lastHttp.provider, ago(i.lastHttp.ts, now)), 'ok')
    return pill(COPY.http.waiting, 'pending')
  }
  const { host, port, tokenFile } = info.api
  const http: ConnectVM['http'] = {
    pill: httpPill(info.api),
    endpoint: `http://${host}:${port}/api/events`,
    tokenFile,
    lang: i.lang,
    snippet: snippet(i.lang, { host, port, tokenFile }),
    ...(i.isWindows && i.lang === 'curl' && { snippetNote: COPY.http.powershell }),
    ...(info.api.portBusy && { portBusy: { port } }),
    live: live(),
  }

  const demo: ConnectVM['demo'] = {
    pill: demoPill(info.mock, agents.filter((a) => a.source === 'mock').length),
    toggle: {
      on: info.mock.enabled,
      ...(info.mock.override && { disabledNote: COPY.demo.overrideNote }),
    },
  }

  const rows = connectedRows(agents, now)
  const tabs: ConnectVM['tabs'] = [
    { id: 'claude', label: COPY.panel.tabs.claude, tone: claude.pill.tone },
    { id: 'http', label: COPY.panel.tabs.http, tone: http.pill.tone },
    { id: 'demo', label: COPY.panel.tabs.demo, tone: demo.pill.tone },
    {
      id: 'connected',
      label: `${COPY.panel.tabs.connected} (${rows.length})`,
      tone: rows.length ? 'ok' : 'off',
    },
  ]
  return { tab: i.tab, tabs, claude, http, demo, connected: { rows } }
}

/** How a provider's agents reach the office, from `agent.source` (plan §2.2, Connected tab). */
function viaOf(provider: string, group: Agent[]): string {
  if (provider === TEST_AGENT_ID) return COPY.connected.viaText(COPY.connected.via.test!)
  const ways = [...new Set(group.map((a) => a.source))].map((s) => {
    const how = COPY.connected.via[s] ?? s
    return s === 'claude-code' && group.some((a) => a.interactive)
      ? how + COPY.connected.hookOk
      : how
  })
  return COPY.connected.viaText(ways.join(' + '))
}

function connectedRows(agents: Agent[], now: number): ConnectVM['connected']['rows'] {
  const byProvider = new Map<string, Agent[]>()
  for (const a of agents) byProvider.set(a.provider, [...(byProvider.get(a.provider) ?? []), a])
  return [...byProvider]
    .map(([provider, group]) => ({
      provider,
      count: group.length,
      dots: group.map((a) => STATUS_COLORS[a.status]),
      via: viaOf(provider, group),
      lastSeen: COPY.connected.lastSeen(ago(Math.max(...group.map((a) => a.lastSeen)), now)),
    }))
    .sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider))
}

/**
 * The empty card's state machine (plan §2.1): `loading` until `ready()` plus the first connection
 * push (or the grace period), then `first-run`; any agent → `active`; back to 0 → `empty-again`.
 */
export function emptyPhase(p: {
  prev: EmptyPhase
  ready: boolean
  infoReceived: boolean
  graceElapsed: boolean
  agents: number
  dismissed: boolean
}): EmptyPhase {
  if (p.agents > 0) return 'active'
  if (p.prev === 'active' || p.prev === 'empty-again') return 'empty-again'
  if (p.prev === 'loading')
    return p.ready && (p.infoReceived || p.graceElapsed)
      ? p.dismissed
        ? 'dismissed'
        : 'first-run'
      : 'loading'
  return p.dismissed ? 'dismissed' : 'first-run'
}

export type DemoStart = 'idle' | 'starting' | 'failed'

export function emptyStateVM(info: ConnectionInfo, demo: DemoStart): EmptyStateVM {
  const e = COPY.empty
  const demoPillNow = demo === 'failed' ? pill(e.demo.failed, 'error') : demoPill(info.mock, 0)
  return {
    tiles: [
      { id: 'claude', ...e.claude, pill: claudePill(info.claude) },
      { id: 'http', ...e.http, pill: httpPill(info.api) },
      {
        id: 'demo',
        title: e.demo.title,
        body: e.demo.body,
        pill: demoPillNow,
        button: demo === 'starting' ? e.demo.starting : e.demo.button,
        ...(demo === 'starting' && { busy: true }),
      },
    ],
    listening: e.listening,
  }
}
