// The ACP profiles of the open-source runtimes (OpenCode, goose, Kilo Code, Qwen Code, Cline,
// OpenHands): shape, verified help text, probe and runner contracts, and the no-leak guarantees,
// against the fake ACP agent (`--profile <id>`). No real CLI is ever started here.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVIDER_DECLS } from '@agent-office/core'
import { managedRuntimeContract, providerProbeContract } from '@agent-office/core/testing'
import type { AgentEvent, ProviderId } from '@agent-office/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { acpHarness } from '../../test/fakes/acp-harness.ts'
import type { AcpProfile } from './common/acp/acp-profile.ts'
import { AcpProbe, AcpRunner } from './common/acp/index.ts'
import {
  CLINE_PROFILE,
  ClineAcpRunner,
  ClineProbe,
  GOOSE_PROFILE,
  GooseAcpRunner,
  GooseProbe,
  KILO_PROFILE,
  KiloAcpRunner,
  KiloProbe,
  OPENCODE_ACP_PROFILE,
  OpenCodeAcpProbe,
  OpenCodeAcpRunner,
  OPENHANDS_PROFILE,
  OpenHandsAcpRunner,
  OpenHandsProbe,
  QWEN_PROFILE,
  QwenAcpRunner,
  QwenProbe,
} from './index.ts'

const FAKE = fileURLToPath(new URL('../../test/fakes/fake-acp-agent.mjs', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'oss-acp-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

interface Case {
  id: ProviderId
  profile: AcpProfile
  Runner: new (o?: ConstructorParameters<typeof AcpRunner>[1]) => AcpRunner
  Probe: new (o?: ConstructorParameters<typeof AcpProbe>[1]) => AcpProbe
  bin: string
  args: string[]
  prefix: string
  /** The line of the real CLI's help (verified on this machine) the acpFlag must match. */
  realHelp: string
  /** Real help of the same CLI without the ACP surface. */
  otherHelp: string
  modes: string[]
  dangerous: string[]
  /** Auth method ids the real CLI advertises in `initialize`: none may ever be preferred. */
  advertised: string[]
}

const CASES: Case[] = [
  {
    id: 'opencode',
    profile: OPENCODE_ACP_PROFILE,
    Runner: OpenCodeAcpRunner,
    Probe: OpenCodeAcpProbe,
    bin: 'opencode',
    args: ['acp'],
    prefix: 'oc:',
    realHelp: 'opencode acp\nstart ACP (Agent Client Protocol) server\nOptions:',
    otherHelp: 'opencode acp\n',
    modes: ['build', 'plan'],
    dangerous: [],
    advertised: ['opencode-login'],
  },
  {
    id: 'goose',
    profile: GOOSE_PROFILE,
    Runner: GooseAcpRunner,
    Probe: GooseProbe,
    bin: 'goose',
    args: ['acp'],
    prefix: 'go:',
    realHelp: 'Run goose as an ACP agent server on stdio\n\nUsage: goose acp [OPTIONS]',
    otherHelp: 'Usage: goose acp [OPTIONS]\n',
    modes: ['approve', 'smart_approve', 'auto', 'chat'],
    dangerous: ['smart_approve', 'auto'],
    advertised: ['goose-provider'],
  },
  {
    id: 'kilo',
    profile: KILO_PROFILE,
    Runner: KiloAcpRunner,
    Probe: KiloProbe,
    bin: 'kilo',
    args: ['acp'],
    prefix: 'ki:',
    realHelp: 'kilo acp\nstart ACP (Agent Client Protocol) server\nOptions:',
    otherHelp: 'kilo acp\n',
    modes: ['code', 'ask', 'plan', 'debug', 'orchestrator'],
    dangerous: [],
    advertised: ['kilo-login'],
  },
  {
    id: 'qwen',
    profile: QWEN_PROFILE,
    Runner: QwenAcpRunner,
    Probe: QwenProbe,
    bin: 'qwen',
    args: ['--acp'],
    prefix: 'qw:',
    realHelp: '      --acp                             Starts the agent in ACP mode  [boolean]',
    otherHelp: '      --approval-mode                   Set the approval mode: plan, default',
    modes: ['default', 'plan', 'auto-edit', 'auto', 'yolo'],
    dangerous: ['auto-edit', 'auto', 'yolo'],
    advertised: ['openai'],
  },
  {
    id: 'cline',
    profile: CLINE_PROFILE,
    Runner: ClineAcpRunner,
    Probe: ClineProbe,
    bin: 'cline',
    args: ['--acp', '--auto-approve', 'false'],
    prefix: 'cl:',
    realHelp: '  --acp                         Run in Agent Client Protocol (ACP) mode for',
    otherHelp: '  --auto-approve <boolean>      Set tool auto-approval for all tools',
    modes: ['act', 'plan'],
    dangerous: [],
    advertised: ['cline', 'cline-pass', 'openai-codex'],
  },
  {
    id: 'openhands',
    profile: OPENHANDS_PROFILE,
    Runner: OpenHandsAcpRunner,
    Probe: OpenHandsProbe,
    bin: 'openhands',
    args: ['acp'],
    prefix: 'oh:',
    realHelp: 'usage: openhands acp [-h] [--resume [RESUME]] [--last]',
    otherHelp: 'usage: openhands [-h] {acp,cloud,login}',
    modes: ['always-ask', 'llm-approve', 'always-approve'],
    dangerous: ['llm-approve', 'always-approve'],
    advertised: ['oauth'],
  },
]

const SECRETS = /secret|\/Users\/|ls -la/

for (const c of CASES) {
  const fakeArgs = [FAKE, '--profile', c.id]
  const probe = (argsPrefix = fakeArgs, bin = process.execPath) => new c.Probe({ bin, argsPrefix })

  describe(`${c.id} ACP profile`, () => {
    it('runs the verified ACP entry with its prefix, the declared caps and a safe auth stance', () => {
      const p = c.profile
      expect(p.provider).toBe(c.id)
      expect(p.bin).toBe(c.bin)
      expect(p.args).toEqual(c.args)
      expect(p.prefix).toBe(c.prefix)
      expect(p.prefix).toBe(PROVIDER_DECLS[c.id].prefix)
      expect(p.caps).toEqual(PROVIDER_DECLS[c.id].managedCaps)
      if (c.id !== 'opencode') expect(PROVIDER_DECLS[c.id].integration.managed).toBe('acp')
      // Every advertised method is a hint, a browser login or an API key: never call one.
      expect(p.authMethodPrefer).toEqual([])
      for (const a of c.advertised) expect(p.authMethodPrefer).not.toContain(a)
    })

    it('matches the verified help text and rejects help without the ACP surface', () => {
      expect(c.profile.acpFlag.test(c.realHelp)).toBe(true)
      expect(c.profile.acpFlag.test(c.otherHelp)).toBe(false)
    })

    it('offers its modes, the default first and dangerous ones flagged', () => {
      const r = new c.Runner()
      expect(r.decl.modes?.map((m) => m.id)).toEqual(c.modes)
      expect(r.decl.defaultModeId).toBe(c.modes[0])
      expect((r.decl.modes ?? []).filter((m) => m.dangerous).map((m) => m.id)).toEqual(c.dangerous)
      for (const m of r.decl.modes ?? []) expect(m.id.length).toBeLessThanOrEqual(60)
    })

    it('tells the user how to log in', () => {
      expect(c.profile.loginHint.length).toBeGreaterThan(0)
      expect(c.profile.label.length).toBeGreaterThan(0)
    })

    it('starts a session against the fake agent, answers and stops cleanly', async () => {
      const runner = new c.Runner({ bin: process.execPath, args: fakeArgs })
      const s = runner.start({
        cwd: dir,
        mode: 'default',
        extraDirs: [],
        chrome: false,
        allowBypass: false,
        modeId: c.modes[0]!,
      })
      const results: string[] = []
      s.onResult((r) => results.push(r.text))
      await expect(s.sessionId).resolves.toBe('sess_fake1')
      s.push('/quick hi')
      await until(() => results.length > 0)
      expect(results).toEqual(['ok: /quick hi'])
      await s.close()
    })

    it('does not start a dangerous mode without allowBypass', async () => {
      if (c.dangerous.length === 0) return
      const runner = new c.Runner({ bin: process.execPath, args: fakeArgs })
      const s = runner.start({
        cwd: dir,
        mode: 'default',
        extraDirs: [],
        chrome: false,
        allowBypass: false,
      })
      await s.sessionId
      await expect(s.setModeId!(c.dangerous[0]!)).rejects.toThrow(/Mode not available/)
      await s.close()
    })

    it('emits status and tool events only: no thoughts, plans, commands or paths', async () => {
      const runner = new c.Runner({ bin: process.execPath, args: fakeArgs })
      const s = runner.start({
        cwd: dir,
        mode: 'default',
        extraDirs: [],
        chrome: false,
        allowBypass: false,
      })
      const events: Omit<AgentEvent, 'agentId'>[] = []
      const perms: unknown[] = []
      const results: string[] = []
      s.onEvent((e) => events.push(e))
      s.onResult((r) => results.push(r.text))
      s.onPermission(async (r) => {
        perms.push(r)
        return { behavior: 'allow' }
      })
      await s.sessionId
      s.push('List the files')
      await until(() => results.length > 0)
      expect(results).toEqual(['Here are the files.'])
      expect(events.length).toBeGreaterThan(0)
      expect(JSON.stringify(events)).not.toMatch(SECRETS)
      // The card shows a short summary only, never the raw tool input.
      expect(perms).toHaveLength(1)
      expect(JSON.stringify(perms)).not.toMatch(/"rawInput"/)
      await s.close()
    })

    it('reports a login problem as the profile login hint when no auth method is usable', async () => {
      const runner = new c.Runner({
        bin: process.execPath,
        args: fakeArgs,
        env: { FAKE_ACP_AUTH: 'required' },
      })
      const s = runner.start({
        cwd: dir,
        mode: 'default',
        extraDirs: [],
        chrome: false,
        allowBypass: false,
      })
      const exit = new Promise<{ error?: string; message?: string }>((r) => s.onExit(r))
      await expect(s.sessionId).rejects.toMatchObject({ error: 'auth' })
      const e = await exit
      expect(e.error).toBe('auth')
      expect(e.message).toContain(c.profile.loginHint)
    })

    describe('probe', () => {
      it('detects the fake CLI and its ACP surface', async () => {
        const p = probe()
        expect(p.provider).toBe(c.id)
        expect(await p.detect()).toMatchObject({ installed: true, flagsOk: true, auth: 'unknown' })
      })

      it('flags a CLI without the ACP surface', async () => {
        const p = new c.Probe({
          bin: process.execPath,
          argsPrefix: fakeArgs,
          env: { FAKE_ACP_NOFLAG: '1' },
        })
        expect(await p.detect()).toMatchObject({ installed: true, flagsOk: false })
      })

      it('reports a missing CLI as not installed', async () => {
        const p = new c.Probe({ bin: join(tmpdir(), `no-such-${c.bin}`) })
        expect(await p.detect()).toMatchObject({ installed: false })
      })
    })

    providerProbeContract(`${c.id} probe (fake)`, () => probe())
    providerProbeContract(
      `${c.id} probe (missing CLI)`,
      () => new c.Probe({ bin: join(tmpdir(), `no-such-${c.bin}`) }),
    )
    managedRuntimeContract(`${c.id} runner`, () => acpHarness(c.profile))
  })
}

describe('safe permission defaults of the OpenCode family', () => {
  const run = async (profile: AcpProfile, id: ProviderId) => {
    const logFile = join(dir, `perm-${id}.jsonl`)
    const runner = new AcpRunner(profile, {
      bin: process.execPath,
      args: [FAKE, '--profile', id],
      env: { FAKE_LOG: logFile },
    })
    const s = runner.start({
      cwd: dir,
      mode: 'default',
      extraDirs: [],
      chrome: false,
      allowBypass: false,
    })
    await s.sessionId
    await s.close()
    expect(existsSync(logFile)).toBe(true)
    const first = JSON.parse(readFileSync(logFile, 'utf8').split('\n')[0]!)
    return JSON.parse(first.perm as string) as { permission: Record<string, string> }
  }

  it('OpenCode asks before edits, shell commands and web fetches', async () => {
    expect((await run(OPENCODE_ACP_PROFILE, 'opencode')).permission).toEqual({
      edit: 'ask',
      bash: 'ask',
      webfetch: 'ask',
    })
  })

  it('Kilo asks before edits and web fetches (shell already asks by default)', async () => {
    expect((await run(KILO_PROFILE, 'kilo')).permission).toEqual({
      edit: 'ask',
      webfetch: 'ask',
    })
  })

  it('the caller env wins over the profile env', async () => {
    const logFile = join(dir, 'perm-override.jsonl')
    const runner = new AcpRunner(OPENCODE_ACP_PROFILE, {
      bin: process.execPath,
      args: [FAKE, '--profile', 'opencode'],
      env: { FAKE_LOG: logFile, OPENCODE_CONFIG_CONTENT: '{"x":1}' },
    })
    const s = runner.start({
      cwd: dir,
      mode: 'default',
      extraDirs: [],
      chrome: false,
      allowBypass: false,
    })
    await s.sessionId
    await s.close()
    expect(JSON.parse(readFileSync(logFile, 'utf8').split('\n')[0]!).perm).toBe('{"x":1}')
  })
})

describe('OpenHands probe budget', () => {
  it('allows the Python CLI two cold starts', async () => {
    const { OPENHANDS_PROBE_TIMEOUT_MS } = await import('./index.ts')
    expect(OPENHANDS_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(6000)
  })
})

async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

// What the real CLIs did on a verification run (2026-10-13), reproduced by the fake.
describe('real CLI behaviours', () => {
  const start = (profile: AcpProfile, id: ProviderId, env: Record<string, string> = {}, modeId?: string) =>
    new AcpRunner(profile, {
      bin: process.execPath,
      args: [FAKE, '--profile', id],
      env,
    }).start({
      cwd: dir,
      mode: 'default',
      extraDirs: [],
      chrome: false,
      allowBypass: false,
      ...(modeId ? { modeId } : {}),
    })
  const sent = (logFile: string) =>
    readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { method?: string; params?: Record<string, unknown> })

  for (const [profile, id, other] of [
    [OPENCODE_ACP_PROFILE, 'opencode', 'plan'],
    [KILO_PROFILE, 'kilo', 'plan'],
  ] as const) {
    it(`${id} offers its modes only as a "mode" config option: start mode and switches use it`, async () => {
      const logFile = join(dir, `modes-${id}.jsonl`)
      const s = start(profile, id, { FAKE_LOG: logFile }, other)
      await s.sessionId
      await expect(s.setModeId!(profile.defaultModeId!)).resolves.toBeUndefined()
      await s.close()
      const modeCalls = sent(logFile)
        .filter((m) => m.method === 'session/set_config_option' && m.params?.configId === 'mode')
        .map((m) => m.params?.value)
      expect(modeCalls).toEqual([other, profile.defaultModeId])
    })
  }

  it('goose without a configured provider asks the user to run `goose configure`', async () => {
    const s = start(GOOSE_PROFILE, 'goose', { FAKE_ACP_UNCONFIGURED: '1' })
    const exit = new Promise<{ error?: string; message?: string }>((r) => s.onExit(r))
    await expect(s.sessionId).rejects.toMatchObject({ error: 'auth' })
    const e = await exit
    expect(e.error).toBe('auth')
    expect(e.message).toContain('`goose configure`')
    expect(e.message).not.toMatch(/GOOSE_PROVIDER|could not be started/)
  })

  it('Kilo without a login ends the turn with the login hint and keeps the session', async () => {
    const s = start(KILO_PROFILE, 'kilo', { FAKE_ACP_UNCONFIGURED: '1' })
    const results: { text: string; isError: boolean }[] = []
    s.onResult((r) => results.push(r))
    await s.sessionId
    s.push('/quick hi')
    await until(() => results.length > 0)
    expect(results[0]!.isError).toBe(true)
    expect(results[0]!.text).toContain('`kilo auth login`')
    // Another model may not need the login: the session stays usable.
    await expect(s.supportedModels()).resolves.not.toEqual([])
    await s.close()
  })
})
