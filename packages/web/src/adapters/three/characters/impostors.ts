// Impostors for far characters beyond the animated budget: the base character is rendered once
// at load from 8 angles × 3 poses (stand / sit / lounge) into an atlas, plus a shirt mask so each
// impostor still wears its agent's shirt color. All impostors draw as ONE InstancedMesh with
// cylindrical billboarding in the vertex shader (alpha-tested, depth-written: no sorting).
import * as THREE from 'three'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import type { ClipName } from '../../../app/office-types.ts'

export const IMPOSTOR_CELLS = 8
/** Pose rows (see `poseRowOf`). */
const ROW_CLIPS: readonly ClipName[] = ['Idle', 'SitIdle', 'LoungeSit']
const ROWS = ROW_CLIPS.length
const CELL_W = 96

const vertexShader = /* glsl */ `
attribute vec2 aCell;
attribute vec3 aTint;
uniform vec2 uCell;
uniform vec2 uSize;
varying vec2 vUv;
varying vec2 vMaskUv;
varying vec3 vTint;
void main() {
  vec3 center = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 toCam = cameraPosition - center;
  toCam.y = 0.0;
  vec3 fwd = normalize(toCam + vec3(1e-5, 0.0, 0.0));
  vec3 right = vec3(fwd.z, 0.0, -fwd.x);
  vec3 world = center + right * (position.x * uSize.x) + vec3(0.0, position.y * uSize.y, 0.0);
  vUv = (aCell + uv) * uCell;
  vMaskUv = vUv + vec2(0.0, ${ROWS.toFixed(1)} * uCell.y);
  vTint = aTint;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`
const fragmentShader = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec2 vMaskUv;
varying vec3 vTint;
void main() {
  vec4 c = texture2D(uAtlas, vUv);
  if (c.a < 0.5) discard;
  float mask = texture2D(uAtlas, vMaskUv).r;
  gl_FragColor = vec4(c.rgb * mix(vec3(1.0), vTint, mask), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

export interface ImpostorBakeInput {
  renderer: THREE.WebGLRenderer
  /** The character scene (not modified). */
  template: THREE.Object3D
  clips: ReadonlyMap<string, THREE.AnimationClip>
  /** Character height (m). */
  height: number
  /** Prepares a bake clone: hide variants, show the default hair. */
  dress(model: THREE.Object3D): void
}

export class Impostors {
  private readonly geometry = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0)
  private readonly material: THREE.ShaderMaterial
  private mesh: THREE.InstancedMesh
  private cells: THREE.InstancedBufferAttribute
  private tints: THREE.InstancedBufferAttribute
  private n = 0
  private readonly m = new THREE.Matrix4()

  private constructor(
    private readonly parent: THREE.Object3D,
    private readonly atlas: THREE.WebGLRenderTarget,
    size: THREE.Vector2,
  ) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: atlas.texture },
        uCell: { value: new THREE.Vector2(1 / IMPOSTOR_CELLS, 1 / (ROWS * 2)) },
        uSize: { value: size },
      },
      vertexShader,
      fragmentShader,
    })
    const made = this.make(128)
    this.mesh = made.mesh
    this.cells = made.cells
    this.tints = made.tints
  }

  private make(capacity: number) {
    const cells = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2)
    const tints = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    cells.setUsage(THREE.DynamicDrawUsage)
    tints.setUsage(THREE.DynamicDrawUsage)
    const geometry = this.geometry.clone()
    geometry.setAttribute('aCell', cells)
    geometry.setAttribute('aTint', tints)
    const mesh = new THREE.InstancedMesh(geometry, this.material, capacity)
    mesh.name = 'character-impostors'
    mesh.frustumCulled = false
    mesh.count = 0
    mesh.raycast = () => {}
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.parent.add(mesh)
    return { mesh, cells, tints }
  }

  /** Renders the atlas. Returns undefined when baking is impossible (no WebGL, …). */
  static bake(parent: THREE.Object3D, input: ImpostorBakeInput): Impostors | undefined {
    const { renderer, template, clips, height } = input
    const W = 1.3
    const H = height + 0.35
    const cw = CELL_W
    const ch = Math.round((CELL_W * H) / W)
    const rt = new THREE.WebGLRenderTarget(cw * IMPOSTOR_CELLS, ch * ROWS * 2, { samples: 0 })
    rt.texture.minFilter = THREE.LinearFilter
    rt.texture.generateMipmaps = false

    const model = cloneSkinned(template)
    input.dress(model)
    const meshes: THREE.Mesh[] = []
    model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh)
    })
    const saved = meshes.map((m) => m.material)
    const owned: THREE.Material[] = []
    const neutral = (m: THREE.Material) => {
      const c = m.clone() as THREE.Material & { color?: THREE.Color }
      if (m.name === 'shirt') c.color?.setHex(0xffffff)
      owned.push(c)
      return c
    }
    const white = new THREE.MeshBasicMaterial({ color: 0xffffff })
    const black = new THREE.MeshBasicMaterial({ color: 0x000000 })
    owned.push(white, black)
    const mask = (m: THREE.Material) => (m.name === 'shirt' ? white : black)
    const colorMats = saved.map((s) => (Array.isArray(s) ? s.map(neutral) : neutral(s)))
    const maskMats = saved.map((s) => (Array.isArray(s) ? s.map(mask) : mask(s)))

    const scene = new THREE.Scene()
    scene.add(model)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x5a5048, 2.2))
    const sun = new THREE.DirectionalLight(0xffffff, 1.6)
    sun.position.set(1, 3, 2)
    scene.add(sun)
    const cam = new THREE.OrthographicCamera(-W / 2, W / 2, H, 0, 0.1, 20)
    const mixer = new THREE.AnimationMixer(model)

    const prevTarget = renderer.getRenderTarget()
    const prevColor = renderer.getClearColor(new THREE.Color())
    const prevAlpha = renderer.getClearAlpha()
    const prevAutoClear = renderer.autoClear
    try {
      renderer.setClearColor(0x000000, 0)
      renderer.autoClear = true
      rt.scissorTest = false
      renderer.setRenderTarget(rt)
      renderer.clear()
      for (let r = 0; r < ROWS; r++) {
        mixer.stopAllAction()
        const clip = clips.get(ROW_CLIPS[r]!) ?? clips.get('Idle')
        if (clip) {
          mixer.clipAction(clip).reset().play()
          mixer.update(0)
        }
        model.updateMatrixWorld(true)
        for (let pass = 0; pass < 2; pass++) {
          const mats = pass === 0 ? colorMats : maskMats
          meshes.forEach((m, i) => (m.material = mats[i]!))
          for (let k = 0; k < IMPOSTOR_CELLS; k++) {
            const a = (k * 2 * Math.PI) / IMPOSTOR_CELLS
            cam.position.set(Math.sin(a) * 5, 0, Math.cos(a) * 5)
            cam.lookAt(0, 0, 0)
            cam.updateMatrixWorld()
            rt.viewport.set(k * cw, (pass * ROWS + r) * ch, cw, ch)
            rt.scissor.copy(rt.viewport)
            rt.scissorTest = true
            renderer.setRenderTarget(rt)
            renderer.render(scene, cam)
          }
        }
      }
    } catch {
      rt.dispose()
      return undefined
    } finally {
      renderer.setRenderTarget(prevTarget)
      renderer.setClearColor(prevColor, prevAlpha)
      renderer.autoClear = prevAutoClear
      meshes.forEach((m, i) => (m.material = saved[i]!))
      mixer.stopAllAction()
      mixer.uncacheRoot(model)
      for (const m of owned) m.dispose()
      model.traverse((o) => (o as THREE.SkinnedMesh).skeleton?.dispose())
    }
    return new Impostors(parent, rt, new THREE.Vector2(W, H))
  }

  begin() {
    this.n = 0
  }

  /** Adds one impostor at (x, z): view cell 0–7, pose row 0–2, shirt tint. */
  push(x: number, z: number, cell: number, row: number, tint: THREE.Color) {
    if (this.n >= this.cells.count) {
      const old = this.mesh
      const made = this.make(this.cells.count * 2)
      ;(made.cells.array as Float32Array).set(this.cells.array as Float32Array)
      ;(made.tints.array as Float32Array).set(this.tints.array as Float32Array)
      made.mesh.instanceMatrix.array.set(old.instanceMatrix.array)
      this.parent.remove(old)
      old.geometry.dispose()
      old.dispose()
      ;({ mesh: this.mesh, cells: this.cells, tints: this.tints } = made)
    }
    const i = this.n++
    this.m.makeTranslation(x, 0, z)
    this.mesh.setMatrixAt(i, this.m)
    this.cells.setXY(i, cell, row)
    this.tints.setXYZ(i, tint.r, tint.g, tint.b)
  }

  get count() {
    return this.n
  }

  end() {
    this.mesh.count = this.n
    this.mesh.instanceMatrix.needsUpdate = true
    this.cells.needsUpdate = true
    this.tints.needsUpdate = true
  }

  dispose() {
    this.parent.remove(this.mesh)
    this.mesh.geometry.dispose()
    this.mesh.dispose()
    this.geometry.dispose()
    this.material.dispose()
    this.atlas.dispose()
  }
}
