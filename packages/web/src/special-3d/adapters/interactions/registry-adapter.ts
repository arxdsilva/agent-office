// Semantic interactions in Night City (docs/special-3d/interaction-contract.md): invisible pick
// proxies at every `interact:*` anchor (a click raycasts them), labels over them, and E within
// 1.6 m (app/special/player.ts `nearestInteraction`) of an object or of an occupied workstation.
// Hits go to the controller through `SceneView.onPickInteraction`; nothing is decided here.
import * as THREE from 'three'
import type { Labels } from '../../../adapters/three/labels.ts'
import type { InteractionHit, InteractionKind, Vec2 } from '../../../app/office-types.ts'
import { nearestInteraction } from '../../../app/special/player.ts'
import type { Interactable } from '../../../app/special/world.ts'

const LABELS: Readonly<Record<InteractionKind, string>> = {
  'project-directory': 'Project Directory',
  'agent-workstation': 'Workstation',
  'command-display': 'Project Dashboard',
  'memory-terminal': 'Memory Vault',
  'context-console': 'Context Console',
  'archive-terminal': 'Session Archive',
  'handoff-platform': 'Handoff Platform',
  'capability-station': 'Capability Station',
  'provider-terminal': 'Provider Terminal',
}

const PROXY = new THREE.BoxGeometry(1.4, 2, 1.4).translate(0, 1, 0)
const INVISIBLE = new THREE.MeshBasicMaterial({ visible: false })

export interface Workstation {
  agentId: string
  pos: Vec2
}

type Candidate = { pos: Vec2; hit: InteractionHit }

export class InteractionRegistry {
  readonly group = new THREE.Group()
  private proxies: THREE.Mesh[] = []
  private items: Interactable[]

  constructor(
    scene: THREE.Scene,
    private labels: Labels,
    items: Interactable[],
    private fire: (hit: InteractionHit) => void,
  ) {
    this.items = items
    this.group.name = 'interactions'
    for (const it of items) {
      const m = new THREE.Mesh(PROXY, INVISIBLE)
      m.position.set(it.pos.x, 0, it.pos.z)
      m.userData.interact = it
      m.name = it.id
      this.group.add(m)
      this.proxies.push(m)
      // Plain-text label over the object; clicking it is the same as E.
      labels.setFixture(it.id, LABELS[it.kind], new THREE.Vector3(it.pos.x, 2.3, it.pos.z), () =>
        fire(this.hitOf(it)),
      )
    }
    scene.add(this.group)
    this.group.updateMatrixWorld(true)
  }

  hitOf(it: Interactable): InteractionHit {
    return { kind: it.kind, anchor: it.id.slice(it.id.indexOf('/') + 1) }
  }

  /** The proxy under a ray, if any. */
  pick(ray: THREE.Raycaster): InteractionHit | null {
    const hit = ray.intersectObjects(this.proxies, false)[0]
    const it = hit?.object.userData.interact as Interactable | undefined
    return it ? this.hitOf(it) : null
  }

  /** What E would use from `p`: the nearest object or occupied workstation within reach. */
  nearest(p: Vec2, stations: readonly Workstation[]): InteractionHit | null {
    const list: Candidate[] = this.items.map((it) => ({ pos: it.pos, hit: this.hitOf(it) }))
    for (const s of stations)
      list.push({
        pos: s.pos,
        hit: { kind: 'agent-workstation', anchor: 'ws', agentId: s.agentId },
      })
    return nearestInteraction(p, list)?.hit ?? null
  }

  /** The first object of a kind (debug `interact(kind)`). */
  first(kind: InteractionKind): InteractionHit | null {
    const it = this.items.find((i) => i.kind === kind)
    return it ? this.hitOf(it) : null
  }

  dispose(): void {
    for (const it of this.items) this.labels.setFixture(it.id, '', null, () => {})
    this.group.removeFromParent()
  }
}
