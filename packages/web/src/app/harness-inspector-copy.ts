// Copy for the Harness tab's flow stepper, pending asks and gate output, and for the flow lines of
// Minimal mode, New Session and the Overview (docs/harness.md §2a, §8). Labels that already live in
// `harness-copy.ts` are read from there, never duplicated.
import type { CheckState, StepCheckKind, StepState } from '@agent-office/shared'

export const INSPECTOR_COPY = {
  flow: {
    heading: 'Flow',
    progress: (done: number, total: number) => `${done} of ${total} steps done`,
    free: 'Any order',
    sequential: 'In order',
    state: {
      pending: 'Not started',
      active: 'In progress',
      done: 'Done',
      skipped: 'Skipped',
    } satisfies Record<StepState, string>,
    check: {
      pending: 'Pending',
      pass: 'Passed',
      fail: 'Failed',
      'waiting-user': 'Waiting for you',
    } satisfies Record<CheckState, string>,
    kind: {
      approval: 'Approval',
      gate: 'Validation',
      artifact: 'File',
      report: 'Agent report',
    } satisfies Record<StepCheckKind, string>,
    approve: 'Approve',
    markDone: 'Mark done',
    skip: 'Skip',
    reopen: 'Re-open',
    optional: 'optional',
    confirmSkip: (name: string) =>
      `Skip "${name}"? It is a required step. The skip is logged in the activity feed.`,
    confirmOk: 'Skip step',
    confirmCancel: 'Cancel',
  },
  pending: {
    heading: 'Waiting for your approval',
    allow: 'Allow once',
    deny: 'Deny',
  },
  gate: {
    showOutput: 'Show output',
    running: (name: string, elapsed: string) => `Running ${name}… (${elapsed})`,
  },
  denied: { showMore: (n: number) => `Show ${n} more`, showLess: 'Show less' },
  minimal: {
    step: (i: number, n: number, name: string) => `Step ${i}/${n} · ${name}`,
    blocked: (n: number) => `${n} blocked`,
  },
  newSession: {
    flow: (names: string, steps: number) =>
      `Flow: ${names} · ${steps} step${steps === 1 ? '' : 's'}`,
    first: (name: string) => `Starts with: ${name}`,
  },
  overview: {
    approve: 'Approve',
    open: 'Open',
    approvalTitle: (project: string, agent: string, step: string, prompt: string) =>
      `${project} · ${agent} · ${step}: ${prompt}`,
    approvalDetail: 'Waiting for your approval. Approving is logged.',
    count: (n: number) => `${n} flow approval${n === 1 ? '' : 's'} waiting`,
  },
  live: {
    approved: 'Approved.',
    markedDone: 'Marked done.',
    skipped: 'Step skipped.',
    reopened: 'Step re-opened.',
    answered: 'Answer sent.',
    declined: 'Question declined.',
    failed: 'That did not work. Try again.',
  },
} as const
