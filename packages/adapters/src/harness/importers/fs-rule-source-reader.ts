import { createHash } from 'node:crypto'
import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { formatOf } from '@agent-office/core'
import type { RuleSourceFile, RuleSourceReader } from '@agent-office/core'

/** Limits from docs/harness.md §6. */
export const RULE_SOURCE_LIMITS = {
  maxFileBytes: 256 * 1024,
  parseBytes: 64 * 1024,
  maxFiles: 200,
  maxEntries: 2000,
  maxDepth: 4,
} as const

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'coverage'])
const ALLOWED_HIDDEN = new Set(['.claude', '.cursor', '.github'])

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/**
 * Finds and reads rule files of one repository. Read-only: never follows symlinks, never executes
 * anything, never returns an absolute path. Bounded by RULE_SOURCE_LIMITS.
 */
export class FsRuleSourceReader implements RuleSourceReader {
  async detect(repoPath: string): Promise<RuleSourceFile[]> {
    const L = RULE_SOURCE_LIMITS
    const found: RuleSourceFile[] = []
    let entries = 0

    const walk = async (rel: string, depth: number): Promise<void> => {
      if (depth > L.maxDepth || entries >= L.maxEntries || found.length >= L.maxFiles) return
      let names: string[]
      try {
        names = await readdir(join(repoPath, rel))
      } catch {
        return
      }
      names.sort()
      for (const name of names) {
        if (entries >= L.maxEntries || found.length >= L.maxFiles) return
        entries++
        const relPath = rel ? `${rel}/${name}` : name
        let st
        try {
          st = await lstat(join(repoPath, relPath))
        } catch {
          continue
        }
        if (st.isSymbolicLink()) continue
        if (st.isDirectory()) {
          if (SKIP_DIRS.has(name)) continue
          if (name.startsWith('.') && !ALLOWED_HIDDEN.has(name)) continue
          await walk(relPath, depth + 1)
        } else if (st.isFile()) {
          const format = formatOf(relPath)
          if (!format || format === 'manual' || format === 'template' || st.size > L.maxFileBytes)
            continue
          const buf = await readWhole(join(repoPath, relPath))
          if (!buf) continue
          found.push({ path: relPath, format, bytes: st.size, hash: sha256(buf) })
        }
      }
    }
    await walk('', 0)
    return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }

  async read(repoPath: string, relPath: string): Promise<{ text: string; hash: string }> {
    if (!relPath || relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath) || relPath.includes('\\'))
      throw new Error('invalid rule source path')
    if (relPath.split('/').some((s) => s === '..' || s === ''))
      throw new Error('invalid rule source path')
    const full = join(repoPath, relPath)
    const st = await lstat(full)
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('not a regular file')
    if (st.size > RULE_SOURCE_LIMITS.maxFileBytes) throw new Error('file too large')
    const whole = await readWhole(full)
    if (!whole) throw new Error('unreadable file')
    return {
      text: whole.subarray(0, RULE_SOURCE_LIMITS.parseBytes).toString('utf8'),
      hash: sha256(whole),
    }
  }
}

async function readWhole(path: string): Promise<Buffer | undefined> {
  try {
    const fh = await open(path, 'r')
    try {
      return await fh.readFile()
    } finally {
      await fh.close()
    }
  } catch {
    return undefined
  }
}
