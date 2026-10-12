import { describe, expect, it } from 'vitest'
import { createApi, resolveToken } from './api.ts'

describe('resolveToken', () => {
  it('prefers the meta tag injected by the server', async () => {
    const doc = { querySelector: () => ({ getAttribute: () => 'meta-token' }) }
    const f = async () => {
      throw new Error('should not fetch')
    }
    expect(await resolveToken(doc, f as unknown as typeof fetch)).toBe('meta-token')
  })

  it('falls back to /api/session (Vite dev server)', async () => {
    const doc = { querySelector: () => ({ getAttribute: () => '' }) }
    const f = async (url: string) => {
      expect(url).toBe('/api/session')
      return new Response(JSON.stringify({ token: 'dev-token' }))
    }
    expect(await resolveToken(doc, f as unknown as typeof fetch)).toBe('dev-token')
  })
})

describe('createApi', () => {
  it('sends messages with the bearer token and returns the created message', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const f = async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response(JSON.stringify({ message: { id: 'm1' } }), { status: 202 })
    }
    const api = createApi('tok', f as unknown as typeof fetch)
    const res = await api.sendMessage('cc:abc', 'hi')
    expect(res).toEqual({ ok: true, message: { id: 'm1' } })
    expect(seen!.url).toBe('/api/agents/cc%3Aabc/messages')
    expect((seen!.init.headers as Record<string, string>).authorization).toBe('Bearer tok')
    expect(JSON.parse(String(seen!.init.body))).toEqual({ text: 'hi' })
  })

  it('returns a readable error on failure', async () => {
    const f = async () =>
      new Response(JSON.stringify({ error: 'too many messages' }), { status: 429 })
    const api = createApi('tok', f as unknown as typeof fetch)
    expect(await api.sendMessage('a', 'x')).toEqual({ ok: false, error: 'too many messages' })
    const down = async () => {
      throw new Error('offline')
    }
    expect(await createApi('t', down as unknown as typeof fetch).sendMessage('a', 'x')).toEqual({
      ok: false,
      error: 'offline',
    })
  })

  it('builds the WebSocket URL from the page location', () => {
    const api = createApi('tok', fetch)
    expect(api.wsUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:5173/ws?token=tok',
    )
    expect(api.wsUrl({ protocol: 'https:', host: 'office' })).toBe('wss://office/ws?token=tok')
  })
})
