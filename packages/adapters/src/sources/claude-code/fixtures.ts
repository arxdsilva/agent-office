// Fixtures mirror the shape of real Claude Code transcripts; all content is invented.
export const T0 = Date.parse('2026-01-01T10:00:00.000Z')
export const iso = (offsetMs = 0) => new Date(T0 + offsetMs).toISOString()
export const base = (over: Record<string, unknown> = {}) => ({
  sessionId: 'sess-1234abcd',
  cwd: '/home/dev/projects/shop',
  timestamp: iso(),
  isSidechain: false,
  ...over,
})
export const assistant = (
  content: unknown[],
  over: Record<string, unknown> = {},
  stop_reason: string | null = null,
) =>
  JSON.stringify({
    type: 'assistant',
    ...base(over),
    message: { role: 'assistant', model: 'claude-opus-5-5', content, stop_reason },
  })
export const user = (content: unknown, over: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', ...base(over), message: { role: 'user', content } })
