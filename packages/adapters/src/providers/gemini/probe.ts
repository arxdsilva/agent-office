import { AcpProbe, type AcpProbeOptions } from '../common/acp/acp-probe.ts'
import { GEMINI_PROFILE } from './profile.ts'

/** `gemini` CLI detection: version and the ACP surface; never starts a session. */
export class GeminiProbe extends AcpProbe {
  constructor(o: AcpProbeOptions = {}) {
    super(GEMINI_PROFILE, o)
  }
}
