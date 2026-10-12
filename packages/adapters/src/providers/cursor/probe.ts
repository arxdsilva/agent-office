import { AcpProbe, type AcpProbeOptions } from '../common/acp/acp-probe.ts'
import { CURSOR_PROFILE } from './profile.ts'

/** `cursor` CLI detection: version and the ACP surface; never starts a session. */
export class CursorProbe extends AcpProbe {
  constructor(o: AcpProbeOptions = {}) {
    super(CURSOR_PROFILE, o)
  }
}
