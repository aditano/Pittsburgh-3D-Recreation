import * as THREE from 'three';

const MAX_FLAKES = 16000;
const VOLUME_WIDTH = 1200;
const VOLUME_DEPTH = 1200;
const VOLUME_HEIGHT = 500;
const VOLUME_BOTTOM = -250;
const WIND_X = -7;
const WIND_Z = 3.5;
const BASE_SIZE = 20;

function rng(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function wrap(value, halfExtent) {
  const size = halfExtent * 2;
  return ((value + halfExtent) % size + size) % size - halfExtent;
}

/** Soft round flake: white core, cool fringe, transparent edge. */
function createFlakeTexture(resolution = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = resolution;
  canvas.height = resolution;
  const ctx = canvas.getContext('2d');
  const mid = resolution * 0.5;
  const gradient = ctx.createRadialGradient(mid, mid, 0, mid, mid, mid);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
  gradient.addColorStop(0.28, 'rgba(236, 244, 255, 0.62)');
  gradient.addColorStop(0.62, 'rgba(220, 232, 248, 0.18)');
  gradient.addColorStop(1, 'rgba(210, 224, 240, 0)');
  ctx.clearRect(0, 0, resolution, resolution);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, resolution, resolution);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Camera-following snow made from a single, fixed Points buffer.
 *
 * Positions are local to object3D, which tracks the active camera each tick.
 * Only the visible prefix is drawn, so a light flurry updates and submits
 * fewer flakes without reallocating any buffers.
 */
export class SnowSystem {
  constructor({ maxFlakes = MAX_FLAKES, seed = 0xa7e4 } = {}) {
    this.maxFlakes = Math.min(MAX_FLAKES, Math.max(1, Math.floor(maxFlakes)));
    this.intensity = 0;
    this.activeCount = 0;

    const random = rng(seed);
    this.x = new Float32Array(this.maxFlakes);
    this.y = new Float32Array(this.maxFlakes);
    this.z = new Float32Array(this.maxFlakes);
    this.speed = new Float32Array(this.maxFlakes);
    this.amp = new Float32Array(this.maxFlakes);
    this.freqX = new Float32Array(this.maxFlakes);
    this.freqZ = new Float32Array(this.maxFlakes);
    this.phase = new Float32Array(this.maxFlakes);

    const positions = new Float32Array(this.maxFlakes * 3);
    const sizes = new Float32Array(this.maxFlakes);
    for (let i = 0; i < this.maxFlakes; i++) {
      this.x[i] = (random() - 0.5) * VOLUME_WIDTH;
      this.y[i] = VOLUME_BOTTOM + random() * VOLUME_HEIGHT;
      this.z[i] = (random() - 0.5) * VOLUME_DEPTH;
      this.speed[i] = 12 + random() * 18;
      this.amp[i] = 5 + random() * 9;
      this.freqX[i] = 0.28 + random() * 0.55;
      this.freqZ[i] = 0.22 + random() * 0.48;
      this.phase[i] = random() * Math.PI * 2;
      sizes[i] = 0.42 + random() * 1.25;
      this.writeFlake(positions, i, 0);
    }

    this.geometry = new THREE.BufferGeometry();
    this.positionAttribute = new THREE.BufferAttribute(positions, 3);
    this.positionAttribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.positionAttribute);
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    this.geometry.setDrawRange(0, 0);

    this.texture = createFlakeTexture();
    this.material = new THREE.PointsMaterial({
      map: this.texture,
      color: 0xe8f2ff,
      size: BASE_SIZE,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.NormalBlending,
      fog: true,
    });
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <begin_vertex>',
          'attribute float aSize;\n\t#include <begin_vertex>',
        )
        .replace('gl_PointSize = size;', 'gl_PointSize = size * aSize;');
    };

    this.object3D = new THREE.Points(this.geometry, this.material);
    this.object3D.name = 'SnowParticles';
    this.object3D.frustumCulled = false;
    this.object3D.renderOrder = 3;
    this.object3D.visible = false;
  }

  writeFlake(positions, index, elapsed) {
    const offset = index * 3;
    const swayX = Math.sin(elapsed * this.freqX[index] + this.phase[index]) * this.amp[index];
    const swayZ =
      Math.cos(elapsed * this.freqZ[index] + this.phase[index] * 1.37) * this.amp[index] * 0.72;
    positions[offset] = this.x[index] + swayX;
    positions[offset + 1] = this.y[index];
    positions[offset + 2] = this.z[index] + swayZ;
  }

  setIntensity(value) {
    const next = THREE.MathUtils.clamp(Number.isFinite(value) ? value : 0, 0, 1);
    this.intensity = next;
    this.activeCount = Math.floor(this.maxFlakes * next);
    this.geometry.setDrawRange(0, this.activeCount);
    this.material.opacity = 0.78 * Math.min(1, next * 1.3);
    this.object3D.visible = next > 0.001 && this.activeCount > 0;
  }

  update(dt, elapsed, camera) {
    if (!this.object3D.visible || !camera) return;

    this.object3D.position.copy(camera.position);

    const positions = this.positionAttribute.array;
    const time = Number.isFinite(elapsed) ? elapsed : 0;
    const count = this.activeCount;
    for (let i = 0; i < count; i++) {
      this.x[i] = wrap(this.x[i] + WIND_X * dt, VOLUME_WIDTH * 0.5);
      this.z[i] = wrap(this.z[i] + WIND_Z * dt, VOLUME_DEPTH * 0.5);
      this.y[i] -= this.speed[i] * dt;

      if (this.y[i] < VOLUME_BOTTOM) {
        this.y[i] += VOLUME_HEIGHT;
      }
      this.writeFlake(positions, i, time);
    }
    this.positionAttribute.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

export function createSnowSystem(options) {
  return new SnowSystem(options);
}
