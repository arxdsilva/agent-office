import type { ChatMessage } from '@agent-office/shared'

interface DocLike {
  querySelector(sel: string): { getAttribute(name: string): string | null } | null
}

/** The built UI gets the token in a meta tag; the Vite dev server asks the API for it. */
export async function resolveToken(doc: DocLike, fetchImpl: typeof fetch = fetch): Promise<string> {
  const meta = doc.querySelector('meta[name="agent-office-token"]')?.getAttribute('content')
  if (meta) return meta
  const res = await fetchImpl('/api/session')
  const body = (await res.json()) as { token: string }
  return body.token
}

export type SendResult = { ok: true; message: ChatMessage } | { ok: false; error: string }

export function createApi(token: string, fetchImpl: typeof fetch = fetch) {
  return {
    async sendMessage(agentId: string, text: string): Promise<SendResult> {
      try {
        const res = await fetchImpl(`/api/agents/${encodeURIComponent(agentId)}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ text }),
        })
        const body = (await res.json()) as { message?: ChatMessage; error?: string }
        return res.ok && body.message
          ? { ok: true, message: body.message }
          : { ok: false, error: body.error ?? `HTTP ${res.status}` }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
    wsUrl(loc: { protocol: string; host: string }): string {
      return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws?token=${encodeURIComponent(token)}`
    },
  }
}
