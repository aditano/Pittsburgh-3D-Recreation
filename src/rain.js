import * as THREE from 'three';

const MAX_DROPS = 10000;
const VOLUME_WIDTH = 1100;
const VOLUME_DEPTH = 1100;
const VOLUME_HEIGHT = 520;
const VOLUME_BOTTOM = -260;
const WIND_X = -20;
const WIND_Z = 9;

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

/**
 * Camera-following rain made from a single, fixed LineSegments buffer.
 *
 * The positions are local to object3D, which is moved to the active camera on
 * each tick. Only the currently visible prefix is drawn, so a low intensity
 * storm updates and submits fewer drops without reallocating any buffers.
 */
export class RainSystem {
  constructor({ maxDrops = MAX_DROPS, seed = 0x5eed } = {}) {
    this.maxDrops = Math.min(MAX_DROPS, Math.max(1, Math.floor(maxDrops)));
    this.intensity = 0;
    this.activeCount = 0;

    const random = rng(seed);
    this.x = new Float32Array(this.maxDrops);
    this.y = new Float32Array(this.maxDrops);
    this.z = new Float32Array(this.maxDrops);
    this.speed = new Float32Array(this.maxDrops);
    this.length = new Float32Array(this.maxDrops);

    const positions = new Float32Array(this.maxDrops * 2 * 3);
    for (let i = 0; i < this.maxDrops; i++) {
      this.x[i] = (random() - 0.5) * VOLUME_WIDTH;
      this.y[i] = VOLUME_BOTTOM + random() * VOLUME_HEIGHT;
      this.z[i] = (random() - 0.5) * VOLUME_DEPTH;
      this.speed[i] = 220 + random() * 140;
      this.length[i] = 9 + random() * 13;
      this.writeDrop(positions, i);
    }

    this.geometry = new THREE.BufferGeometry();
    this.positionAttribute = new THREE.BufferAttribute(positions, 3);
    this.positionAttribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.positionAttribute);
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.LineBasicMaterial({
      color: 0x9fc9e5,
      transparent: true,
      opacity: 0.34,
      blending: THREE.NormalBlending,
      depthWrite: false,
      fog: true,
    });

    this.object3D = new THREE.LineSegments(this.geometry, this.material);
    this.object3D.name = 'RainParticles';
    this.object3D.frustumCulled = false;
    this.object3D.renderOrder = 2;
    this.object3D.visible = false;
  }

  writeDrop(positions, index) {
    const top = index * 6;
    const x = this.x[index];
    const y = this.y[index];
    const z = this.z[index];
    const length = this.length[index];
    const windTime = length / this.speed[index];
    const bottom = top + 3;

    positions[top] = x;
    positions[top + 1] = y;
    positions[top + 2] = z;
    positions[bottom] = x - WIND_X * windTime;
    positions[bottom + 1] = y - length;
    positions[bottom + 2] = z - WIND_Z * windTime;
  }

  setIntensity(value) {
    const next = THREE.MathUtils.clamp(Number.isFinite(value) ? value : 0, 0, 1);
    this.intensity = next;
    this.activeCount = Math.floor(this.maxDrops * next);
    this.geometry.setDrawRange(0, this.activeCount * 2);
    this.material.opacity = 0.34 * Math.min(1, next * 1.35);
    this.object3D.visible = next > 0.001 && this.activeCount > 0;
  }

  update(dt, _elapsed, camera) {
    if (!this.object3D.visible || !camera) return;

    this.object3D.position.copy(camera.position);

    const positions = this.positionAttribute.array;
    const count = this.activeCount;
    for (let i = 0; i < count; i++) {
      this.x[i] = wrap(this.x[i] + WIND_X * dt, VOLUME_WIDTH * 0.5);
      this.z[i] = wrap(this.z[i] + WIND_Z * dt, VOLUME_DEPTH * 0.5);
      this.y[i] -= this.speed[i] * dt;

      if (this.y[i] < VOLUME_BOTTOM - this.length[i]) {
        this.y[i] += VOLUME_HEIGHT;
      }
      this.writeDrop(positions, i);
    }
    this.positionAttribute.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

export function createRainSystem(options) {
  return new RainSystem(options);
}
