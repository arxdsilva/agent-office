// Gemini CLI as an ACP agent: `gemini --acp` (https://geminicli.com/docs/cli/acp-mode/). Verified
// against 0.63.0: a logged-in CLI opens sessions without `authenticate`; its methods
// (oauth-personal, gemini-api-key, vertex-ai, gateway) either start a browser login, take a key, or
// rewrite `security.auth.selectedType` in the user's settings — so none is ever called.
import { PROVIDER_DECLS } from '@agent-office/core'
import type { AcpProfile } from '../common/acp/acp-profile.ts'
import { AcpRunner, type AcpRunnerOptions } from '../common/acp/acp-runner.ts'

export const GEMINI_PROFILE: AcpProfile = {
  provider: 'gemini',
  prefix: PROVIDER_DECLS.gemini.prefix,
  label: 'Gemini CLI',
  bin: 'gemini',
  args: ['--acp'],
  acpFlag: /--acp\b/,
  caps: [...PROVIDER_DECLS.gemini.managedCaps],
  authMethodPrefer: [],
  loginHint: 'gemini',
  // buildAvailableModes() in 0.63.0; `plan` only when the user enabled it (the runner checks).
  modes: [
    { id: 'default', label: 'Ask before tools' },
    { id: 'autoEdit', label: 'Auto-approve edits', dangerous: true },
    { id: 'yolo', label: 'Auto-approve everything', dangerous: true },
    { id: 'plan', label: 'Plan (read-only)' },
  ],
  defaultModeId: 'default',
}

export class GeminiAcpRunner extends AcpRunner {
  constructor(o: AcpRunnerOptions = {}) {
    super(GEMINI_PROFILE, o)
  }
}
