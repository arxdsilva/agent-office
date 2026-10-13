import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const VERSION = '1'
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const B64 = /^[A-Za-z0-9+/]*={0,2}$/

function checkKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error('aes-box: key must be 32 bytes')
}

/** AES-256-GCM: returns one line `1.<b64 iv>.<b64 ciphertext+tag>`, authenticated with `aad`. */
export function sealLine(key: Buffer, plaintext: string | Buffer, aad: string): string {
  checkKey(key)
  const iv = randomBytes(IV_BYTES)
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  c.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()])
  return `${VERSION}.${iv.toString('base64')}.${ct.toString('base64')}`
}

/** Opens a `sealLine` line. Throws on a bad format, a wrong key or AAD, or any tampering. */
export function openLine(key: Buffer, line: string, aad: string): Buffer {
  checkKey(key)
  const parts = line.split('.')
  if (parts.length !== 3 || parts[0] !== VERSION) throw new Error('aes-box: bad line')
  const [, ivB64, ctB64] = parts as [string, string, string]
  if (!B64.test(ivB64) || !B64.test(ctB64)) throw new Error('aes-box: bad line')
  const iv = Buffer.from(ivB64, 'base64')
  const ct = Buffer.from(ctB64, 'base64')
  if (iv.length !== IV_BYTES || ct.length < TAG_BYTES) throw new Error('aes-box: bad line')
  const d = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  d.setAAD(Buffer.from(aad, 'utf8'))
  d.setAuthTag(ct.subarray(ct.length - TAG_BYTES))
  return Buffer.concat([d.update(ct.subarray(0, ct.length - TAG_BYTES)), d.final()])
}
