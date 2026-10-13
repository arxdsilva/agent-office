import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RecordLog, VaultRecord } from '@agent-office/core'
import { describe, expect, it } from 'vitest'
import { FileRecordLog } from './file-record-log.ts'
import { TestKeyProvider } from './key-provider.ts'
import { MemoryRecordLog } from './memory-record-log.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'ao-vault-'))
const rec = (t: string, data: Record<string, unknown> = {}, ts = 1): VaultRecord => ({
  t,
  ts,
  data,
})
const P = 'p/prj_abcdefghij'
const S = 's/ses_0123456789'

/** Every file under `dir`, recursively. */
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  )
}

function shared(name: string, make: () => RecordLog) {
  describe(`${name} (shared behaviour)`, () => {
    it('appends and reads back in order with monotonic seq', async () => {
      const log = make()
      await log.append('catalog', [rec('project', { n: 1 }), rec('session', { n: 2 })])
      await log.append('catalog', [rec('assign', { n: 3 })])
      const out = await log.read('catalog')
      expect(out.map((r) => r.t)).toEqual(['project', 'session', 'assign'])
      expect(out.map((r) => r.seq)).toEqual([1, 2, 3])
      expect(out[0]!.data).toEqual({ n: 1 })
    })

    it('reads an unknown partition as empty and keeps partitions apart', async () => {
      const log = make()
      expect(await log.read(P)).toEqual([])
      await log.append(P, [rec('memory')])
      await log.append(S, [rec('message')])
      expect((await log.read(P)).map((r) => r.t)).toEqual(['memory'])
      expect(await log.partitions('p/')).toEqual([P])
      expect(await log.partitions('')).toEqual([P, S])
    })

    it('compacts to the given records and keeps appending after them', async () => {
      const log = make()
      await log.append(P, [rec('a'), rec('b'), rec('c')])
      await log.compact(P, [rec('c', { kept: true })])
      await log.append(P, [rec('d')])
      const out = await log.read(P)
      expect(out.map((r) => [r.t, r.seq])).toEqual([
        ['c', 1],
        ['d', 2],
      ])
      expect(out[0]!.data).toEqual({ kept: true })
    })

    it('drops a partition', async () => {
      const log = make()
      await log.append(S, [rec('message')])
      await log.drop(S)
      await log.drop(S)
      expect(await log.read(S)).toEqual([])
      expect(await log.partitions('s/')).toEqual([])
    })

    it('rejects partition names outside the grammar', async () => {
      const log = make()
      for (const bad of [
        '../x',
        'p/../catalog',
        'p/prj_short',
        'x/prj_abcdefghij',
        'p/PRJ_ABCDEFGHIJ',
        'catalog/',
        '',
      ]) {
        await expect(log.append(bad, [rec('a')])).rejects.toThrow()
        await expect(log.read(bad)).rejects.toThrow()
        await expect(log.compact(bad, [])).rejects.toThrow()
        await expect(log.drop(bad)).rejects.toThrow()
      }
    })

    it('returns copies, so callers cannot mutate stored records', async () => {
      const log = make()
      const r = rec('a', { v: 1 })
      await log.append(P, [r])
      r.data.v = 2
      const [first] = await log.read(P)
      first!.data.v = 3
      expect((await log.read(P))[0]!.data).toEqual({ v: 1 })
      expect(r.seq).toBeUndefined()
    })
  })
}

shared('MemoryRecordLog', () => new MemoryRecordLog())
shared('FileRecordLog', () => new FileRecordLog({ dir: tmp(), keys: new TestKeyProvider() }))
shared(
  'FileRecordLog (memory-only fallback)',
  () => new FileRecordLog({ dir: tmp(), keys: new TestKeyProvider({ available: false }) }),
)

describe('MemoryRecordLog', () => {
  it('is memory-only', () => {
    expect(new MemoryRecordLog().status()).toBe('memory-only')
  })
})

describe('FileRecordLog', () => {
  const keys = new TestKeyProvider()

  it('is encrypted and creates a wrapped key file with mode 0600 on first open', () => {
    const dir = tmp()
    const log = new FileRecordLog({ dir, keys })
    expect(log.status()).toBe('encrypted')
    const key = join(dir, 'key.v1')
    expect(existsSync(key)).toBe(true)
    if (process.platform !== 'win32') expect(statSync(key).mode & 0o777).toBe(0o600)
  })

  it('never writes the plaintext to disk', async () => {
    const dir = tmp()
    const log = new FileRecordLog({ dir, keys })
    const sentinel = 'SENTINEL-plaintext-7f3a'
    await log.append('catalog', [rec('project', { name: sentinel })])
    await log.append(P, [rec(sentinel, { x: sentinel })])
    await log.compact(P, [rec('memory', { body: sentinel })])
    await log.append(S, [rec('message', { text: sentinel })])
    const all = files(dir)
    expect(all.length).toBeGreaterThanOrEqual(4)
    for (const f of all) {
      const bytes = readFileSync(f)
      expect(bytes.includes(Buffer.from(sentinel))).toBe(false)
      expect(bytes.includes(Buffer.from('SENTINEL'))).toBe(false)
    }
    expect((await log.read(S))[0]!.data.text).toBe(sentinel)
  })

  it('reopen preserves records, order and seq', async () => {
    const dir = tmp()
    const a = new FileRecordLog({ dir, keys })
    await a.append(P, [rec('a'), rec('b')])
    const b = new FileRecordLog({ dir, keys })
    await b.append(P, [rec('c')])
    expect((await b.read(P)).map((r) => [r.t, r.seq])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ])
    expect(await b.partitions('p/')).toEqual([P])
  })

  it('skips and counts a tampered line, and reads the others', async () => {
    const dir = tmp()
    const log = new FileRecordLog({ dir, keys })
    await log.append(P, [rec('a'), rec('b'), rec('c')])
    const file = join(dir, 'p', 'prj_abcdefghij.log')
    const lines = readFileSync(file, 'utf8').split('\n')
    const ct = Buffer.from(lines[1]!.split('.')[2]!, 'base64')
    ct[3] = ct[3]! ^ 0xff
    lines[1] = lines[1]!.split('.').slice(0, 2).concat(ct.toString('base64')).join('.')
    writeFileSync(file, lines.join('\n'))
    const reopened = new FileRecordLog({ dir, keys })
    expect((await reopened.read(P)).map((r) => r.t)).toEqual(['a', 'c'])
    expect(reopened.stats().corrupt).toBe(1)
    await reopened.append(P, [rec('d')])
    expect((await reopened.read(P)).map((r) => [r.t, r.seq])).toEqual([
      ['a', 1],
      ['c', 3],
      ['d', 4],
    ])
  })

  it('detects swapped lines (AAD binds partition and seq)', async () => {
    const dir = tmp()
    const log = new FileRecordLog({ dir, keys })
    await log.append(P, [rec('a'), rec('b')])
    await log.append(S, [rec('x')])
    const pf = join(dir, 'p', 'prj_abcdefghij.log')
    const [l1, l2] = readFileSync(pf, 'utf8').split('\n')
    const [sl] = readFileSync(join(dir, 's', 'ses_0123456789.log'), 'utf8').split('\n')
    // Lines moved between positions or partitions fail authentication.
    writeFileSync(pf, `${l2}\n${l1}\n${sl}\n`)
    const reopened = new FileRecordLog({ dir, keys })
    expect(await reopened.read(P)).toEqual([])
  })

  it('survives a torn last line', async () => {
    const dir = tmp()
    const log = new FileRecordLog({ dir, keys })
    await log.append(P, [rec('a')])
    const file = join(dir, 'p', 'prj_abcdefghij.log')
    writeFileSync(file, `${readFileSync(file, 'utf8')}1.abc`)
    const reopened = new FileRecordLog({ dir, keys })
    await reopened.append(P, [rec('b')])
    expect((await reopened.read(P)).map((r) => [r.t, r.seq])).toEqual([
      ['a', 1],
      ['b', 3],
    ])
    expect(reopened.stats().corrupt).toBe(1)
  })

  it('skips lines that decrypt to something that is not a record', async () => {
    const dir = tmp()
    const log = new FileRecordLog({ dir, keys })
    await log.append(P, [rec('a'), { t: 5, ts: 'x', data: [] } as unknown as VaultRecord])
    expect((await log.read(P)).map((r) => r.t)).toEqual(['a'])
    expect(log.stats().corrupt).toBe(1)
  })

  it('quarantines a file with no readable line as .corrupt-<ts> and starts it fresh', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'p'), { recursive: true })
    const file = join(dir, 'p', 'prj_abcdefghij.log')
    writeFileSync(file, 'not\nencrypted\n')
    const log = new FileRecordLog({ dir, keys, now: () => 1234 })
    expect(await log.read(P)).toEqual([])
    expect(existsSync(file)).toBe(false)
    expect(readFileSync(`${file}.corrupt-1234`, 'utf8')).toBe('not\nencrypted\n')
    await log.append(P, [rec('a')])
    expect((await log.read(P)).map((r) => [r.t, r.seq])).toEqual([['a', 1]])
    expect(await log.partitions('p/')).toEqual([P])
  })

  it('quarantines a file it cannot read at all', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'p', 'prj_abcdefghij.log'), { recursive: true })
    const log = new FileRecordLog({ dir, keys, now: () => 9 })
    expect(await log.read(P)).toEqual([])
    expect(existsSync(join(dir, 'p', 'prj_abcdefghij.log.corrupt-9'))).toBe(true)
  })

  it('a wrong key means memory-only, and the key file is never overwritten', async () => {
    const dir = tmp()
    const first = new FileRecordLog({ dir, keys })
    await first.append('catalog', [rec('project')])
    const keyFile = join(dir, 'key.v1')
    const before = readFileSync(keyFile)
    const warnings: string[] = []
    const wrong = new FileRecordLog({
      dir,
      keys: new TestKeyProvider({ master: 'another-machine' }),
      log: { info: () => {}, warn: (m) => warnings.push(m) },
    })
    expect(wrong.status()).toBe('memory-only')
    expect(await wrong.read('catalog')).toEqual([])
    await wrong.append('catalog', [rec('x')])
    expect(readFileSync(keyFile).equals(before)).toBe(true)
    expect(warnings.join(' ')).not.toContain(dir)
    expect((await new FileRecordLog({ dir, keys }).read('catalog')).map((r) => r.t)).toEqual([
      'project',
    ])
  })

  it('a corrupt key file means memory-only too', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'key.v1'), 'junk')
    expect(new FileRecordLog({ dir, keys }).status()).toBe('memory-only')
    expect(readFileSync(join(dir, 'key.v1'), 'utf8')).toBe('junk')
  })

  it('no keychain means memory-only and nothing is written', async () => {
    const dir = tmp()
    const log = new FileRecordLog({ dir, keys: new TestKeyProvider({ available: false }) })
    expect(log.status()).toBe('memory-only')
    await log.append('catalog', [rec('a')])
    expect(files(dir)).toEqual([])
  })

  it('a provider that throws while wrapping means memory-only', () => {
    const dir = tmp()
    const keysBroken = {
      status: () => 'available' as const,
      wrap: () => {
        throw new Error('keychain locked')
      },
      unwrap: () => Buffer.alloc(32),
    }
    expect(new FileRecordLog({ dir, keys: keysBroken }).status()).toBe('memory-only')
    expect(existsSync(join(dir, 'key.v1'))).toBe(false)
  })

  it('compaction preserves state across reopen and leaves no temp files', async () => {
    const dir = tmp()
    const log = new FileRecordLog({ dir, keys })
    await log.append(P, [rec('a', { v: 1 }), rec('b', { v: 2 })])
    const state = await log.read(P)
    await log.compact(P, state)
    const reopened = new FileRecordLog({ dir, keys })
    expect(await reopened.read(P)).toEqual(state)
    expect(files(dir).some((f) => f.includes('.tmp'))).toBe(false)
    await reopened.compact(S, [])
    expect(await reopened.read(S)).toEqual([])
  })

  it('reports when a partition needs compaction', async () => {
    const dir = tmp()
    const log = new FileRecordLog({ dir, keys, compactBytes: 512 })
    expect(await log.needsCompaction(P)).toBe(false)
    await log.append(P, [rec('a', { pad: 'x'.repeat(600) })])
    expect(await log.needsCompaction(P)).toBe(true)
    await log.compact(P, [])
    expect(await log.needsCompaction(P)).toBe(false)
    expect(await new MemoryRecordLog().needsCompaction(P)).toBe(false)
  })

  it('defaults the compaction threshold to 2 MB', () => {
    expect(FileRecordLog.COMPACT_BYTES).toBe(2 * 1024 * 1024)
  })

  it('serialises concurrent appends to one partition', async () => {
    const dir = tmp()
    const log = new FileRecordLog({ dir, keys })
    await Promise.all(Array.from({ length: 20 }, (_, i) => log.append(P, [rec('m', { i })])))
    const out = await new FileRecordLog({ dir, keys }).read(P)
    expect(out.map((r) => r.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
  })

  it('lists partitions only from well-formed file names', async () => {
    const dir = tmp()
    const log = new FileRecordLog({ dir, keys })
    await log.append('catalog', [rec('a')])
    await log.append(P, [rec('a')])
    writeFileSync(join(dir, 'p', 'evil name.log'), '')
    writeFileSync(join(dir, 'p', 'prj_abcdefghij.log.corrupt-1'), '')
    expect(await log.partitions('')).toEqual(['catalog', P])
    expect(await log.partitions('s/')).toEqual([])
  })
})
