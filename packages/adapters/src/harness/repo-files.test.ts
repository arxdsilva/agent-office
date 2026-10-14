import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FsRepoFiles } from './repo-files.ts'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ao-repofiles-bounds-'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('FsRepoFiles bounds', () => {
  const fs = new FsRepoFiles()

  it('skips node_modules and .git', async () => {
    await mkdir(join(root, 'node_modules/p'), { recursive: true })
    await writeFile(join(root, 'node_modules/p/a.md'), 'x')
    await mkdir(join(root, '.git'))
    await writeFile(join(root, '.git/b.md'), 'x')
    expect(await fs.exists(root, '**/*.md')).toBe(false)
  })

  it('does not look deeper than 8 levels', async () => {
    const deep = join(root, 'a/b/c/d/e/f/g/h/i')
    await mkdir(deep, { recursive: true })
    await writeFile(join(deep, 'x.md'), 'x')
    expect(await fs.exists(root, '**/x.md')).toBe(false)
    await writeFile(join(root, 'a/b/c/d/e/f/y.md'), 'x')
    expect(await fs.exists(root, '**/y.md')).toBe(true)
  })

  it('gives up after 2 000 directory entries', async () => {
    await mkdir(join(root, 'many'))
    for (let i = 0; i < 2100; i++) await writeFile(join(root, 'many', `f${i}.txt`), '')
    await writeFile(join(root, 'many', 'zz.md'), '')
    expect(await fs.exists(root, 'many/*.md')).toBe(false)
  })

  it('does not follow a symlinked directory, in a literal path or a glob', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ao-repofiles-out-'))
    await writeFile(join(outside, 'o.md'), 'x')
    await symlink(outside, join(root, 'link'))
    expect(await fs.exists(root, 'link/o.md')).toBe(false)
    expect(await fs.exists(root, '**/o.md')).toBe(false)
    expect(await fs.exists(root, 'link/*.md')).toBe(false)
    await rm(outside, { recursive: true, force: true })
  })

  it('is false for a missing repo or a backslash path', async () => {
    expect(await fs.exists(join(root, 'nope'), '**/*.md')).toBe(false)
    expect(await fs.exists(root, 'a\\b.md')).toBe(false)
  })
})
