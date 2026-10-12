import { STATUS_COLORS, type Agent, type AgentStatus } from '@agent-office/shared'
import * as THREE from 'three'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import type { Collider } from './office.ts'

// Shared geometries/materials (SCENE rule): built once, reused by every avatar.
const geo = {
  deskTop: new THREE.BoxGeometry(1.8, 0.08, 0.9),
  leg: new THREE.BoxGeometry(0.06, 0.72, 0.06),
  monitor: new THREE.BoxGeometry(0.9, 0.55, 0.05),
  stand: new THREE.BoxGeometry(0.08, 0.25, 0.08),
  seat: new THREE.CylinderGeometry(0.32, 0.32, 0.08, 20),
  body: new THREE.CapsuleGeometry(0.28, 0.5, 6, 14),
  head: new THREE.SphereGeometry(0.22, 20, 16),
  arm: new THREE.CapsuleGeometry(0.07, 0.38, 4, 8),
  hit: new THREE.BoxGeometry(1.2, 2.2, 1.6),
}
const deskMat = new THREE.MeshStandardMaterial({ color: 0xb08a63, roughness: 0.7 })
const darkMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.6 })
const skinMat = new THREE.MeshStandardMaterial({ color: 0xf1c7a5, roughness: 0.8 })
const hitMat = new THREE.MeshBasicMaterial({ visible: false })
const screenMats = new Map<AgentStatus, THREE.MeshStandardMaterial>()
const bodyMats = new Map<number, THREE.MeshStandardMaterial>()

function screenMat(status: AgentStatus) {
  let m = screenMats.get(status)
  if (!m) {
    const c = new THREE.Color(STATUS_COLORS[status])
    m = new THREE.MeshStandardMaterial({
      color: c,
      emissive: c,
      emissiveIntensity: status === 'idle' ? 0.15 : 0.8,
    })
    screenMats.set(status, m)
  }
  return m
}

function bodyMat(id: string) {
  let h = 0
  for (const ch of id) h = (h * 33 + ch.charCodeAt(0)) >>> 0
  const hue = h % 24
  let m = bodyMats.get(hue)
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(hue / 24, 0.55, 0.5),
      roughness: 0.7,
    })
    bodyMats.set(hue, m)
  }
  return m
}

function bubbleText(a: Agent): string {
  switch (a.status) {
    case 'tool':
      return `🔧 ${a.tool ?? 'tool'}${a.text ? ` — ${a.text}` : ''}`
    case 'thinking':
      return a.text ? `💭 ${a.text}` : '💭 …'
    case 'waiting':
      return '✔ waiting for you'
    case 'error':
      return `⚠ ${a.text || 'error'}`
    default:
      return ''
  }
}

const SPAWN_SECONDS = 0.4

/** One agent: desk, chair, monitor, a little person, and DOM labels. */
export class Avatar {
  readonly group = new THREE.Group()
  readonly hit: THREE.Mesh
  agent: Agent
  leaving = false
  private person = new THREE.Group()
  private head: THREE.Mesh
  private arms: THREE.Mesh[]
  private screen: THREE.Mesh
  private tagEl = document.createElement('div')
  private nameEl = document.createElement('span')
  private badgeEl = document.createElement('span')
  private chatEl = document.createElement('span')
  private bubbleEl = document.createElement('div')
  private stackEl = document.createElement('div')
  private label: CSS2DObject
  private target = new THREE.Vector3()
  private scale = 0
  private phase = Math.random() * Math.PI * 2

  constructor(agent: Agent, onSelect: (id: string) => void) {
    this.agent = agent
    const top = new THREE.Mesh(geo.deskTop, deskMat)
    top.position.set(0, 0.76, 0)
    const legs = [-0.8, 0.8].flatMap((x) =>
      [-0.38, 0.38].map((z) => {
        const l = new THREE.Mesh(geo.leg, deskMat)
        l.position.set(x, 0.36, z)
        return l
      }),
    )
    this.screen = new THREE.Mesh(geo.monitor, screenMat(agent.status))
    this.screen.position.set(0, 1.18, -0.25)
    const stand = new THREE.Mesh(geo.stand, darkMat)
    stand.position.set(0, 0.92, -0.25)
    const seat = new THREE.Mesh(geo.seat, darkMat)
    seat.position.set(0, 0.48, 1.0)

    const body = new THREE.Mesh(geo.body, bodyMat(agent.id))
    body.position.set(0, 0.92, 1.05)
    this.head = new THREE.Mesh(geo.head, skinMat)
    this.head.position.set(0, 1.5, 1.05)
    this.arms = [-0.3, 0.3].map((x) => {
      const arm = new THREE.Mesh(geo.arm, bodyMat(agent.id))
      arm.position.set(x, 1.0, 0.72)
      arm.rotation.x = Math.PI / 2.4
      return arm
    })
    this.person.add(body, this.head, ...this.arms)

    for (const m of [top, ...legs, this.screen, stand, seat, body, this.head, ...this.arms]) {
      m.castShadow = true
      m.receiveShadow = true
    }

    this.hit = new THREE.Mesh(geo.hit, hitMat)
    this.hit.position.set(0, 1.1, 0.6)
    this.hit.userData.agentId = agent.id

    this.tagEl.className = 'tag'
    this.tagEl.dataset.agentId = agent.id
    this.badgeEl.className = 'badge'
    this.tagEl.append(this.nameEl, this.chatEl, this.badgeEl)
    this.tagEl.addEventListener('click', (e) => {
      e.stopPropagation()
      onSelect(this.agent.id)
    })
    this.bubbleEl.className = 'bubble'
    // Bubble stacked above the name tag in one label, anchored at its bottom, so they never overlap.
    this.stackEl.className = 'label-stack'
    this.stackEl.append(this.bubbleEl, this.tagEl)
    this.label = new CSS2DObject(this.stackEl)
    this.label.center.set(0.5, 1)
    this.label.position.set(0, 1.95, 1.05)

    this.group.add(top, ...legs, this.screen, stand, seat, this.person, this.hit, this.label)
    this.group.scale.setScalar(0)
    this.setAgent(agent)
  }

  /** Updates labels and materials. All text goes through textContent (PRIVACY_SECURITY rule). */
  setAgent(a: Agent): void {
    this.agent = a
    this.nameEl.textContent = a.name
    this.chatEl.textContent = a.interactive ? '💬' : ''
    this.chatEl.title = a.interactive ? 'reads messages' : ''
    this.badgeEl.textContent = a.unread > 0 ? `📨 ${a.unread}` : ''
    this.badgeEl.hidden = a.unread === 0
    const text = bubbleText(a)
    this.bubbleEl.textContent = text
    this.bubbleEl.style.setProperty('--status', STATUS_COLORS[a.status])
    this.bubbleEl.hidden = text === ''
    this.screen.material = screenMat(a.status)
  }

  setSelected(selected: boolean): void {
    this.tagEl.classList.toggle('selected', selected)
  }

  /** Desk position; the avatar glides there. The first call places it directly. */
  setSeat(x: number, z: number): void {
    const first = this.target.lengthSq() === 0 && this.group.position.lengthSq() === 0
    this.target.set(x, 0, z)
    if (first) this.group.position.copy(this.target)
  }

  collider(): Collider {
    const p = this.target
    return { minX: p.x - 0.95, maxX: p.x + 0.95, minZ: p.z - 0.5, maxZ: p.z + 1.4 }
  }

  /** Returns false once the leave animation is finished. */
  update(dt: number, t: number): boolean {
    const goal = this.leaving ? 0 : this.agent.parentId ? 0.75 : 1
    this.scale +=
      Math.sign(goal - this.scale) * Math.min(Math.abs(goal - this.scale), dt / SPAWN_SECONDS)
    this.group.scale.setScalar(Math.max(this.scale, 0.0001))
    this.group.position.lerp(this.target, Math.min(1, dt * 4))

    const s = this.agent.status
    const p = t + this.phase
    this.person.position.y = s === 'tool' ? Math.abs(Math.sin(p * 9)) * 0.03 : 0
    this.person.rotation.y = s === 'idle' ? Math.sin(p * 0.6) * 0.25 : 0
    this.head.rotation.z = s === 'thinking' ? Math.sin(p * 1.5) * 0.18 : 0
    this.head.rotation.x = s === 'waiting' ? -0.15 : 0
    const typing = s === 'tool' ? 0.25 : 0
    this.arms[0]!.rotation.x = Math.PI / 2.4 + Math.sin(p * 14) * typing
    this.arms[1]!.rotation.x = Math.PI / 2.4 + Math.cos(p * 14) * typing

    return !(this.leaving && this.scale <= 0)
  }

  dispose(): void {
    // Geometries/materials are shared; only DOM labels belong to this avatar.
    this.stackEl.remove()
    this.group.removeFromParent()
  }
}
