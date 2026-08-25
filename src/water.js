import * as THREE from 'three';

/**
 * River surface.
 *
 * The three rivers are 150-350 m across and thousands long, and the camera
 * looks at them from 300-2500 m up, so one pixel covers roughly 0.3-3 m. That
 * rules out a tiled normal map (a repeat either reads as corduroy or blurs to
 * nothing) and it also rules out any fixed-frequency procedural detail: the
 * surface has to know how big a pixel is and drop whatever it cannot resolve.
 *
 * Everything here is driven from world XZ so the pattern never tiles, and the
 * frequency content is band-limited per octave against the on-screen footprint.
 */

/**
 * Local flow direction, unit length, in world XZ.
 *
 * All three rivers run broadly west (-X). The Allegheny comes in from the
 * north-east with a slight southward set, the Monongahela from the south-east
 * with a northward one, and they merge at the Point (near x=-800, z=-80) into
 * the Ohio, which then bends north-west. Blending the cross-stream term by Z
 * reproduces the convergence without needing per-river geometry; the ramps are
 * deliberately wide so the direction field has no crease anywhere, because a
 * crease in the flow frame becomes a seam in everything sampled in it.
 */
export const RIVER_FLOW_GLSL = `
  vec2 riverFlow(vec2 p) {
    float north = 1.0 - smoothstep(-420.0, 60.0, p.y);
    float south = smoothstep(-160.0, 340.0, p.y);
    float ohio = 1.0 - smoothstep(-1500.0, -600.0, p.x);
    float set = 0.20 * north - 0.30 * south;
    return normalize(vec2(-1.0, mix(set, -0.34, ohio)));
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

  /**
   * Value noise returned as (value, d/dx, d/dy). The analytic derivative earns
   * its keep twice over: finite-differencing costs three evaluations per octave
   * instead of one, and because neighbouring taps share hash corners the
   * difference is piecewise constant across a cell, which a surface this shiny
   * renders as visible facets.
   */
  vec3 vnoiseD(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    vec2 du = 6.0 * f * (1.0 - f);
    float a = vhash(i);
    float b = vhash(i + vec2(1.0, 0.0));
    float c = vhash(i + vec2(0.0, 1.0));
    float d = vhash(i + vec2(1.0, 1.0));
    float k1 = b - a;
    float k2 = c - a;
    float k3 = a - b - c + d;
    return vec3(
      a + k1 * u.x + k2 * u.y + k3 * u.x * u.y,
      du.x * (k1 + k3 * u.y),
      du.y * (k2 + k3 * u.x));
  }`;

/**
 * Surface field in the flow frame.
 *
 * Three things keep this from turning into the diagonal corduroy that a plain
 * anisotropic noise stack produces:
 *
 *  - Anisotropy is only ~2.2:1 per octave, not ~5:1. Past about 3:1 a value
 *    noise cell stops reading as a patch of texture and starts reading as a
 *    line segment, and since the flow direction barely changes across the whole
 *    scene those segments are all parallel and join up end to end.
 *  - Each octave's lattice is rotated by a different angle *after* the
 *    anisotropic scale, so the elongation still points downstream but the
 *    square grids underneath no longer coincide and cannot reinforce.
 *  - The fine octaves are domain-warped by the coarse octave's gradient, which
 *    bends the streaks the way real current shear does.
 *
 * Each octave is also weighted by how many pixels its across-stream wavelength
 * covers. An octave narrower than a couple of pixels carries no information the
 * framebuffer can hold, only shimmer, so it is faded out rather than sampled.
 */
const SURFACE_GLSL = `
  struct River {
    float shade;
    vec2 slope;
    float chop;
    float foam;
  };

  // 26, 57 and 83 degrees: mutually non-parallel, and none a multiple of
  // another, so no two lattices share an axis.
  const mat2 ROT1 = mat2(0.8988, 0.4384, -0.4384, 0.8988);
  const mat2 ROT2 = mat2(0.5446, 0.8387, -0.8387, 0.5446);
  const mat2 ROT3 = mat2(0.1219, 0.9925, -0.9925, 0.1219);

  // An octave is drawn at full strength once its wavelength spans five pixels
  // and dropped entirely below two, where it can only contribute shimmer.
  float bandLimit(float wavelength, float px) {
    return smoothstep(1.8, 5.0, wavelength / px);
  }

  River riverField(vec2 p, vec2 flow, float t, float px) {
    vec2 across = vec2(-flow.y, flow.x);
    float along = dot(p, flow);
    float side = dot(p, across);

    // Wavelengths, metres: 230x104, 92x42, 37x17, 15x7.
    float w0 = bandLimit(104.0, px);
    float w1 = bandLimit(42.0, px);
    float w2 = bandLimit(17.0, px);
    float w3 = bandLimit(7.0, px);

    // t is seconds; uFlow is a cinematic multiplier so the current reads from
    // a downtown camera instead of waiting a minute for a 200 m wave to pass.
    float adv = t;
    vec3 n0 = vnoiseD(vec2(along * 0.00435 - adv * 0.055, side * 0.0096));
    // Warp is measured in cells of the octave it is applied to, so a little
    // goes a long way: half a cell is enough to break the lattice alignment,
    // while a couple of cells shears the whole field into paint marbling.
    vec2 warp = n0.yz * 0.55;

    vec3 n1 = w1 > 0.0
      ? vnoiseD(ROT1 * vec2(along * 0.0109 - adv * 0.14, side * 0.0238) + warp)
      : vec3(0.5, 0.0, 0.0);
    vec3 n2 = w2 > 0.0
      ? vnoiseD(ROT2 * vec2(along * 0.027 - adv * 0.34, side * 0.059) + warp * 1.35)
      : vec3(0.5, 0.0, 0.0);
    vec3 n3 = w3 > 0.0
      ? vnoiseD(ROT3 * vec2(along * 0.067 - adv * 0.82, side * 0.145) + warp * 1.7)
      : vec3(0.5, 0.0, 0.0);

    // Current lines: 8:1 anisotropy, which on its own would be exactly the
    // corduroy failure mode, so it is warped, advected, and kept to a few per
    // cent of contrast. It works through the ripple energy rather than the
    // albedo, because that is what a shear line physically is — a band where
    // the surface goes slick between rippled water — and because albedo is such
    // a small part of what a river reflects that anything painted on it is
    // invisible from the air.
    float wl = bandLimit(28.0, px);
    float lines = wl > 0.0
      ? vnoiseD(vec2(along * 0.0046 - adv * 0.095, side * 0.0357) + warp * 0.8).x
      : 0.5;

    // A dedicated current sheet, more elongated than the ripple stack, so the
    // eye can track features moving downstream. Contrast stays in roughness
    // and a little foam rather than a painted stripe.
    float wc = bandLimit(14.0, px);
    float current = wc > 0.0
      ? vnoiseD(vec2(along * 0.016 - adv * 0.26, side * 0.095) + warp * 1.1).x
      : 0.5;

    River r;
    r.shade = 0.5
      + (n0.x - 0.5) * 0.34 * w0
      + (n1.x - 0.5) * 0.26 * w1
      + (n2.x - 0.5) * 0.20 * w2
      + (n3.x - 0.5) * 0.14 * w3;

    // Slopes stay small on purpose: a navigable pool-stage river is close to
    // glassy, and one degree of tilt already swings the reflected ray two
    // degrees, which is plenty against a sky gradient this steep. Anything
    // steeper starts reading as sea state, and none of these rivers has any.
    r.slope = n0.yz * 0.0105 * w0
      + n1.yz * 0.0145 * w1
      + n2.yz * 0.0135 * w2
      + n3.yz * 0.0115 * w3;

    // Local ripple energy, from the gradients that are already in hand. The
    // scale matters: value-noise derivatives peak near 1.5, so an unscaled sum
    // pins this at 1.0 over the entire river, which flattens the roughness and
    // the reflection blend into constants and takes all the life out of the
    // surface. Calibrated so the mean lands near 0.35.
    r.chop = clamp(
      ((abs(n2.y) + abs(n2.z)) * w2 + (abs(n3.y) + abs(n3.z)) * w3) * 0.30
      + (lines - 0.5) * 0.26 * wl
      + (current - 0.5) * 0.34 * wc,
      0.0, 1.0);
    r.foam = clamp((current - 0.58) * 2.4 * wc + (lines - 0.62) * 1.4 * wl, 0.0, 1.0);
    return r;
  }`;

/**
 * What the surface reflects, as a function of the reflected direction.
 *
 * This is analytic rather than left to `scene.environment` because the shared
 * environment map is sky in every direction. Water's Fresnel reflectance really
 * does reach 40% by six degrees above the surface, so an all-sky probe turns
 * every grazing view of a river into a flat white sheet.
 *
 * What a near-horizontal ray off these rivers actually hits is the valley:
 * Mount Washington stands 120 m over the Monongahela, and the far bank is city
 * or wooded bluff for the whole length of all three rivers. Below the treeline
 * angle the reflection is that dark green-grey surround, and having it there is
 * most of what separates water from fog. The sky above it is matched to the
 * gradient in `createSkyDome` so the river agrees with the sky it sits under.
 */
function skyGlsl(dayMode) {
  const zenith = dayMode ? 'vec3(0.068, 0.278, 0.697)' : 'vec3(0.0010, 0.0020, 0.0050)';
  const horizon = dayMode ? 'vec3(0.482, 0.661, 0.871)' : 'vec3(0.0100, 0.0215, 0.0410)';
  const valley = dayMode ? 'vec3(0.072, 0.082, 0.079)' : 'vec3(0.0150, 0.0110, 0.0075)';
  return `
    vec3 riverSurround(vec3 dir) {
      vec3 sky = mix(${horizon}, ${zenith}, pow(clamp(dir.y, 0.0, 1.0), 0.55));
      // The bluffs and the North Shore blocks subtend 15-30 degrees from
      // mid-channel, so the crossover into open sky sits around 20 degrees,
      // well above the geometric horizon.
      return mix(${valley}, sky, smoothstep(0.055, 0.620, dir.y));
    }`;
}

export function createWaterMaterial({ dayMode = true } = {}) {
  const uniforms = {
    uTime: { value: 0 },
    uFlow: { value: 1 },
    uPrecip: { value: 0 },
  };

  // Albedo is deliberately near-black: a silty river reflects only a few per
  // cent diffusely and almost everything you see in it is reflection. Anything
  // lighter here immediately reads as a swimming pool.
  //
  // Water is a dielectric, so metalness stays at zero and the specular runs off
  // the default F0 of 0.04. Any metalness at all tints the specular lobe with
  // the albedo and multiplies it, which on a near-mirror plane clips the sun
  // reflection to a hard-edged white blob before the tone mapper has any
  // headroom left to roll off.
  //
  // There is deliberately no envMapIntensity here: the renderer overwrites it
  // with scene.environmentIntensity for any MeshStandardMaterial that has no
  // envMap of its own, so setting it would only look like a working knob. The
  // environment probe's specular contribution is replaced in the shader instead;
  // its irradiance is kept, since that skylight is real.
  const mat = new THREE.MeshStandardMaterial({
    color: dayMode ? 0x2f3a35 : 0x081014,
    roughness: dayMode ? 0.28 : 0.26,
    metalness: 0.0,
    transparent: true,
    opacity: dayMode ? 0.975 : 0.985,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  mat.customProgramCacheKey = () => 'river-surface-flow-v2';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uFlow = uniforms.uFlow;
    shader.uniforms.uPrecip = uniforms.uPrecip;
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
      uniform float uFlow;
      uniform float uPrecip;
      varying vec3 vWorldPos;
      ${RIVER_FLOW_GLSL}
      ${NOISE_GLSL}
      ${SURFACE_GLSL}
      ${skyGlsl(dayMode)}`;

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${flowCommon}`)
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
         vec2 rFlow = riverFlow(vWorldPos.xz);
         vec2 rAcross = vec2(-rFlow.y, rFlow.x);
         // Metres of river per screen pixel, straight off the interpolated
         // world position. At grazing angles this grows fast, which is exactly
         // where the fine octaves have to go away.
         float rPx = max(length(fwidth(vWorldPos.xz)), 0.02);
         River rField = riverField(vWorldPos.xz, rFlow, uTime * uFlow, rPx);
         vec3 rNormalW = normalize(vec3(
           -(rField.slope.x * rFlow.x + rField.slope.y * rAcross.x),
           1.0,
           -(rField.slope.x * rFlow.y + rField.slope.y * rAcross.y)));
         vec3 rViewW = normalize(cameraPosition - vWorldPos);`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         {
           // The Monongahela runs over shale and sandstone and carries enough
           // silt to read visibly browner than the gravel-bedded Allegheny; the
           // Ohio below the Point is the two of them still mixing, and by the
           // West End it has evened out. The split is by Z because the Mon
           // enters from the south-east.
           float mon = smoothstep(-140.0, 430.0, vWorldPos.z) * smoothstep(-1400.0, -720.0, vWorldPos.x);
           float ohio = 1.0 - smoothstep(-1500.0, -650.0, vWorldPos.x);
           // Suspended silt both warms the water and raises its diffuse albedo,
           // so this has to be a mix towards a sediment colour rather than a
           // tint multiplier: the base albedo is green-dominant, and scaling it
           // by anything keeps it green. Load is not uniform either — silt comes
           // down in plumes and hangs over the shallow inside of every bend.
           float plume = smoothstep(0.56, 0.96, rField.shade) * 0.22;
           diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.055, 0.039, 0.021),
             clamp(max(mon, ohio * 0.45) * 0.82 + plume, 0.0, 1.0));
           diffuseColor.rgb *= 0.82 + rField.shade * 0.38;
           // Moving foam on the current sheet is what makes the river read as
           // flowing from a few hundred metres up, where the ripple stack is
           // only a slow morph.
           float foam = rField.foam;
           foam += step(0.5, uPrecip) * step(uPrecip, 1.5) * rField.chop * 0.35;
           diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.46, 0.52, 0.50), clamp(foam, 0.0, 1.0) * 0.55);
           // Snow: paler, quieter surface.
           diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.22, 0.26, 0.28), step(1.5, uPrecip) * 0.28);
         }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         // Glassy in the slack water, rougher where the ripple field has some
         // energy. Varying it this way is what turns one hard specular blob
         // into a broken glitter path, and because chop is already band-limited
         // the far bank stops sparkling once the ripples go subpixel.
         roughnessFactor = clamp(roughnessFactor + rField.chop * 0.30 - 0.07
           + step(0.5, uPrecip) * step(uPrecip, 1.5) * 0.10
           - step(1.5, uPrecip) * 0.08, 0.09, 0.70);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         normal = normalize((viewMatrix * vec4(rNormalW, 0.0)).xyz);`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
         float rNdv = clamp(dot(rViewW, rNormalW), 0.0, 1.0);
         {
           // Schlick against water's real F0 of 0.02. Left alone: it tracks the
           // exact Fresnel curve for n=1.333 to within a per cent, and every
           // attempt to "widen" it is what makes water look like wet plastic.
           float fres = 0.02 + 0.98 * pow(1.0 - rNdv, 5.0);
           // A rippled patch gathers its reflection from a cone around the
           // mirror direction, so it averages towards straight up; a slick
           // patch takes the mirror direction alone. On a river that difference
           // is most of the visible mottling, because up is bright sky and the
           // mirror direction is usually the dark far bank.
           vec3 refl = normalize(mix(reflect(-rViewW, rNormalW), rNormalW, 0.03 + rField.chop * 0.20));
           reflectedLight.indirectSpecular = riverSurround(refl) * fres;
         }
         // The scene lights the city with a sun plus a low fill from the
         // opposite quarter. On matte surfaces the fill only softens shadows,
         // but a near-mirror plane resolves it as a second sun: its half-vector
         // with any downward view is almost straight up, so its GGX lobe covers
         // every river at once as a single enormous sheet an order of magnitude
         // brighter than the water under it. Only the primary sun gets a lobe
         // here, wide and rolled off so the glitter reads as a soft path.
         //
         // The cost is that the glitter ignores shadows. That is close to free
         // on water this dark — a bridge shadow was already invisible in the
         // diffuse term — but it does mean the lobe follows directionalLights[0],
         // so the sun has to stay the first directional light added to the scene.
         reflectedLight.directSpecular = vec3(0.0);
         #if NUM_DIR_LIGHTS > 0
         {
           vec3 sunW = inverseTransformDirection(directionalLights[0].direction, viewMatrix);
           vec3 halfW = normalize(sunW + rViewW);
           float ndl = max(dot(rNormalW, sunW), 0.0);
           // Effective slope distribution of the ripple field, wider than the
           // shading roughness on purpose: a glitter path on a river a kilometre
           // off is tens of degrees long, and a tight lobe is what collapses it
           // into a blob.
           float alpha = 0.130 + rField.chop * 0.32;
           vec3 lobe = directionalLights[0].color * ndl
             * F_Schlick(vec3(0.02), 1.0, max(dot(rViewW, halfW), 0.0))
             * V_GGX_SmithCorrelated(alpha, ndl, rNdv)
             * D_GGX(alpha, max(dot(rNormalW, halfW), 0.0));
           reflectedLight.directSpecular += lobe / (1.0 + lobe * 3.4);
         }
         #endif`,
      );
  };

  return { mat, uniforms };
}
