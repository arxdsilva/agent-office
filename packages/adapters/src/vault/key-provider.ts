import { createHash } from 'node:crypto'
import { openLine, sealLine } from './aes-box.ts'

/** Wraps the vault's data key with an OS secret (Electron safeStorage in production). */
export interface KeyProvider {
  status(): 'available' | 'unavailable'
  /** Encrypts the data key for storage. Throws when unavailable. */
  wrap(key: Buffer): Buffer
  /** Reverses `wrap`. Throws when unavailable or the blob is not ours. */
  unwrap(blob: Buffer): Buffer
}

const AAD = 'agent-office/key.v1'

/**
 * TEST ONLY. AES-256-GCM wrapping with a master key derived from a fixed, public string.
 * It protects nothing; it exists so tests exercise real wrapping without an OS keychain.
 */
export class TestKeyProvider implements KeyProvider {
  private master: Buffer
  private available: boolean

  constructor(o: { master?: string; available?: boolean } = {}) {
    this.master = createHash('sha256')
      .update(`agent-office-test-master:${o.master ?? 'default'}`)
      .digest()
    this.available = o.available ?? true
  }

  status(): 'available' | 'unavailable' {
    return this.available ? 'available' : 'unavailable'
  }

  wrap(key: Buffer): Buffer {
    this.check()
    return Buffer.from(sealLine(this.master, key, AAD), 'utf8')
  }

  unwrap(blob: Buffer): Buffer {
    this.check()
    return openLine(this.master, blob.toString('utf8'), AAD)
  }

  private check(): void {
    if (!this.available) throw new Error('key provider unavailable')
  }
}
