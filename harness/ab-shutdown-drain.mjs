/**
 * A/B harness 3: shutdown drain.
 *
 * Round 1 measures the NATURAL duration of a 100-session archive batch (the
 * threshold the race depends on). Round 2 fires the same batch, sends SIGTERM
 * partway through it, and immediately issues a second maintenance request.
 *
 * head expectation: the admitted batch completes and its transcripts really
 * moved; the late request is refused 503 daemon_draining; the process exits
 * only after the admitted batch responded.
 *
 * argv: <arm> <treeDir> <outJsonPath>
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [arm, treeDir, outPath] = process.argv.slice(2);

const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), `pr7975-drain-${arm}-`)),
);
const home = path.join(root, 'home');
const ws = path.join(root, 'ws');
fs.mkdirSync(path.join(home, '.qwen'), { recursive: true });
fs.mkdirSync(path.join(ws, '.qwen'), { recursive: true });
const runtimeBaseDir = path.join(home, '.qwen');

const core = await import(
  pathToFileURL(path.join(treeDir, 'packages/core/dist/index.js')).href
);
const chatsDir = path.join(
  new core.Storage(ws, runtimeBaseDir).getProjectDir(),
  'chats',
);
const archiveDir = path.join(chatsDir, 'archive');
fs.mkdirSync(archiveDir, { recursive: true });

const hex = (n) => n.toString(16).padStart(12, '0');
const idsFor = (batch) =>
  Array.from(
    { length: 100 },
    (_, i) => `${hex(batch).slice(0, 8)}-0000-4000-8000-${hex(i)}`,
  );

function plant(ids) {
  for (const id of ids) {
    fs.writeFileSync(
      path.join(chatsDir, `${id}.jsonl`),
      `${JSON.stringify({
        uuid: `record-${id}`,
        parentUuid: null,
        sessionId: id,
        timestamp: '2026-07-30T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'drain fixture' }] },
        cwd: ws,
        version: '1.0.0',
      })}\n`,
    );
  }
}
const warmIds = idsFor(0xaa000000);
const raceIds = idsFor(0xbb000000);
const lateIds = idsFor(0xcc000000).slice(0, 1);
plant(warmIds);
plant(raceIds);
plant(lateIds);

const port = 4300 + (arm === 'head' ? 71 : 72);
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
    ws,
    '--no-web',
  ],
  {
    cwd: ws,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
  },
);
let daemonExitedAt = null;
daemon.on('exit', () => (daemonExitedAt = Date.now()));

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
    json = { _raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
}
const deadline = Date.now() + 60000;
while (Date.now() < deadline) {
  try {
    if ((await http('GET', '/health')).status === 200) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 100));
}

// ---- round 1: natural duration ----------------------------------------
const t0 = Date.now();
const warm = await http('POST', '/sessions/archive', { sessionIds: warmIds });
const naturalMs = Date.now() - t0;

// ---- round 2: SIGTERM partway through an admitted batch ----------------
const raceStart = Date.now();
const racePromise = http('POST', '/sessions/archive', { sessionIds: raceIds });
const sigtermDelay = Math.max(20, Math.round(naturalMs * 0.35));
await new Promise((r) => setTimeout(r, sigtermDelay));
const sigtermAt = Date.now();
daemon.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 30));

let late;
try {
  late = await http('POST', '/sessions/delete', { sessionIds: lateIds });
} catch (err) {
  late = { status: 'network-error', json: { message: String(err) } };
}
const lateAt = Date.now();

let race;
try {
  race = await racePromise;
} catch (err) {
  race = { status: 'network-error', json: { message: String(err) } };
}
const raceDoneAt = Date.now();

await new Promise((r) => {
  if (daemonExitedAt) return r();
  daemon.on('exit', r);
  setTimeout(() => {
    daemon.kill('SIGKILL');
    r();
  }, 30000);
});
fs.closeSync(fd);

const movedRace = raceIds.filter((id) =>
  fs.existsSync(path.join(archiveDir, `${id}.jsonl`)),
).length;
const stillActiveRace = raceIds.filter((id) =>
  fs.existsSync(path.join(chatsDir, `${id}.jsonl`)),
).length;
const lateStillActive = fs.existsSync(
  path.join(chatsDir, `${lateIds[0]}.jsonl`),
);

fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      arm,
      naturalMs,
      warmStatus: warm.status,
      warmArchived: warm.json.archived?.length ?? 0,
      sigtermDelay,
      timings: {
        raceStart,
        sigtermAt,
        lateAt,
        raceDoneAt,
        daemonExitedAt,
        sigtermToRaceDoneMs: raceDoneAt - sigtermAt,
        raceDoneBeforeExit: daemonExitedAt ? daemonExitedAt >= raceDoneAt : null,
      },
      race: { status: race.status, json: summarize(race.json) },
      late: { status: late.status, json: late.json },
      movedRace,
      stillActiveRace,
      lateStillActive,
      daemonLogTail: fs
        .readFileSync(daemonLog, 'utf8')
        .split('\n')
        .slice(-25)
        .join('\n'),
    },
    null,
    2,
  ),
);

function summarize(json) {
  if (!json || typeof json !== 'object') return json;
  const out = {};
  for (const [k, v] of Object.entries(json)) {
    out[k] = Array.isArray(v) ? { count: v.length, sample: v.slice(0, 2) } : v;
  }
  return out;
}
console.log(`[drain/${arm}] natural=${naturalMs}ms wrote ${outPath}`);
