import { AcpProbe, type AcpProbeOptions } from '../common/acp/acp-probe.ts'
import { KILO_PROFILE } from './profile.ts'

/** `kilo` CLI detection: version and `kilo acp`; never starts a session. */
export class KiloProbe extends AcpProbe {
  constructor(o: AcpProbeOptions = {}) {
    super(KILO_PROFILE, o)
  }
}
