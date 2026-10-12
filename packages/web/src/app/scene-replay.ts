// Resync for a freshly created scene (plan §2.3): the steps an agent still has to play, `elapsed`
// after they were issued. Completed steps are dropped, the elapsed part becomes a teleport to the
// predicted pose (same `poseAt` math as the director), an in-progress walk is re-timed from where
// the agent is, and an in-progress one-shot resumes at its offset. Nothing is re-decided.
import { DEFAULT_CLIP_DURATIONS, poseAt } from './choreography.ts'
import { timePath } from './navigation.ts'
import type { AgentPose, Intent, Step, TimedPath, Vec2 } from './office-types.ts'

/** What the director issued for one agent, and when (epoch ms). */
export interface Issued {
  from: AgentPose
  steps: Step[]
  at: number
  intent?: Intent
}

export function remainingSteps(issued: Issued, elapsedMs: number): Step[] {
  const t = elapsedMs / 1000
  if (t <= 0) return issued.steps
  const { steps } = issued
  if (!steps.length) return []
  const pose = poseAt(issued.from, steps, t)
  const teleport: Step = { kind: 'teleport', pos: { ...pose.pos }, heading: pose.heading }
  if (pose.anchor) teleport.anchor = pose.anchor
  if (!pose.visible) return [teleport, { kind: 'fade', to: 0, duration: 0 }]
  const out: Step[] = [
    teleport,
    ...pose.props.map((prop): Step => ({ kind: 'prop', prop, on: true })),
  ]
  let clock = 0
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!
    const rest = () => out.concat(steps.slice(i + 1))
    switch (s.kind) {
      case 'teleport':
      case 'prop':
        break
      case 'fade':
        if (s.to === 0 && clock + s.duration > t)
          out.push({ kind: 'fade', to: 0, duration: clock + s.duration - t })
        break
      case 'face':
        if (t < clock + s.duration) {
          out.push({ kind: 'face', heading: s.heading, duration: clock + s.duration - t })
          return rest()
        }
        clock += s.duration
        break
      case 'move':
        if (t < clock + s.path.duration) {
          const path = trimmed(s.path, pose)
          if (path) out.push({ kind: 'move', path })
          return rest()
        }
        clock += s.path.duration
        break
      case 'clip': {
        if (s.loop) {
          out.push({ ...s, fadeIn: 0 })
          return rest()
        }
        const d = s.duration ?? DEFAULT_CLIP_DURATIONS[s.clip] ?? 1
        if (t < clock + d || s.hold) {
          const into = Math.min(d, t - clock)
          out.push({ ...s, fadeIn: 0, offset: (s.offset ?? 0) + into, duration: d - into })
          return rest()
        }
        clock += d
        break
      }
    }
  }
  return out
}

/** The rest of a timed path from the agent's current pose (re-timed with its current speed). */
function trimmed(path: TimedPath, pose: AgentPose): TimedPath | undefined {
  const pts = path.points
  let best = 0
  let bestD = Infinity
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = segmentDistance(pose.pos, pts[i]!, pts[i + 1]!)
    if (d < bestD - 1e-9) ((bestD = d), (best = i))
  }
  const points = [{ ...pose.pos }, ...pts.slice(best + 1)].filter(
    (p, i, all) => i === 0 || Math.hypot(p.x - all[i - 1]!.x, p.z - all[i - 1]!.z) > 1e-6,
  )
  if (points.length < 2) return undefined
  return timePath(points, {
    endHeading: path.endHeading,
    vMax: path.vMax,
    accel: path.accel,
    ...(path.decel !== undefined && { decel: path.decel }),
    startSpeed: pose.speed,
    startHeading: pose.heading,
  })
}

function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const l2 = dx * dx + dz * dz
  const k = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0
  return Math.hypot(p.x - (a.x + dx * k), p.z - (a.z + dz * k))
}
