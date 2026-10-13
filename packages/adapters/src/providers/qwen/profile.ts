// Qwen Code as an ACP agent: `qwen --acp`. Verified against 0.25.1: `initialize` advertises one
// auth method (`openai`: needs OPENAI_API_KEY in the environment), an API key, so it is never
// called; the user configures a model in Qwen's own settings (`qwen auth` is removed). Modes are
// Qwen's approval modes (`--approval-mode`: plan, default, auto-edit, auto, yolo).
import { PROVIDER_DECLS } from '@agent-office/core'
import type { AcpProfile } from '../common/acp/acp-profile.ts'
import { AcpRunner, type AcpRunnerOptions } from '../common/acp/acp-runner.ts'

export const QWEN_PROFILE: AcpProfile = {
  provider: 'qwen',
  prefix: PROVIDER_DECLS.qwen.prefix,
  label: 'Qwen Code',
  bin: 'qwen',
  args: ['--acp'],
  acpFlag: /--acp\b/,
  caps: [...PROVIDER_DECLS.qwen.managedCaps],
  authMethodPrefer: [],
  loginHint: 'qwen',
  modes: [
    { id: 'default', label: 'Ask before tools' },
    { id: 'plan', label: 'Plan (read-only)' },
    { id: 'auto-edit', label: 'Auto-approve edits', dangerous: true },
    { id: 'auto', label: 'Auto-approve safe actions', dangerous: true },
    { id: 'yolo', label: 'Auto-approve everything', dangerous: true },
  ],
  defaultModeId: 'default',
}

export class QwenAcpRunner extends AcpRunner {
  constructor(o: AcpRunnerOptions = {}) {
    super(QWEN_PROFILE, o)
  }
}
