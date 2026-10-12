#!/usr/bin/env node
// Renders packages/desktop/build/{icon,tray}.svg to the PNGs electron-builder and the tray use.
// Uses Playwright's Chromium (already a dev dependency) so no image tooling is needed.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(new URL('../packages/desktop/package.json', import.meta.url))
const { chromium } = require('@playwright/test')
const dir = new URL('../packages/desktop/build/', import.meta.url).pathname

const jobs = [
  { svg: 'icon.svg', out: 'icon.png', size: 1024 },
  { svg: 'tray.svg', out: 'trayTemplate.png', size: 16 },
  { svg: 'tray.svg', out: 'trayTemplate@2x.png', size: 32 },
  // Windows/Linux trays have no template tinting: render the glyph light-on-transparent at 32px.
  { svg: 'tray.svg', out: 'tray.png', size: 32, recolor: '#e8ebf1' },
]

const browser = await chromium.launch()
const page = await browser.newPage()
for (const j of jobs) {
  let svg = readFileSync(join(dir, j.svg), 'utf8')
  if (j.recolor) svg = svg.replaceAll('#000', j.recolor)
  await page.setViewportSize({ width: j.size, height: j.size })
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${j.size}" height="${j.size}" `)}</body></html>`,
  )
  await page.screenshot({
    path: join(dir, j.out),
    omitBackground: true,
    clip: { x: 0, y: 0, width: j.size, height: j.size },
  })
  console.log(`rendered ${j.out}`)
}
await browser.close()
