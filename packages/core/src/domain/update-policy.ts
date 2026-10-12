import type { UpdatePolicy } from '@agent-office/shared'

export interface UpdateEnvironment {
  packaged: boolean
  platform: string
  /** macOS builds can only self-update when code-signed (Squirrel.Mac). */
  signed: boolean
  /** Only AppImage can replace itself on Linux; .deb installs are managed by the package manager. */
  linuxAppImage: boolean
  enabled: boolean
}

export function updatePolicy(env: UpdateEnvironment): UpdatePolicy {
  if (!env.packaged || !env.enabled) return 'off'
  if (env.platform === 'darwin' && !env.signed) return 'notify-only'
  if (env.platform === 'linux' && !env.linuxAppImage) return 'notify-only'
  return 'auto'
}
