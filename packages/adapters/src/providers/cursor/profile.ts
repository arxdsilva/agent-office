// Cursor CLI as an ACP agent: `agent acp` (https://cursor.com/docs/cli/acp). Verified against
// agent 2026.10.01-e373342: session/new answers auth_required until `authenticate {cursor_login}`,
// which reuses the existing `agent login` credentials (no browser, no key).
import { PROVIDER_DECLS } from '@agent-office/core'
import type { AcpProfile } from '../common/acp/acp-profile.ts'
import { AcpRunner, type AcpRunnerOptions } from '../common/acp/acp-runner.ts'

export const CURSOR_PROFILE: AcpProfile = {
  provider: 'cursor',
  prefix: PROVIDER_DECLS.cursor.prefix,
  label: 'Cursor',
  bin: 'agent',
  args: ['acp'],
  helpArgs: ['acp', '--help'],
  acpFlag: /\bACP\b|Agent Client Protocol/,
  caps: [...PROVIDER_DECLS.cursor.managedCaps],
  authMethodPrefer: ['cursor_login'],
  loginHint: 'agent login',
  modes: [
    { id: 'agent', label: 'Agent' },
    { id: 'plan', label: 'Plan (read-only)' },
    { id: 'ask', label: 'Ask (no edits)' },
  ],
  defaultModeId: 'agent',
}

export class CursorAcpRunner extends AcpRunner {
  constructor(o: AcpRunnerOptions = {}) {
    super(CURSOR_PROFILE, o)
  }
}
