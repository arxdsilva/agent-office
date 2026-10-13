// Every user-facing string of the Night City mode (docs/special-3d). Plain text only.
import type { AgentStatus } from '@agent-office/shared'

/** The mode's user-facing name: change it here only (the toggle, HUD, intro and errors use it). */
export const MODE_NAME = 'Night City'

export const SPECIAL_COPY = {
  mode: MODE_NAME,
  allProjects: 'All projects',
  unknownPlace: 'Meridian HQ',
  camera: { third: 'Third person', first: 'First person', overview: 'Overview' },
  status: {
    idle: 'Idle',
    thinking: 'Thinking',
    tool: 'Working',
    waiting: 'Waiting for you',
    error: 'Error',
    done: 'Done',
  } satisfies Record<AgentStatus, string>,
  hud: {
    project: 'Project',
    active: 'Active',
    waiting: 'Waiting',
    location: 'Location',
    selected: 'Selected',
    settings: 'Night City settings',
    keys: 'WASD move · Shift sprint · E interact · F camera · M map · J directory',
  },
  settings: {
    title: MODE_NAME,
    camera: 'Camera',
    atmosphere: 'Atmosphere',
    atmosphereLevels: { low: 'Low', medium: 'Medium', high: 'High' },
    rain: 'Rain',
    reducedMotion: 'Reduced motion',
    audio: 'Audio',
    master: 'Master',
    effects: 'Effects',
    ambient: 'Ambient',
    mute: 'Mute',
    close: 'Close',
  },
  intro: {
    title: `Welcome to ${MODE_NAME}`,
    body: 'A cinematic headquarters for your live agents: the same agents, projects and sessions as the other views. It uses more of your graphics card; lower the quality in Settings → Graphics if it stutters.',
    continue: 'Continue',
    back: 'Back to Classic',
  },
  failure: {
    title: `${MODE_NAME} could not start`,
    body: 'Your agents and sessions are untouched. Pick another view:',
    classic: 'Classic 3D',
    rpg: '2D RPG',
  },
  display: {
    lastCompletion: (mins: number) =>
      mins < 1 ? 'Last completion just now' : `Last completion ${mins} min ago`,
    noCompletions: 'No completions yet',
    vault: (v: string) => `Vault ${v}`,
  },
  loading: `Entering ${MODE_NAME}…`,
  errors: {
    webgl2: `${MODE_NAME} needs WebGL 2`,
    start: (m: string) => `${MODE_NAME} could not start: ${m}`,
    forced: `${MODE_NAME} start was forced to fail (forceSpecialFail)`,
  },
} as const
