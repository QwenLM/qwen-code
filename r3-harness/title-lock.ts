/**
 * Carried-over finding (declined as out of scope) — re-verified at head a96c93bd
 * with the CURRENT producer's output, not a hand-written artifact.
 *
 * write_file is now structurally the first writer for every workspace artifact
 * (a file must exist before it can be recorded). mergeArtifact only reassigns
 * title/description inside `if (publishedUpdate)`, so a later record_artifact
 * for the same workspacePath is a no-op that still answers "Recorded artifact".
 */
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildWorkspaceArtifactMetadata } from '../packages/core/src/tools/write-file.js';
import { SessionArtifactStore } from '../packages/acp-bridge/src/sessionArtifacts.js';

const workspace = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pr7914-lock-')));
const abs = path.join(workspace, 'reports', 'q3.html');
mkdirSync(path.dirname(abs), { recursive: true });
writeFileSync(abs, '<!doctype html><h1>Q3</h1>');

const cfg = {
  isRecordArtifactEnabled: () => true,
  getTargetDir: () => workspace,
} as never;

const store = new SessionArtifactStore({ sessionId: 'lock', workspaceCwd: workspace });

// 1. exactly what write_file now emits
const auto = buildWorkspaceArtifactMetadata(cfg, abs, 26);
console.log('write_file emits :', JSON.stringify({ title: auto?.title }));
await store.upsertMany([auto as never], {});

// 2. the model then curates it, as record_artifact would
const curated = await store.upsertMany(
  [
    {
      title: 'Q3 Revenue Report',
      description: 'Quarterly revenue breakdown by region',
      kind: 'html',
      storage: 'workspace',
      workspacePath: 'reports/q3.html',
    } as never,
  ],
  {},
);

const list = (await store.list()).artifacts;
console.log('record_artifact  :', JSON.stringify({ title: 'Q3 Revenue Report' }));
console.log('');
console.log('changes emitted by the curated upsert :', JSON.stringify(curated.changes ?? []));
console.log('stored after both                     :', JSON.stringify(list.map((a) => ({ title: a.title, description: a.description }))));
console.log('');
console.log(
  'publishArtifactChanges emits one artifact_changed per change, so [] means',
);
console.log('no client is notified at all — the curated title never reaches the panel.');

// Negative controls, so the [] above means something.
const other = await store.upsertMany(
  [{ title: 'Other', kind: 'html', storage: 'workspace', workspacePath: 'reports/other.html' } as never],
  {},
);
console.log('\ncontrol — different path      :', (other.changes ?? []).map((c) => c.type ?? c.kind ?? 'change').join(',') || '[]');
const extUrl = await store.upsertMany(
  [{ title: 'External', kind: 'html', storage: 'external_url', url: 'https://example.com/q3' } as never],
  {},
);
console.log('control — external_url        :', (extUrl.changes ?? []).map((c) => c.type ?? c.kind ?? 'change').join(',') || '[]');
