// Aerial traffic (`traffic` role, docs/special-3d/rendering.md): instanced light pairs flying along
// closed splines around the HQ (procedural lanes, or `extras.points` from the real set). One draw
// call per colour; instance matrices are rewritten in place each frame (allocation-free).
import * as THREE from 'three'
import { mulberry32 } from '../../../app/special/env-schedule.ts'
import { markBloom } from '../rendering/bloom-selective.ts'

interface Car {
  curve: number
  t: number
  speed: number
  lane: number
}

export class Traffic {
  readonly group = new THREE.Group()
  private curves: THREE.CatmullRomCurve3[] = []
  private lengths: number[] = []
  private cars: Car[] = []
  private heads: THREE.InstancedMesh
  private tails: THREE.InstancedMesh
  private geometry = new THREE.BoxGeometry(0.9, 0.35, 0.25)
  private headMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(1.0, 0.9, 0.75).multiplyScalar(3),
  })
  private tailMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(1.0, 0.12, 0.2).multiplyScalar(2.6),
  })
  private m = new THREE.Matrix4()
  private p = new THREE.Vector3()
  private tan = new THREE.Vector3()
  private q = new THREE.Quaternion()
  private s = new THREE.Vector3(1, 1, 1)
  private up = new THREE.Vector3(0, 1, 0)
  private look = new THREE.Matrix4()

  constructor(
    scene: THREE.Scene,
    center: THREE.Vector3,
    max: number,
    seed = 9,
    paths?: THREE.Vector3[][],
  ) {
    this.group.name = 'traffic'
    const rnd = mulberry32(seed)
    const loops =
      paths ??
      Array.from({ length: 6 }, (_, i) => {
        const r = 95 + i * 28 + rnd() * 10
        const y = 18 + i * 9 + rnd() * 6
        const pts: THREE.Vector3[] = []
        for (let k = 0; k < 10; k++) {
          const a = (k / 10) * Math.PI * 2
          const rr = r * (0.85 + rnd() * 0.3)
          pts.push(
            new THREE.Vector3(
              center.x + Math.cos(a) * rr,
              y + (rnd() - 0.5) * 6,
              center.z + Math.sin(a) * rr * 0.8,
            ),
          )
        }
        return pts
      })
    for (const pts of loops) {
      const c = new THREE.CatmullRomCurve3(pts, true, 'centripetal')
      c.arcLengthDivisions = 120
      this.curves.push(c)
      this.lengths.push(c.getLength())
    }
    for (let i = 0; i < max; i++)
      this.cars.push({
        curve: i % this.curves.length,
        t: rnd(),
        speed: (14 + rnd() * 16) * (i % 2 ? 1 : -1),
        lane: (rnd() - 0.5) * 3,
      })
    this.heads = new THREE.InstancedMesh(this.geometry, this.headMat, Math.max(1, max))
    this.tails = new THREE.InstancedMesh(this.geometry, this.tailMat, Math.max(1, max))
    for (const im of [this.heads, this.tails]) {
      im.frustumCulled = false
      markBloom(im)
      this.group.add(im)
    }
    this.setCount(0)
    scene.add(this.group)
  }

  setCount(n: number): void {
    const c = Math.max(0, Math.min(this.cars.length, n))
    this.heads.count = this.tails.count = c
    this.group.visible = c > 0
  }

  update(dt: number): void {
    if (!this.group.visible) return
    const n = this.heads.count
    for (let i = 0; i < n; i++) {
      const car = this.cars[i]!
      const curve = this.curves[car.curve]!
      car.t = (((car.t + (car.speed * dt) / this.lengths[car.curve]!) % 1) + 1) % 1
      curve.getPointAt(car.t, this.p)
      curve.getTangentAt(car.t, this.tan)
      if (car.speed < 0) this.tan.negate()
      this.p.y += car.lane * 0.3
      this.look.lookAt(this.tan, this.p.set(0, 0, 0), this.up)
      this.q.setFromRotationMatrix(this.look)
      curve.getPointAt(car.t, this.p)
      this.p.y += car.lane * 0.3
      // Head lights at the front, tail lights 3 m behind.
      this.p.addScaledVector(this.tan, 1.5)
      this.heads.setMatrixAt(i, this.m.compose(this.p, this.q, this.s))
      this.p.addScaledVector(this.tan, -3)
      this.tails.setMatrixAt(i, this.m.compose(this.p, this.q, this.s))
    }
    this.heads.instanceMatrix.needsUpdate = true
    this.tails.instanceMatrix.needsUpdate = true
  }

  dispose(): void {
    this.group.removeFromParent()
    this.heads.dispose()
    this.tails.dispose()
    this.geometry.dispose()
    this.headMat.dispose()
    this.tailMat.dispose()
  }
}
