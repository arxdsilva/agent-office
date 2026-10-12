// Contact shadows: one soft dark disc under every visible character, drawn as a single
// InstancedMesh (one draw call for everyone). Always on, at every quality preset.
import * as THREE from 'three'

const TEX = 64

function blobTexture(): THREE.DataTexture {
  const data = new Uint8Array(TEX * TEX * 4)
  for (let y = 0; y < TEX; y++)
    for (let x = 0; x < TEX; x++) {
      const dx = (x + 0.5) / TEX - 0.5
      const dy = (y + 0.5) / TEX - 0.5
      const r = Math.min(1, Math.hypot(dx, dy) * 2)
      const a = (1 - r * r) ** 2
      data[(y * TEX + x) * 4 + 3] = Math.round(a * 255)
    }
  const t = new THREE.DataTexture(data, TEX, TEX, THREE.RGBAFormat)
  t.magFilter = THREE.LinearFilter
  t.minFilter = THREE.LinearFilter
  t.needsUpdate = true
  return t
}

export class BlobShadows {
  private readonly geometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
  private readonly texture = blobTexture()
  private readonly material = new THREE.MeshBasicMaterial({
    color: 0x000000,
    map: this.texture,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
  private mesh: THREE.InstancedMesh
  private n = 0
  private readonly m = new THREE.Matrix4()

  constructor(private readonly parent: THREE.Object3D) {
    this.mesh = this.make(256)
  }

  private make(capacity: number) {
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity)
    mesh.name = 'character-blobs'
    mesh.frustumCulled = false
    mesh.renderOrder = 1
    mesh.count = 0
    mesh.raycast = () => {}
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.parent.add(mesh)
    return mesh
  }

  begin() {
    this.n = 0
  }

  push(x: number, z: number, size: number) {
    if (this.n >= this.mesh.instanceMatrix.count) {
      const old = this.mesh
      this.mesh = this.make(old.instanceMatrix.count * 2)
      this.mesh.instanceMatrix.array.set(old.instanceMatrix.array)
      this.parent.remove(old)
      old.dispose()
    }
    this.m.makeScale(size, 1, size).setPosition(x, 0.006, z)
    this.mesh.setMatrixAt(this.n++, this.m)
  }

  end() {
    this.mesh.count = this.n
    this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose() {
    this.parent.remove(this.mesh)
    this.mesh.dispose()
    this.geometry.dispose()
    this.material.dispose()
    this.texture.dispose()
  }
}
