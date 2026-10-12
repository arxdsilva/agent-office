// PX-atlas (plan §12): every .px parses with known palette keys, anims.json refs exist, the atlas covers the
// contract lists (FURNITURE_KINDS, PIXEL_ANIMS, effects, glyphs), stays within budget and is byte-deterministic.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  BUDGET_BYTES,
  DIRS,
  EXTRA_GLYPHS,
  EXTRA_OBJECTS,
  FURNITURE_KINDS,
  PIXEL_ANIMS,
  REQUIRED_EFFECTS,
  REQUIRED_TILES,
  SRC,
  THEMES,
  autotileRows,
  buildAtlas,
  encodePng,
  image,
  loadPalettes,
  parsePx,
  readPxDir,
  totalBytes,
  transformRows,
  type Build,
} from './build.mjs'

let build: Build
beforeAll(() => {
  build = buildAtlas()
})

describe('parsePx', () => {
  it('parses frames, meta, attributes and glyph names', () => {
    const fs = parsePx('# c\n@frame a ax=1\n@meta {"foot":[1,1]}\n..k\nkk.\n@glyph space\n.\n@glyph U+2192\nx\n', 't.px')
    expect(fs.map((f) => f.name)).toEqual(['a', ' ', '→'])
    expect(fs[0]).toMatchObject({ w: 3, h: 2, attrs: { ax: '1' }, meta: { foot: [1, 1] } })
  })
  it('rejects ragged rows, unknown directives and stray rows with file:line', () => {
    expect(() => parsePx('@frame a\n..\n...\n', 'r.px')).toThrow(/r\.px.*row 1 is 3 wide/)
    expect(() => parsePx('@nope\n', 'd.px')).toThrow(/d\.px:1: unknown directive/)
    expect(() => parsePx('..\n', 's.px')).toThrow(/before @frame/)
    expect(() => parsePx('@frame a\n.\n@frame a\n.\n', 'u.px')).toThrow(/duplicate/)
    expect(() => parsePx('@frame a\n@meta {bad\n.\n', 'm.px')).toThrow(/bad @meta/)
  })
  it('copies with from= (flip, wrap shift, edges) and inherits attributes', () => {
    const fs = parsePx('@frame a oy=-2\n@meta {"hand":[0,1]}\nab.\n@frame b from=a flip=x\n@frame c from=a dx=1 wrap=1 edgeR=k\n')
    expect(fs[1]).toMatchObject({ rows: ['.ba'], attrs: { oy: '-2' }, meta: { hand: [2, 1] } })
    expect(fs[2]!.rows).toEqual(['.ak'])
    expect(() => parsePx('@frame a\n.\n@frame b from=zz\n')).toThrow(/unknown "zz"/)
  })
  it('transforms and autotiles grids', () => {
    expect(transformRows(['ab', 'cd'], { flip: 'y' })).toEqual(['cd', 'ab'])
    expect(transformRows(['ab', 'cd'], { dy: '1' })).toEqual(['..', 'ab'])
    expect(autotileRows(['....', '....', '....', '....'], 1 | 2 | 4 | 8)).toEqual(['....', '....', '....', '....'])
    expect(autotileRows(['....', '....', '....', '....'], 0)).toEqual(['kkkk', 'k..k', 'k..k', 'kkkk'])
  })
})

describe('sources', () => {
  it('every .px uses only known palette keys', () => {
    const pal = loadPalettes()
    const office = new Set([...Object.keys(pal.office), ...Object.keys(pal.themes.house!)])
    const char = new Set(Object.keys(pal.char))
    for (const dir of ['tiles', 'objects', 'effects', 'ui'])
      for (const f of readPxDir(dir)) for (const r of f.rows) for (const c of r) expect(office.has(c), `${f.file} ${f.name} "${c}"`).toBe(true)
    for (const f of readPxDir('characters')) for (const r of f.rows) for (const c of r) expect(char.has(c), `${f.file} ${f.name} "${c}"`).toBe(true)
    for (const f of readPxDir('font')) for (const r of f.rows) expect(r).toMatch(/^[.x]+$/)
  })
  it('every theme defines the same slots', () => {
    const pal = loadPalettes()
    const keys = Object.keys(pal.themes.house!).sort()
    for (const t of THEMES) expect(Object.keys(pal.themes[t]!).sort()).toEqual(keys)
  })
  it('anims.json poses refer to existing parts and every character part is used', () => {
    const anims = JSON.parse(readFileSync(join(SRC, 'characters/anims.json'), 'utf8')) as {
      poses: Record<string, unknown>
      anims: Record<string, { frames: [string, number][] }>
    }
    for (const [name, spec] of Object.entries(anims.anims))
      for (const [pose] of spec.frames) expect(anims.poses[pose], `${name} → ${pose}`).toBeDefined()
    expect(build.unusedParts).toEqual([])
  })
})

describe('atlas', () => {
  it('has no placeholders: every contract item is drawn', () => {
    expect(build.atlas.placeholders).toEqual([])
  })
  it('covers every furniture kind and extra object, with frames that exist (per theme when themed)', () => {
    const { objects, frames } = build.atlas
    for (const k of [...FURNITURE_KINDS, ...EXTRA_OBJECTS]) expect(objects[k], k).toBeDefined()
    for (const [kind, o] of Object.entries(objects))
      for (const [facing, v] of Object.entries(o.variants)) {
        const keys = v.themed ? THEMES.map((t) => `${v.frame}@${t}`) : [v.frame]
        for (const key of keys) expect(frames[key], `${kind}@${facing}`).toBeDefined()
        expect(v.foot).toHaveLength(2)
      }
  })
  it('has every required tile, a tile table indexed from 1 and 16 wall-top masks', () => {
    const names = new Set(build.atlas.tiles.slice(1).map((t) => t!.name))
    for (const t of REQUIRED_TILES) expect(names.has(t), t).toBe(true)
    expect(build.atlas.tiles[0]).toBeNull()
    for (const [id, idx] of Object.entries(build.atlas.tileIds)) expect(build.atlas.tiles[idx]!.id).toBe(id)
    for (let m = 0; m < 16; m++) expect(build.atlas.tileIds[`wall/top-${m}@terracotta`], `mask ${m}`).toBeGreaterThan(0)
  })
  it('animates every PIXEL_ANIM in four directions with existing poses and body frames', () => {
    const { animations, characters, frames, clipDurations } = build.atlas
    for (const a of PIXEL_ANIMS) {
      for (const d of DIRS) {
        const anim = animations.find((x) => x.name === a && x.dir === d)
        expect(anim, `${a}-${d}`).toBeDefined()
        for (const f of anim!.frames) {
          expect(characters.poses[f.ref], f.ref).toBeDefined()
          expect(frames[`char:body/${f.ref}`], f.ref).toBeDefined()
          expect(frames[`char:shirt/${f.ref}`], f.ref).toBeDefined()
        }
      }
      expect(clipDurations[a]).toBeGreaterThan(0)
    }
    // One-shots match the 3D clips they stand for (character.json).
    expect(clipDurations['wave']).toBeCloseTo(1.333, 2)
    expect(clipDurations['elevator-in']).toBeCloseTo(1.333, 2)
  })
  it('has every hair style, the player layers and props', () => {
    const { frames, characters } = build.atlas
    for (const h of ['hair-a', 'hair-b', 'hair-c', 'hair-d', 'cap', 'jacket', 'glasses', 'headset', 'badge'])
      expect(frames[`char:${h}/stand-s`], h).toBeDefined()
    expect(characters.props).toEqual(['book', 'cup', 'laptop', 'paddle', 'phone'])
    expect(frames['char:prop/laptop-w']).toBeDefined()
  })
  it('has the effects, the font (ASCII 32–126 + extras) and the 9-slice frame', () => {
    const { effects, font, ui, frames } = build.atlas
    for (const e of REQUIRED_EFFECTS) {
      expect(effects[e], e).toBeDefined()
      for (const f of effects[e]!.frames) expect(frames[f.ref]).toBeDefined()
    }
    for (let c = 32; c <= 126; c++) expect(font.glyphs[String.fromCharCode(c)], String.fromCharCode(c)).toBeDefined()
    for (const c of EXTRA_GLYPHS) expect(font.glyphs[c], c).toBeDefined()
    expect(ui.frame).toMatchObject({ slice: 8 })
    expect(build.files['frame.png']).toBeDefined()
  })
  it('keeps every frame inside its sheet', () => {
    for (const [k, f] of Object.entries(build.atlas.frames)) {
      const s = build.atlas.sheets[f.sheet]!
      expect(f.x + f.w <= s.w && f.y + f.h <= s.h, k).toBe(true)
    }
  })
  it('writes valid PNGs of the declared sizes', async () => {
    for (const [name, s] of Object.entries(build.atlas.sheets)) {
      const meta = await sharp(build.files[s.file]!).metadata()
      expect([meta.width, meta.height], name).toEqual([s.w, s.h])
    }
    const tiny = image(2, 1)
    tiny.data.set([255, 0, 0, 255, 0, 0, 255, 128])
    const raw = await sharp(encodePng(tiny)).raw().toBuffer()
    expect([...raw]).toEqual([255, 0, 0, 255, 0, 0, 255, 128])
  })
  it('stays within the 2 MB budget', () => {
    expect(totalBytes(build.files)).toBeLessThanOrEqual(BUDGET_BYTES)
  })
  it('is deterministic: the same sources give the same bytes', () => {
    const again = buildAtlas()
    for (const [name, buf] of Object.entries(build.files)) expect(again.files[name]!.equals(buf), name).toBe(true)
  })
})
