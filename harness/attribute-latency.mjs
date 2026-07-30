/**
 * Attribute the head-vs-base batch-archive latency delta.
 * Hypothesis: the per-session writer lease dominates it, and on darwin the
 * lease's own cost is dominated by the `/bin/ps` spawn that stamps
 * process_start_identity into the lock record.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const treeDir = process.argv[2];
const outPath = process.argv[3];
const N = 100;

const core = await import(
  pathToFileURL(path.join(treeDir, 'packages/core/dist/index.js')).href
);
const { SessionWriterLease } = core;

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr7975-lat-')));
const chats = path.join(root, 'chats');
fs.mkdirSync(chats, { recursive: true });

const ids = Array.from(
  { length: N },
  (_, i) => `0000dd00-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
);
for (const id of ids) fs.writeFileSync(path.join(chats, `${id}.jsonl`), '{}\n');

// 1) full acquire + release cycle
let t = Date.now();
for (const id of ids) {
  const lease = await SessionWriterLease.acquire({
    runtimeBaseDir: root,
    sessionId: id,
    transcriptPath: path.join(chats, `${id}.jsonl`),
    processKind: 'daemon',
    reclaimPolicy: 'never',
  });
  await lease.release();
}
const leaseMs = Date.now() - t;

// 2) just the /bin/ps spawn the lease performs once per acquire (darwin)
const psOnce = () =>
  new Promise((resolve) =>
    execFile(
      '/bin/ps',
      ['-o', 'lstart=', '-p', String(process.pid)],
      { encoding: 'utf8', timeout: 1000 },
      () => resolve(),
    ),
  );
t = Date.now();
for (let i = 0; i < N; i++) await psOnce();
const psMs = Date.now() - t;

const result = {
  platform: process.platform,
  n: N,
  leaseAcquireReleaseMs: leaseMs,
  leasePerSessionMs: +(leaseMs / N).toFixed(2),
  psSpawnMs: psMs,
  psPerCallMs: +(psMs / N).toFixed(2),
  psShareOfLease: +((psMs / leaseMs) * 100).toFixed(1),
};
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
