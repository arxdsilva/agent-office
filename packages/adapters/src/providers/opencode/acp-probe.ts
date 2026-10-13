import { AcpProbe, type AcpProbeOptions } from '../common/acp/acp-probe.ts'
import { OPENCODE_ACP_PROFILE } from './acp-profile.ts'

/** `opencode` CLI detection for the ACP runtime: version and `opencode acp`; never starts a session. */
export class OpenCodeAcpProbe extends AcpProbe {
  constructor(o: AcpProbeOptions = {}) {
    super(OPENCODE_ACP_PROFILE, o)
  }
}
