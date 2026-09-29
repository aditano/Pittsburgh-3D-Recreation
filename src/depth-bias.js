/**
 * City-scale ground, roads, parks and water used to separate coplanar layers
 * with polygonOffset. OpenGL's offset is `factor * slope + units * resolution`,
 * and the units are tiny. D3D11 (what ANGLE uses in Edge and Chrome on Windows)
 * implements the same call as
 *
 *   Bias = DepthBias * r + SlopeScaledDepthBias * MaxDepthSlope
 *
 * with no clamp. A factor of -1 on a polygon the size of the Acrisure footprint,
 * seen from across the river, produces a slope so large that the polygon is
 * pulled up to the near plane and drawn over the bowl. It shimmers because the
 * slope changes with the camera. Native GL, Metal and SwiftShader never build
 * an offset that big, which is why the same view is fine there.
 *
 * A bias in clip space is applied before ANGLE's GL-to-D3D viewport transform,
 * so the same epsilon means the same thing on every backend. The magnitudes
 * below are about a metre at a kilometre of range: enough to stop coplanar
 * flicker, not enough to cover a building.
 */

export function useClipDepthBias(material, bias) {
  material.polygonOffset = false;
  material.polygonOffsetFactor = 0;
  material.polygonOffsetUnits = 0;
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  const token = Number(bias).toExponential(2);
  material.onBeforeCompile = (shader, renderer) => {
    previous?.(shader, renderer);
    const needle = '#include <project_vertex>';
    if (!shader.vertexShader.includes(needle)) return;
    shader.vertexShader = shader.vertexShader.replace(
      needle,
      `${needle}\n\tgl_Position.z += (${token}) * gl_Position.w;`,
    );
  };
  material.customProgramCacheKey = function cacheKey() {
    const base = previousKey ? previousKey.call(this) : '';
    return `${base}|clip-bias-${token}`;
  };
}
