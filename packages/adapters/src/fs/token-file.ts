import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Reads `<dir>/token`, creating a random one (mode 0600) on first run. Shared with the hook script. */
export function loadOrCreateToken(dir: string): string {
  const file = join(dir, 'token')
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(t)) return t
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const token = randomBytes(32).toString('hex')
  writeFileSync(file, token + '\n', { mode: 0o600 })
  chmodSync(file, 0o600)
  return token
}
