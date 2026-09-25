/**
 * Release GPU resources owned by the postprocessing chain.
 *
 * three r170 EffectComposer.dispose() frees its ping-pong targets and the
 * internal copy pass, but not passes added with addPass. UnrealBloomPass owns
 * a mip chain of half-float targets, and its own dispose() leaves the
 * luminosity high-pass material allocated.
 */
export function disposePass(pass) {
  if (!pass) return;
  const highPass = pass.materialHighPassFilter ?? null;
  if (typeof pass.dispose === 'function') pass.dispose();
  if (highPass && typeof highPass.dispose === 'function') highPass.dispose();
}

export function disposeComposerResources(composer) {
  if (!composer) return;
  for (const pass of composer.passes ?? []) disposePass(pass);
  if (typeof composer.dispose === 'function') composer.dispose();
}
