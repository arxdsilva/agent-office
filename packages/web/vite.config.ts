import { defineConfig } from 'vite'

const api = 'http://127.0.0.1:4317'

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: api },
      '/ws': { target: api, ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
})
