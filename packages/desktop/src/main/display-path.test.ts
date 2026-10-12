import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { abbreviateForSnippet, displayPathOf } from './display-path'

describe('displayPathOf', () => {
  it('abbreviates inside home (posix)', () => {
    expect(displayPathOf('/Users/me/code/app', '/Users/me', posix)).toBe('~/code/app')
    expect(displayPathOf('/Users/me', '/Users/me', posix)).toBe('~')
  })
  it('never returns an absolute path outside home (posix)', () => {
    expect(displayPathOf('/srv/work/acme-api', '/Users/me', posix)).toBe('…/work/acme-api')
    expect(displayPathOf('/srv/a/b/acme', '/Users/me', posix)).toBe('…/b/acme')
    expect(displayPathOf('/Users/mellon/x', '/Users/me', posix)).toBe('…/mellon/x')
    expect(displayPathOf('/opt', '/Users/me', posix)).toBe('…/opt')
    expect(displayPathOf('/', '/Users/me', posix)).toBe('…')
    expect(displayPathOf('', '/Users/me', posix)).toBe('…')
  })
  it('handles windows paths', () => {
    expect(displayPathOf('C:\\Users\\x\\proj', 'C:\\Users\\x', win32)).toBe('~\\proj')
    expect(displayPathOf('D:\\code\\proj', 'C:\\Users\\x', win32)).toBe('…\\code\\proj')
    expect(displayPathOf('D:\\', 'C:\\Users\\x', win32)).toBe('…')
  })
})

describe('abbreviateForSnippet', () => {
  it('keeps paths outside home whole', () => {
    expect(abbreviateForSnippet('/srv/x/token', '/Users/me')).toBe('/srv/x/token')
  })
})
