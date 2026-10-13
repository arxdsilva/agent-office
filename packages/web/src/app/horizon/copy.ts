// Every user-facing string of the Horizon view mode (docs/horizon). Plain text only.

/** The mode's user-facing name: change it here only (the toggle, intro and errors use it). */
export const MODE_NAME = 'Horizon'

export const HORIZON_COPY = {
  mode: MODE_NAME,
  intro: {
    title: `Welcome to ${MODE_NAME}`,
    body: `${MODE_NAME} is a lighter, futuristic version of your office. Same rooms, same agents.`,
    continue: 'Continue',
    back: 'Back to Classic',
  },
  failure: {
    title: `${MODE_NAME} could not start`,
    body: 'Your agents and sessions are untouched. Pick another view:',
    classic: 'Classic 3D',
    rpg: '2D RPG',
  },
  errors: {
    forced: `${MODE_NAME} start was forced to fail (forceSpecialFail)`,
  },
} as const
