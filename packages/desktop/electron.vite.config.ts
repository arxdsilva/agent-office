import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import { contentSecurityPolicy } from './src/main/security.ts'

// Workspace packages are TypeScript sources: bundle them. Real npm deps stay external (packed by electron-builder).
const workspace = ['@agent-office/core', '@agent-office/adapters', '@agent-office/shared']

/** Production CSP as a <meta> tag (file:// pages have no response headers). Dev gets it as a header. */
const cspMeta = (): Plugin => ({
  name: 'agent-office-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy()}" />`),
})

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: workspace },
      rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') },
    },
    define: { __SIGNED__: JSON.stringify(!!process.env.CSC_LINK) },
  },
  preload: {
    // Sandboxed preloads must be a single CommonJS file with everything inlined.
    build: {
      externalizeDeps: false,
      isolatedEntries: true,
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
