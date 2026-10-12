import { defineConfig } from 'vitest/config'

const threshold = { statements: 70, branches: 70, functions: 70, lines: 70 }

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'hooks/**/*.test.ts', 'scripts/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['packages/server/test/**/*.test.ts'],
          testTimeout: 20_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: [
        'packages/shared/src/**',
        'packages/server/src/**',
        'packages/web/src/**',
        'hooks/**',
        'scripts/**',
      ],
      // Rendering-only files: covered by the Playwright smoke test, not unit tests.
      // Keep in sync with .claude/rules/TESTING.md.
      exclude: [
        '**/*.test.ts',
        'packages/server/src/index.ts',
        'packages/web/src/{main,office,avatar,controls,panel}.ts',
      ],
      // 70% per package (aggregated per glob), see .claude/rules/TESTING.md.
      thresholds: {
        'packages/shared/src/**': threshold,
        'packages/server/src/**': threshold,
        'packages/web/src/**': threshold,
        'hooks/**': threshold,
        'scripts/**': threshold,
      },
    },
  },
})
