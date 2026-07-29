/**
 * PR #7914 R3 — when the new guard rejects, is anything actually lost?
 *
 * On main the model got "call record_artifact with workspacePath X".
 * At HEAD it gets no note at all, and record_artifact's description now says
 * write_file already records HTML/image/PDF/notebook files.
 *
 * So: for each rejected case, could a model-chosen title have survived the
 * store via record_artifact? Real store, real normalizeInput.
 */
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionArtifactStore } from '../packages/acp-bridge/src/sessionArtifacts.js';

const workspace = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pr7914-rec-')));
const ZWSP = '​';

const CASES = [
  { id: 'C3', rel: `reports/${'a'.repeat(206)}.html`, why: 'title > 200 chars' },
  { id: 'C4', rel: `reports/q3${ZWSP}chart.html`, why: 'U+200B in title' },
  { id: 'C5', rel: 'out&amp;dir/weather.html', why: 'entity markup in directory' },
  {
    id: 'C7',
    rel: `${Array.from({ length: 12 }, (_, i) => `d${i}${'p'.repeat(40)}`).join('/')}/r.html`,
    why: 'workspacePath > 500 chars',
  },
];

for (const c of CASES) {
  const abs = path.join(workspace, c.rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, '<!doctype html><h1>r</h1>');

  const store = new SessionArtifactStore({
    sessionId: `rec-${c.id}`,
    workspaceCwd: workspace,
  });

  // What a model would send after main's reminder: its OWN clean title,
  // the workspacePath the reminder handed it.
  const workspacePath = path.relative(workspace, abs).split(path.sep).join('/');
  await store.upsertMany(
    [
      {
        title: 'Q3 Revenue Report',
        description: 'Quarterly revenue breakdown by region',
        kind: 'html',
        storage: 'workspace',
        workspacePath,
      } as never,
    ],
    {},
  );
  const stored = (await store.list()).artifacts.length;
  console.log(
    `${c.id}  ${c.why.padEnd(28)} record_artifact(model title) -> ${
      stored === 1 ? 'RECORDED  (recoverable on main, lost at HEAD)' : 'dropped too (no loss)'
    }`,
  );
}
