/**
 * One place for the rules that decide whether an OSM height may replace a
 * dataset height, shared by the audit and the repair so they cannot disagree
 * about what "wrong" means.
 *
 * The asymmetry encoded here is the whole point. An explicit `height` tag is a
 * measurement. A `building:levels` count is an estimate, and estimates are
 * systematically LOW on exactly the buildings that matter most: the tag counts
 * occupiable floors and knows nothing about a gothic crown, a ziggurat or a
 * mechanical penthouse. Letting one lower an authored landmark height is how a
 * skyline gets flattened.
 */

/** Metres per floor plus a parapet, for turning a storey count into a height. */
const FLOOR_H = 3.6;
const PARAPET = 1.2;

/** `{ h, source, exact }` from OSM tags, or null when the tags are silent. */
export function heightFromTags(tags = {}) {
  const raw = tags.height ?? tags['building:height'];
  if (raw != null) {
    const m = /([\d.]+)\s*(m|ft|')?/i.exec(String(raw));
    if (m) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v) && v > 2) {
        const feet = /ft|'/i.test(m[2] || '');
        return { h: feet ? v * 0.3048 : v, source: feet ? 'height tag, ft' : 'height tag', exact: true };
      }
    }
  }
  const lv = parseFloat(tags['building:levels']);
  if (Number.isFinite(lv) && lv >= 1) {
    return { h: lv * FLOOR_H + PARAPET, source: `${lv} levels`, exact: false };
  }
  return null;
}

/**
 * Narrowest width of a footprint, by rotating calipers over its own edges.
 * Used to reject heights that would stand a needle on a shed.
 */
export function narrowestExtent(ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const dx = ring[i + 1][0] - ring[i][0];
    const dz = ring[i + 1][1] - ring[i][1];
    const len = Math.hypot(dx, dz);
    if (len < 1) continue;
    const ux = dx / len;
    const uz = dz / len;
    let lo = Infinity;
    let hi = -Infinity;
    for (const [x, z] of ring) {
      const t = -x * uz + z * ux;
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    if (hi - lo < best) best = hi - lo;
  }
  return Number.isFinite(best) ? best : 0;
}

/** Above this ratio of height to narrowest width the result is not a building. */
const MAX_SLENDERNESS = 6;

/**
 * The height the original build handed to every footprint it could not measure.
 * It is a placeholder, not a decision, so unlike an authored height it carries
 * no authority and an OSM storey count is free to lower it: a two-storey
 * rowhouse is better at 8.4 m than at a made-up 14 m.
 */
const BUILD_DEFAULT_H = 14;

/** Whether `b.h` was chosen for this building rather than defaulted into it. */
const isAuthored = (b) =>
  Boolean(b.landmarkMesh || b.landmark || b.roof || b.style) || b.h !== BUILD_DEFAULT_H;

/**
 * Whether an OSM height should replace `b.h`, and why.
 * `hasCitation` means a published figure already governs this building.
 */
export function plausible(b, tag, hasCitation) {
  if (hasCitation) return { apply: false, why: 'a published figure governs this one' };
  if (b.landmarkMesh) return { apply: false, why: 'bespoke mesh, authored height' };
  if (!tag.exact && tag.h <= (b.h ?? 0) && isAuthored(b)) {
    return { apply: false, why: 'a levels estimate may not lower an authored height' };
  }
  if ((b.landmark || b.roof) && tag.h < (b.h ?? 0)) {
    return { apply: false, why: 'authored crown stands above the OSM roof' };
  }
  const narrow = narrowestExtent(b.f);
  if (tag.h > 25 && narrow > 0 && tag.h > narrow * MAX_SLENDERNESS) {
    return { apply: false, why: `too slender: ${tag.h.toFixed(0)}m on a ${narrow.toFixed(0)}m width` };
  }
  return { apply: true, why: tag.exact ? 'measured tag' : 'levels raise it' };
}
