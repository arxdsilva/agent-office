import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { repoFilesContract } from '@agent-office/core/testing'
import { FsRepoFiles } from './repo-files.ts'

repoFilesContract('FsRepoFiles', async (layout) => {
  const root = await mkdtemp(join(tmpdir(), 'ao-repofiles-'))
  const repoPath = join(root, 'repo')
  await mkdir(repoPath)
  for (const d of layout.dirs) await mkdir(join(repoPath, d), { recursive: true })
  for (const f of layout.files) {
    await mkdir(dirname(join(repoPath, f)), { recursive: true })
    await writeFile(join(repoPath, f), 'x')
  }
  await writeFile(join(root, 'outside.md'), 'secret')
  for (const l of layout.outsideLinks) await symlink(join(root, 'outside.md'), join(repoPath, l))
  return {
    repoPath,
    port: new FsRepoFiles(),
    dispose: () => rm(root, { recursive: true, force: true }),
  }
})
