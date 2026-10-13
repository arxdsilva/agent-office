import { safeStorage } from 'electron'

/** Structurally the adapters' `KeyProvider` (only the composition root may import adapters). */
interface KeyProvider {
  status(): 'available' | 'unavailable'
  wrap(key: Buffer): Buffer
  unwrap(blob: Buffer): Buffer
}

/**
 * Wraps the vault data key with the OS keychain through Electron safeStorage (main only).
 * Fails closed: no encryption, or Linux's plaintext 'basic_text' backend, means 'unavailable'
 * and the vault runs memory-only. Call after `app.whenReady()`.
 */
export class ElectronKeyProvider implements KeyProvider {
  status(): 'available' | 'unavailable' {
    try {
      if (!safeStorage.isEncryptionAvailable()) return 'unavailable'
      const backend = (
        safeStorage as { getSelectedStorageBackend?: () => string }
      ).getSelectedStorageBackend?.()
      return backend === 'basic_text' ? 'unavailable' : 'available'
    } catch {
      return 'unavailable'
    }
  }

  wrap(key: Buffer): Buffer {
    this.check()
    return safeStorage.encryptString(key.toString('base64'))
  }

  unwrap(blob: Buffer): Buffer {
    this.check()
    return Buffer.from(safeStorage.decryptString(blob), 'base64')
  }

  private check(): void {
    if (this.status() !== 'available') throw new Error('OS keychain unavailable')
  }
}
