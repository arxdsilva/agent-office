import { AcpProbe, type AcpProbeOptions } from '../common/acp/acp-probe.ts'
import { QWEN_PROFILE } from './profile.ts'

/** `qwen` CLI detection: version and the `--acp` flag; never starts a session. */
export class QwenProbe extends AcpProbe {
  constructor(o: AcpProbeOptions = {}) {
    super(QWEN_PROFILE, o)
  }
}
