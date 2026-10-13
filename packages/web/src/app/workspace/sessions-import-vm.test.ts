import { describe, expect, it } from 'vitest'
import { NOW, project, session } from './__fixtures__/projects.ts'
import { sessionsVM } from './sessions-vm.ts'
import { initialState, reduce, type WorkspaceState } from './state.ts'

const base = (): WorkspaceState =>
  reduce(reduce(initialState(), { type: 'projects', projects: [project()] }), {
    type: 'sessions',
    sessions: [session()],
  })

describe('Session Vault automatic import line', () => {
  it('off: the one-shot button works as before and there is no status line', () => {
    const vm = sessionsVM(
      reduce(base(), { type: 'import-status', status: { on: false, imported: 0, added: 0 } }),
      NOW,
    )
    expect(vm.importHistory).toMatchObject({
      id: 'import',
      label: 'Import Claude history',
      enabled: true,
    })
    expect(vm.importStatus).toBeNull()
  })

  it('unknown status (not loaded yet) behaves like off', () => {
    const vm = sessionsVM(base(), NOW)
    expect(vm.importHistory.enabled).toBe(true)
    expect(vm.importStatus).toBeNull()
  })

  it('on: the button reads "Automatic import is on" and is disabled', () => {
    const vm = sessionsVM(
      reduce(base(), {
        type: 'import-status',
        status: { on: true, lastRunAt: NOW - 5 * 60_000, imported: 4, added: 3 },
      }),
      NOW,
    )
    expect(vm.importHistory).toMatchObject({ label: 'Automatic import is on', enabled: false })
  })

  it('on: shows the last run time and counts', () => {
    const vm = sessionsVM(
      reduce(base(), {
        type: 'import-status',
        status: { on: true, lastRunAt: NOW - 5 * 60_000, imported: 4, added: 3 },
      }),
      NOW,
    )
    expect(vm.importStatus).toBe('Last run 5m ago: 4 sessions, 3 summaries')
  })

  it('uses singular nouns for 1', () => {
    const vm = sessionsVM(
      reduce(base(), {
        type: 'import-status',
        status: { on: true, lastRunAt: NOW - 30_000, imported: 1, added: 1 },
      }),
      NOW,
    )
    expect(vm.importStatus).toBe('Last run 30s ago: 1 session, 1 summary')
  })

  it('on, before the first run: says it is waiting', () => {
    const vm = sessionsVM(
      reduce(base(), { type: 'import-status', status: { on: true, imported: 0, added: 0 } }),
      NOW,
    )
    expect(vm.importStatus).toBe('Waiting for the first automatic run.')
  })
})
