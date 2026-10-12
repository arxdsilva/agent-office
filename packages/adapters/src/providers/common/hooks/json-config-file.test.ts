import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jsonConfigStoreContract } from '@agent-office/core/testing'
import { describe, expect, it } from 'vitest'
import { JsonConfigFile } from './json-config-file.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'ao-jc-'))

jsonConfigStoreContract('JsonConfigFile', async (initial) => {
  const file = join(tmp(), '.cursor', 'hooks.json')
  if (initial !== undefined) {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, initial)
  }
  return { store: new JsonConfigFile(file) }
})

describe('JsonConfigFile details', () => {
  it('creates missing parents and writes 2-space JSON with a trailing newline, no backup', async () => {
    const file = join(tmp(), 'a', 'b', 'c.json')
    const store = new JsonConfigFile(file)
    await store.write({ a: 1 })
    expect(readFileSync(file, 'utf8')).toBe('{\n  "a": 1\n}\n')
    expect(existsSync(store.backupPath)).toBe(false)
  })

  it('backs up the original once and never overwrites the backup', async () => {
    const file = join(tmp(), 'c.json')
    writeFileSync(file, '{"orig":true}')
    const store = new JsonConfigFile(file)
    await store.write({ v: 1 })
    await store.write({ v: 2 })
    expect(readFileSync(store.backupPath, 'utf8')).toBe('{"orig":true}')
    expect(await store.read()).toEqual({ v: 2 })
  })

  it('refuses non-object JSON and rethrows other read errors', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'arr.json'), '[1]')
    await expect(new JsonConfigFile(join(dir, 'arr.json')).read()).rejects.toThrow(/not valid JSON/)
    // A directory in place of the file: EISDIR, not ENOENT.
    await expect(new JsonConfigFile(dir).read()).rejects.toThrow()
  })
})
