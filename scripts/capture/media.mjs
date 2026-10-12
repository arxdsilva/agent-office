// Image and clip encoding for the README gallery: 1600×900 palette PNGs, composites and animated
// WebP clips, all with sharp (no ffmpeg needed).
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import sharp from 'sharp'

export const STILL = { width: 1600, height: 900 }
export const CLIP = { width: 960, height: 540 }

const kb = (path) => `${Math.round(statSync(path).size / 1024)} KB`

/** Quantized PNG: 3D renders keep their look with a 256-color palette at a fraction of the size. */
export const png = (img) =>
  img.png({ palette: true, quality: 90, effort: 10, compressionLevel: 9, dither: 0.6 })

/** Any screenshot buffer → a 1600×900 PNG (center crop when the aspect differs). */
export async function saveStill(buf, path) {
  mkdirSync(dirname(path), { recursive: true })
  await png(sharp(buf).resize(STILL.width, STILL.height, { fit: 'cover' })).toFile(path)
  console.log(`  still ${path} (${kb(path)})`)
}

const esc = (s) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`)

/** A rounded caption pill as an SVG overlay. */
export function captionSvg(text, { size = 26, pad = 14 } = {}) {
  const w = Math.round(text.length * size * 0.58 + pad * 2)
  const h = Math.round(size * 1.7)
  return {
    input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
        `<rect width="${w}" height="${h}" rx="${h / 2}" fill="#111827" fill-opacity="0.78"/>` +
        `<text x="${w / 2}" y="${h * 0.68}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" font-weight="600" fill="#ffffff" text-anchor="middle">${esc(text)}</text></svg>`,
    ),
    width: w,
    height: h,
  }
}

/**
 * Lays out tiles (buffers or paths, each with an optional crop and caption) on a grid.
 * @param {{src: Buffer|string, crop?: {left:number, top:number, width:number, height:number}, caption?: string}[]} tiles
 */
export async function grid(
  tiles,
  { cols, cellW, cellH, gap = 0, background = '#0f172a', top = 0 },
) {
  const rows = Math.ceil(tiles.length / cols)
  const width = cols * cellW + (cols - 1) * gap
  const height = top + rows * cellH + (rows - 1) * gap
  const layers = []
  for (const [i, t] of tiles.entries()) {
    let img = sharp(t.src)
    if (t.crop) img = img.extract(t.crop)
    const left = (i % cols) * (cellW + gap)
    const y = top + Math.floor(i / cols) * (cellH + gap)
    layers.push({
      input: await img.resize(cellW, cellH, { fit: 'cover' }).toBuffer(),
      left,
      top: y,
    })
    if (t.caption) {
      const c = captionSvg(t.caption, { size: Math.max(14, Math.round(cellH / 16)) })
      layers.push({
        input: c.input,
        left: left + Math.max(0, Math.round((cellW - c.width) / 2)),
        top: y + cellH - c.height - 10,
      })
    }
  }
  return {
    width,
    height,
    layers,
    image: () => sharp({ create: { width, height, channels: 3, background } }).composite(layers),
  }
}

/** Writes a composite (from `grid` or raw layers) as a 1600×900 palette PNG. */
export async function saveComposite(image, path) {
  mkdirSync(dirname(path), { recursive: true })
  const buf = await image.png().toBuffer()
  await png(
    sharp(buf).resize(STILL.width, STILL.height, { fit: 'contain', background: '#0f172a' }),
  ).toFile(path)
  console.log(`  composite ${path} (${kb(path)})`)
}

/** Frames (JPEG/PNG buffers) → looping animated WebP at CLIP size, within a byte budget. */
export async function saveClip(
  frames,
  path,
  { fps = 12, quality = 62, maxBytes = 2.8 * 1024 * 1024 } = {},
) {
  mkdirSync(dirname(path), { recursive: true })
  const sized = await Promise.all(
    frames.map((f) =>
      sharp(f).resize(CLIP.width, CLIP.height, { fit: 'cover' }).removeAlpha().png().toBuffer(),
    ),
  )
  const delay = Math.round(1000 / fps)
  for (let q = quality; ; q -= 8) {
    const out = await sharp(sized, { join: { animated: true } })
      .webp({ quality: q, effort: 5, loop: 0, delay: sized.map(() => delay), smartSubsample: true })
      .toBuffer()
    if (out.length <= maxBytes || q <= 30) {
      writeFileSync(path, out)
      console.log(`  clip ${path} (${frames.length} frames @ ${fps} fps, q${q}, ${kb(path)})`)
      return
    }
  }
}
