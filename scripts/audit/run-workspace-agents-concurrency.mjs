#!/usr/bin/env node
/**
 * Contends the workspace store from several real processes at once.
 *
 * Usage: node scripts/audit/run-workspace-agents-concurrency.mjs
 *
 * Separate from run-workspace-agents.mjs because it spawns processes and is
 * therefore slow, and because it tests a different claim. That harness runs
 * one operation at a time, which is the shape a store with a mutation lock is
 * guaranteed to survive. This one asks whether the *cross-process* file lock
 * holds — the case two daemons, or a daemon and a restart, actually hit.
 *
 * The in-process mutex cannot answer that: it serialises everything inside one
 * process for free. Only separate processes contend for the file lock.
 *
 * Calibrated: with `lockfile.lock` removed from withAgentStoreTransaction this
 * loses roughly half the posts, so the assertions below are load-bearing
 * rather than a formality.
 */
import { createRequire } from 'node:module';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const src = `${repo}/packages/core/src/agents/workspace-agents`;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-conc-'));

await fs.writeFile(
  path.join(tmp, 'entry.ts'),
  `export * from '${src}/store.js';
export * from '${src}/thread-actions.js';
export * from '${src}/types.js';
export { Storage } from '${repo}/packages/core/src/config/storage.js';
`,
);
execFileSync(
  path.join(repo, 'node_modules/.bin/esbuild'),
  [
    path.join(tmp, 'entry.ts'),
    '--bundle',
    '--format=cjs',
    '--platform=node',
    '--target=node20',
    `--outfile=${path.join(tmp, 'bundle.cjs')}`,
    '--log-level=error',
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);
await fs.writeFile(
  path.join(tmp, 'child.cjs'),
  `const M = require('${path.join(tmp, 'bundle.cjs')}');
const [, , runtimeDir, root, threadId, label] = process.argv;
M.Storage.setRuntimeBaseDir(runtimeDir);
M.postMessage(root, threadId, { from: M.HUMAN_AUTHOR_ID, text: label })
  .then(() => process.exit(0))
  .catch((e) => { console.error(label, e.message); process.exit(1); });
`,
);

const M = createRequire(import.meta.url)(path.join(tmp, 'bundle.cjs'));
M.Storage.setRuntimeBaseDir(tmp);
const ROOT = '/wa-concurrency';
const N = 10;

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log('  PASS ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (detail ? '  → ' + detail : ''));
  }
};

const thread = await M.createThread(ROOT, { title: 'Contended' });
const results = await Promise.allSettled(
  Array.from({ length: N }, (_, i) =>
    run(
      process.execPath,
      [path.join(tmp, 'child.cjs'), tmp, ROOT, thread.id, `p${i}`],
      { timeout: 60_000 },
    ),
  ),
);

console.log(`\n${N} processes posting to one thread at once`);
ok(
  'every process completed',
  results.every((r) => r.status === 'fulfilled'),
  String(results.find((r) => r.status === 'rejected')?.reason).slice(0, 160),
);

const after = await M.readThread(ROOT, thread.id);
const seqs = after.messages.map((m) => m.sequence);
ok(
  'no post is lost',
  after.messages.length === N,
  `${after.messages.length} of ${N} kept`,
);
ok(
  'each is present exactly once',
  new Set(after.messages.map((m) => m.text)).size === N,
);
ok(
  'sequences are unique',
  new Set(seqs).size === seqs.length,
  JSON.stringify(seqs),
);
ok(
  'and strictly increasing',
  seqs.every((v, i) => i === 0 || v > seqs[i - 1]),
  JSON.stringify(seqs),
);
ok(
  'the watermark stays ahead of every message',
  after.nextMessageSequence > Math.max(...seqs, 0),
);

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
