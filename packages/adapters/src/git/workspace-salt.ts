import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Reads `<dir>/workspace-salt` (32 random bytes as 64 hex chars, mode 0600), creating it on first
 * run. Lives next to the token file; the observe hook reads the same file to compute `wk_` keys.
 */
export function loadOrCreateWorkspaceSalt(dir: string): Buffer {
  const file = join(dir, 'workspace-salt')
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(t)) return Buffer.from(t, 'hex')
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const salt = randomBytes(32)
  writeFileSync(file, salt.toString('hex') + '\n', { mode: 0o600 })
  chmodSync(file, 0o600)
  return salt
}
