// GitHub Copilot CLI as an ACP agent: `copilot --acp` (public preview). Verified against 1.0.96:
// a logged-in CLI opens sessions without `authenticate`; its only method (copilot-login) is a
// terminal login the user runs themselves. Mode ids are URLs, so the profile maps short ids.
import { PROVIDER_DECLS } from '@agent-office/core'
import type { AcpProfile } from '../common/acp/acp-profile.ts'
import { AcpRunner, type AcpRunnerOptions } from '../common/acp/acp-runner.ts'

const MODE = 'https://agentclientprotocol.com/protocol/session-modes#'

export const COPILOT_PROFILE: AcpProfile = {
  provider: 'copilot',
  prefix: PROVIDER_DECLS.copilot.prefix,
  label: 'Copilot CLI',
  bin: 'copilot',
  args: ['--acp'],
  acpFlag: /--acp\b/,
  caps: [...PROVIDER_DECLS.copilot.managedCaps],
  authMethodPrefer: [],
  loginHint: 'copilot login',
  modes: [
    { id: 'agent', label: 'Agent', native: `${MODE}agent` },
    { id: 'plan', label: 'Plan', native: `${MODE}plan` },
    // Turns on allow-all and runs without asking.
    {
      id: 'autopilot',
      label: 'Autopilot (allow all)',
      native: `${MODE}autopilot`,
      dangerous: true,
    },
  ],
  defaultModeId: 'agent',
}

export class CopilotAcpRunner extends AcpRunner {
  constructor(o: AcpRunnerOptions = {}) {
    super(COPILOT_PROFILE, o)
  }
}
