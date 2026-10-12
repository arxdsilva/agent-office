#!/usr/bin/env node
// README gallery capture (plan §11.2): stills and animated clips of every feature → docs/screenshots.
// Run `make build` first. Each scenario in scripts/capture/scenarios.mjs launches the built app with
// an isolated profile, seeds invented agents through the HTTP API and frames shots through the
// renderer's debug hook (window.__aoDebug, only present with AGENT_OFFICE_DEBUG=1).
//   node scripts/screenshots.mjs [--only office,chat-panel] [--no-clips] [--quality high]
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

export { launchApp } from './capture/app.mjs'

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const { values: args } = parseArgs({
    options: {
      only: { type: 'string' },
      'no-clips': { type: 'boolean', default: false },
      quality: { type: 'string', default: 'high' },
      out: { type: 'string', default: new URL('../docs/screenshots/', import.meta.url).pathname },
    },
  })
  const only = args.only ? new Set(args.only.split(',')) : null
  const want = (n) => !only || only.has(n)
  mkdirSync(args.out, { recursive: true })

  // Sheets from the Blender previews (no app needed).
  const { characters, themesGallery } = await import('./capture/composites.mjs')
  if (want('themes-gallery')) await themesGallery(join(args.out, 'themes-gallery.png'))
  if (want('characters')) await characters(join(args.out, 'characters.png'))

  const { runScenarios } = await import('./capture/scenarios.mjs')
  await runScenarios({ out: args.out, quality: args.quality, only, clips: !args['no-clips'] })
}
