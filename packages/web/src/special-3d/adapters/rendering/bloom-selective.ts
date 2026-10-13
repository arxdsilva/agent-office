// Emissive tagging (docs/special-3d/rendering.md). Bloom itself is the shared RenderPipeline's
// threshold bloom on the HDR image: only emissive surfaces (screens, neon, strips, city windows)
// exceed 1.0, so no extra scene render is needed. Tagged objects sit on BLOOM_LAYER as well, for
// debugging and a possible layer-masked pass on Ultra later.
import type * as THREE from 'three'

export const BLOOM_LAYER = 11
/** Night City's bloom: threshold 1.0 on linear HDR (baked surfaces stay below it). */
export const SPECIAL_BLOOM = { threshold: 1.0, strength: 0.28, radius: 0.25 }

/** Puts an object (and its subtree) on the bloom layer, keeping its normal layers. */
export function markBloom(o: THREE.Object3D): void {
  o.traverse((c) => c.layers.enable(BLOOM_LAYER))
}
