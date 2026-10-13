// Canvas content on glTF planes (`holo`, `ad` roles): which way the plane's UVs run, so text drawn
// on a canvas reads left-to-right and upright from the side facing `viewer` (the building centre),
// whatever way the asset authored them. glTF UVs start top-left (texture.flipY = false).
import * as THREE from 'three'

const a = new THREE.Vector3()
const b = new THREE.Vector3()
const c = new THREE.Vector3()

/** Flips (u, v) for an upright, unmirrored canvas on `mesh`'s front (its normals; else seen from `viewer`). */
export function uvFlips(mesh: THREE.Mesh, viewer?: THREE.Vector3): { x: boolean; y: boolean } {
  const g = mesh.geometry
  const pos = g.getAttribute('position')
  const uv = g.getAttribute('uv')
  if (!pos || !uv || pos.count < 3) return { x: false, y: false }
  const idx = g.index
  const i0 = idx ? idx.getX(0) : 0
  const i1 = idx ? idx.getX(1) : 1
  const i2 = idx ? idx.getX(2) : 2
  mesh.updateWorldMatrix(true, false)
  a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld)
  b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld)
  c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld)
  const e1 = b.clone().sub(a)
  const e2 = c.clone().sub(a)
  const du1 = uv.getX(i1) - uv.getX(i0)
  const dv1 = uv.getY(i1) - uv.getY(i0)
  const du2 = uv.getX(i2) - uv.getX(i0)
  const dv2 = uv.getY(i2) - uv.getY(i0)
  const r = du1 * dv2 - du2 * dv1
  if (Math.abs(r) < 1e-12) return { x: false, y: false }
  // Tangent (direction of increasing u) and bitangent (increasing v) in world space.
  const t = e1.clone().multiplyScalar(dv2).sub(e2.clone().multiplyScalar(dv1)).divideScalar(r)
  const bt = e2.clone().multiplyScalar(du1).sub(e1.clone().multiplyScalar(du2)).divideScalar(r)
  const n = e1.clone().cross(e2).normalize()
  // The authored front: the vertex normal (else the viewer's side).
  const na = g.getAttribute('normal')
  if (na) {
    const vn = new THREE.Vector3().fromBufferAttribute(na, i0).transformDirection(mesh.matrixWorld)
    if (n.dot(vn) < 0) n.negate()
  } else if (viewer && n.dot(viewer.clone().sub(a)) < 0) n.negate()
  const right = n
    .clone()
    .negate()
    .cross(new THREE.Vector3(0, 1, 0))
  return { x: t.dot(right) < 0, y: bt.y > 0 }
}

/** Applies flips to a texture through its UV transform. */
export function applyFlips(t: THREE.Texture, f: { x: boolean; y: boolean }): void {
  t.repeat.set(f.x ? -1 : 1, f.y ? -1 : 1)
  t.offset.set(f.x ? 1 : 0, f.y ? 1 : 0)
  t.needsUpdate = true
}
