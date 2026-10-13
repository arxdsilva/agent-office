import { AcpProbe, type AcpProbeOptions } from '../common/acp/acp-probe.ts'
import { CLINE_PROFILE } from './profile.ts'

/** `cline` CLI detection: version and the `--acp` flag; never starts a session. */
export class ClineProbe extends AcpProbe {
  constructor(o: AcpProbeOptions = {}) {
    super(CLINE_PROFILE, o)
  }
}
