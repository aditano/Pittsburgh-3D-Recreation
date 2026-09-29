import * as THREE from 'three';

/**
 * One planar reflection shared by every river polygon.
 *
 * Ultra renders it at the drawing-buffer resolution (capped just above 1440p)
 * on every frame. High and Medium step the resolution and the refresh rate
 * down; Low leaves the analytic sky reflection in place.
 *
 * The color target is half-float when the backend can actually render one, and
 * unsigned-byte otherwise. Multisampling is only attached to the byte target:
 * a half-float multisampled buffer is a known ANGLE failure and comes back as
 * a black rectangle. When there is no MSAA, the water shader blurs a 3x3
 * neighbourhood instead, which is the same job at a much lower risk.
 */

const _viewport = new THREE.Vector4();
const _clear = new THREE.Color();

function halfFloatRenders(renderer) {
  const gl = renderer.getContext();
  if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
    return false;
  }
  const probe = new THREE.WebGLRenderTarget(4, 4, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
  });
  const previous = renderer.getRenderTarget();
  const alpha = renderer.getClearAlpha();
  renderer.getClearColor(_clear);
  let ok = false;
  try {
    gl.getError();
    renderer.setRenderTarget(probe);
    renderer.setClearColor(0x336699, 1);
    renderer.clear();
    const pixel = new Uint8Array(4);
    renderer.readRenderTargetPixels(probe, 0, 0, 1, 1, pixel);
    const error = gl.getError();
    ok = error === gl.NO_ERROR && pixel[2] > 16;
  } catch {
    ok = false;
  } finally {
    renderer.setRenderTarget(previous);
    renderer.setClearColor(_clear, alpha);
    probe.dispose();
    gl.getError();
  }
  return ok;
}

function maxSamples(renderer) {
  const gl = renderer.getContext();
  if (!gl.MAX_SAMPLES) return 0;
  return gl.getParameter(gl.MAX_SAMPLES) || 0;
}

function targetExtent(renderer, quality) {
  const gl = renderer.getContext();
  let width = gl.drawingBufferWidth || renderer.domElement.width || 16;
  let height = gl.drawingBufferHeight || renderer.domElement.height || 16;
  const scale = quality.reflectionScale || 1;
  width = Math.max(16, Math.round(width * scale));
  height = Math.max(16, Math.round(height * scale));
  const cap = quality.reflectionCap || 2560;
  const longest = Math.max(width, height);
  if (longest > cap) {
    const fit = cap / longest;
    width = Math.max(16, Math.round(width * fit));
    height = Math.max(16, Math.round(height * fit));
  }
  return { width, height };
}

export function createRiverReflections(renderer, scene, camera, uniforms, waterMaterial, excluded) {
  const mirror = new THREE.Object3D();
  mirror.rotation.x = -Math.PI / 2;
  mirror.position.y = 0.3;
  mirror.updateMatrixWorld(true);
  const inverse = mirror.matrixWorld.clone().invert();

  const virtualCamera = new THREE.PerspectiveCamera();
  const reflectorPlane = new THREE.Plane();
  const normal = new THREE.Vector3();
  const reflectorWorldPosition = new THREE.Vector3();
  const cameraWorldPosition = new THREE.Vector3();
  const rotationMatrix = new THREE.Matrix4();
  const lookAtPosition = new THREE.Vector3();
  const clipPlane = new THREE.Vector4();
  const view = new THREE.Vector3();
  const target = new THREE.Vector3();
  const q = new THREE.Vector4();
  const textureMatrix = new THREE.Matrix4();

  let renderTarget = null;
  let targetKey = '';
  let useHalfFloat = null;
  let elapsed = 0;
  const hidden = [];
  scene.traverse((object) => {
    if (object.material === waterMaterial) hidden.push(object);
  });

  function ensureTarget(quality) {
    if (useHalfFloat === null) useHalfFloat = halfFloatRenders(renderer);
    const { width, height } = targetExtent(renderer, quality);
    const wantedSamples = useHalfFloat ? 0 : Math.min(quality.reflectionSamples || 0, maxSamples(renderer));
    const samples = wantedSamples >= 2 ? wantedSamples : 0;
    const type = useHalfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const key = `${width}x${height}:${samples}:${type}`;
    if (key === targetKey && renderTarget) return { samples };
    renderTarget?.dispose();
    renderTarget = new THREE.WebGLRenderTarget(width, height, {
      type,
      samples,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
    });
    // Linear values. The capture is made with tone mapping off so the water
    // shader can treat the sample as radiance and the frame maps it once.
    renderTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;
    uniforms.uReflection.value = renderTarget.texture;
    if (uniforms.uReflectionTexel) uniforms.uReflectionTexel.value.set(1 / width, 1 / height);
    targetKey = key;
    return { samples };
  }

  function capture() {
    reflectorWorldPosition.setFromMatrixPosition(mirror.matrixWorld);
    cameraWorldPosition.setFromMatrixPosition(camera.matrixWorld);
    rotationMatrix.extractRotation(mirror.matrixWorld);
    normal.set(0, 0, 1).applyMatrix4(rotationMatrix);
    view.subVectors(reflectorWorldPosition, cameraWorldPosition);
    if (view.dot(normal) > 0) return;

    view.reflect(normal).negate();
    view.add(reflectorWorldPosition);
    rotationMatrix.extractRotation(camera.matrixWorld);
    lookAtPosition.set(0, 0, -1).applyMatrix4(rotationMatrix).add(cameraWorldPosition);
    target.subVectors(reflectorWorldPosition, lookAtPosition);
    target.reflect(normal).negate();
    target.add(reflectorWorldPosition);

    virtualCamera.position.copy(view);
    virtualCamera.up.set(0, 1, 0).applyMatrix4(rotationMatrix);
    virtualCamera.up.reflect(normal);
    virtualCamera.lookAt(target);
    virtualCamera.far = camera.far;
    virtualCamera.updateMatrixWorld();
    virtualCamera.projectionMatrix.copy(camera.projectionMatrix);

    textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    textureMatrix.multiply(virtualCamera.projectionMatrix);
    textureMatrix.multiply(virtualCamera.matrixWorldInverse);
    textureMatrix.multiply(mirror.matrixWorld);

    reflectorPlane.setFromNormalAndCoplanarPoint(normal, reflectorWorldPosition);
    reflectorPlane.applyMatrix4(virtualCamera.matrixWorldInverse);
    clipPlane.set(reflectorPlane.normal.x, reflectorPlane.normal.y, reflectorPlane.normal.z, reflectorPlane.constant);
    const projectionMatrix = virtualCamera.projectionMatrix;
    q.x = (Math.sign(clipPlane.x) + projectionMatrix.elements[8]) / projectionMatrix.elements[0];
    q.y = (Math.sign(clipPlane.y) + projectionMatrix.elements[9]) / projectionMatrix.elements[5];
    q.z = -1;
    q.w = (1 + projectionMatrix.elements[10]) / projectionMatrix.elements[14];
    clipPlane.multiplyScalar(2 / clipPlane.dot(q));
    projectionMatrix.elements[2] = clipPlane.x;
    projectionMatrix.elements[6] = clipPlane.y;
    projectionMatrix.elements[10] = clipPlane.z + 1 - 0.003;
    projectionMatrix.elements[14] = clipPlane.w;

    const objects = [...hidden, ...excluded.filter(Boolean)];
    const visibility = objects.map((object) => object.visible);
    objects.forEach((object) => {
      object.visible = false;
    });
    const tone = renderer.toneMapping;
    const previousTarget = renderer.getRenderTarget();
    renderer.getViewport(_viewport);
    const xr = renderer.xr.enabled;
    const shadows = renderer.shadowMap.autoUpdate;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.xr.enabled = false;
    renderer.shadowMap.autoUpdate = false;
    try {
      renderer.setRenderTarget(renderTarget);
      renderer.clear();
      renderer.render(scene, virtualCamera);
      uniforms.uReflectionMatrix.value.copy(textureMatrix).multiply(inverse);
    } finally {
      renderer.toneMapping = tone;
      renderer.xr.enabled = xr;
      renderer.shadowMap.autoUpdate = shadows;
      renderer.setRenderTarget(previousTarget);
      renderer.setViewport(_viewport);
      objects.forEach((object, index) => {
        object.visible = visibility[index];
      });
    }
  }

  return {
    update(dt, enabled, quality) {
      uniforms.uReflectionMix.value = enabled ? 1 : 0;
      if (!enabled || !quality) return;
      const { samples } = ensureTarget(quality);
      const blur = samples >= 2 ? 0 : quality.reflectionScale >= 0.9 ? 0.75 : 1.2;
      if (uniforms.uReflectionBlur) uniforms.uReflectionBlur.value = blur;
      const hz = quality.reflectionHz || 0;
      if (hz > 0) {
        elapsed += dt;
        if (elapsed < 1 / hz) return;
        elapsed = 0;
      }
      camera.updateMatrixWorld();
      capture();
    },
    dispose() {
      renderTarget?.dispose();
      renderTarget = null;
    },
  };
}
