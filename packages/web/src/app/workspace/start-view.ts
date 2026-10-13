import type { Settings } from '@agent-office/shared'

/** Where the app opens: the Overview once a project exists (auto), else the Office. */
export function startView(
  setting: Settings['startView'],
  projectCount: number,
): 'overview' | 'office' {
  if (setting === 'overview') return 'overview'
  if (setting === 'office') return 'office'
  return projectCount >= 1 ? 'overview' : 'office'
}
