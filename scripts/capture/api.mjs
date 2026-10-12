// A tiny client for the app's local HTTP API (README → HTTP API), used to seed capture scenarios.
export function apiClient(port, token) {
  const base = `http://127.0.0.1:${port}`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const call = async (method, path, body) => {
    const r = await fetch(base + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`)
    return r.status === 204 ? null : r.json()
  }
  return {
    /** One event or a batch (partial updates). */
    events: (e) => call('POST', '/api/events', e),
    declare: (provider, decls) =>
      call('POST', `/api/providers/${encodeURIComponent(provider)}/capabilities`, decls),
    send: (id, text) => call('POST', `/api/agents/${encodeURIComponent(id)}/messages`, { text }),
    claim: (id) => call('GET', `/api/agents/${encodeURIComponent(id)}/inbox?claim=1`),
    reply: (id, text, inReplyTo) =>
      call('POST', `/api/agents/${encodeURIComponent(id)}/replies`, { text, inReplyTo }),
    agents: () => call('GET', '/api/agents'),
  }
}
