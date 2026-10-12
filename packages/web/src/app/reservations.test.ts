import { describe, expect, it } from 'vitest'
import { fixtureManifest } from './__fixtures__/manifest.ts'
import { planBuilding } from './building.ts'
import {
  MEETING_MAX_TEAM,
  emptyReservations,
  expire,
  holderOf,
  release,
  reservationOf,
  reserve,
  type ReservationRequest,
  type ReservationState,
} from './reservations.ts'

const L = planBuilding(
  [
    { provider: 'a', agents: 30 },
    { provider: 'b', agents: 2 },
  ],
  fixtureManifest,
  undefined,
  0,
)
const A = ['wing:a:0']

/** Applies requests in order and returns the grants. */
function run(reqs: ReservationRequest[], state: ReservationState = emptyReservations(), now = 0) {
  const grants: (string[] | undefined)[] = []
  for (const r of reqs) {
    const res = reserve(state, L, r, now)
    state = res.state
    grants.push(res.grant)
  }
  return { state, grants }
}

describe('reserve', () => {
  it('grants a whole meeting room to one team', () => {
    const { state, grants } = run([
      { kind: 'meeting', holder: 'team:p', wings: A, seats: 3 },
      { kind: 'meeting', holder: 'team:q', wings: A, seats: 2 },
      { kind: 'meeting', holder: 'team:r', wings: A, seats: 2 },
    ])
    expect(grants[0]).toEqual([0, 1, 2, 3, 4, 5].map((i) => `wing:a:0/seat:meeting:A:${i}`))
    expect(grants[1]![0]).toBe('wing:a:0/seat:meeting:B:0')
    // Both rooms are taken: no fallback for meetings.
    expect(grants[2]).toBeUndefined()
    expect(holderOf(state, 'wing:a:0/seat:meeting:A:5')).toBe('team:p')
    expect(reservationOf(state, 'team:q')).toMatchObject({ kind: 'meeting', room: 'wing:a:0/meeting-B' })
  })

  it('rejects teams larger than a room', () => {
    const before = emptyReservations()
    const res = reserve(before, L, { kind: 'meeting', holder: 'team:big', wings: A, seats: MEETING_MAX_TEAM + 1 }, 0)
    expect(res.grant).toBeUndefined()
    expect(res.state.byHolder.size).toBe(0)
    // A held room is released when the team grows past the limit.
    const ok = reserve(before, L, { kind: 'meeting', holder: 'team:t', wings: A, seats: 2 }, 0)
    const grown = reserve(ok.state, L, { kind: 'meeting', holder: 'team:t', wings: A, seats: 7 }, 1)
    expect(grown.grant).toBeUndefined()
    expect(grown.state.byHolder.has('team:t')).toBe(false)
  })

  it('is idempotent for a holder that already has the resource', () => {
    const first = reserve(emptyReservations(), L, { kind: 'meeting', holder: 'team:t', wings: A, seats: 2 }, 0)
    const again = reserve(first.state, L, { kind: 'meeting', holder: 'team:t', wings: A, seats: 4 }, 5)
    expect(again.grant).toEqual(first.grant)
    expect(again.state).toBe(first.state)
  })

  it('reserves booths individually and falls back to nothing when they run out', () => {
    const reqs = Array.from({ length: 5 }, (_, i) => ({ kind: 'booth' as const, holder: `w${i}`, wings: ['wing:b:0'] }))
    const { grants } = run(reqs)
    expect(grants.slice(0, 4)).toEqual([0, 1, 2, 3].map((i) => [`wing:b:0/spot:booth:${i}`]))
    expect(grants[4]).toBeUndefined()
  })

  it('searches the provider wings in order (main wing, then annex)', () => {
    const reqs = Array.from({ length: 5 }, (_, i) => ({ kind: 'booth' as const, holder: `w${i}`, wings: ['wing:a:0', 'wing:a:1'] }))
    expect(run(reqs).grants[4]).toEqual(['wing:a:1/spot:booth:0'])
  })

  it('falls back from kitchen or lounge to the atrium cafe, then to nothing', () => {
    let state = emptyReservations()
    for (let i = 0; i < 6; i++) state = reserve(state, L, { kind: 'kitchen', holder: `k${i}`, wings: A }, 0).state
    const overflow = reserve(state, L, { kind: 'kitchen', holder: 'k6', wings: A }, 0)
    expect(overflow.grant).toEqual(['atrium/seat:cafe:0'])
    expect(overflow.kind).toBe('cafe')
    expect(reservationOf(overflow.state, 'k6')!.kind).toBe('cafe')
    state = overflow.state
    for (let i = 1; i < 24; i++) state = reserve(state, L, { kind: 'cafe', holder: `c${i}` }, 0).state
    const none = reserve(state, L, { kind: 'lounge', holder: 'l0', wings: ['wing:zzz:0'] }, 0)
    expect(none.grant).toBeUndefined()
    const lounge = reserve(emptyReservations(), L, { kind: 'lounge', holder: 'l1', wings: A }, 0)
    expect(lounge).toMatchObject({ grant: ['wing:a:0/seat:lounge:0'], kind: 'lounge' })
  })

  it('reserves whole ping-pong tables and individual reception and elevator spots', () => {
    const { grants } = run([
      { kind: 'pingpong', holder: 'pp:1' },
      { kind: 'pingpong', holder: 'pp:2' },
      { kind: 'pingpong', holder: 'pp:3' },
      { kind: 'reception', holder: 'r' },
      { kind: 'elevator', holder: 'e1' },
      { kind: 'elevator', holder: 'e2' },
    ])
    expect(grants[0]).toEqual(['atrium/spot:pingpong:0:A', 'atrium/spot:pingpong:0:B'])
    expect(grants[1]).toEqual(['atrium/spot:pingpong:1:A', 'atrium/spot:pingpong:1:B'])
    expect(grants[2]).toBeUndefined()
    expect(grants[3]).toEqual(['atrium/spot:reception:0'])
    expect(grants[5]).toEqual(['atrium/spot:elevator:1'])
  })

  it('replaces the holder’s previous reservation', () => {
    const { state } = run([
      { kind: 'kitchen', holder: 'x', wings: A },
      { kind: 'booth', holder: 'x', wings: A },
    ])
    expect(reservationOf(state, 'x')!.kind).toBe('booth')
    expect(holderOf(state, 'wing:a:0/spot:kitchen:0')).toBeUndefined()
  })

  it('releases and expires reservations', () => {
    const { state } = run([
      { kind: 'booth', holder: 'x', wings: A },
      { kind: 'reception', holder: 'y', ttl: 5000 },
    ])
    const released = release(state, 'x')
    expect(released.byHolder.has('x')).toBe(false)
    expect(holderOf(released, 'wing:a:0/spot:booth:0')).toBeUndefined()
    expect(release(released, 'nobody')).toBe(released)
    expect(expire(released, 4999)).toBe(released)
    const expired = expire(released, 5000)
    expect(expired.byHolder.size).toBe(0)
    expect(expired.byAnchor.size).toBe(0)
    // Expired spots are free again.
    expect(reserve(expired, L, { kind: 'reception', holder: 'z' }, 5000).grant).toEqual(['atrium/spot:reception:0'])
  })

  it('is deterministic: the same inputs give the same grants', () => {
    const reqs: ReservationRequest[] = [
      { kind: 'meeting', holder: 'team:1', wings: A, seats: 4 },
      { kind: 'booth', holder: 'b1', wings: A },
      { kind: 'kitchen', holder: 'k1', wings: A },
      { kind: 'cafe', holder: 'c1' },
    ]
    expect(run(reqs).grants).toEqual(run(reqs).grants)
  })
})
