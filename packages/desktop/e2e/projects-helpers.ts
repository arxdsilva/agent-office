import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/** A real git repository with one commit (the repo identity needs a first commit). */
export function makeRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'E2E',
        GIT_AUTHOR_EMAIL: 'e2e@example.com',
        GIT_COMMITTER_NAME: 'E2E',
        GIT_COMMITTER_EMAIL: 'e2e@example.com',
      },
    })
  git('init', '-q')
  writeFileSync(join(dir, 'README.md'), '# Shop API\n')
  git('add', 'README.md')
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial commit')
  return dir
}

type ProjectsApi = {
  agentOffice: {
    projects: {
      list(): Promise<{ id: string; name: string }[]>
      create(a: { name: string; folders?: string[] }): Promise<{ id: string; name: string }>
      createMemory(d: object): Promise<{ id: string; title: string; state: string }>
      memories(a: object): Promise<{ id: string; title: string; state: string }[]>
      sessions(a: object): Promise<{ id: string; title: string; state: string }[]>
    }
  }
}

/** Calls the preload bridge from the page (the same path the UI uses). */
export const projectsApi = <T>(
  win: Page,
  fn: (api: ProjectsApi['agentOffice']['projects']) => Promise<T>,
) => win.evaluate(`(${fn.toString()})((window).agentOffice.projects)`) as Promise<T>

/** Stubs the native folder picker and the quit confirm. */
export async function stubDialogs(
  app: import('@playwright/test').ElectronApplication,
  folder: string,
) {
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as never
  }, folder)
}

export async function answerQuitConfirm(app: import('@playwright/test').ElectronApplication) {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as never
  })
}
