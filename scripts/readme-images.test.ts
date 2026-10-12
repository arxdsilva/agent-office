// The README gallery stays honest: every image it shows exists, every Features bullet links to a
// section with at least one image, and docs/screenshots stays within its size budget (plan §11.3).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const README = readFileSync(join(ROOT, 'README.md'), 'utf8')
const SHOTS = join(ROOT, 'docs', 'screenshots')
const MB = 1024 * 1024
const BUDGET_MB = 30
const CLIP_MB = 3

/** Real macOS captures, produced manually by `make screenshots-macos` (needs OS permissions). */
const MANUAL = new Set(['docs/screenshots/tray-menu.png', 'docs/screenshots/notification.png'])

const MEDIA = /\.(png|jpe?g|gif|webp|svg|mp4|webm)$/i

/** Local media paths referenced as Markdown images or HTML img/video/source tags. */
function mediaRefs(md: string): string[] {
  const refs = [
    ...[...md.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)].map((m) => m[1]!),
    ...[...md.matchAll(/<(?:img|video|source)\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]!),
  ]
  return refs
    .filter((r) => !/^[a-z]+:/i.test(r) && MEDIA.test(r))
    .map((r) => r.replace(/^\.\//, ''))
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

interface Section {
  level: number
  title: string
  body: string
}

/** Headings outside code fences, each with its text up to the next heading of the same or a higher level. */
function sections(md: string): Section[] {
  const lines = md.split('\n')
  const heads: { level: number; title: string; line: number }[] = []
  let fenced = false
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced
    const m = !fenced && /^(#{1,6})\s+(.*)$/.exec(l)
    if (m) heads.push({ level: m[1]!.length, title: m[2]!, line: i })
  })
  return heads.map((h, k) => {
    const end = heads.slice(k + 1).find((n) => n.level <= h.level)?.line ?? lines.length
    return { level: h.level, title: h.title, body: lines.slice(h.line + 1, end).join('\n') }
  })
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)],
  )
}

describe('README images', () => {
  const all = sections(README)

  it('has a hero image and the walkthrough clip under the pitch', () => {
    const intro = README.slice(0, README.indexOf('\n## '))
    expect(mediaRefs(intro)).toEqual(
      expect.arrayContaining([
        'docs/screenshots/hero-overview.png',
        'docs/screenshots/walkthrough.webp',
      ]),
    )
  })

  it('references only images and clips that exist (except the manual macOS captures)', () => {
    const refs = mediaRefs(README)
    expect(refs.length).toBeGreaterThanOrEqual(30)
    const missing = refs.filter((r) => !MANUAL.has(r) && !existsSync(join(ROOT, r)))
    expect(missing).toEqual([])
  })

  it('links every Features bullet to a section that shows an image', () => {
    const features = all.find((s) => s.level === 2 && s.title === 'Features')
    expect(features, 'a "## Features" section').toBeDefined()
    const bullets = features!.body.split('\n').filter((l) => /^- /.test(l))
    expect(bullets.length).toBeGreaterThanOrEqual(8)
    const bySlug = new Map(all.map((s) => [slug(s.title), s]))
    const problems = bullets.flatMap((b) => {
      const anchors = [...b.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]!)
      if (!anchors.length) return [`no section link: ${b.slice(0, 60)}`]
      const ok = anchors.some((a) => {
        const s = bySlug.get(a)
        return s && mediaRefs(s.body).length > 0
      })
      return ok ? [] : [`no image behind ${anchors.join(', ')}`]
    })
    expect(problems).toEqual([])
  })

  it('keeps docs/screenshots within the size budget', () => {
    const files = filesUnder(SHOTS)
    const total = files.reduce((s, f) => s + statSync(f).size, 0)
    expect(total / MB).toBeLessThanOrEqual(BUDGET_MB)
    const bigClips = files
      .filter((f) => f.endsWith('.webp') && statSync(f).size > CLIP_MB * MB)
      .map((f) => relative(ROOT, f))
    expect(bigClips).toEqual([])
  })
})

describe('slug', () => {
  it('matches GitHub heading anchors', () => {
    expect(slug('Tray and notifications')).toBe('tray-and-notifications')
    expect(slug('Talk to agents')).toBe('talk-to-agents')
    expect(slug('HTTP API (for any agent framework)')).toBe('http-api-for-any-agent-framework')
    expect(slug('Meeting rooms & phone booths')).toBe('meeting-rooms--phone-booths')
  })
})
