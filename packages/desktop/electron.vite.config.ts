import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import { contentSecurityPolicy } from './src/main/security.ts'

// Workspace packages are TypeScript sources: bundle them. Electron and the real npm runtime deps stay
// external (electron-builder packs `dependencies` into the app).
const workspace = ['@agent-office/core', '@agent-office/adapters', '@agent-office/shared']
const runtimeExternals = [
  /^electron(\/.*)?$/,
  /^electron-updater(\/.*)?$/,
  /^fastify(\/.*)?$/,
  /^zod(\/.*)?$/,
  // Claude Agent SDK: loaded at runtime from node_modules (spawns the Claude Code CLI).
  /^@anthropic-ai\/claude-agent-sdk(\/.*)?$/,
  /^node:/,
]

/** Production CSP as a <meta> tag (file:// pages have no response headers). Dev gets it as a header. */
const cspMeta = (): Plugin => ({
  name: 'agent-office-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy()}" />`,
    ),
})

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: workspace },
      rollupOptions: { input: resolve(__dirname, 'src/main/index.ts'), external: runtimeExternals },
    },
    define: { __SIGNED__: JSON.stringify(!!process.env.CSC_LINK) },
  },
  preload: {
    // Sandboxed preloads must be a single CommonJS file with everything inlined (one entry → no code splitting).
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, '../web'),
    plugins: [cspMeta()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: { input: resolve(__dirname, '../web/index.html') },
      chunkSizeWarningLimit: 900,
    },
  },
})
