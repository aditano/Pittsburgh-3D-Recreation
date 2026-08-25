/**
 * Read the rendering side's hard-coded tables as data.
 *
 * src/architecture.js and src/landmarks.js belong to the rendering side and are
 * not ours to change, but they hard-code positions that only work while they
 * agree with the footprints in the dataset we do own. Parsing the tables keeps
 * the audit honest; a copy maintained here would drift silently.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './osm.mjs';

/** Balanced-bracket slice of an array literal, so nested arrays survive. */
function arrayLiteral(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) return null;
  const open = src.indexOf('[', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']' && !--depth) return src.slice(open, i + 1);
  }
  return null;
}

function evalTable(file, marker) {
  const body = arrayLiteral(readFileSync(join(ROOT, file), 'utf8'), marker);
  if (!body) return [];
  return Function(`"use strict";return (${body.replace(/\/\/[^\n]*/g, '')});`)();
}

/** `{ n, at: [x, z], r, h, ... }` — the bespoke crowns and their anchors. */
export const readRendererLandmarks = () => evalTable('src/architecture.js', 'const LANDMARKS = [');

/** `{ n, lower: [x, z], upper: [x, z], ... }` — the two funiculars. */
export const readInclines = () => evalTable('src/landmarks.js', 'const INCLINES = [');

/**
 * Whether a footprint would claim a landmark anchor, mirroring
 * src/architecture.js landmarkFor(): the anchor must lie inside the ring AND
 * within `r` of the ring's area centroid. Failing either one drops the crown
 * and renders the landmark as generic stock, which on screen is
 * indistinguishable from the building being in the wrong place.
 */
export function anchorBinds(lm, ring, centroid) {
  const d = Math.hypot(centroid[0] - lm.at[0], centroid[1] - lm.at[1]);
  return d <= lm.r && pointInRing(lm.at[0], lm.at[1], ring) ? d : null;
}

export function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
