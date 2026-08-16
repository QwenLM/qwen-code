// Extract the two self-hosted-only steps of serve-ab.yml's `ab` job VERBATIM,
// with the same YAML parser the repo's own pin test uses, so the replay runs
// the workflow's real script text instead of a hand-copied approximation.
//
// usage: node extract-steps.mjs <serve-ab.yml> <outdir>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const [, , wfPath, outDir] = process.argv;
const doc = parse(readFileSync(wfPath, 'utf8'));
const steps = doc.jobs.ab.steps;
mkdirSync(outDir, { recursive: true });

const pick = (pred, file) => {
  const s = steps.find(pred);
  if (!s) throw new Error(`step not found for ${file}`);
  writeFileSync(join(outDir, file), s.run, { mode: 0o755 });
  return s;
};

const ownership = pick((s) => s.name === 'Restore workspace ownership', 'ownership.sh');
const wipe = pick((s) => /^Wipe stale workspace/.test(s.name || ''), 'wipe.sh');

const checkouts = steps
  .filter((s) => String(s.uses || '').startsWith('actions/checkout'))
  .map((s) => ({ uses: s.uses, with: s.with, if: s.if }));

writeFileSync(
  join(outDir, 'meta.json'),
  JSON.stringify(
    {
      wipeStepName: wipe.name,
      wipeIf: wipe.if,
      ownershipIf: ownership.if,
      defaultShell: doc.defaults?.run?.shell,
      checkouts,
    },
    null,
    2,
  ),
);
console.log(`${wfPath}\n  wipe step: ${wipe.name}\n  -> ${outDir}`);
