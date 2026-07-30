/**
 * A/B harness 2: does workspace-qualified daemon maintenance stay inside the
 * SELECTED workspace runtime root, for both the transcript and the writer lock?
 *
 * Layout (all real dirs, one real daemon, two registered workspaces):
 *   RT1 = <home>/.qwen                  <- primary runtime root (ws1)
 *   RT2 = <root>/rt2                    <- ws2's advanced.runtimeOutputDir
 *
 * For every probe session id we plant TWO transcripts under ws2's project id:
 *   RT2/projects/<ws2>/chats/<id>.jsonl   <- the real one (selected runtime)
 *   RT1/projects/<ws2>/chats/<id>.jsonl   <- decoy (primary-runtime fallback)
 * A daemon that resolves ws2 through the ambient primary runtime hits the decoy.
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

const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), `pr7975-iso-${arm}-`)),
);
const home = path.join(root, 'home');
const ws1 = path.join(root, 'ws1');
const ws2 = path.join(root, 'ws2');
const RT1 = path.join(home, '.qwen');
const RT2 = path.join(root, 'rt2');
for (const d of [RT1, path.join(ws1, '.qwen'), path.join(ws2, '.qwen'), RT2]) {
  fs.mkdirSync(d, { recursive: true });
}

// Trust both workspaces so the workspace-qualified routes are reachable, and
// give ws2 its own runtime output root.
fs.writeFileSync(
  path.join(home, '.qwen', 'settings.json'),
  JSON.stringify({ security: { folderTrust: { enabled: false } } }, null, 2),
);
fs.writeFileSync(
  path.join(ws2, '.qwen', 'settings.json'),
  JSON.stringify({ advanced: { runtimeOutputDir: RT2 } }, null, 2),
);

const core = await import(
  pathToFileURL(path.join(treeDir, 'packages/core/dist/index.js')).href
);
const { Storage } = core;

const chatsIn = (runtimeBaseDir, workspaceCwd) =>
  path.join(new Storage(workspaceCwd, runtimeBaseDir).getProjectDir(), 'chats');

const realChats = chatsIn(RT2, ws2); // selected runtime for ws2
const decoyChats = chatsIn(RT1, ws2); // where a primary-runtime fallback lands
fs.mkdirSync(realChats, { recursive: true });
fs.mkdirSync(decoyChats, { recursive: true });

const ID = {
  routing: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  lockRight: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  lockWrong: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
};

function writeTranscript(dir, id, marker) {
  fs.writeFileSync(
    path.join(dir, `${id}.jsonl`),
    `${JSON.stringify({
      uuid: `record-${id}`,
      parentUuid: null,
      sessionId: id,
      timestamp: '2026-07-30T00:00:00.000Z',
      type: 'user',
      message: { role: 'user', parts: [{ text: marker }] },
      cwd: ws2,
      version: '1.0.0',
    })}\n`,
  );
}
for (const id of Object.values(ID)) {
  writeTranscript(realChats, id, `SELECTED-RUNTIME rt2 ${id}`);
  writeTranscript(decoyChats, id, `PRIMARY-RUNTIME-DECOY rt1 ${id}`);
}

const probe = (p) => {
  try {
    const st = fs.statSync(p);
    return { exists: true, size: st.size, ino: st.ino };
  } catch {
    return { exists: false };
  }
};
const snapshot = () =>
  Object.fromEntries(
    Object.entries(ID).map(([k, id]) => [
      k,
      {
        rt2: probe(path.join(realChats, `${id}.jsonl`)),
        rt1decoy: probe(path.join(decoyChats, `${id}.jsonl`)),
      },
    ]),
  );
const before = snapshot();

// ------------------------------------------------- foreign writer leases
// lockRight: held in RT2 (the selected runtime)  -> maintenance must conflict
// lockWrong: held in RT1 (the primary runtime)   -> must NOT block ws2 work
function startHolder(runtimeBaseDir, chatsDir, ids) {
  const child = spawn(
    process.execPath,
    [
      path.join(HARNESS_DIR, 'lease-holder.mjs'),
      treeDir,
      runtimeBaseDir,
      chatsDir,
      ...ids,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const state = { out: '', err: '', child };
  child.stdout.on('data', (d) => (state.out += d));
  child.stderr.on('data', (d) => (state.err += d));
  return state;
}
const holderRt2 = startHolder(RT2, realChats, [ID.lockRight]);
const holderRt1 = startHolder(RT1, decoyChats, [ID.lockWrong]);

async function waitFor(pred, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${what}`);
}
await waitFor(() => holderRt2.out.includes('READY'), 30000, 'rt2 lease');
await waitFor(() => holderRt1.out.includes('READY'), 30000, 'rt1 lease');

const lockDirs = {
  rt2: fs.readdirSync(path.join(RT2, 'tmp', 'session-writer-locks')),
  rt1: fs.readdirSync(path.join(RT1, 'tmp', 'session-writer-locks')),
};

// ------------------------------------------------------------- the daemon
const port = 4200 + (arm === 'head' ? 71 : 72);
const daemonLog = path.join(root, 'daemon.log');
const fd = fs.openSync(daemonLog, 'a');
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
    ws1,
    '--workspace',
    ws2,
    '--no-web',
  ],
  {
    cwd: ws1,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
  },
);

const baseUrl = `http://127.0.0.1:${port}`;
async function http(method, urlPath, body) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text.slice(0, 400) };
  }
  return { status: res.status, json };
}
await waitFor(
  async () => {
    try {
      return (await http('GET', '/health')).status === 200;
    } catch {
      return false;
    }
  },
  60000,
  'daemon /health',
);

const wsSel = encodeURIComponent(ws2);
const workspaces = await http('GET', '/workspaces');

// 1) classification/listing must see the selected runtime's transcripts
const listing = await http('GET', `/workspaces/${wsSel}/sessions?size=50`);

// 2) routing probe: delete must remove the RT2 copy and leave the RT1 decoy
const deleteRouting = await http(
  'POST',
  `/workspaces/${wsSel}/sessions/delete`,
  { sessionIds: [ID.routing] },
);
const afterRouting = snapshot();

// 3) lock root probe
const deleteLockRight = await http(
  'POST',
  `/workspaces/${wsSel}/sessions/delete`,
  { sessionIds: [ID.lockRight] },
);
const deleteLockWrong = await http(
  'POST',
  `/workspaces/${wsSel}/sessions/delete`,
  { sessionIds: [ID.lockWrong] },
);
const afterLocks = snapshot();

holderRt2.child.stdin.write('RELEASE\n');
holderRt1.child.stdin.write('RELEASE\n');
daemon.kill('SIGTERM');
await new Promise((r) => {
  daemon.on('exit', r);
  setTimeout(() => {
    daemon.kill('SIGKILL');
    r();
  }, 20000);
});
fs.closeSync(fd);

fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      arm,
      treeDir,
      root,
      ws1,
      ws2,
      RT1,
      RT2,
      realChats,
      decoyChats,
      ids: ID,
      lockDirs,
      workspaces,
      listing,
      before,
      deleteRouting,
      afterRouting,
      deleteLockRight,
      deleteLockWrong,
      afterLocks,
      daemonLogTail: fs
        .readFileSync(daemonLog, 'utf8')
        .split('\n')
        .slice(-30)
        .join('\n'),
    },
    null,
    2,
  ),
);
console.log(`[iso/${arm}] wrote ${outPath}`);
