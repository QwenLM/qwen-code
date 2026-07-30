/**
 * Foreign writer: acquires a real SessionWriterLease for each session id using
 * the SAME core build as the daemon under test, then holds it until told to
 * release. This is the "another Qwen process still owns this transcript" peer.
 *
 * argv: <treeDir> <runtimeBaseDir> <chatsDir> <sessionId...>
 * stdout protocol: "READY <json>" ... then on stdin "RELEASE\n" -> "RELEASED"
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [treeDir, runtimeBaseDir, chatsDir, ...sessionIds] = process.argv.slice(2);

const core = await import(
  pathToFileURL(path.join(treeDir, 'packages/core/dist/index.js')).href
);
const { SessionWriterLease } = core;

const leases = [];
for (const sessionId of sessionIds) {
  const lease = await SessionWriterLease.acquire({
    runtimeBaseDir,
    sessionId,
    transcriptPath: path.join(chatsDir, `${sessionId}.jsonl`),
    processKind: 'acp',
    qwenVersion: 'foreign-writer-harness',
    reclaimPolicy: 'never',
  });
  leases.push(lease);
}

process.stdout.write(
  `READY ${JSON.stringify({ pid: process.pid, held: sessionIds })}\n`,
);

process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', async (chunk) => {
  buf += chunk;
  if (!buf.includes('RELEASE')) return;
  for (const lease of leases) {
    await lease.release();
  }
  process.stdout.write('RELEASED\n');
  process.exit(0);
});
