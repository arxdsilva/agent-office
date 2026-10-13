import { defineConfig } from 'vitest/config'

const threshold = { statements: 70, branches: 70, functions: 70, lines: 70 }

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'packages/*/src/**/*.test.ts',
            'packages/core/test/**/*.test.ts',
            'hooks/**/*.test.ts',
            'scripts/**/*.test.ts',
            'assets/**/*.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['packages/adapters/test/**/*.test.ts'],
          testTimeout: 20_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: [
        'packages/shared/src/**',
        'packages/core/src/**',
        'packages/adapters/src/**',
        'packages/desktop/src/**',
        'packages/web/src/**',
        'hooks/**',
        'scripts/**',
      ],
      // Thin rendering/Electron shells: covered by the Playwright Electron suite (packages/desktop/e2e), not unit tests.
      // Keep in sync with .claude/rules/TESTING.md — do not widen silently.
      exclude: [
        '**/*.test.ts',
        'packages/desktop/src/main/index.ts',
        'packages/desktop/src/main/adapters/electron-*.ts',
        'packages/desktop/src/main/window.ts',
        'packages/desktop/src/preload/**',
        'packages/web/src/main.ts',
        'packages/web/src/adapters/three/**',
        'packages/web/src/adapters/dom/**',
        // Canvas2D drawing for the optional 2D RPG mode; its logic is pure in app/pixel/** (covered).
        'packages/web/src/adapters/pixel/**',
        // Night City's three.js shells (covered by Playwright); its logic lives in app/special/**.
        'packages/web/src/special-3d/adapters/**',
        'scripts/arch.mjs',
        'scripts/codex-schema-check.mjs',
        // Drives the real, logged-in provider CLIs (make verify-providers); can't run in CI.
        'scripts/verify-providers.ts',
        'scripts/render-icons.mjs',
        'scripts/screenshots.mjs',
        'scripts/perf.mjs',
        'scripts/capture/**',
      ],
      // ≥70% per package (aggregated per glob), see .claude/rules/TESTING.md.
      thresholds: {
        'packages/shared/src/**': threshold,
        'packages/core/src/**': threshold,
        'packages/adapters/src/**': threshold,
        'packages/desktop/src/**': threshold,
        'packages/web/src/**': threshold,
        'hooks/**': threshold,
        'scripts/**': threshold,
      },
    },
  },
})
