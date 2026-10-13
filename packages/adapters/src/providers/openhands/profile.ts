// OpenHands CLI as an ACP agent: `openhands acp` (uv tool). Verified against CLI 1.16.0: `initialize`
// advertises one auth method (`oauth`: OpenHands Cloud OAuth), a browser login, so it is never
// called. We never pass `--cloud` (remote workspace) or `--override-with-envs`, and we start in
// "always-ask" (the CLI's default; mode ids from openhands_cli/acp_impl/confirmation.py).
// The CLI is Python: a cold `--version` / `--help` takes ~2.3 s each, so its probe needs a larger budget.
import { PROVIDER_DECLS } from '@agent-office/core'
import type { AcpProfile } from '../common/acp/acp-profile.ts'
import { AcpRunner, type AcpRunnerOptions } from '../common/acp/acp-runner.ts'

export const OPENHANDS_PROFILE: AcpProfile = {
  provider: 'openhands',
  prefix: PROVIDER_DECLS.openhands.prefix,
  label: 'OpenHands',
  bin: 'openhands',
  args: ['acp'],
  helpArgs: ['acp', '--help'],
  acpFlag: /usage: openhands acp/i,
  caps: [...PROVIDER_DECLS.openhands.managedCaps],
  authMethodPrefer: [],
  loginHint: 'openhands login',
  modes: [
    { id: 'always-ask', label: 'Ask before every action' },
    { id: 'llm-approve', label: 'Ask only for risky actions', dangerous: true },
    { id: 'always-approve', label: 'Auto-approve everything', dangerous: true },
  ],
  defaultModeId: 'always-ask',
}

/** The probe budget the Python CLI needs (two cold starts). */
export const OPENHANDS_PROBE_TIMEOUT_MS = 10_000

export class OpenHandsAcpRunner extends AcpRunner {
  constructor(o: AcpRunnerOptions = {}) {
    super(OPENHANDS_PROFILE, o)
  }
}
