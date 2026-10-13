import { execFile } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import type { RepoIdentity, RepoIdentityInfo } from '@agent-office/core'

export type RunGit = (file: string, args: string[], o: { timeoutMs: number }) => Promise<string>

export interface GitRepoIdentityOptions {
  /** Secret salt for the HMAC keys (see `loadOrCreateWorkspaceSalt`). */
  salt: Buffer
  git?: string
  timeoutMs?: number
  /** Injectable process runner (defaults to `execFile` with `shell: false`). Resolves stdout. */
  run?: RunGit
  now?: () => number
}

const CACHE_MS = 60_000

const defaultRun: RunGit = (file, args, { timeoutMs }) =>
  new Promise((res, rej) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, shell: false, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => (err ? rej(err) : res(stdout)),
    )
  })

/**
 * Normalizes a git remote URL to `host/path`: no userinfo, query or fragment, lowercase host,
 * no `.git` suffix. Returns undefined for anything unparseable (local paths included).
 */
export function normalizeRemote(raw: string): string | undefined {
  let s = raw.trim()
  if (!s) return undefined
  let host: string
  let path: string
  const scheme = s.match(/^[a-z][a-z0-9+.-]*:\/\/(.*)$/i)
  if (scheme) {
    s = scheme[1]!.replace(/[?#].*$/, '')
    const slash = s.indexOf('/')
    if (slash < 0) return undefined
    host = s.slice(0, slash)
    path = s.slice(slash + 1)
    host = host.slice(host.lastIndexOf('@') + 1).replace(/:\d*$/, '')
  } else {
    const scp = s.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/)
    if (!scp) return undefined
    host = scp[1]!
    path = scp[2]!.replace(/[?#].*$/, '')
  }
  path = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
  host = host.toLowerCase()
  return host && path ? `${host}/${path}` : undefined
}

/** Resolves directories to repository identities by shelling out to `git` (main process only). */
export class GitRepoIdentity implements RepoIdentity {
  private cache = new Map<string, { at: number; info: RepoIdentityInfo | null }>()
  private git: string
  private timeoutMs: number
  private run: RunGit
  private now: () => number

  constructor(private o: GitRepoIdentityOptions) {
    this.git = o.git ?? 'git'
    this.timeoutMs = o.timeoutMs ?? 2000
    this.run = o.run ?? defaultRun
    this.now = o.now ?? Date.now
  }

  key(realPath: string): string {
    return createHmac('sha256', this.o.salt).update(realPath).digest('hex').slice(0, 32)
  }

  async resolve(locator: string): Promise<RepoIdentityInfo | null> {
    try {
      const dir = await realpath(locator)
      const hit = this.cache.get(dir)
      if (hit && this.now() - hit.at < CACHE_MS) return hit.info
      const info = (await this.fromGit(dir)) ?? this.fallback(dir)
      this.cache.set(dir, { at: this.now(), info })
      return info
    } catch {
      return null
    }
  }

  async workspaceKey(locator: string): Promise<string | null> {
    const info = await this.resolve(locator)
    return info ? `wk_${info.commonDirKey}` : null
  }

  private fallback(dir: string): RepoIdentityInfo {
    const k = this.key(dir)
    return {
      commonDirKey: k,
      rootKey: k,
      remotes: [],
      name: basename(dir),
      isWorktree: false,
      relPath: '',
    }
  }

  private async git_(dir: string, args: string[]): Promise<string> {
    return this.run(this.git, ['-C', dir, ...args], { timeoutMs: this.timeoutMs })
  }

  private async fromGit(dir: string): Promise<RepoIdentityInfo | null> {
    let top: string
    let common: string
    try {
      const out = await this.git_(dir, [
        'rev-parse',
        '--show-toplevel',
        '--git-common-dir',
        '--is-inside-work-tree',
      ])
      const [t, c, inside] = out.split('\n').map((l) => l.trim())
      if (!t || !c || inside !== 'true') return null
      top = await realpath(t)
      common = await realpath(resolve(dir, c))
    } catch {
      return null
    }
    let rootCommit: string | undefined
    try {
      const hashes = (await this.git_(dir, ['rev-list', '--max-parents=0', 'HEAD']))
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^[0-9a-f]{40,64}$/.test(l))
        .sort()
      rootCommit = hashes[0]
    } catch {
      /* no commits yet */
    }
    const remotes = new Set<string>()
    try {
      for (const line of (await this.git_(dir, ['remote', '-v'])).split('\n')) {
        const m = line.match(/^\S+\s+(\S+)\s+\(fetch\)$/)
        const n = m && normalizeRemote(m[1]!)
        if (n) remotes.add(n)
      }
    } catch {
      /* no remotes */
    }
    const rel = relative(top, dir)
    return {
      commonDirKey: this.key(common),
      rootKey: this.key(top),
      ...(rootCommit ? { rootCommit } : {}),
      remotes: [...remotes],
      name: basename(top),
      isWorktree: common !== join(top, '.git'),
      relPath: rel.split(sep).join('/'),
    }
  }
}
