import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

// Isolated server: own port, own token dir, mock agents only (never the real ~/.claude).
export const PORT = 4318
export const HOME = join(tmpdir(), 'agent-office-ui-test')

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    // Software WebGL so the scene renders on CI machines without a GPU.
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  webServer: {
    command: 'pnpm --filter @agent-office/server start',
    cwd: '../..',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      AGENT_OFFICE_HOME: HOME,
      AGENT_OFFICE_MOCK: '1',
      AGENT_OFFICE_CLAUDE: '0',
    },
  },
})
