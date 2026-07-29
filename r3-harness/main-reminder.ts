/**
 * src/tools/write-file.ts currently holds main's version (BASE arm of the dist
 * A/B), so this reads main's real producer.
 *
 * Question: for the filenames the new guard now rejects, what did main tell the
 * model? If main emitted the "call record_artifact" reminder, the guard traded a
 * false claim for silence — and for the cases record_artifact could still have
 * saved, that is a lost recovery path.
 */
import { realpathSync, mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRecordArtifactReminder } from '../packages/core/src/tools/write-file.js';

const workspace = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pr7914-main-')));
const cfg = {
  isRecordArtifactEnabled: () => true,
  getTargetDir: () => workspace,
} as never;

const ZWSP = '​';
const CASES = [
  ['C3 title > 200 chars', `reports/${'a'.repeat(206)}.html`],
  ['C4 U+200B in title', `reports/q3${ZWSP}chart.html`],
  ['C5 markup in directory', 'out&amp;dir/weather.html'],
  ['C6 markup in title', 'reports/chart onerror=alert(1).html'],
  ['C7 path > 500 chars', `${Array.from({ length: 12 }, (_, i) => `d${i}${'p'.repeat(40)}`).join('/')}/r.html`],
];

console.log("main's write_file note for the filenames HEAD's guard now rejects:\n");
for (const [label, rel] of CASES) {
  const note = buildRecordArtifactReminder(cfg, path.join(workspace, rel));
  console.log(
    `${label.padEnd(24)} -> ${note ? 'REMINDER EMITTED: "' + note.slice(0, 62) + '..."' : 'no note'}`,
  );
}
