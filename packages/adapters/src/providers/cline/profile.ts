// Cline CLI as an ACP agent: `cline --acp`. Verified against 3.0.70: `initialize` advertises
// `cline`, `cline-pass` and `openai-codex` sign-in methods, all browser logins that write the
// user's credentials, so none is ever called. `--auto-approve false` turns off the CLI's default
// of approving every tool (`cline --help`); whether ACP mode then sends permission requests is
// not verified yet (docs/providers/cline.md).
import { PROVIDER_DECLS } from '@agent-office/core'
import type { AcpProfile } from '../common/acp/acp-profile.ts'
import { AcpRunner, type AcpRunnerOptions } from '../common/acp/acp-runner.ts'

export const CLINE_PROFILE: AcpProfile = {
  provider: 'cline',
  prefix: PROVIDER_DECLS.cline.prefix,
  label: 'Cline',
  bin: 'cline',
  args: ['--acp', '--auto-approve', 'false'],
  acpFlag: /--acp\b/,
  caps: [...PROVIDER_DECLS.cline.managedCaps],
  authMethodPrefer: [],
  loginHint: 'cline auth',
  modes: [
    { id: 'act', label: 'Act' },
    { id: 'plan', label: 'Plan (read-only)' },
  ],
  defaultModeId: 'act',
}

export class ClineAcpRunner extends AcpRunner {
  constructor(o: AcpRunnerOptions = {}) {
    super(CLINE_PROFILE, o)
  }
}
