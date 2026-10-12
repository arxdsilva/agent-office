import { defineConfig } from '@playwright/test'

// Drives the built app (`make build` first) through Playwright's Electron support.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1, // one app instance at a time (single-instance lock, fixed test port)
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
})
