/**
 * Run every geography audit in one go, so the state of the dataset can be
 * checked in one command after any rebuild.
 *
 * Order matters only in that the repairs must already have run; these are all
 * read-only. Each audit owns one question and prints its own numbers:
 *
 *   audit-geography  projection residuals, footprint agreement, water, buildings in water
 *   audit-coverage   building-stock coverage against the full OSM stock
 *   audit-landmarks  the significant-structure checklist and the renderer anchors
 *   audit-heights    heights against cited figures and OSM tags
 *   audit-bridges    river crossings against the OSM carriageways
 *   audit-streets    street alignment against named OSM centrelines
 *   verify-water     water coverage and the dry-building probes
 *   verify-terrain   terrain heights against USGS 3DEP
 *
 * Run: node scripts/verify-geography.mjs [name ...]
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './osm.mjs';

const AUDITS = [
  'audit-geography',
  'audit-coverage',
  'audit-landmarks',
  'audit-heights',
  'audit-bridges',
  'audit-streets',
  'verify-water',
  'verify-terrain',
];

const pick = process.argv.slice(2);
const run = pick.length ? AUDITS.filter((a) => pick.some((p) => a.includes(p))) : AUDITS;

let failed = 0;
for (const name of run) {
  console.log(`\n${'='.repeat(72)}\n${name}\n${'='.repeat(72)}`);
  const res = spawnSync(process.execPath, [join(ROOT, 'scripts', `${name}.mjs`)], {
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    failed++;
    console.log(`  ${name} exited ${res.status}`);
  }
}

console.log(`\n${run.length} audits run, ${failed} failed`);
process.exit(failed ? 1 : 0);
