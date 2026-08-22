import * as THREE from 'three';
import { createRainSystem } from './rain.js';

/**
 * Dynamic weather system.
 *
 * The controller owns every atmospheric/lighting parameter that differs
 * between weather presets and blends between them smoothly. It deliberately
 * does NOT own geometry: precipitation particles are added by later passes
 * through the documented hooks near the bottom of this file
 * (`rainSystem` / `snowSystem`).
 *
 * Design notes:
 * - Every preset is a flat bag of scalars/hex colors (see `WEATHER_PRESETS`).
 *   Adding a new preset is purely declarative — no new plumbing required.
 * - Blending happens on a mirrored "state" object made of preallocated
 *   THREE.Color instances, so `update()` performs no allocations.
 * - `apply()` is the single place that writes into the scene/renderer, which
 *   keeps the transition math and the side effects separated.
 */

export const WEATHER_NAMES = ['sunny', 'rain', 'snow'];

/** Default cross-fade duration between two presets, in seconds. */
const DEFAULT_TRANSITION = 1.25;

/**
 * Per-preset target parameters.
 *
 * Colors are hex ints, everything else is a plain number so presets stay
 * serializable/diffable. `precipitation` and `wetness` carry no visual effect
 * on their own yet — they are the normalized 0..1 signals Pass 6 (rain) and
 * Pass 7 (snow) read to fade particles and surface wetness in/out.
 */
export const WEATHER_PRESETS = {
  // Clear golden-hour dusk: the brightest, cleanest, most saturated option.
  sunny: {
    label: 'Sunny',
    fogColor: 0x2a3a4e,
    fogDensity: 0.00013,
    backgroundColor: 0x2a3a4e,
    skyZenith: 0x0a1a3a,
    skyMid: 0x18304e,
    skyHorizon: 0x2a3a4e,
    skyGlow: 0x6e3a1c,
    skyNadir: 0x050810,
    sunColor: 0xfff0d8,
    sunIntensity: 1.55,
    hemiSkyColor: 0xc8d8f0,
    hemiGroundColor: 0x2a3428,
    hemiIntensity: 0.62,
    fillColor: 0x7a8ab0,
    fillIntensity: 0.34,
    focusColor: 0xffffff,
    focusIntensity: 20,
    bloomStrength: 0.62,
    bloomRadius: 0.62,
    bloomThreshold: 0.82,
    exposure: 1.14,
    environmentIntensity: 0.9,
    precipitation: 0,
    wetness: 0,
  },

  // Overcast downpour: desaturated, cool blue-gray, dim sun, heavy haze.
  // Pass 6 layers rain streaks + wet ground on top of this mood.
  rain: {
    label: 'Rain',
    fogColor: 0x2b3138,
    fogDensity: 0.00042,
    backgroundColor: 0x2f3740,
    skyZenith: 0x1a2029,
    skyMid: 0x232a34,
    skyHorizon: 0x2f3740,
    // Sunset glow is neutralized so the horizon reads as flat overcast cloud
    // rather than a warm dusk band poking through the storm.
    skyGlow: 0x2a2f36,
    skyNadir: 0x0a0d11,
    sunColor: 0x9fb4c8,
    sunIntensity: 0.55,
    hemiSkyColor: 0x8a97a8,
    hemiGroundColor: 0x22262a,
    // Overcast light is mostly diffuse, so the hemisphere carries more of it.
    hemiIntensity: 0.74,
    fillColor: 0x5a6470,
    fillIntensity: 0.28,
    focusColor: 0xc8d4e0,
    focusIntensity: 14,
    bloomStrength: 0.46,
    bloomRadius: 0.7,
    bloomThreshold: 0.86,
    exposure: 0.95,
    environmentIntensity: 0.55,
    precipitation: 1,
    wetness: 1,
  },

  // Cold snowfall: bright and hazy but blue-white, with very soft shading.
  // Pass 7 layers snowflakes + accumulation on top of this mood.
  snow: {
    label: 'Snow',
    fogColor: 0x7c8ea6,
    fogDensity: 0.00046,
    backgroundColor: 0x8496aa,
    skyZenith: 0x46586e,
    skyMid: 0x5a6c82,
    skyHorizon: 0x8496aa,
    skyGlow: 0x6a7688,
    skyNadir: 0x1a2028,
    sunColor: 0xdfe8f5,
    sunIntensity: 0.85,
    hemiSkyColor: 0xd8e4f2,
    hemiGroundColor: 0x6a7482,
    // Snow bounces a lot of light back up; the strong hemisphere fill is what
    // keeps facades legible even though the sun itself is weak and diffuse.
    hemiIntensity: 1.15,
    fillColor: 0x8fa2b8,
    fillIntensity: 0.42,
    focusColor: 0xeaf2ff,
    focusIntensity: 16,
    bloomStrength: 0.5,
    bloomRadius: 0.72,
    // Threshold stays high: the scene is already bright, so a low threshold
    // would bloom the whole snowfield into a white smear.
    bloomThreshold: 0.9,
    exposure: 1.0,
    environmentIntensity: 0.85,
    precipitation: 1,
    wetness: 0.35,
  },
};

/** Keys whose preset values are hex colors (everything else is scalar). */
const COLOR_KEYS = [
  'fogColor',
  'backgroundColor',
  'skyZenith',
  'skyMid',
  'skyHorizon',
  'skyGlow',
  'skyNadir',
  'sunColor',
  'hemiSkyColor',
  'hemiGroundColor',
  'fillColor',
  'focusColor',
];

const SCALAR_KEYS = [
  'fogDensity',
  'sunIntensity',
  'hemiIntensity',
  'fillIntensity',
  'focusIntensity',
  'bloomStrength',
  'bloomRadius',
  'bloomThreshold',
  'exposure',
  'environmentIntensity',
  'precipitation',
  'wetness',
];

/** Allocate a blendable state object mirroring the preset schema. */
function createState() {
  const state = {};
  for (const key of COLOR_KEYS) state[key] = new THREE.Color();
  for (const key of SCALAR_KEYS) state[key] = 0;
  return state;
}

/** Copy a preset (hex ints) into a state object (Color instances). */
function readPreset(state, preset) {
  for (const key of COLOR_KEYS) state[key].setHex(preset[key]);
  for (const key of SCALAR_KEYS) state[key] = preset[key];
  return state;
}

function copyState(dst, src) {
  for (const key of COLOR_KEYS) dst[key].copy(src[key]);
  for (const key of SCALAR_KEYS) dst[key] = src[key];
  return dst;
}

function lerpState(out, a, b, t) {
  for (const key of COLOR_KEYS) out[key].lerpColors(a[key], b[key], t);
  for (const key of SCALAR_KEYS) out[key] = a[key] + (b[key] - a[key]) * t;
  return out;
}

/** Smoothstep easing so transitions ease in and out instead of ramping linearly. */
function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function wetSurface(material, wetRoughness, wetMetalness, wetEnvironment, darken) {
  if (!material) return null;
  return {
    material,
    baseColor: material.color.clone(),
    baseRoughness: material.roughness,
    baseMetalness: material.metalness,
    baseEnvironment: material.envMapIntensity,
    wetRoughness,
    wetMetalness,
    wetEnvironment,
    darken,
  };
}

export class WeatherController {
  /**
   * @param {object} refs
   * @param {THREE.Scene}            refs.scene       Scene owning fog/background.
   * @param {THREE.WebGLRenderer}    refs.renderer    For tone mapping exposure.
   * @param {THREE.DirectionalLight} refs.sun         Key light.
   * @param {THREE.HemisphereLight}  refs.hemiLight   Sky/ground ambient.
   * @param {THREE.DirectionalLight} [refs.fillLight] Cool bounce light.
   * @param {THREE.SpotLight}        [refs.focusLight] Camera-target spot.
   * @param {object}                 [refs.bloomPass] UnrealBloomPass instance.
   * @param {THREE.Mesh}             [refs.sky]       Sky dome (ShaderMaterial).
   * @param {(v:number)=>void}       [refs.setEnvironmentIntensity] IBL strength setter.
   * @param {object}                 [refs.materials] City materials (Pass 6/7: wet roads, snow cover).
   * @param {string}                 [refs.initial='sunny'] Preset applied instantly at startup.
   * @param {number}                 [refs.transitionDuration=1.25] Cross-fade seconds.
   */
  constructor({
    scene,
    renderer,
    sun,
    hemiLight,
    fillLight = null,
    focusLight = null,
    bloomPass = null,
    sky = null,
    setEnvironmentIntensity = null,
    materials = null,
    initial = 'sunny',
    transitionDuration = DEFAULT_TRANSITION,
  }) {
    this.scene = scene;
    this.renderer = renderer;
    this.sun = sun;
    this.hemiLight = hemiLight;
    this.fillLight = fillLight;
    this.focusLight = focusLight;
    this.bloomPass = bloomPass;
    this.sky = sky;
    this.skyUniforms = sky?.material?.uniforms ?? null;
    this.setEnvironmentIntensity = setEnvironmentIntensity;
    this.materials = materials;
    this.transitionDuration = transitionDuration;
    this._wetSurfaces = [
      wetSurface(materials?.groundMat, 0.3, 0.13, 1.2, 0.14),
      wetSurface(materials?.roadMat, 0.16, 0.18, 1.7, 0.22),
    ].filter(Boolean);

    this.presets = WEATHER_PRESETS;

    // Blend buffers. `from` is the snapshot taken when a switch starts,
    // `to` the destination preset, `current` the live blended values.
    this._from = createState();
    this._to = createState();
    this._current = createState();
    this._blend = 1; // 0 = at `from`, 1 = settled on `to`
    this._dirty = true;

    /**
     * Precipitation particle slots.
     *
     * Pass 6 assigns `rainSystem` and Pass 7 assigns `snowSystem` with an
     * object exposing at least `{ object3D, update(dt, elapsed, camera),
     * setIntensity(0..1), dispose() }`. They stay null until then; every hook
     * below is written to tolerate that.
     */
    this.rainSystem = null;
    this.snowSystem = null;

    const start = WEATHER_PRESETS[initial] ? initial : 'sunny';
    this.current = start;
    this.target = start;
    readPreset(this._to, WEATHER_PRESETS[start]);
    copyState(this._from, this._to);
    copyState(this._current, this._to);
    this.apply();
  }

  /** Names of the available presets, in UI order. */
  static get names() {
    return WEATHER_NAMES;
  }

  /**
   * Switch weather. The scene cross-fades over `transitionDuration` seconds
   * unless `instant` is set. Re-selecting the settled preset is a no-op.
   *
   * @param {'sunny'|'rain'|'snow'} name
   * @param {{instant?: boolean}} [opts]
   */
  setWeather(name, { instant = false } = {}) {
    const preset = WEATHER_PRESETS[name];
    if (!preset) {
      console.warn(`[weather] unknown preset "${name}"`);
      return false;
    }
    if (name === this.target && this._blend >= 1) return false;

    // Start from wherever the blend currently sits so rapid clicking never
    // snaps — it just re-aims the in-flight transition.
    copyState(this._from, this._current);
    readPreset(this._to, preset);
    this.target = name;
    this.current = name;
    this._blend = instant ? 1 : 0;
    if (instant) {
      copyState(this._current, this._to);
      this.apply();
    }
    this._dirty = true;
    this._syncPrecipitation();
    return true;
  }

  /** True while a cross-fade is still running. */
  get isTransitioning() {
    return this._blend < 1;
  }

  /** Live blended values (read-only view for Pass 6/7 and debug UI). */
  getState() {
    return this._current;
  }

  /** Normalized precipitation amount, 0..1, already eased by the cross-fade. */
  get precipitation() {
    return this._current.precipitation;
  }

  /** Normalized surface wetness, 0..1. Pass 6 uses this for wet asphalt. */
  get wetness() {
    return this._current.wetness;
  }

  /**
   * Per-frame tick. Advances the cross-fade, pushes the blended state into the
   * scene, then updates any precipitation systems.
   *
   * @param {number} dt      Seconds since the previous frame.
   * @param {number} elapsed Seconds since page load.
   * @param {THREE.Camera} camera Active camera (particles follow it).
   */
  update(dt, elapsed, camera) {
    if (this._blend < 1) {
      this._blend = Math.min(1, this._blend + dt / this.transitionDuration);
      lerpState(this._current, this._from, this._to, smoothstep(this._blend));
      this.apply();
    } else if (this._dirty) {
      this.apply();
    }

    this._updatePrecipitation(dt, elapsed, camera);
  }

  /** Push the blended state into the scene, renderer, lights and bloom. */
  apply() {
    const s = this._current;

    if (this.scene.fog) {
      this.scene.fog.color.copy(s.fogColor);
      if (this.scene.fog.isFogExp2) this.scene.fog.density = s.fogDensity;
    }
    if (this.scene.background?.isColor) {
      this.scene.background.copy(s.backgroundColor);
    }

    if (this.skyUniforms) {
      this.skyUniforms.uZenithColor.value.copy(s.skyZenith);
      this.skyUniforms.uMidColor.value.copy(s.skyMid);
      this.skyUniforms.uHorizonColor.value.copy(s.skyHorizon);
      this.skyUniforms.uSunsetGlowColor.value.copy(s.skyGlow);
      this.skyUniforms.uNadirColor.value.copy(s.skyNadir);
    }

    this.sun.color.copy(s.sunColor);
    this.sun.intensity = s.sunIntensity;

    this.hemiLight.color.copy(s.hemiSkyColor);
    this.hemiLight.groundColor.copy(s.hemiGroundColor);
    this.hemiLight.intensity = s.hemiIntensity;

    if (this.fillLight) {
      this.fillLight.color.copy(s.fillColor);
      this.fillLight.intensity = s.fillIntensity;
    }
    if (this.focusLight) {
      this.focusLight.color.copy(s.focusColor);
      this.focusLight.intensity = s.focusIntensity;
    }

    if (this.bloomPass) {
      this.bloomPass.strength = s.bloomStrength;
      this.bloomPass.radius = s.bloomRadius;
      this.bloomPass.threshold = s.bloomThreshold;
    }

    this.renderer.toneMappingExposure = s.exposure;
    this.setEnvironmentIntensity?.(s.environmentIntensity);
    this._applyWetness(s.wetness);

    this._dirty = false;
  }

  /**
   * Blend asphalt/ground material parameters from their original dry values.
   * The snapshots make returning to Sunny exact, including custom base colors.
   */
  _applyWetness(wetness) {
    const amount = THREE.MathUtils.clamp(wetness, 0, 1);
    for (const surface of this._wetSurfaces) {
      const { material } = surface;
      material.color.copy(surface.baseColor).multiplyScalar(1 - surface.darken * amount);
      material.roughness =
        surface.baseRoughness + (surface.wetRoughness - surface.baseRoughness) * amount;
      material.metalness =
        surface.baseMetalness + (surface.wetMetalness - surface.baseMetalness) * amount;
      material.envMapIntensity =
        surface.baseEnvironment + (surface.wetEnvironment - surface.baseEnvironment) * amount;
    }
  }

  // ---------------------------------------------------------------------
  // Precipitation hooks — intentionally inert in Pass 5.
  // ---------------------------------------------------------------------

  /**
   * Called when the target weather changes, before the cross-fade finishes.
   *
   * Pass 6 adds rain particles here: lazily build the rain system (a
   * THREE.Points / InstancedMesh of streaks parented to the camera rig), add
   * it to `this.scene`, and toggle `object3D.visible` based on
   * `this.target === 'rain'`.
   *
   * Pass 7 adds snow particles here: same shape, but for drifting flakes plus
   * whatever accumulation material tweaks it needs from `this.materials`.
   */
  _syncPrecipitation() {
    if (this.target === 'rain' && !this.rainSystem) {
      this.rainSystem = createRainSystem();
      this.scene.add(this.rainSystem.object3D);
    }
    // Pass 7: if (this.target === 'snow' && !this.snowSystem) this.snowSystem = createSnowSystem(...)
    this.rainSystem?.setIntensity?.(this.target === 'rain' ? 1 : 0);
    this.snowSystem?.setIntensity?.(this.target === 'snow' ? 1 : 0);
  }

  /**
   * Per-frame particle tick, driven from `update()`.
   *
   * Both calls are null-safe no-ops until Pass 6/7 populate the slots. Use the
   * already-blended `this.precipitation` (0..1) to fade particle opacity/count
   * in step with the atmospheric cross-fade instead of popping them on.
   */
  _updatePrecipitation(dt, elapsed, camera) {
    // Keep rain visible while Rain is fading in. When fading to Sunny, the
    // blended precipitation signal provides a smooth fade-out; Snow owns its
    // separate precipitation layer in Pass 7.
    const fadingToSunny =
      this.target !== 'rain' && this._to.precipitation === 0 && this._from.precipitation > 0;
    const rainIntensity = this.target === 'rain' || fadingToSunny ? this.precipitation : 0;
    this.rainSystem?.setIntensity?.(rainIntensity);
    this.rainSystem?.update?.(dt, elapsed, camera, this._current);

    // Pass 7 adds snow particles here (drifting flakes with wind sway plus
    // accumulation blending on roofs/ground).
    this.snowSystem?.update?.(dt, elapsed, camera, this._current);
  }

  /** Release any resources owned by the weather systems. */
  dispose() {
    for (const system of [this.rainSystem, this.snowSystem]) {
      if (!system) continue;
      if (system.object3D?.parent) system.object3D.parent.remove(system.object3D);
      system.dispose?.();
    }
    this.rainSystem = null;
    this.snowSystem = null;
  }
}

/** Convenience factory mirroring the rest of the codebase's `createX` style. */
export function createWeatherController(refs) {
  return new WeatherController(refs);
}
