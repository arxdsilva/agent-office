import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs script, no types
import { workspaceKey as hookKey } from '../../../../hooks/agent-office-observe.mjs'
import { GitRepoIdentity, normalizeRemote } from './git-repo-identity.ts'
import { loadOrCreateWorkspaceSalt } from './workspace-salt.ts'

const root = mkdtempSync(join(tmpdir(), 'ao-git-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const env = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  PATH: process.env.PATH ?? '',
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env, stdio: 'pipe' }).toString()
function repo(name: string, msg = 'init'): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), msg)
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', msg)
  return dir
}

const saltDir = join(root, 'home')
const salt = loadOrCreateWorkspaceSalt(saltDir)
const id = new GitRepoIdentity({ salt })

describe('workspace salt', () => {
  it('creates a 0600 hex file once and reuses it', () => {
    expect(salt).toHaveLength(32)
    expect(statSync(join(saltDir, 'workspace-salt')).mode & 0o777).toBe(0o600)
    expect(loadOrCreateWorkspaceSalt(saltDir).equals(salt)).toBe(true)
  })
  it('replaces a malformed file', () => {
    const d = join(root, 'badsalt')
    mkdirSync(d)
    writeFileSync(join(d, 'workspace-salt'), 'nope')
    expect(loadOrCreateWorkspaceSalt(d)).toHaveLength(32)
  })
})

describe('GitRepoIdentity (real repos)', () => {
  it('identifies a repo, its root commit and subdirectory', async () => {
    const dir = repo('one')
    mkdirSync(join(dir, 'pkg/x'), { recursive: true })
    const a = await id.resolve(dir)
    const sub = await id.resolve(join(dir, 'pkg/x'))
    expect(a).toMatchObject({ name: 'one', isWorktree: false, relPath: '', remotes: [] })
    expect(a?.rootCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(a?.commonDirKey).toMatch(/^[0-9a-f]{32}$/)
    expect(sub?.relPath).toBe('pkg/x')
    expect(sub?.commonDirKey).toBe(a?.commonDirKey)
    expect(sub?.rootKey).toBe(a?.rootKey)
  })

  it('a worktree shares the commonDirKey but not the rootKey', async () => {
    const dir = repo('wt-main')
    const wt = join(root, 'wt-linked')
    git(dir, 'worktree', 'add', '-q', '-b', 'feat', wt)
    const a = await id.resolve(dir)
    const b = await id.resolve(wt)
    expect(b?.isWorktree).toBe(true)
    expect(a?.isWorktree).toBe(false)
    expect(b?.commonDirKey).toBe(a?.commonDirKey)
    expect(b?.rootKey).not.toBe(a?.rootKey)
    expect(b?.rootCommit).toBe(a?.rootCommit)
  })

  it('a moved clone keeps its rootCommit and remotes; a clone shares the rootCommit', async () => {
    const dir = repo('movable')
    git(dir, 'remote', 'add', 'origin', 'https://user:SECRET-TOKEN@GitHub.com/Acme/Thing.git?x=1#f')
    const before = await new GitRepoIdentity({ salt }).resolve(dir)
    const moved = join(root, 'moved-elsewhere')
    renameSync(dir, moved)
    const after = await new GitRepoIdentity({ salt }).resolve(moved)
    expect(after?.rootCommit).toBe(before?.rootCommit)
    expect(after?.remotes).toEqual(['github.com/Acme/Thing'])
    expect(after?.name).toBe('moved-elsewhere')
    const clone = join(root, 'clone-of-moved')
    git(root, 'clone', '-q', moved, clone)
    const c = await id.resolve(clone)
    expect(c?.rootCommit).toBe(after?.rootCommit)
    expect(c?.commonDirKey).not.toBe(after?.commonDirKey)
    expect(JSON.stringify([before, after, c])).not.toContain('SECRET-TOKEN')
  })

  it('two repos with the same basename differ', async () => {
    const a = repo('same-a/app', 'one')
    const b = repo('same-b/app', 'two')
    const [x, y] = [await id.resolve(a), await id.resolve(b)]
    expect(x?.name).toBe(y?.name)
    expect(x?.commonDirKey).not.toBe(y?.commonDirKey)
    expect(x?.rootCommit).not.toBe(y?.rootCommit)
  })

  it('a repo without commits has no rootCommit', async () => {
    const dir = join(root, 'empty')
    mkdirSync(dir)
    git(dir, 'init', '-q')
    const i = await id.resolve(dir)
    expect(i?.rootCommit).toBeUndefined()
    expect(i?.commonDirKey).toMatch(/^[0-9a-f]{32}$/)
  })

  it('a plain directory gets a realpath-only identity', async () => {
    const dir = join(root, 'plain')
    mkdirSync(dir)
    const i = await id.resolve(dir)
    expect(i).toMatchObject({ name: 'plain', remotes: [], relPath: '', isWorktree: false })
    expect(i?.rootKey).toBe(i?.commonDirKey)
    expect(i?.rootCommit).toBeUndefined()
  })

  it('returns null for a missing directory and never throws', async () => {
    expect(await id.resolve(join(root, 'nope'))).toBeNull()
    expect(await id.workspaceKey(join(root, 'nope'))).toBeNull()
  })

  it('a different salt gives different keys', async () => {
    const dir = repo('salted')
    const other = new GitRepoIdentity({ salt: Buffer.alloc(32, 7) })
    expect((await other.resolve(dir))?.commonDirKey).not.toBe((await id.resolve(dir))?.commonDirKey)
  })

  it('falls back to a plain identity when git fails', async () => {
    const dir = repo('gitless')
    const bad = new GitRepoIdentity({
      salt,
      run: async () => {
        throw new Error('ENOENT')
      },
    })
    const i = await bad.resolve(dir)
    expect(i?.rootKey).toBe(i?.commonDirKey)
    expect(i?.remotes).toEqual([])
  })

  it('caches for 60 s then runs git again', async () => {
    const dir = repo('cached')
    let calls = 0
    let t = 0
    const real = new GitRepoIdentity({ salt })
    const counting = new GitRepoIdentity({
      salt,
      now: () => t,
      run: async (f, a) => {
        calls++
        return execFileSync(f, a, { env }).toString()
      },
    })
    void real
    await counting.resolve(dir)
    const first = calls
    await counting.resolve(dir)
    expect(calls).toBe(first)
    t = 61_000
    await counting.resolve(dir)
    expect(calls).toBe(first * 2)
  })

  it('treats a bare repo as a plain directory', async () => {
    const dir = join(root, 'bare.git')
    mkdirSync(dir)
    git(dir, 'init', '-q', '--bare')
    const i = await id.resolve(dir)
    expect(i?.rootKey).toBe(i?.commonDirKey)
  })
})

describe('workspaceKey and the observe hook agree', () => {
  const saltFile = join(saltDir, 'workspace-salt')
  const hookEnv = { AGENT_OFFICE_WORKSPACE_SALT_FILE: saltFile }

  it('same key for a normal repo (and a subdirectory)', async () => {
    const dir = repo('hook-normal')
    mkdirSync(join(dir, 'deep/er'), { recursive: true })
    const k = await id.workspaceKey(dir)
    expect(k).toMatch(/^wk_[0-9a-f]{32}$/)
    expect(hookKey(dir, hookEnv)).toBe(k)
    expect(hookKey(join(dir, 'deep/er'), hookEnv)).toBe(k)
  })

  it('same key for a linked worktree', async () => {
    const dir = repo('hook-wt')
    const wt = join(root, 'hook-wt-linked')
    git(dir, 'worktree', 'add', '-q', '-b', 'b2', wt)
    const k = await id.workspaceKey(wt)
    expect(k).toBe(await id.workspaceKey(dir))
    expect(hookKey(wt, hookEnv)).toBe(k)
  })

  it('hook omits the key outside git or without a usable salt', () => {
    const plain = join(root, 'plain')
    expect(hookKey(plain, hookEnv)).toBeUndefined()
    expect(
      hookKey(repo('hook-nosalt'), { AGENT_OFFICE_WORKSPACE_SALT_FILE: join(root, 'missing') }),
    ).toBeUndefined()
    expect(readFileSync(saltFile, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('normalizeRemote', () => {
  it.each([
    ['git@GitHub.com:Acme/Thing.git', 'github.com/Acme/Thing'],
    ['ssh://git@host.example:2222/a/b.git/', 'host.example/a/b'],
    ['https://user:SECRET@Host.io/x/y.git?q=1#h', 'host.io/x/y'],
    ['https://host.io/x/y', 'host.io/x/y'],
  ])('%s', (raw, want) => {
    expect(normalizeRemote(raw)).toBe(want)
  })
  it('rejects local paths and empties', () => {
    expect(normalizeRemote('/srv/git/repo.git')).toBeUndefined()
    expect(normalizeRemote('')).toBeUndefined()
    expect(normalizeRemote('https://host')).toBeUndefined()
  })
})
