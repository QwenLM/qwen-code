/**
 * PR #7914 R3 — does the expanded guard actually stop the store from dropping
 * artifacts the model was told were "automatically recorded"?
 *
 * Real producer (both arms) -> real SessionArtifactStore.upsertMany, non-strict,
 * exactly as bridgeClient.upsertAndPublishArtifacts calls it.
 *
 *   REVIEWED = 2674aa4a12  (guard = hasUnsafeDisplayPayload(title) only)
 *   HEAD     = a96c93bdc2  (guard = all five store rules)
 */
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildWorkspaceArtifactMetadata as producerHead } from '../packages/core/src/tools/write-file.js';
import { buildWorkspaceArtifactMetadata as producerReviewed } from '../packages/core/src/tools/write-file.reviewed.js';
import { SessionArtifactStore } from '../packages/acp-bridge/src/sessionArtifacts.js';

// realpathSync: the daemon binds the realpath of --workspace, and
// path.relative(/var/...) vs /private/var/... silently puts every file
// "outside the workspace" -> both arms emit nothing (the R1 false negative).
const workspace = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pr7914-')));

const cfg = {
  isRecordArtifactEnabled: () => true,
  getTargetDir: () => workspace,
} as never;

const ZWSP = '​';

interface Case {
  id: string;
  rel: string;
  why: string;
}

const CASES: Case[] = [
  { id: 'C1', rel: 'reports/quarterly.html', why: 'ordinary html report' },
  { id: 'C2', rel: 'notes/analysis.ipynb', why: 'notebook mimeType fallback' },
  { id: 'C3', rel: `reports/${'a'.repeat(206)}.html`, why: 'title > 200 chars' },
  { id: 'C4', rel: `reports/q3${ZWSP}chart.html`, why: 'U+200B in title' },
  { id: 'C5', rel: 'out&amp;dir/weather.html', why: 'entity markup in DIRECTORY segment' },
  { id: 'C6', rel: 'reports/chart onerror=alert(1).html', why: 'unsafe markup in title (PR test case)' },
  {
    id: 'C7',
    rel: `${Array.from({ length: 12 }, (_, i) => `d${i}${'p'.repeat(40)}`).join('/')}/r.html`,
    why: 'workspacePath > 500 chars',
  },
];

const EXTENSIONS = [
  '.htm', '.html', '.ipynb', '.jpeg', '.jpg', '.pdf', '.png', '.svg', '.webp',
];

type Arm = 'REVIEWED' | 'HEAD';
const PRODUCERS: Record<Arm, typeof producerHead> = {
  REVIEWED: producerReviewed as typeof producerHead,
  HEAD: producerHead,
};

async function drive(arm: Arm, c: Case) {
  const abs = path.join(workspace, c.rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, '<!doctype html><h1>report</h1>');

  const artifact = PRODUCERS[arm](cfg, abs, 29);

  // Fresh store per case so counts are unambiguous.
  const store = new SessionArtifactStore({
    sessionId: `s-${arm}-${c.id}`,
    workspaceCwd: workspace,
  });

  let changes = 0;
  let stored = 0;
  let warnings: string[] = [];
  if (artifact) {
    const res = await store.upsertMany([artifact as never], {
      // non-strict: what bridgeClient.upsertAndPublishArtifacts actually does
    });
    changes = res.changes?.length ?? 0;
    warnings = res.warnings ?? [];
    stored = (await store.list()).artifacts.length;
  }

  return {
    emitted: artifact !== null,
    // The "automatically recorded ... No extra artifact registration step is
    // needed" note is pushed iff the producer returned an artifact.
    noteShown: artifact !== null,
    changes,
    stored,
    warnings,
    title: artifact?.title,
    kind: artifact?.kind,
    mimeType: artifact?.mimeType,
  };
}

const rows: string[] = [];
console.log(`workspace = ${workspace}\n`);

console.log('=== A. Guard cases: producer -> real store ===\n');
for (const c of CASES) {
  const reviewed = await drive('REVIEWED', c);
  const head = await drive('HEAD', c);

  const verdict = (r: Awaited<ReturnType<typeof drive>>) =>
    !r.emitted
      ? 'no artifact, no note'
      : r.stored === 1
        ? 'recorded + note (truthful)'
        : `NOTE SHOWN but store DROPPED it -> ${r.warnings.join('; ') || 'silent'}`;

  console.log(`${c.id}  ${c.why}`);
  console.log(`     path      ${c.rel.length > 90 ? c.rel.slice(0, 87) + '...' : c.rel}`);
  console.log(`     REVIEWED  ${verdict(reviewed)}`);
  console.log(`     HEAD      ${verdict(head)}`);
  console.log('');

  rows.push(
    [c.id, c.why, verdict(reviewed), verdict(head)].join(' | '),
  );
}

console.log('=== B. All nine artifact extensions at HEAD (kind / mimeType / store accepts) ===\n');
for (const ext of EXTENSIONS) {
  const abs = path.join(workspace, 'ext', `sample${ext}`);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, 'x');
  const a = producerHead(cfg, abs, 1);
  const store = new SessionArtifactStore({
    sessionId: `s-ext-${ext}`,
    workspaceCwd: workspace,
  });
  let stored = 0;
  let warn: string[] = [];
  if (a) {
    const res = await store.upsertMany([a as never], {});
    warn = res.warnings ?? [];
    stored = (await store.list()).artifacts.length;
  }
  console.log(
    `${ext.padEnd(7)} kind=${String(a?.kind).padEnd(9)} mimeType=${String(a?.mimeType).padEnd(26)} stored=${stored}${warn.length ? ' WARN=' + warn.join(';') : ''}`,
  );
}

console.log('\n=== C. Is the .ipynb mimeType fallback load-bearing? ===\n');
const { getSpecificMimeType } = await import(
  '../packages/core/src/utils/fileUtils.js'
);
for (const ext of ['.ipynb', '.html', '.svg']) {
  console.log(`getSpecificMimeType("a${ext}") = ${String(getSpecificMimeType(`a${ext}`))}`);
}

console.log('\n=== D. Win32 reserved characters in the PR test filenames ===\n');
// Win32 forbids  < > : " / \ | ? *  and control chars in a path component.
const WIN32_RESERVED = /[<>:"/\\|?*\x00-\x1f]/;
for (const name of ['<img src=x onerror=alert(1)>.html', 'chart onerror=alert(1).html']) {
  const { hasUnsafeDisplayPayload } = await import(
    '../packages/core/src/tools/record-artifact.js'
  );
  console.log(
    `${JSON.stringify(name)}\n   win32Reserved=${WIN32_RESERVED.test(name)}  triggersGuard=${hasUnsafeDisplayPayload(name)}`,
  );
}
