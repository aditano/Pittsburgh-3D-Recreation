import * as THREE from 'three';

/**
 * River surface.
 *
 * The three rivers are hundreds of metres across and thousands long, and the
 * camera looks at them from a few hundred metres up. That rules out the usual
 * tiled normal map — at this scale a repeat either tiles visibly into corduroy
 * or blurs to nothing — so the whole surface is shaded procedurally from noise
 * sampled in a frame aligned to the local flow direction.
 */

/**
 * Local flow direction, unit length, in world XZ.
 *
 * All three rivers run broadly west (-X). The Allegheny comes in from the
 * north-east with a slight southward set, the Monongahela from the south-east
 * with a northward one, and they merge at the Point into the Ohio. Blending the
 * cross-stream term by Z reproduces the convergence without needing per-river
 * geometry.
 */
export const RIVER_FLOW_GLSL = `
  vec2 riverFlow(vec2 p) {
    float north = 1.0 - smoothstep(-260.0, -40.0, p.y);
    float south = smoothstep(-20.0, 200.0, p.y);
    return normalize(vec2(-1.0, 0.17 * north - 0.32 * south));
  }`;

/**
 * Sine-free hash. The usual `fract(sin(dot(p, k)) * 43758.5)` breaks down here:
 * the flow frame reaches coordinates in the hundreds, so sin() is evaluated
 * tens of thousands of radians out, where float32 resolves only a couple of
 * hundred steps per period. The hash then correlates between neighbouring cells
 * and the correlation reads as diagonal banding marching across the channel.
 */
const NOISE_GLSL = `
  float vhash(vec2 c) {
    vec3 p = fract(vec3(c.xyx) * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(vhash(i), vhash(i + vec2(1.0, 0.0)), u.x),
      mix(vhash(i + vec2(0.0, 1.0)), vhash(i + vec2(1.0, 1.0)), u.x),
      u.y);
  }`;

/**
 * Surface height field, 0..1, in the flow frame.
 *
 * The frame is stretched ALONG the flow and compressed across it so the noise
 * pulls into long downstream streaks; scaling it the other way makes features
 * short along the flow and wide across it, which is what reads as bands
 * marching sideways across the channel. Streaks here run ~55 m by ~12 m.
 */
const SURFACE_GLSL = `
  float riverSurface(vec2 p, vec2 flow, float t) {
    vec2 across = vec2(-flow.y, flow.x);
    float along = dot(p, flow);
    float side = dot(p, across);
    vec2 q = vec2(along * 0.018 - t * 0.45, side * 0.085);
    float n = vnoise(q) * 0.60;
    n += vnoise(q * 2.4 + vec2(t * 0.2, 0.0)) * 0.22;
    n += vnoise(vec2(along * 0.004 + t * 0.03, side * 0.018)) * 0.44;
    return n / 1.26;
  }`;

export function createWaterMaterial({ dayMode = true } = {}) {
  const uniforms = { uTime: { value: 0 } };

  // No albedo/roughness maps: at river scale a tiled texture reads as corduroy.
  const mat = new THREE.MeshStandardMaterial({
    color: dayMode ? 0x34718c : 0x0a2834,
    roughness: dayMode ? 0.24 : 0.28,
    metalness: 0.34,
    transparent: true,
    opacity: dayMode ? 0.9 : 0.95,
    envMapIntensity: dayMode ? 1.25 : 1.05,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vWorldPos;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );

    const flowCommon = `
      uniform float uTime;
      varying vec3 vWorldPos;
      ${RIVER_FLOW_GLSL}
      ${NOISE_GLSL}
      ${SURFACE_GLSL}`;

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${flowCommon}`)
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         {
           vec2 flow = riverFlow(vWorldPos.xz);
           vec2 across = vec2(-flow.y, flow.x);
           // Differenced over a stride comparable to the streak width, so the
           // slope stays gentle instead of sparkling at every pixel.
           float e = 6.0;
           float c0 = riverSurface(vWorldPos.xz, flow, uTime);
           float ca = riverSurface(vWorldPos.xz + flow * e, flow, uTime);
           float cb = riverSurface(vWorldPos.xz + across * e, flow, uTime);
           vec2 grad = vec2(ca - c0, cb - c0) * 0.53;
           normal = normalize(normal + vec3(
             flow.x * grad.x + across.x * grad.y,
             0.0,
             flow.y * grad.x + across.y * grad.y));
         }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         {
           vec2 flow = riverFlow(vWorldPos.xz);
           float s = riverSurface(vWorldPos.xz, flow, uTime);
           diffuseColor.rgb *= 0.94 + s * 0.12;
           diffuseColor.rgb += smoothstep(0.72, 0.99, s) * vec3(0.045, 0.07, 0.085);
         }`,
      );
  };

  return { mat, uniforms };
}
