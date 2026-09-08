#!/usr/bin/env node
/**
 * Kills a writer while it holds the workspace lock, and measures what happens.
 *
 * Usage: node scripts/audit/run-workspace-agents-crash.mjs
 *
 * A daemon can die mid-transaction. Two things have to be true afterwards:
 * the store must still be readable — a half-written record would take the
 * workspace with it — and writes must come back on their own, because a lock
 * held by a dead process that nothing can clear is a workspace wedged forever.
 *
 * How long that takes is reported, not asserted. Repeated runs recover in
 * about 25ms, but one early measurement took 10.5 seconds — the `stale`
 * window — and that outlier did not reproduce, so whether a write in the gap
 * is refused depends on where in the staleness cycle the crash landed. Only
 * the properties that must always hold are checked. The REST layer answers a
 * refusal with 503 and a Retry-After either way, since it is a wait rather
 * than a fault.
 *
 * What this does NOT cover: a crash *during* a write. The holder is killed
 * while idle inside its transaction, so the atomic write is never interrupted
 * — replacing atomicWriteJSON with a plain truncating write leaves both this
 * and the concurrency script green, because the file lock means two writers
 * never touch one file at once. Partial-write recovery is covered by the
 * fault injection in store.test.ts, which can interpose on the write itself.
 * This script should not be read as vouching for it.
 */
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const src = `${repo}/packages/core/src/agents/workspace-agents`;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-crash-'));

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
  path.join(tmp, 'holder.cjs'),
  `const M = require('${path.join(tmp, 'bundle.cjs')}');
M.Storage.setRuntimeBaseDir(process.argv[2]);
M.withAgentStoreTransaction(process.argv[3], async () => {
  console.log('holding');
  await new Promise(() => {});
}).catch(() => {});
`,
);

const M = createRequire(import.meta.url)(path.join(tmp, 'bundle.cjs'));
M.Storage.setRuntimeBaseDir(tmp);
const ROOT = '/wa-crash';

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

const thread = await M.createThread(ROOT, { title: 'Survivor' });
await M.postMessage(ROOT, thread.id, {
  from: M.HUMAN_AUTHOR_ID,
  text: 'before',
});

const child = spawn(
  process.execPath,
  [path.join(tmp, 'holder.cjs'), tmp, ROOT],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
await new Promise((resolve) =>
  child.stdout.on('data', (d) => String(d).includes('holding') && resolve()),
);
child.kill('SIGKILL');
await new Promise((resolve) => child.on('exit', resolve));
console.log('\na writer was killed while holding the lock');

const started = Date.now();
let immediate = null;
try {
  await M.postMessage(ROOT, thread.id, {
    from: M.HUMAN_AUTHOR_ID,
    text: 'immediate',
  });
} catch (error) {
  immediate = error.message;
}
ok('the store is still readable', Boolean(await M.readThread(ROOT, thread.id)));
console.log(
  `    the write straight after the crash ${immediate ? 'was refused' : 'went through'}`,
);
ok(
  'nothing written before the crash is lost',
  (await M.readThread(ROOT, thread.id)).messages.some(
    (m) => m.text === 'before',
  ),
);

let recovered = null;
for (let attempt = 0; attempt < 40; attempt++) {
  try {
    await M.postMessage(ROOT, thread.id, {
      from: M.HUMAN_AUTHOR_ID,
      text: 'after',
    });
    recovered = Date.now() - started;
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
ok(
  'writes come back without anyone clearing the lock',
  recovered !== null,
  'the workspace stayed wedged',
);
ok(
  'and within the staleness window, not much later',
  recovered !== null && recovered < 20_000,
  `${recovered}ms`,
);
console.log(`    recovery took ${recovered}ms`);

const after = await M.readThread(ROOT, thread.id);
const seqs = after.messages.map((m) => m.sequence);
ok(
  'the surviving thread is intact',
  new Set(seqs).size === seqs.length &&
    seqs.every((v, i) => i === 0 || v > seqs[i - 1]) &&
    after.nextMessageSequence > Math.max(...seqs),
  JSON.stringify(seqs),
);

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
