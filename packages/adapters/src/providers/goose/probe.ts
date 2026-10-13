import { AcpProbe, type AcpProbeOptions } from '../common/acp/acp-probe.ts'
import { GOOSE_PROFILE } from './profile.ts'

/** `goose` CLI detection: version and `goose acp`; never starts a session. */
export class GooseProbe extends AcpProbe {
  constructor(o: AcpProbeOptions = {}) {
    super(GOOSE_PROFILE, o)
  }
}
