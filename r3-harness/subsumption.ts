/**
 * Are the two title-side clauses reachable as the SOLE reason to reject?
 * title === path.basename(filePath), and workspacePath always ends with that
 * same basename — so any substring match inside title is also inside
 * workspacePath. If so, M2/M3 surviving is redundancy, not a test gap.
 */
import * as path from 'node:path';
import {
  hasControlCharacter,
  hasUnsafeDisplayPayload,
} from '../packages/core/src/tools/record-artifact.js';

const ZWSP = '​';
const samples = [
  'reports/chart onerror=alert(1).html', // the PR's own unsafe-markup test
  `reports/q3${ZWSP}chart.html`,
  'a/b/<script>.html',
  `deep/dir/${'x'.repeat(150)}&amp;.html`,
];

console.log('workspacePath                                  | title trips | path trips');
console.log('-----------------------------------------------|-------------|-----------');
for (const wp of samples) {
  const title = path.basename(wp);
  const t = hasControlCharacter(title) || hasUnsafeDisplayPayload(title);
  const p = hasControlCharacter(wp) || hasUnsafeDisplayPayload(wp);
  const shown = wp.length > 45 ? wp.slice(0, 42) + '...' : wp;
  console.log(`${shown.padEnd(46)} | ${String(t).padEnd(11)} | ${p}`);
}

console.log(
  '\ntitle is a suffix of workspacePath in every case:',
  samples.every((wp) => wp.endsWith(path.basename(wp))),
);
console.log(
  'any case where the title clauses fire but the path clauses do NOT:',
  samples.filter((wp) => {
    const title = path.basename(wp);
    return (
      (hasControlCharacter(title) || hasUnsafeDisplayPayload(title)) &&
      !(hasControlCharacter(wp) || hasUnsafeDisplayPayload(wp))
    );
  }).length,
);

console.log('\n--- the two clauses that ARE independently reachable ---');
const longPath = `${Array.from({ length: 12 }, (_, i) => `d${i}${'p'.repeat(40)}`).join('/')}/r.html`;
console.log(
  `workspacePath > 500 (len=${longPath.length}) with title "r.html" (len=6): ` +
    `titleClauses=${hasControlCharacter('r.html') || hasUnsafeDisplayPayload('r.html') || 'r.html'.length > 200}`,
);
const ctrlDir = `out${ZWSP}dir/weather.html`;
console.log(
  `control char in DIRECTORY only: titleTrips=${hasControlCharacter(path.basename(ctrlDir))} ` +
    `pathTrips=${hasControlCharacter(ctrlDir)}`,
);
