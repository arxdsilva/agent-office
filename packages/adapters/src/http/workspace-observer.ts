import type { ReportActivity, SessionObservation } from '@agent-office/core'

/**
 * Decorates ReportActivity so events carrying an opaque `workspace` key (observe hooks) tell the
 * projects layer where the agent works. The key goes to the session record only; it never reaches
 * the Agent DTO. Observation failures never affect reporting.
 */
export function observeWorkspace(
  inner: ReportActivity,
  observation: SessionObservation,
): ReportActivity {
  return {
    report(events) {
      const accepted = inner.report(events)
      for (const e of events) {
        if (!e.workspace) continue
        observation
          .located(e.agentId, e.provider ?? e.source ?? 'http', { workspaceKey: e.workspace })
          .catch(() => {})
      }
      return accepted
    },
  }
}
