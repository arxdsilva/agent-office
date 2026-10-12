import { describe, expect, it } from 'vitest'
import { preloadGateway } from './preload-gateway.ts'

describe('preloadGateway', () => {
  it('returns the API the preload exposed', () => {
    const api = { ready: async () => ({ agents: [], messages: [] }) }
    expect(preloadGateway({ agentOffice: api } as never)).toBe(api)
  })

  it('fails loudly outside the desktop app', () => {
    expect(() => preloadGateway({} as never)).toThrow(/desktop app/)
  })
})
