import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { RepoFiles } from '@agent-office/core'

const MAX_ENTRIES = 2000
const MAX_DEPTH = 8
const SKIP = new Set(['node_modules', '.git'])

/** A glob (`**`, `*`, `?`) over '/'-separated relative paths, as a regular expression. */
function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') {
        i++
        out += '(?:.*/)?'
      } else out += '.*'
    } else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

/**
 * Read-only "does a file match" probe for flow checks. Bounded (≤ 2 000 directory entries, depth
 * ≤ 8), never follows symlinks, skips `node_modules` and `.git`, and refuses absolute paths and
 * `..` segments. It reads names and types only, never file contents.
 */
export class FsRepoFiles implements RepoFiles {
  async exists(repoPath: string, relGlob: string): Promise<boolean> {
    try {
      if (
        !relGlob ||
        relGlob.startsWith('/') ||
        relGlob.startsWith('\\') ||
        /^[A-Za-z]:/.test(relGlob)
      )
        return false
      const segs = relGlob.split('/')
      if (segs.some((s) => s === '..' || s.includes('\\'))) return false
      // Static prefix: the leading segments without wildcards.
      const wild = segs.findIndex((s) => /[*?]/.test(s))
      if (wild === -1) return await this.isRegularFile(repoPath, segs)
      const prefix = segs.slice(0, wild)
      if (!(await this.dirChain(repoPath, prefix))) return false
      const re = globToRegExp(relGlob)
      let budget = MAX_ENTRIES
      const walk = async (rel: string[]): Promise<boolean> => {
        if (rel.length >= MAX_DEPTH) return false
        const entries = await readdir(join(repoPath, ...rel), { withFileTypes: true })
        const dirs: string[] = []
        for (const e of entries) {
          if (--budget < 0) return false
          const path = [...rel, e.name]
          if (e.isFile() && re.test(path.join('/'))) return true
          if (e.isDirectory() && !SKIP.has(e.name)) dirs.push(e.name)
        }
        for (const d of dirs) if (await walk([...rel, d])) return true
        return false
      }
      return await walk(prefix)
    } catch {
      return false
    }
  }

  /** Every component exists and is a real directory (no symlinks). */
  private async dirChain(root: string, segs: string[]): Promise<boolean> {
    for (let i = 0; i <= segs.length; i++) {
      const st = await lstat(join(root, ...segs.slice(0, i)))
      if (!st.isDirectory()) return false
    }
    return true
  }

  private async isRegularFile(root: string, segs: string[]): Promise<boolean> {
    if (segs.length > 1 && !(await this.dirChain(root, segs.slice(0, -1)))) return false
    return (await lstat(join(root, ...segs))).isFile()
  }
}
