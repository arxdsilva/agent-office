import { PROVIDER_IDS, type ProviderState } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import type { ProbeResult } from '../ports/driven.ts'
import {
  ENDED_CAPS,
  PROVIDER_DECLS,
  prefixOf,
  providerOfAgentId,
  providerState,
  sessionCaps,
  type ProviderStateInput,
} from './providers.ts'

const ok: ProbeResult = { installed: true, version: '1.0.0', flagsOk: true, auth: 'ok' }
const base: ProviderStateInput = { enabled: true, liveSessions: 0, hasRuntime: true }
const cursor = PROVIDER_DECLS.cursor
const state = (probe: ProbeResult | undefined, over: Partial<ProviderStateInput> = {}) =>
  providerState(cursor, probe, { ...base, ...over })

describe('PROVIDER_DECLS', () => {
  it('PV-1 declares every provider with a unique, non-empty prefix (ChatGPT has none)', () => {
    expect(Object.keys(PROVIDER_DECLS).sort()).toEqual([...PROVIDER_IDS].sort())
    const prefixes = PROVIDER_IDS.map((id) => PROVIDER_DECLS[id].prefix).filter(Boolean)
    expect(new Set(prefixes).size).toBe(5)
    expect(PROVIDER_DECLS.chatgpt.prefix).toBe('')
    for (const id of PROVIDER_IDS) expect(PROVIDER_DECLS[id].id).toBe(id)
  })

  it('PV-2 keeps Claude Code caps and the tested versions as documented', () => {
    expect(PROVIDER_DECLS['claude-code']).toMatchObject({
      prefix: 'cc:',
      testedVersion: '2.1.270',
      integration: { managed: 'agent-sdk', observe: 'transcripts' },
      observedCaps: ['observe', 'send-message'],
    })
    expect(PROVIDER_DECLS['claude-code'].managedCaps).toEqual([
      'launch',
      'send-message',
      'interrupt',
      'stop',
      'approve-tools',
      'select-model',
      'change-mode',
      'attach-context',
      'chrome',
    ])
    expect(PROVIDER_DECLS.codex).toMatchObject({ prefix: 'cx:', testedVersion: '0.162.1' })
    expect(PROVIDER_DECLS.codex.observedCaps).toEqual([])
    expect(PROVIDER_DECLS.codex.managedCaps).toContain('select-model')
    expect(cursor).toMatchObject({ prefix: 'cu:', testedVersion: '2026.10.01-e373342' })
    expect(PROVIDER_DECLS.gemini).toMatchObject({ prefix: 'gm:', testedVersion: '0.63.0' })
    expect(PROVIDER_DECLS.copilot).toMatchObject({ prefix: 'gh:', testedVersion: '1.0.96' })
    for (const id of ['cursor', 'gemini', 'copilot'] as const) {
      // Verified on the real CLIs: Cursor, Gemini and Copilot sessions all report their models.
      expect(PROVIDER_DECLS[id].managedCaps).toContain('select-model')
      expect(PROVIDER_DECLS[id].managedCaps).not.toContain('chrome')
      expect(PROVIDER_DECLS[id].observedCaps).toEqual(['observe'])
      expect(PROVIDER_DECLS[id].integration).toEqual({ managed: 'acp', observe: 'hooks' })
    }
    expect(PROVIDER_DECLS.chatgpt).toMatchObject({
      managedCaps: [],
      observedCaps: [],
      hint: 'opt-in-tunnel',
    })
    for (const id of PROVIDER_IDS) expect(PROVIDER_DECLS[id].managedCaps).not.toContain('resume')
  })

  it('PV-3 maps prefixes and agent ids both ways', () => {
    expect(prefixOf('codex')).toBe('cx:')
    expect(prefixOf('chatgpt')).toBeUndefined()
    expect(providerOfAgentId('gm:abc')).toBe('gemini')
    expect(providerOfAgentId('cc:1')).toBe('claude-code')
    expect(providerOfAgentId('worker-7')).toBeUndefined()
  })
})

describe('providerState precedence (docs §4)', () => {
  it('PV-4 disabled beats everything; not-installed needs no CLI and no hooks', () => {
    expect(state({ ...ok, error: 'timeout' }, { enabled: false }).state).toBe('disabled')
    expect(state({ installed: false, flagsOk: false, auth: 'unknown' })).toEqual({
      state: 'not-installed',
      hint: 'install-cli',
    })
    expect(state(undefined, { hasRuntime: false })).toMatchObject({ state: 'not-installed' })
    // hooks present without the CLI: still observable
    expect(
      state({ installed: false, flagsOk: false, auth: 'unknown' }, { hooks: 'installed' }).state,
    ).toBe('observe-only')
  })

  it('PV-5 error, unsupported-version, needs-auth and needs-setup carry closed hints', () => {
    expect(state({ ...ok, error: 'timeout' })).toEqual({ state: 'error', hint: 'probe-timeout' })
    expect(state({ ...ok, error: 'spawn' })).toEqual({ state: 'error', hint: 'probe-failed' })
    expect(state({ ...ok, flagsOk: false })).toEqual({
      state: 'unsupported-version',
      hint: 'update-cli',
    })
    expect(state({ ...ok, auth: 'needed' })).toEqual({
      state: 'needs-auth',
      hint: 'login-required',
    })
    expect(state(ok, { hooks: 'outdated' })).toEqual({
      state: 'needs-setup',
      hint: 'hooks-outdated',
    })
    expect(state(ok, { hooks: 'invalid' })).toEqual({
      state: 'needs-setup',
      hint: 'hooks-invalid-config',
    })
  })

  it('PV-6 connected, observe-only, managed-available, installed', () => {
    const order: [Partial<ProviderStateInput>, ProviderState][] = [
      [{ liveSessions: 2, hooks: 'installed' }, 'connected'],
      [{ hasRuntime: false, hooks: 'installed' }, 'observe-only'],
      [{ hooks: 'installed' }, 'managed-available'],
      [{}, 'managed-available'],
      [{ hasRuntime: false }, 'installed'],
    ]
    for (const [over, want] of order) expect(state(ok, over).state).toBe(want)
  })

  it('PV-7 falls back to the declaration hint; Claude without a probe is managed-available', () => {
    expect(providerState(PROVIDER_DECLS.chatgpt, undefined, { ...base, enabled: false })).toEqual({
      state: 'disabled',
      hint: 'opt-in-tunnel',
    })
    expect(providerState(PROVIDER_DECLS['claude-code'], undefined, base)).toEqual({
      state: 'managed-available',
    })
    expect(providerState(PROVIDER_DECLS.codex, ok, { ...base, hasRuntime: false }).hint).toBe(
      'no-observation-surface',
    )
  })
})

describe('sessionCaps', () => {
  it('PV-8 managed running → managed caps; ended → observe + stop; observed → observed caps', () => {
    expect(sessionCaps(cursor, { managed: true, phase: 'running' })).toEqual(cursor.managedCaps)
    expect(sessionCaps(cursor, { managed: true, phase: 'ended' })).toEqual(['observe', 'stop'])
    expect(ENDED_CAPS).toEqual(['observe', 'stop'])
    expect(sessionCaps(cursor, { managed: false })).toEqual(['observe'])
    expect(sessionCaps(PROVIDER_DECLS.codex, { managed: false })).toEqual([])
    // copies, never the shared constant
    expect(sessionCaps(cursor, { managed: true, phase: 'running' })).not.toBe(cursor.managedCaps)
  })
})
