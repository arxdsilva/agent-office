import { AcpProbe, type AcpProbeOptions } from '../common/acp/acp-probe.ts'
import { COPILOT_PROFILE } from './profile.ts'

/** `copilot` CLI detection: version and the ACP surface; never starts a session. */
export class CopilotProbe extends AcpProbe {
  constructor(o: AcpProbeOptions = {}) {
    super(COPILOT_PROFILE, o)
  }
}
