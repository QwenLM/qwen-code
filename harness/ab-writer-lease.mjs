/**
 * A/B harness: does daemon session maintenance respect a foreign writer lease?
 *
 * One arm = one real `qwen serve` daemon (built dist, real HTTP on loopback,
 * real filesystem runtime root, real foreign writer process holding real
 * lock files). Nothing about the daemon or the lease protocol is mocked.
 *
 * argv: <arm> <treeDir> <outJsonPath>
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [arm, treeDir, outPath] = process.argv.slice(2);
const HARNESS_DIR = path.dirname(new URL(import.meta.url).pathname);

// realpath: macOS tmpdir is a symlink (/var -> /private/var) and the daemon
// resolves the workspace root, so the fixture must use the same identity the
// daemon will derive or every session reads back as notFound.
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), `pr7975-${arm}-`)),
);
const home = path.join(root, 'home');
const ws = path.join(root, 'ws');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(ws, '.qwen'), { recursive: true });

const runtimeBaseDir = path.join(home, '.qwen');

const core = await import(
  pathToFileURL(path.join(treeDir, 'packages/core/dist/index.js')).href
);
const { Storage } = core;
const chatsDir = path.join(
  new Storage(ws, runtimeBaseDir).getProjectDir(),
  'chats',
);
const archiveDir = path.join(chatsDir, 'archive');
fs.mkdirSync(archiveDir, { recursive: true });

// ---------------------------------------------------------------- fixtures
const ID = {
  heldDelete: '11111111-1111-4111-8111-111111111111',
  heldArchive: '22222222-2222-4222-8222-222222222222',
  heldUnarchive: '33333333-3333-4333-8333-333333333333',
  freeDelete: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  freeArchive: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  freeUnarchive: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};

function writeTranscript(id, state) {
  const dir = state === 'archived' ? archiveDir : chatsDir;
  const line = `${JSON.stringify({
    uuid: `record-${id}`,
    parentUuid: null,
    sessionId: id,
    timestamp: '2026-07-30T00:00:00.000Z',
    type: 'user',
    message: { role: 'user', parts: [{ text: 'synthetic verification fixture' }] },
    cwd: ws,
    version: '1.0.0',
  })}\n`;
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), line);
}

writeTranscript(ID.heldDelete, 'active');
writeTranscript(ID.heldArchive, 'active');
writeTranscript(ID.heldUnarchive, 'archived');
writeTranscript(ID.freeDelete, 'active');
writeTranscript(ID.freeArchive, 'active');
writeTranscript(ID.freeUnarchive, 'archived');

function stateOf(id) {
  const probe = (p) => {
    try {
      const st = fs.statSync(p);
      return { exists: true, size: st.size, ino: st.ino };
    } catch {
      return { exists: false };
    }
  };
  return {
    active: probe(path.join(chatsDir, `${id}.jsonl`)),
    archived: probe(path.join(archiveDir, `${id}.jsonl`)),
  };
}

const before = Object.fromEntries(
  Object.values(ID).map((id) => [id, stateOf(id)]),
);

// ---------------------------------------------------- foreign writer peer
const holder = spawn(
  process.execPath,
  [
    path.join(HARNESS_DIR, 'lease-holder.mjs'),
    treeDir,
    runtimeBaseDir,
    chatsDir,
    ID.heldDelete,
    ID.heldArchive,
    ID.heldUnarchive,
  ],
  { stdio: ['pipe', 'pipe', 'pipe'] },
);
let holderOut = '';
let holderErr = '';
holder.stdout.on('data', (d) => (holderOut += d));
holder.stderr.on('data', (d) => (holderErr += d));

async function waitFor(pred, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${what}\nholderErr=${holderErr}`);
}

await waitFor(() => holderOut.includes('READY'), 30000, 'lease holder READY');
const lockDir = path.join(runtimeBaseDir, 'tmp', 'session-writer-locks');
const lockFilesHeld = fs.existsSync(lockDir) ? fs.readdirSync(lockDir) : [];

// ------------------------------------------------------------- the daemon
const port = 4100 + (arm === 'head' ? 71 : 72);
const daemonLog = path.join(root, 'daemon.log');
const daemonLogFd = fs.openSync(daemonLog, 'a');
const daemon = spawn(
  process.execPath,
  [
    path.join(treeDir, 'packages/cli/dist/index.js'),
    'serve',
    '--port',
    String(port),
    '--hostname',
    '127.0.0.1',
    '--workspace',
    ws,
    '--no-web',
  ],
  {
    cwd: ws,
    stdio: ['ignore', daemonLogFd, daemonLogFd],
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      QWEN_RUNTIME_DIR: '',
      NO_COLOR: '1',
    },
  },
);
delete process.env['QWEN_RUNTIME_DIR'];

const base = `http://127.0.0.1:${port}`;
async function http(method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json };
}

await waitFor(
  async () => {
    try {
      const r = await http('GET', '/health');
      return r.status === 200;
    } catch {
      return false;
    }
  },
  60000,
  'daemon /health',
);

// ------------------------------------------------- maintenance under lease
const contended = {};
contended.delete = await http('POST', '/sessions/delete', {
  sessionIds: [ID.heldDelete, ID.freeDelete],
});
contended.archive = await http('POST', '/sessions/archive', {
  sessionIds: [ID.heldArchive, ID.freeArchive],
});
contended.unarchive = await http('POST', '/sessions/unarchive', {
  sessionIds: [ID.heldUnarchive, ID.freeUnarchive],
});

const afterContended = Object.fromEntries(
  Object.values(ID).map((id) => [id, stateOf(id)]),
);

// ------------------------------------------------- release, then retry
holder.stdin.write('RELEASE\n');
await waitFor(() => holderOut.includes('RELEASED'), 30000, 'lease RELEASED');

const retried = {};
retried.delete = await http('POST', '/sessions/delete', {
  sessionIds: [ID.heldDelete],
});
retried.archive = await http('POST', '/sessions/archive', {
  sessionIds: [ID.heldArchive],
});
retried.unarchive = await http('POST', '/sessions/unarchive', {
  sessionIds: [ID.heldUnarchive],
});

const afterRetry = Object.fromEntries(
  Object.values(ID).map((id) => [id, stateOf(id)]),
);

daemon.kill('SIGTERM');
await new Promise((r) => {
  daemon.on('exit', r);
  setTimeout(() => {
    daemon.kill('SIGKILL');
    r();
  }, 15000);
});
fs.closeSync(daemonLogFd);

fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      arm,
      treeDir,
      root,
      ws,
      runtimeBaseDir,
      chatsDir,
      ids: ID,
      lockFilesHeld,
      before,
      contended,
      afterContended,
      retried,
      afterRetry,
      daemonLogTail: fs
        .readFileSync(daemonLog, 'utf8')
        .split('\n')
        .slice(-40)
        .join('\n'),
    },
    null,
    2,
  ),
);
console.log(`[${arm}] wrote ${outPath}`);
