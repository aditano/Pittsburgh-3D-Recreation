import * as THREE from 'three';

const RAIN_MAX = 9000;
const SNOW_MAX = 7000;
const VOLUME = { x: 420, y: 280, z: 420 };

function streakTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, 'rgba(236, 244, 255, 0)');
  g.addColorStop(0.2, 'rgba(236, 244, 255, 0.85)');
  g.addColorStop(1, 'rgba(236, 244, 255, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(5, 0, 6, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function flakeTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(16, 16, 1, 16, 16, 14);
  g.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
  g.addColorStop(0.45, 'rgba(240, 246, 255, 0.55)');
  g.addColorStop(1, 'rgba(240, 246, 255, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function fillCloud(count, spread, speeds, pos, vel) {
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * spread.x;
    pos[i * 3 + 1] = (Math.random() - 0.5) * spread.y;
    pos[i * 3 + 2] = (Math.random() - 0.5) * spread.z;
    vel[i] = speeds.min + Math.random() * (speeds.max - speeds.min);
  }
}

/**
 * Camera-centred precipitation. The city is 15 km across, so a world-filling
 * particle field is wasted; a box that rides with the camera is enough to fill
 * the view at any heading.
 */
export function createWeatherFX() {
  const root = new THREE.Group();
  root.name = 'weather';
  root.frustumCulled = false;

  const rainPos = new Float32Array(RAIN_MAX * 3);
  const rainVel = new Float32Array(RAIN_MAX);
  fillCloud(RAIN_MAX, VOLUME, { min: 38, max: 72 }, rainPos, rainVel);
  const rainGeom = new THREE.BufferGeometry();
  rainGeom.setAttribute('position', new THREE.BufferAttribute(rainPos, 3).setUsage(THREE.DynamicDrawUsage));
  rainGeom.setDrawRange(0, 0);
  const rain = new THREE.Points(
    rainGeom,
    new THREE.PointsMaterial({
      map: streakTexture(),
      color: 0xeef4fb,
      size: 42,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  rain.frustumCulled = false;
  rain.renderOrder = 20;
  rain.visible = false;
  root.add(rain);

  const snowPos = new Float32Array(SNOW_MAX * 3);
  const snowVel = new Float32Array(SNOW_MAX);
  fillCloud(SNOW_MAX, VOLUME, { min: 7, max: 16 }, snowPos, snowVel);
  const snowGeom = new THREE.BufferGeometry();
  snowGeom.setAttribute('position', new THREE.BufferAttribute(snowPos, 3).setUsage(THREE.DynamicDrawUsage));
  snowGeom.setDrawRange(0, 0);
  const snow = new THREE.Points(
    snowGeom,
    new THREE.PointsMaterial({
      map: flakeTexture(),
      color: 0xf7f9fd,
      size: 7.5,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    }),
  );
  snow.frustumCulled = false;
  snow.renderOrder = 20;
  snow.visible = false;
  root.add(snow);

  let kind = 'sunny';
  let particleScale = 1;
  let rainN = 0;
  let snowN = 0;

  function applyCounts() {
    rainN = kind === 'rain' ? Math.max(0, Math.floor(RAIN_MAX * particleScale)) : 0;
    snowN = kind === 'snow' ? Math.max(0, Math.floor(SNOW_MAX * particleScale)) : 0;
    rainGeom.setDrawRange(0, rainN);
    snowGeom.setDrawRange(0, snowN);
    rain.visible = rainN > 0;
    snow.visible = snowN > 0;
  }

  return {
    root,
    setWeather(next) {
      kind = next;
      applyCounts();
    },
    setParticleScale(scale) {
      particleScale = scale;
      applyCounts();
    },
    update(dt, camera, now) {
      if (kind === 'sunny') return;
      root.position.copy(camera.position);
      const hx = VOLUME.x * 0.5;
      const hy = VOLUME.y * 0.5;
      const hz = VOLUME.z * 0.5;

      if (kind === 'rain') {
        for (let i = 0; i < rainN; i++) {
          const o = i * 3;
          rainPos[o + 1] -= rainVel[i] * dt;
          rainPos[o] -= 12 * dt;
          if (rainPos[o + 1] < -hy) {
            rainPos[o + 1] += VOLUME.y;
            rainPos[o] = (Math.random() - 0.5) * VOLUME.x;
            rainPos[o + 2] = (Math.random() - 0.5) * VOLUME.z;
          }
          if (rainPos[o] < -hx) rainPos[o] += VOLUME.x;
        }
        rainGeom.attributes.position.needsUpdate = true;
      } else if (kind === 'snow') {
        const t = now * 0.001;
        for (let i = 0; i < snowN; i++) {
          const o = i * 3;
          snowPos[o + 1] -= snowVel[i] * dt;
          snowPos[o] += Math.sin(t * 0.7 + i * 0.37) * 6.5 * dt;
          snowPos[o + 2] += Math.cos(t * 0.55 + i * 0.21) * 4.5 * dt;
          if (snowPos[o + 1] < -hy) {
            snowPos[o + 1] += VOLUME.y;
            snowPos[o] = (Math.random() - 0.5) * VOLUME.x;
            snowPos[o + 2] = (Math.random() - 0.5) * VOLUME.z;
          }
          if (snowPos[o] > hx) snowPos[o] -= VOLUME.x;
          if (snowPos[o] < -hx) snowPos[o] += VOLUME.x;
          if (snowPos[o + 2] > hz) snowPos[o + 2] -= VOLUME.z;
          if (snowPos[o + 2] < -hz) snowPos[o + 2] += VOLUME.z;
        }
        snowGeom.attributes.position.needsUpdate = true;
      }
    },
  };
}

const WEATHER_LOOK = {
  sunny: {
    horizon: 0xb8d4f0,
    zenith: 0x4a90d9,
    glow: 0xfff4d8,
    city: 0xe8f0f8,
    fog: 0x9dbcd8,
    fogDensity: 0.00009,
    clear: 0x8ec8f0,
    sun: 2.9,
    sunColor: 0xfff6e8,
    hemi: 0.4,
    fill: 0.16,
    exposure: 1.0,
    env: 0.42,
    flow: 1.0,
    precip: 0,
  },
  rain: {
    horizon: 0x8aa0b4,
    zenith: 0x4a5c70,
    glow: 0x6a7a88,
    city: 0x6e7c88,
    fog: 0x7a8a98,
    fogDensity: 0.00016,
    clear: 0x6e8294,
    sun: 0.55,
    sunColor: 0xc8d0d8,
    hemi: 0.52,
    fill: 0.22,
    exposure: 0.92,
    env: 0.22,
    flow: 1.35,
    precip: 1,
  },
  snow: {
    horizon: 0xd8e2ec,
    zenith: 0xa8b8c8,
    glow: 0xe8eef4,
    city: 0xd0d8e0,
    fog: 0xc8d2dc,
    fogDensity: 0.00014,
    clear: 0xc5d0da,
    sun: 1.15,
    sunColor: 0xe8eef6,
    hemi: 0.58,
    fill: 0.2,
    exposure: 1.04,
    env: 0.28,
    flow: 0.72,
    precip: 2,
  },
};

export function applyWeatherLook(kind, ctx) {
  const look = WEATHER_LOOK[kind] || WEATHER_LOOK.sunny;
  const { sky, scene, sun, hemi, fill, renderer, waterUniforms } = ctx;
  sky.material.uniforms.uHorizon.value.setHex(look.horizon);
  sky.material.uniforms.uZenith.value.setHex(look.zenith);
  sky.material.uniforms.uGlow.value.setHex(look.glow);
  sky.material.uniforms.uCityGlow.value.setHex(look.city);
  scene.fog.color.setHex(look.fog);
  scene.fog.density = look.fogDensity;
  scene.background.setHex(look.clear);
  renderer.setClearColor(look.clear, 1);
  sun.intensity = look.sun;
  sun.color.setHex(look.sunColor);
  hemi.intensity = look.hemi;
  fill.intensity = look.fill;
  renderer.toneMappingExposure = look.exposure;
  scene.environmentIntensity = look.env;
  waterUniforms.uFlow.value = look.flow;
  waterUniforms.uPrecip.value = look.precip;
}
