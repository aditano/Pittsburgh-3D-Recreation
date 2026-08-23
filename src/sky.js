import * as THREE from 'three';

export function createSkyDome({ day = true } = {}) {
  const geo = new THREE.SphereGeometry(12000, 48, 32);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0.55, 0.42, 0.22).normalize() },
      uHorizon: { value: new THREE.Color(day ? 0xb8d4f0 : 0x1a2838) },
      uZenith: { value: new THREE.Color(day ? 0x4a90d9 : 0x050810) },
      uGlow: { value: new THREE.Color(day ? 0xfff4d8 : 0x2a3a4a) },
      uCityGlow: { value: new THREE.Color(day ? 0xe8f0f8 : 0x3a2a18) },
      uDay: { value: day ? 1.0 : 0.0 },
    },
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform vec3 uSunDir;
      uniform vec3 uHorizon;
      uniform vec3 uZenith;
      uniform vec3 uGlow;
      uniform vec3 uCityGlow;
      uniform float uDay;
      varying vec3 vWorldPos;
      void main() {
        vec3 dir = normalize(vWorldPos);
        float h = dir.y * 0.5 + 0.5;
        vec3 col = mix(uHorizon, uZenith, pow(h, mix(0.65, 0.85, uDay)));
        float sun = pow(max(dot(dir, uSunDir), 0.0), mix(64.0, 128.0, uDay));
        col += uGlow * sun * mix(0.35, 0.65, uDay);
        float city = smoothstep(0.0, 0.22, 0.22 - dir.y) * smoothstep(0.0, 0.5, dir.y + 0.08);
        col += uCityGlow * city * mix(0.18, 0.06, uDay);
        float stars = step(0.997, fract(sin(dot(floor(dir.xz * 800.0), vec2(12.9898, 78.233))) * 43758.5453));
        col += vec3(0.85, 0.9, 1.0) * stars * smoothstep(0.35, 0.85, h) * (1.0 - uDay);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

export function createEnvironmentMap(renderer, { day = true } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  if (day) {
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#6ab0e8');
    g.addColorStop(0.35, '#a8d4f8');
    g.addColorStop(0.52, '#e8f0f8');
    g.addColorStop(0.58, '#d8e8f4');
    g.addColorStop(1, '#8ab8e0');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 256);
    ctx.fillStyle = 'rgba(255,240,200,0.55)';
    ctx.beginPath();
    ctx.arc(400, 72, 36, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#060810');
    g.addColorStop(0.35, '#0c1420');
    g.addColorStop(0.48, '#1a2838');
    g.addColorStop(0.52, '#2a2218');
    g.addColorStop(0.58, '#141a22');
    g.addColorStop(1, '#080a10');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 256);
    for (let i = 0; i < 120; i++) {
      const x = 80 + Math.random() * 360;
      const y = 118 + Math.random() * 18;
      const w = 4 + Math.random() * 28;
      ctx.fillStyle = `rgba(255,200,140,${0.04 + Math.random() * 0.1})`;
      ctx.fillRect(x, y, w, 1 + Math.random() * 2);
    }
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = `rgba(255,255,255,${0.15 + Math.random() * 0.5})`;
      ctx.fillRect(Math.random() * 512, Math.random() * 90, 1, 1);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** @deprecated use createEnvironmentMap */
export function createCityGlow(renderer) {
  return createEnvironmentMap(renderer, { day: false });
}
