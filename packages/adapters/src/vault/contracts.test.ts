import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordLogContract, searchIndexContract } from '@agent-office/core/testing'
import { FileRecordLog } from './file-record-log.ts'
import { TestKeyProvider } from './key-provider.ts'
import { MemoryRecordLog } from './memory-record-log.ts'
import { TextIndex } from './text-index.ts'

recordLogContract('FileRecordLog (encrypted)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ao-vault-contract-'))
  const keys = new TestKeyProvider()
  return {
    log: new FileRecordLog({ dir, keys }),
    reopen: async () => new FileRecordLog({ dir, keys }),
    // Flip one ciphertext byte of the second line.
    corrupt: async (partition) => {
      const file = join(dir, `${partition}.log`)
      const lines = readFileSync(file, 'utf8').split('\n')
      const [v, iv, ct] = lines[1]!.split('.') as [string, string, string]
      const bytes = Buffer.from(ct, 'base64')
      bytes[0] = bytes[0]! ^ 0x01
      lines[1] = `${v}.${iv}.${bytes.toString('base64')}`
      writeFileSync(file, lines.join('\n'))
    },
  }
})

recordLogContract('MemoryRecordLog', async () => {
  const log = new MemoryRecordLog()
  return { log, reopen: async () => log }
})

searchIndexContract('TextIndex', () => new TextIndex())
