// Composite images: split comparisons (quality presets, light and dark UI) and sheets built from
// the Blender preview renders in assets/previews (wing themes, characters and their clips).
import { join } from 'node:path'
import sharp from 'sharp'
import { captionSvg, grid, saveComposite, STILL } from './media.mjs'

const PREVIEWS = new URL('../../assets/previews/', import.meta.url).pathname
const prev = (f) => join(PREVIEWS, f)

/** Left half of `a`, right half of `b`, a divider and a caption on each side. */
export async function saveSplit(a, b, [la, lb], path, { split = 0.5 } = {}) {
  const { width: W, height: H } = STILL
  const fit = (buf) => sharp(buf).resize(W, H, { fit: 'cover' }).png().toBuffer()
  const [fa, fb] = await Promise.all([fit(a), fit(b)])
  const cut = Math.round(W * split)
  const right = await sharp(fb)
    .extract({ left: cut, top: 0, width: W - cut, height: H })
    .toBuffer()
  const ca = captionSvg(la)
  const cb = captionSvg(lb)
  const img = sharp(fa).composite([
    { input: right, left: cut, top: 0 },
    {
      input: { create: { width: 4, height: H, channels: 4, background: '#ffffff' } },
      left: cut - 2,
      top: 0,
    },
    { input: ca.input, left: Math.round(cut / 2 - ca.width / 2), top: H - ca.height - 24 },
    {
      input: cb.input,
      left: Math.round(cut + (W - cut) / 2 - cb.width / 2),
      top: H - cb.height - 24,
    },
  ])
  await saveComposite(img, path)
}

/** The right-hand part of two screenshots (where the panels are), side by side, captioned. */
export async function saveSideBySide(a, b, [la, lb], path, { keep = 820 } = {}) {
  const { width: W, height: H } = STILL
  const half = (W - 4) / 2
  const crop = async (buf) => {
    const full = await sharp(buf).resize(W, H, { fit: 'cover' }).toBuffer()
    const part = await sharp(full)
      .extract({ left: W - keep, top: 0, width: keep, height: H })
      .toBuffer()
    return sharp(part).resize(half, H, { fit: 'cover', position: 'right' }).toBuffer()
  }
  const [ca, cb] = await Promise.all([crop(a), crop(b)])
  const ta = captionSvg(la)
  const tb = captionSvg(lb)
  const img = sharp({
    create: { width: W, height: H, channels: 3, background: '#ffffff' },
  }).composite([
    { input: ca, left: 0, top: 0 },
    { input: cb, left: half + 4, top: 0 },
    { input: ta.input, left: 24, top: 24 },
    { input: tb.input, left: half + 28, top: 24 },
  ])
  await saveComposite(img, path)
}

export const THEMES = ['terracotta', 'nordic', 'forest', 'ocean', 'brass', 'neon']

/** 3×2 sheet of the six wing themes (Blender Eevee previews). */
export async function themesGallery(path) {
  const g = await grid(
    THEMES.map((t) => ({
      src: prev(`wing-${t}-overview.png`),
      crop: { left: 330, top: 150, width: 1000, height: 846 - 150 + 0 },
      caption: t,
    })),
    { cols: 3, cellW: 532, cellH: 448, gap: 2 },
  )
  await saveComposite(g.image(), path)
}

const CLIPS = [
  'SitType',
  'SitThink',
  'HeadScratch',
  'PhoneCall',
  'SitTalk',
  'DrinkCoffee',
  'LoungeSit',
  'PingPong',
  'Walk',
  'Wave',
  'ElevatorIn',
  'StandInteract',
  'ShelfPick',
  'SitRead',
  'SitLaptop',
  'StandTalk',
]

/** The character lineup on top, one frame of 16 animation clips below (Blender previews). */
export async function characters(path) {
  const W = STILL.width
  const lineup = await sharp(prev('character-lineup.png')).resize(W).toBuffer()
  const lh = (await sharp(lineup).metadata()).height
  const cellW = 200
  const cellH = Math.floor((STILL.height - lh) / 2)
  const tiles = []
  for (const name of CLIPS) {
    const file = prev(`character-clip-${name}.png`)
    const m = await sharp(file).metadata()
    // A strip of square-ish frames (each ≈ 0.766 × height, with a 4 px border): take one mid-clip.
    const frames = Math.round(m.width / (m.height * 0.766))
    const fw = Math.floor(m.width / frames)
    const k = Math.floor(frames / 2)
    tiles.push({
      src: file,
      crop: { left: k * fw + 6, top: 6, width: fw - 12, height: m.height - 12 },
      caption: name,
    })
  }
  const g = await grid(tiles, { cols: 8, cellW, cellH, top: lh })
  const img = g.image().composite([{ input: lineup, left: 0, top: 0 }, ...g.layers])
  await saveComposite(img, path)
}
