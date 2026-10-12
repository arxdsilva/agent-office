// Links from agents to the capabilities they use (docs/capabilities.md §5, plan §10.6/§10.F):
// adapters get a glowing tube with flowing dashes, skills and rules a stream of drifting page
// particles, both along the director's quadratic arc. Readable through walls (no depth test).
import * as THREE from 'three'
import type { Link } from '../../app/office-types.ts'

export const MAX_LINKS = 64
const SEGMENTS = 24
const RADIUS = 0.035
const PARTICLES = 24
const FADE_IN_S = 0.25
const FADE_OUT_S = 0.6
const DASH_SPEED = 1.5 // m/s, from agent to capability
const DASH_LENGTH = 0.35
const PARTICLE_SPEED = 0.9

const dashVertex = /* glsl */ `
  varying float vU;
  void main() {
    vU = uv.x;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`
const dashFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uLength;
  uniform float uOpacity;
  varying float vU;
  void main() {
    float d = vU * uLength / ${DASH_LENGTH.toFixed(2)} - uTime * ${(DASH_SPEED / DASH_LENGTH).toFixed(3)};
    float dash = smoothstep(0.35, 0.5, fract(d)) * (1.0 - smoothstep(0.85, 1.0, fract(d)));
    float ends = mix(0.55, 0.85, smoothstep(0.35, 0.0, min(vU, 1.0 - vU)));
    gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.35 * dash), uOpacity * ends * (0.45 + 0.55 * dash));
  }`

/** Soft round glyph with a page fold, for library particles; a radial glow for endpoints. */
function spriteTexture(kind: 'page' | 'glow'): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.Texture() // unit tests (no DOM)
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  if (kind === 'glow') {
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32)
    r.addColorStop(0, 'rgba(255,255,255,1)')
    r.addColorStop(0.35, 'rgba(255,255,255,0.55)')
    r.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = r
    g.fillRect(0, 0, 64, 64)
  } else {
    // A small page: tinted fill (the material color) with a dark edge, readable on light floors.
    g.beginPath()
    g.moveTo(16, 10)
    g.lineTo(40, 10)
    g.lineTo(50, 20)
    g.lineTo(50, 54)
    g.lineTo(16, 54)
    g.closePath()
    g.fillStyle = 'rgba(255,255,255,1)'
    g.fill()
    g.lineWidth = 4
    g.strokeStyle = 'rgba(40,30,20,0.9)'
    g.stroke()
    g.fillStyle = 'rgba(40,30,20,0.55)'
    for (const y of [26, 34, 42]) g.fillRect(22, y, 22, 3)
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

interface Slot {
  link: Link
  curve: THREE.QuadraticBezierCurve3
  tube: THREE.Mesh<THREE.TubeGeometry, THREE.ShaderMaterial> | null
  points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null
  ends: THREE.Sprite[]
  shown: number
  /** Desired opacity from the director (0 once the link is gone). */
  target: number
  gone: boolean
  key: string
  length: number
  phase: number
  drawn: number
}

export class LinkSystem {
  readonly group = new THREE.Group()
  private slots = new Map<string, Slot>()
  private time = 0
  private pageTex = spriteTexture('page')
  private glowTex = spriteTexture('glow')
  private tmp = new THREE.Vector3()
  private camPos = new THREE.Vector3()
  /** "Show links": only this capability's links at full strength. */
  private highlighted: string | null = null
  /** Fires when the set of visible links changes (accessible list, E2E). */
  onChange: (links: Link[]) => void = () => {}

  constructor() {
    this.group.name = 'links'
    this.group.renderOrder = 10
  }

  /** The director's current links (calls fading out included). Over budget: nearest win. */
  set(links: Link[], camera: THREE.Camera, selected: string | null): void {
    camera.getWorldPosition(this.camPos)
    const ranked =
      links.length <= MAX_LINKS ? links : this.rank(links, selected).slice(0, MAX_LINKS)
    const keep = new Set<string>()
    for (const l of ranked) {
      keep.add(l.id)
      let s = this.slots.get(l.id)
      if (!s) s = this.create(l)
      s.link = l
      s.target = l.opacity
      s.gone = false
      this.shape(s)
    }
    for (const [id, s] of this.slots) if (!keep.has(id)) ((s.target = 0), (s.gone = true))
    this.onChange(ranked)
  }

  private rank(links: Link[], selected: string | null): Link[] {
    const d = (l: Link) =>
      l.agentId === selected
        ? -1
        : this.tmp.set(l.from.x, l.from.y, l.from.z).distanceToSquared(this.camPos)
    return [...links].sort((a, b) => d(a) - d(b))
  }

  private create(l: Link): Slot {
    const s: Slot = {
      link: l,
      curve: new THREE.QuadraticBezierCurve3(),
      tube: null,
      points: null,
      ends: [],
      shown: 0,
      target: l.opacity,
      gone: false,
      key: '',
      length: 1,
      phase: Math.random(),
      drawn: 0,
    }
    const color = new THREE.Color(l.color)
    if (l.style === 'dash') {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: color },
          uTime: { value: 0 },
          uLength: { value: 1 },
          uOpacity: { value: 0 },
        },
        vertexShader: dashVertex,
        fragmentShader: dashFragment,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      })
      s.tube = new THREE.Mesh(new THREE.TubeGeometry(s.curve, SEGMENTS, RADIUS, 6), mat)
      s.tube.renderOrder = 10
      s.tube.frustumCulled = false
      this.group.add(s.tube)
    } else {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PARTICLES * 3), 3))
      const mat = new THREE.PointsMaterial({
        color,
        map: this.pageTex,
        size: 0.3,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      })
      s.points = new THREE.Points(geo, mat)
      s.points.renderOrder = 10
      s.points.frustumCulled = false
      this.group.add(s.points)
    }
    for (let i = 0; i < 2; i++) {
      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glowTex,
          color,
          transparent: true,
          depthTest: false,
          depthWrite: false,
          toneMapped: false,
          opacity: 0,
        }),
      )
      sp.scale.setScalar(0.28)
      sp.renderOrder = 11
      s.ends.push(sp)
      this.group.add(sp)
    }
    this.slots.set(l.id, s)
    return s
  }

  /** Rebuilds the tube only when an end moved more than 2 cm (walking agents). */
  private shape(s: Slot): void {
    const { from, to, control } = s.link
    const key = [from.x, from.y, from.z, to.x, to.y, to.z].map((v) => Math.round(v * 50)).join(',')
    if (key === s.key) return
    s.key = key
    s.curve.v0.set(from.x, from.y, from.z)
    s.curve.v1.set(control.x, control.y, control.z)
    s.curve.v2.set(to.x, to.y, to.z)
    // Curves cache their arc lengths; TubeGeometry samples by arc length (getPointAt), so a stale
    // cache from the empty curve would collapse every tube onto one point.
    s.curve.updateArcLengths()
    s.length = s.curve.getLength()
    s.ends[0]!.position.copy(s.curve.v0)
    s.ends[1]!.position.copy(s.curve.v2)
    if (s.tube) {
      s.tube.geometry.dispose()
      s.tube.geometry = new THREE.TubeGeometry(s.curve, SEGMENTS, RADIUS, 6)
      s.tube.material.uniforms.uLength!.value = s.length
    }
    if (s.points) this.placeParticles(s)
  }

  highlight(capabilityId: string | null): void {
    this.highlighted = capabilityId
  }

  /** Where the links to a capability start (agents' ports), for camera framing. */
  sources(capabilityId: string): THREE.Vector3[] {
    const out: THREE.Vector3[] = []
    for (const s of this.slots.values())
      if (!s.gone && s.link.capabilityId === capabilityId) out.push(s.curve.v0, s.curve.v2)
    return out
  }

  update(dt: number): void {
    this.time += dt
    for (const [id, s] of this.slots) {
      const rate = s.target > s.shown ? 1 / FADE_IN_S : 1 / FADE_OUT_S
      s.shown += Math.sign(s.target - s.shown) * Math.min(Math.abs(s.target - s.shown), dt * rate)
      if (s.gone && s.shown <= 0) {
        this.dispose(s)
        this.slots.delete(id)
        continue
      }
      const dim = this.highlighted && s.link.capabilityId !== this.highlighted ? 0.12 : 1
      const o = s.shown * dim
      s.drawn = o
      // A pulse on the capability end when a new call starts.
      const age = (Date.now() - s.link.since) / 1000
      const pulse = age >= 0 && age < 0.6 ? 1 + 0.8 * (1 - age / 0.6) : 1
      s.ends[0]!.material.opacity = o * 0.7
      s.ends[1]!.material.opacity = o * 0.9
      s.ends[1]!.scale.setScalar(0.28 * pulse)
      if (s.tube) {
        s.tube.material.uniforms.uTime!.value = this.time
        s.tube.material.uniforms.uOpacity!.value = o
      }
      if (s.points) {
        s.points.material.opacity = o * 0.9
        this.placeParticles(s)
      }
    }
  }

  /** Particles along the arc, drifting from the capability back to the agent. */
  private placeParticles(s: Slot): void {
    const pos = s.points!.geometry.getAttribute('position') as THREE.BufferAttribute
    const speed = PARTICLE_SPEED / Math.max(s.length, 0.5)
    for (let i = 0; i < PARTICLES; i++) {
      const t = 1 - ((i / PARTICLES + this.time * speed + s.phase) % 1)
      s.curve.getPoint(t, this.tmp)
      // A little drift sideways so the stream reads as pages, not a line.
      const wob = Math.sin((t * 9 + i) * 2.1 + this.time * 2) * 0.05
      pos.setXYZ(i, this.tmp.x + wob, this.tmp.y + Math.abs(wob), this.tmp.z - wob)
    }
    pos.needsUpdate = true
  }

  private dispose(s: Slot): void {
    if (s.tube) {
      s.tube.geometry.dispose()
      s.tube.material.dispose()
      this.group.remove(s.tube)
    }
    if (s.points) {
      s.points.geometry.dispose()
      s.points.material.dispose()
      this.group.remove(s.points)
    }
    for (const e of s.ends) {
      e.material.dispose()
      this.group.remove(e)
    }
  }

  /** Debug: every drawn link's geometry and opacity inputs (regression checks, capture). */
  debug(): {
    id: string
    style: string
    from: number[]
    to: number[]
    shown: number
    /** Opacity actually drawn (fade × highlight dimming). */
    opacity: number
    visible: boolean
    radius: number
  }[] {
    return [...this.slots.values()].map((s) => {
      const obj = s.tube ?? s.points!
      obj.geometry.computeBoundingSphere()
      return {
        id: s.link.id,
        style: s.link.style,
        from: s.curve.v0.toArray(),
        to: s.curve.v2.toArray(),
        shown: s.shown,
        opacity: s.drawn,
        visible: obj.visible && this.group.visible,
        radius: obj.geometry.boundingSphere?.radius ?? 0,
      }
    })
  }

  count(): number {
    return this.slots.size
  }
}
