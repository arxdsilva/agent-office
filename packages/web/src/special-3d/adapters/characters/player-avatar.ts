// The player's avatar (third person): a clone of the character template with its own mixer,
// tinted dark teal with a glowing collar (the cyber set's accent slot when present). Idle and Walk
// crossfade with speed; Walk's time scale follows the ground speed so the feet don't slide.
import * as THREE from 'three'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import type { CharacterAssets } from '../../../adapters/three/characters.ts'
import {
  SlotMaterial,
  paintSlots,
  type BodyLayout,
} from '../../../adapters/three/characters/slots.ts'
import { walkTimeScale } from '../../../app/motion.ts'
import type { PlayerState } from '../../../app/special/player.ts'
import type { CyberLook } from '../../../app/special/outfit.ts'
import { markBloom } from '../rendering/bloom-selective.ts'

const TINT: Record<string, number> = {
  shirt: 0x0d3b4b,
  pants: 0x121418,
  hair: 0x0b0b0d,
  accent: 0x29e3ff,
}
const SHOW = new Set(['hairB', 'headset', 'glasses'])

export class PlayerAvatar {
  readonly root = new THREE.Group()
  private mixer: THREE.AnimationMixer
  private idle: THREE.AnimationAction | null = null
  private walk: THREE.AnimationAction | null = null
  private walking = false
  private materials: THREE.Material[] = []
  private collar: THREE.Mesh
  private walkSpeed: number

  constructor(scene: THREE.Scene, assets: CharacterAssets, look: CyberLook | null = null) {
    this.root.name = 'player'
    const model = cloneSkinned(assets.gltf.scene)
    const layout = assets.gltf.scene.userData.aoBodyLayout as BodyLayout | undefined
    model.traverse((o) => {
      const ud = o.userData as { accessory?: unknown; prop?: unknown; lod?: unknown }
      if (typeof ud.accessory === 'string')
        o.visible =
          look && ud.accessory in look.accessories
            ? look.accessories[ud.accessory]!
            : SHOW.has(ud.accessory)
      if (typeof ud.prop === 'string') o.visible = false
      if ((typeof ud.lod === 'number' && ud.lod >= 1) || /(^|[_.-])lod[1-9]/i.test(o.name))
        o.visible = false
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      m.castShadow = true
      m.frustumCulled = false
      const mats = Array.isArray(m.material) ? m.material : [m.material]
      const next = mats.map((mat) => {
        const c = mat.clone()
        this.materials.push(c)
        const accent = look?.accent ?? TINT.accent!
        if (c instanceof SlotMaterial && layout)
          paintSlots(c, layout, (slot) => (slot === 'accent' ? accent : TINT[slot]))
        else if (mat.name === 'accent') {
          const a = c as THREE.MeshStandardMaterial
          a.color?.setHex(accent)
          if (a.emissive && a.emissive.getHex() !== 0) a.emissive.setHex(accent)
        } else if ((c as THREE.MeshStandardMaterial).color && TINT[mat.name])
          (c as THREE.MeshStandardMaterial).color.setHex(TINT[mat.name]!)
        return c
      })
      m.material = Array.isArray(m.material) ? next : next[0]!
    })
    this.root.add(model)
    const ring = new THREE.TorusGeometry(0.12, 0.012, 6, 24)
    const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x29e3ff).multiplyScalar(3) })
    this.materials.push(glow)
    this.collar = new THREE.Mesh(ring, glow)
    this.collar.rotation.x = Math.PI / 2
    this.collar.position.y = assets.meta.height * 0.83
    markBloom(this.collar)
    // The cyber set has its own collar light (an accessory); the torus stands in for the classic one.
    if (!look) this.root.add(this.collar)
    this.mixer = new THREE.AnimationMixer(model)
    const clip = (name: string) => assets.gltf.animations.find((a) => a.name === name)
    const idle = clip('Idle')
    const walk = clip('Walk')
    if (idle) (this.idle = this.mixer.clipAction(idle)).play()
    if (walk) {
      this.walk = this.mixer.clipAction(walk)
      this.walk.enabled = true
      this.walk.setEffectiveWeight(0)
      this.walk.play()
    }
    this.walkSpeed = assets.meta.clips.Walk?.speed ?? 1.4
    scene.add(this.root)
  }

  update(dt: number, s: PlayerState): void {
    this.root.position.set(s.x, s.y, s.z)
    this.root.rotation.y = s.heading
    const moving = s.speed > 0.15
    if (moving !== this.walking && this.idle && this.walk) {
      this.walking = moving
      const [from, to] = moving ? [this.idle, this.walk] : [this.walk, this.idle]
      to.setEffectiveWeight(1)
      from.crossFadeTo(to, moving ? 0.25 : 0.3, false)
    }
    if (this.walk && moving) this.walk.timeScale = walkTimeScale(s.speed, this.walkSpeed)
    this.mixer.update(dt)
  }

  setVisible(on: boolean): void {
    this.root.visible = on
  }

  dispose(): void {
    this.mixer.stopAllAction()
    this.root.removeFromParent()
    this.collar.geometry.dispose()
    for (const m of this.materials) m.dispose()
    this.root.traverse((o) => (o as THREE.SkinnedMesh).skeleton?.dispose())
  }
}
