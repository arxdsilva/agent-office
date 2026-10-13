import { AcpProbe, type AcpProbeOptions } from '../common/acp/acp-probe.ts'
import { OPENHANDS_PROBE_TIMEOUT_MS, OPENHANDS_PROFILE } from './profile.ts'

/** `openhands` CLI detection: version and `openhands acp`; never starts a session. */
export class OpenHandsProbe extends AcpProbe {
  constructor(o: AcpProbeOptions = {}) {
    super(OPENHANDS_PROFILE, { timeoutMs: OPENHANDS_PROBE_TIMEOUT_MS, ...o })
  }
}
