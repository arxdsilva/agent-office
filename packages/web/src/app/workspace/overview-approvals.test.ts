import { describe, expect, it } from 'vitest'
import { NOW, P1, overview, project } from './__fixtures__/projects.ts'
import { flowApprovalCount, overviewVM, type OverviewApprovalVM } from './overview-vm.ts'
import { initialState, reduce } from './state.ts'

const approval = {
  projectId: P1,
  projectName: 'Alpha',
  agentId: 'cc:1',
  agentName: 'Ada',
  stepId: 'stp_outline',
  stepName: 'Outline',
  checkIndex: 0,
  prompt: 'Outline approved?',
}
const withApprovals = (flowApprovals: (typeof approval)[], pendingApprovals = 0) =>
  reduce(reduce(initialState(), { type: 'projects', projects: [project()] }), {
    type: 'overview',
    overview: overview({ flowApprovals, pendingApprovals }),
  })

describe('overviewVM: flow approvals', () => {
  it('lists one card per pending approval with Approve and Open', () => {
    const vm = overviewVM(withApprovals([approval]), NOW)
    const items = vm.sections.find((s) => s.id === 'approvals')!.items as OverviewApprovalVM[]
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'flow:cc:1:stp_outline:0',
      agentId: 'cc:1',
      stepId: 'stp_outline',
      title: 'Alpha · Ada · Outline: Outline approved?',
      approve: {
        label: 'Approve',
        action: { type: 'flow-approve', agentId: 'cc:1', stepId: 'stp_outline', checkIndex: 0 },
      },
      action: { type: 'focus-agent', agentId: 'cc:1' },
      actionLabel: 'Open',
    })
  })

  it('puts flow approvals before the memory-approvals card and counts them', () => {
    const s = withApprovals([approval], 3)
    const items = overviewVM(s, NOW).sections.find((x) => x.id === 'approvals')!.items
    expect(items.map((i) => i.id)).toEqual(['flow:cc:1:stp_outline:0', 'approvals'])
    expect(flowApprovalCount(s)).toBe(1)
  })

  it('counts none on older mains without the field', () => {
    expect(flowApprovalCount(initialState())).toBe(0)
  })
})
