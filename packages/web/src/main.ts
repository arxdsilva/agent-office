import {
  byProviderAndTopic,
  STATUS_COLORS,
  AGENT_STATUSES,
  type AgentStatus,
} from '@agent-office/shared'
import * as THREE from 'three'
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js'
import { createApi, resolveToken } from './api.ts'
import { Avatar } from './avatar.ts'
import { Controls } from './controls.ts'
import { layoutOffice, type LayoutState } from './layout.ts'
import { Office, type Collider } from './office.ts'
import { Panel } from './panel.ts'
import { applyMessage, connect, emptyState, type OfficeState } from './socket.ts'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const dark = matchMedia('(prefers-color-scheme: dark)').matches

// --- renderer, scene, camera -------------------------------------------------------------
const stage = $('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
stage.append(renderer.domElement)

const labels = new CSS2DRenderer()
labels.domElement.style.position = 'absolute'
labels.domElement.style.inset = '0'
labels.domElement.style.pointerEvents = 'none'
stage.append(labels.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(dark ? 0x12151b : 0xeef0f3)
scene.fog = new THREE.Fog(scene.background, 60, 160)
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400)
camera.position.set(0, 18, 26)

const office = new Office(dark)
scene.add(office.group)
const controls = new Controls(camera, renderer.domElement)

function resize() {
  const w = innerWidth
  const h = innerHeight
  renderer.setSize(w, h)
  labels.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
resize()

// --- state ------------------------------------------------------------------------------
let state: OfficeState = emptyState()
let layoutState: LayoutState = new Map()
const avatars = new Map<string, Avatar>()
const leaving = new Set<Avatar>()
let colliders: Collider[] = []
let selected: string | null = null
let dirty = true
let framedZones = -1

const token = await resolveToken(document)
const api = createApi(token)
const panel = new Panel((id, text) => api.sendMessage(id, text))
panel.onClose = () => select(null)
panel.onSelectParent = (id) => select(id)

function select(id: string | null) {
  if (selected) avatars.get(selected)?.setSelected(false)
  selected = id && state.agents.has(id) ? id : null
  if (!selected) return panel.close()
  const av = avatars.get(selected)!
  av.setSelected(true)
  if (controls.mode === 'walk') controls.exitWalk()
  controls.focus(av.group.position.x, av.group.position.z)
  panel.open(selected, state)
}

function sync() {
  dirty = false
  const agents = [...state.agents.values()]
  const { zones, slots, state: next } = layoutOffice(agents, byProviderAndTopic, layoutState)
  layoutState = next
  office.setZones(zones)
  // Re-frame when zones appear or disappear (not on every update, so we don't fight the user).
  if (zones.length !== framedZones) {
    framedZones = zones.length
    controls.frame(office.bounds)
  }
  for (const a of agents) {
    let av = avatars.get(a.id)
    if (!av) {
      av = new Avatar(a, (id) => select(id))
      avatars.set(a.id, av)
      scene.add(av.group)
    }
    av.setAgent(a)
    const seat = slots.get(a.id)!
    av.setSeat(seat.x, seat.z)
  }
  for (const [id, av] of avatars) {
    if (state.agents.has(id)) continue
    av.leaving = true
    leaving.add(av)
    avatars.delete(id)
    if (selected === id) panel.render(state)
  }
  colliders = [...office.wallColliders, ...[...avatars.values()].map((a) => a.collider())]
  panel.render(state)
  renderHud()
}

// --- HUD --------------------------------------------------------------------------------
const legend = $('legend')
const legendCounts = new Map<AgentStatus, HTMLElement>()
for (const s of AGENT_STATUSES) {
  const li = document.createElement('li')
  const swatch = document.createElement('span')
  swatch.className = 'swatch'
  swatch.style.background = STATUS_COLORS[s]
  const label = document.createElement('span')
  li.append(swatch, label)
  legend.append(li)
  legendCounts.set(s, label)
}
function renderHud() {
  const counts = new Map<AgentStatus, number>()
  for (const a of state.agents.values()) counts.set(a.status, (counts.get(a.status) ?? 0) + 1)
  for (const [s, label] of legendCounts) label.textContent = `${s} ${counts.get(s) ?? 0}`
  const n = state.agents.size
  $('count').textContent = `${n} agent${n === 1 ? '' : 's'}`
}

connect({
  url: api.wsUrl(location),
  onMessage: (msg) => {
    state = applyMessage(state, msg)
    dirty = true
  },
  onStatus: (s) => {
    const dot = $('conn')
    dot.classList.toggle('open', s === 'open')
    dot.title = s === 'open' ? 'connected' : 'reconnecting…'
  },
})

// --- input ------------------------------------------------------------------------------
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
let downAt: [number, number] | null = null

function pick(ndcX: number, ndcY: number): string | null {
  pointer.set(ndcX, ndcY)
  raycaster.setFromCamera(pointer, camera)
  const hits = raycaster.intersectObjects(
    [...avatars.values()].map((a) => a.hit),
    false,
  )
  return (hits[0]?.object.userData.agentId as string | undefined) ?? null
}

renderer.domElement.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]))
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || controls.mode !== 'orbit') return
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1])
  downAt = null
  if (moved > 5) return // it was a drag
  select(pick((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1))
})

$('walk').addEventListener('click', () => controls.enterWalk())
$('fit').addEventListener('click', () => controls.frame(office.bounds))
controls.onModeChange = (mode) => {
  $('crosshair').hidden = mode !== 'walk'
  $('walk-help').hidden = mode !== 'walk'
  $('walk').textContent = mode === 'walk' ? '🎥 Orbit' : '🚶 Walk'
}
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return
  if (e.code === 'KeyF' && controls.mode === 'orbit') controls.enterWalk()
  if (e.code === 'KeyE' && controls.mode === 'walk') {
    const id = pick(0, 0) // crosshair at screen center
    if (id) select(id)
  }
  if (e.code === 'Escape' && controls.mode === 'orbit') select(null)
})

// --- loop -------------------------------------------------------------------------------
const clock = new THREE.Clock()
setInterval(() => panel.render(state), 1000) // refresh "last seen"
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1)
  const t = clock.elapsedTime
  if (dirty) sync()
  for (const av of avatars.values()) av.update(dt, t)
  for (const av of leaving) {
    if (!av.update(dt, t)) {
      av.dispose()
      leaving.delete(av)
    }
  }
  controls.update(dt, colliders)
  renderer.render(scene, camera)
  labels.render(scene, camera)
})
