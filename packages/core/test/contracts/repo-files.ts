// Contract for `RepoFiles` (docs/harness.md §2a): a bounded, read-only "does a file match" probe.
import { describe, expect, it } from 'vitest'
import type { RepoFiles } from '../../src/ports/driven.ts'

/** What the implementation under test must hold. Paths are repo-relative, '/'-separated. */
export interface RepoLayout {
  /** Regular files inside the repo. */
  files: string[]
  /** Directories inside the repo (kept even when empty). */
  dirs: string[]
  /** Symlinks inside the repo pointing at a regular file outside it. */
  outsideLinks: string[]
}

export interface RepoFilesFixture {
  /** The repo root handed to `exists`. */
  repoPath: string
  port: RepoFiles
  dispose?(): void | Promise<void>
}

export function repoFilesContract(
  name: string,
  make: (layout: RepoLayout) => Promise<RepoFilesFixture>,
): void {
  const layout: RepoLayout = {
    files: ['README.md', 'docs/spec.md', 'docs/deep/notes.md', 'src/a.ts', 'src/b.ts'],
    dirs: ['emptydir', 'docs/folder.md'],
    outsideLinks: ['linked.md'],
  }
  const check = async (rel: string) => {
    const fx = await make(layout)
    try {
      return await fx.port.exists(fx.repoPath, rel)
    } finally {
      await fx.dispose?.()
    }
  }

  describe(`${name} (RepoFiles contract)`, () => {
    it('matches a literal path to a file', async () => {
      expect(await check('README.md')).toBe(true)
      expect(await check('docs/spec.md')).toBe(true)
    })
    it('matches ** across directories and * / ? within one', async () => {
      expect(await check('docs/**/*.md')).toBe(true)
      expect(await check('**/notes.md')).toBe(true)
      expect(await check('src/*.ts')).toBe(true)
      expect(await check('src/?.ts')).toBe(true)
      expect(await check('docs/*/notes.md')).toBe(true)
    })
    it('is false when nothing matches', async () => {
      expect(await check('missing.md')).toBe(false)
      expect(await check('src/*.go')).toBe(false)
      expect(await check('nothing/**/*.md')).toBe(false)
    })
    it('does not match a directory, even one named like a file', async () => {
      expect(await check('emptydir')).toBe(false)
      expect(await check('docs/folder.md')).toBe(false)
    })
    it('does not match a symlink to a file outside the repo', async () => {
      expect(await check('linked.md')).toBe(false)
      expect(await check('*.md')).toBe(true) // README.md still matches
      expect(await check('link*.md')).toBe(false)
    })
    it('refuses `..` segments', async () => {
      expect(await check('../README.md')).toBe(false)
      expect(await check('docs/../README.md')).toBe(false)
      expect(await check('**/../README.md')).toBe(false)
    })
    it('refuses absolute paths', async () => {
      expect(await check('/etc/passwd')).toBe(false)
      expect(await check('C:\\Windows\\win.ini')).toBe(false)
      expect(await check('')).toBe(false)
    })
  })
}
