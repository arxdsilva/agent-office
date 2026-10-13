// The scrubbed environment of a validation gate (docs/harness.md §4): the user's environment minus
// agent-office's own variables, anything that may carry a credential, and NODE_OPTIONS (it can
// inject code into every Node process the gate starts).
const OURS = /^AGENT_OFFICE_/i
const CREDENTIAL = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION/i
const DROPPED = new Set(['NODE_OPTIONS'])

export function gateEnv(base: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || OURS.test(k) || CREDENTIAL.test(k) || DROPPED.has(k.toUpperCase()))
      continue
    out[k] = v
  }
  out.CI = '1'
  out.AGENT_OFFICE_GATE = '1'
  return out
}
