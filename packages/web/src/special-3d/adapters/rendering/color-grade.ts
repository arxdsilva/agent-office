// Colour grade (docs/special-3d/rendering.md): runs on the linear HDR image before the shared
// pipeline's OutputPass (AgX tone mapping, sRGB). Exposure, a gentle split tone (cool shadows,
// warm highlights, on the luminance of the tone-mapped estimate), saturation and a vignette.
import * as THREE from 'three'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'

export const GRADE = {
  exposure: 1.0,
  shadows: new THREE.Color(0x2a6a80),
  highlights: new THREE.Color(0xffc48a),
  balance: 0.4,
  amount: 0.18,
  saturation: 1.05,
  vignette: 0.42,
}

export function createColorGrade(): ShaderPass {
  return new ShaderPass(
    new THREE.ShaderMaterial({
      name: 'special:color-grade',
      uniforms: {
        tDiffuse: { value: null },
        exposure: { value: GRADE.exposure },
        shadowTint: { value: GRADE.shadows.clone() },
        highlightTint: { value: GRADE.highlights.clone() },
        balance: { value: GRADE.balance },
        amount: { value: GRADE.amount },
        saturation: { value: GRADE.saturation },
        vignette: { value: GRADE.vignette },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float exposure, balance, amount, saturation, vignette;
        uniform vec3 shadowTint, highlightTint;
        varying vec2 vUv;
        void main() {
          vec4 src = texture2D(tDiffuse, vUv);
          vec3 c = src.rgb * exposure;
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          float t = l / (1.0 + l);
          float w = smoothstep(balance - 0.3, balance + 0.3, t);
          vec3 tint = mix(shadowTint, highlightTint, w);
          c *= mix(vec3(1.0), tint * 1.6, amount);
          c = max(mix(vec3(l), c, saturation), 0.0);
          vec2 q = vUv - 0.5;
          c *= 1.0 - vignette * smoothstep(0.2, 0.8, dot(q, q) * 2.0);
          gl_FragColor = vec4(c, src.a);
        }`,
    }),
  )
}
