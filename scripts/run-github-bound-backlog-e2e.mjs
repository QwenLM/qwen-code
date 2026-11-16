#!/usr/bin/env node
// Hermetic E2E for the bound-delivery comment digest (startup backlog).
//
// Spins up a local mock GitHub (HTTP) and a mock model endpoint, boots an
// isolated `qwen serve` daemon (isolated QWEN_HOME), binds a session to a PR,
// lets the silent first-observation baseline form, stops the daemon, rewrites
// the persisted comment cursor + heartbeat to simulate a downtime gap, reboots,
// and counts the bound prompts in the session transcript. No real GitHub or
// model traffic.
//
// Groups / expectations:
//   g1 digest       gap -> ONE digest prompt, every rendered member key recorded
//   g2 individual   no gap -> five per-comment prompts, no digest lead
//   g4 none         first observation under a gap -> silent baseline, 0 prompts
//   g5 digest-full  full-size backlog -> newest members survive the body budget
//
// Usage (build the bundle first: npm run build && npm run bundle):
//   node scripts/run-github-bound-backlog-e2e.mjs \
//     --group g1 --cli "node dist/cli.js" --tag g1-run --expect digest
//
// --root overrides the scratch directory (default: <tmpdir>/bound-backlog-e2e).
// A relative --cli script path is resolved against the invocation directory.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}
const group = arg('group', 'g1');
const cli = arg('cli', 'qwen');
const tag = arg('tag', `${group}-run`);
const expectMode = arg('expect', 'digest');
// An unrecognized --expect must fail loudly, not fall through the assertion
// chain and report PASS having verified nothing.
const EXPECT_MODES = ['digest', 'individual', 'none', 'digest-full'];
if (!EXPECT_MODES.includes(expectMode)) {
  console.error(
    `[fixture] FAIL: unknown --expect ${expectMode} (want ${EXPECT_MODES.join('|')})`,
  );
  process.exit(2);
}
// An unrecognized --group must fail loudly too: it seeds no comments, so an
// unknown group would otherwise report PASS on the none arm having verified
// nothing.
const GROUPS = ['g1', 'g2', 'g4', 'g5'];
if (!GROUPS.includes(group)) {
  console.error(
    `[fixture] FAIL: unknown --group ${group} (want ${GROUPS.join('|')})`,
  );
  process.exit(2);
}
const g = Number(group.slice(1));
const MOCK_PORT = 8790 + 10 * g;
const DAEMON_PORT = 4199 + 10 * g;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const API = `http://127.0.0.1:${DAEMON_PORT}`;
const AUTH = { Authorization: 'Bearer fixture-serve-token' };

const ROOT = arg('root', path.join(os.tmpdir(), 'bound-backlog-e2e'));
// The tag reaches a recursive rmSync: reject anything that could climb out of
// ROOT (path traversal) before any deletion.
if (!/^[A-Za-z0-9._-]+$/.test(tag) || tag === '.' || tag === '..') {
  console.error(`[fixture] FAIL: invalid --tag ${tag}`);
  process.exit(2);
}
const rootResolved = path.resolve(ROOT);
const tagDir = path.resolve(rootResolved, tag);
if (!tagDir.startsWith(rootResolved + path.sep)) {
  console.error(`[fixture] FAIL: --tag ${tag} escapes --root`);
  process.exit(2);
}
const home = path.join(tagDir, 'home');
const ws = path.join(tagDir, 'ws');
fs.rmSync(tagDir, { recursive: true, force: true });
fs.mkdirSync(path.join(ws, '.qwen'), { recursive: true });
fs.mkdirSync(home, { recursive: true });

const CHANNEL = 'backlog-test';
const channel = {
  type: 'github',
  token: 'fixture-token',
  baseUrl: MOCK,
  groupPolicy: 'allowlist',
  groups: { 'owner/repo': {} },
  deliverToBoundSessions: true,
  prWatchEvents: [],
  pollInterval: 1000,
};
fs.writeFileSync(
  path.join(ws, '.qwen', 'settings.json'),
  JSON.stringify(
    { serve: { channels: [CHANNEL] }, channels: { [CHANNEL]: channel } },
    null,
    2,
  ),
);

const nameHash = crypto
  .createHash('sha256')
  .update(CHANNEL)
  .digest('hex')
  .slice(0, 16);
const wsReal = fs.realpathSync(ws);
const scope =
  path
    .basename(wsReal)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 32) +
  '-' +
  crypto.createHash('sha256').update(wsReal).digest('hex').slice(0, 12);
const stateDir = path.join(home, 'channels', scope);
fs.mkdirSync(stateDir, { recursive: true });
const watchPath = path.join(
  stateDir,
  `${CHANNEL}-${nameHash}-github-pr-watch.json`,
);
const cursorPath = path.join(
  stateDir,
  `${CHANNEL}-${nameHash}-poll-cursor.json`,
);

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 3600 * 1000;

// ---- mock GitHub + mock model ----
const comments = [];
if (group === 'g1' || group === 'g2') {
  for (let i = 1; i <= 5; i++) {
    comments.push({
      id: 100 + i,
      node_id: `IC_fixture_${i}`,
      body: `gap-comment-${i} body text`,
      created_at: iso(NOW - HOUR + i * 8 * 60 * 1000),
      updated_at: iso(NOW - HOUR + i * 8 * 60 * 1000),
      user: { login: 'fixture-bot' },
    });
  }
} else if (group === 'g4') {
  for (let i = 1; i <= 3; i++) {
    comments.push({
      id: 200 + i,
      node_id: `IC_old_${i}`,
      body: `old-comment-${i}`,
      created_at: iso(NOW - 30 * 60 * 1000),
      updated_at: iso(NOW - 30 * 60 * 1000),
      user: { login: 'fixture-bot' },
    });
  }
} else if (group === 'g5') {
  // Full-size backlog: 20 members at the 400-code-point excerpt cap. The
  // digest must keep the NEWEST members within the 6000-point body budget.
  for (let i = 0; i < 20; i++) {
    comments.push({
      id: 300 + i,
      node_id: `IC_full_${i}`,
      body: `marker-${i} ${'x'.repeat(412)}`,
      created_at: iso(NOW - HOUR + (i + 1) * 60 * 1000),
      updated_at: iso(NOW - HOUR + (i + 1) * 60 * 1000),
      user: { login: 'fixture-bot' },
    });
  }
}

const mock = http.createServer((req, res) => {
  const url = new URL(req.url, MOCK);
  const send = (code, obj) => {
    res.writeHead(code, {
      'content-type': 'application/json',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4999',
      'x-ratelimit-used': '1',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
      'x-ratelimit-resource': 'core',
    });
    res.end(JSON.stringify(obj));
  };
  if (url.pathname === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const stream = /"stream"\s*:\s*true/.test(body);
      if (!stream) {
        return send(200, {
          id: 'chatcmpl-fixture',
          object: 'chat.completion',
          created: 0,
          model: 'fixture-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      const chunk = (delta, finish) =>
        `data: ${JSON.stringify({
          id: 'chatcmpl-fixture',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fixture-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ role: 'assistant', content: 'ok' }, null));
      res.write(chunk({}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }
  if (url.pathname === '/user')
    return send(200, { id: 1, login: 'fixture-bot' });
  if (url.pathname === '/notifications') return send(200, []);
  if (url.pathname === '/repos/owner/repo/issues/42/comments')
    return send(200, comments);
  if (url.pathname === '/repos/owner/repo/pulls/42/comments')
    return send(200, []);
  if (url.pathname === '/repos/owner/repo/pulls/42') {
    return send(200, {
      number: 42,
      state: 'open',
      title: 'Fixture PR',
      merged: false,
      mergeable: true,
      mergeable_state: 'clean',
      head: { sha: 'a'.repeat(40) },
      updated_at: iso(NOW),
      user: { login: 'fixture-author' },
    });
  }
  return send(200, {});
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = {
  ...process.env,
  QWEN_HOME: home,
  OPENAI_API_KEY: 'fixture-key',
  OPENAI_BASE_URL: `${MOCK}/v1`,
  OPENAI_MODEL: 'fixture-model',
};
for (const key of [
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'QWEN_CODE_SERVE',
  'QWEN_SERVE_MCP_BUDGET_MODE',
  'QWEN_RUNTIME_DIR',
])
  delete env[key];

function startDaemon(logName) {
  const logPath = path.join(tagDir, logName);
  const logFd = fs.openSync(logPath, 'w');
  const [binRaw, ...rest] = cli.split(' ');
  // A relative CLI script path must resolve against the INVOCATION directory,
  // not the scratch workspace the daemon runs in (cwd stays ws: the fixture
  // derives its state scope from realpathSync(ws)).
  const invocationDir = process.cwd();
  // A relative executable (contains a path separator) resolves against the
  // invocation directory too; a bare command name stays a PATH lookup.
  const bin =
    binRaw.includes('/') && !path.isAbsolute(binRaw)
      ? path.resolve(invocationDir, binRaw)
      : binRaw;
  const resolvedArgs = rest.map((a) =>
    !a.startsWith('-') && !path.isAbsolute(a) && /\.(js|mjs|cjs)$/.test(a)
      ? path.resolve(invocationDir, a)
      : a,
  );
  const daemon = spawn(
    bin,
    [
      ...resolvedArgs,
      'serve',
      '--port',
      String(DAEMON_PORT),
      '--token',
      'fixture-serve-token',
    ],
    { cwd: ws, env, detached: true, stdio: ['ignore', logFd, logFd] },
  );
  console.log(`[fixture] daemon pid ${daemon.pid} (${cli}), log ${logPath}`);
  return { daemon, logPath };
}
async function waitDaemon() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${API}/health`, { headers: AUTH });
      if (res.ok) return;
    } catch {
      // daemon not up yet; retry
    }
    await sleep(500);
  }
  throw new Error('daemon did not come up in 60s');
}
async function stopDaemon(daemon) {
  // A child that already exited fired 'exit' before we subscribe (EventEmitter
  // does not replay), so awaiting a fresh listener would hang forever.
  if (daemon.exitCode !== null || daemon.signalCode !== null) return;
  const exited = new Promise((r) => {
    daemon.once('exit', r);
    daemon.once('error', r);
  });
  try {
    process.kill(-daemon.pid, 'SIGTERM');
  } catch {
    // already exited
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-daemon.pid, 'SIGKILL');
    } catch {
      // already exited
    }
  }, 15000);
  await exited;
  clearTimeout(timer);
  await sleep(500);
}

function findChatsDir() {
  const projects = path.join(home, 'projects');
  if (!fs.existsSync(projects)) return undefined;
  for (const entry of fs.readdirSync(projects)) {
    const chats = path.join(projects, entry, 'chats');
    if (fs.existsSync(chats)) return chats;
  }
  return undefined;
}
function collectStrings(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object')
    Object.values(value).forEach((v) => collectStrings(v, out));
}
const MARKERS = [
  '[GitHub event for a PR this session follows]',
  '[本会话跟进的 PR 的 GitHub 事件]',
];
function boundPrompts(chatsDir) {
  // One entry per DELIVERY, keyed by the promptId that the queue record and the
  // transcript message of one delivery share. Deduping by prompt TEXT would
  // collapse a byte-identical duplicate delivery into the first and hide it;
  // the promptId still collapses the two records of one delivery but keeps
  // separate deliveries distinct, so a duplicate delivery is countable.
  const byDelivery = new Map();
  if (!chatsDir || !fs.existsSync(chatsDir)) return [];
  for (const file of fs.readdirSync(chatsDir)) {
    if (!file.endsWith('.jsonl') || file.endsWith('.ledger.jsonl')) continue;
    const text = fs.readFileSync(path.join(chatsDir, file), 'utf8');
    if (!MARKERS.some((m) => text.includes(m))) continue;
    for (const line of text.split('\n')) {
      if (!MARKERS.some((m) => line.includes(m))) continue;
      try {
        const record = JSON.parse(line);
        const strings = [];
        collectStrings(record, strings);
        const hit = strings
          .filter((s) => MARKERS.some((m) => s.includes(m)))
          .sort((a, b) => b.length - a.length)[0];
        if (!hit) continue;
        const key = record.promptId ?? hit;
        if (!byDelivery.has(key)) byDelivery.set(key, hit);
      } catch {
        // skip malformed transcript line
      }
    }
  }
  return [...byDelivery.values()];
}
function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return undefined;
  }
}

async function createBoundSession() {
  const res = await fetch(`${API}/session`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: '{}',
  });
  const body = await res.json();
  const sessionId = body.sessionId ?? body.session?.id ?? body.id;
  if (!res.ok || !sessionId)
    throw new Error(
      `session create failed: ${res.status} ${JSON.stringify(body)}`,
    );
  const warm = await fetch(`${API}/session/${sessionId}/prompt`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: [{ type: 'text', text: 'fixture warmup' }],
    }),
  });
  if (!warm.ok)
    throw new Error(`warmup failed: ${warm.status} ${await warm.text()}`);
  let chatsDir;
  for (let i = 0; i < 60 && !chatsDir; i++) {
    chatsDir = findChatsDir();
    if (!chatsDir) await sleep(500);
  }
  if (!chatsDir) throw new Error('chats dir never appeared');
  fs.writeFileSync(
    path.join(chatsDir, `${sessionId}.pr.json`),
    JSON.stringify({
      prs: [
        {
          number: 42,
          url: `${MOCK}/owner/repo/pull/42`,
          createdAt: new Date().toISOString(),
          state: 'open',
        },
      ],
    }),
  );
  console.log(`[fixture] session ${sessionId} bound`);
  return { sessionId, chatsDir };
}

async function main() {
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  console.log(
    `[fixture] group ${group} mock on :${MOCK_PORT}, expect=${expectMode}`,
  );

  // Stage 1: boot, bind, wait for the silent first-observation baseline.
  let chatsDir;
  const first = startDaemon('daemon-stage1.log');
  try {
    await waitDaemon();
    const s = await createBoundSession();
    chatsDir = s.chatsDir;
    let baselined = false;
    for (let i = 0; i < 60; i++) {
      const w = readJson(watchPath);
      if (w?.entries?.['owner/repo#42']?.commentBaseline) {
        baselined = true;
        break;
      }
      await sleep(500);
    }
    if (!baselined) throw new Error('stage 1: watch baseline never appeared');
    console.log('[fixture] stage 1 baseline formed');
  } finally {
    await stopDaemon(first.daemon);
  }
  // Rewrite persisted state to simulate a 1h downtime gap.
  const w = readJson(watchPath);
  const entry = w.entries['owner/repo#42'];
  if (group === 'g4') {
    // First observation under a gap: drop the entry entirely.
    fs.writeFileSync(watchPath, JSON.stringify({ version: 1, entries: {} }));
  } else {
    entry.commentBaseline = iso(NOW - HOUR);
    entry.commentSince = iso(NOW - HOUR);
    entry.commentLastFetchAt = NOW - HOUR;
    fs.writeFileSync(watchPath, JSON.stringify(w));
  }
  const cursor = readJson(cursorPath) ?? { lastProcessedAt: iso(NOW - HOUR) };
  cursor.lastProcessedAt = iso(NOW - HOUR);
  cursor.lastPollAt = group === 'g2' ? iso(Date.now() - 5000) : iso(NOW - HOUR);
  fs.writeFileSync(cursorPath, JSON.stringify(cursor));
  console.log('[fixture] gap state rewritten; rebooting');
  // Stage 2: reboot and observe.
  let prompts = [];
  const second = startDaemon('daemon-stage2.log');
  try {
    await waitDaemon();
    if (expectMode === 'none') {
      await sleep(20000);
      prompts = boundPrompts(chatsDir);
    } else {
      const want =
        expectMode === 'digest' || expectMode === 'digest-full' ? 1 : 5;
      for (let i = 0; i < 120; i++) {
        prompts = boundPrompts(chatsDir);
        if (prompts.length >= want) break;
        await sleep(500);
      }
      await sleep(5000);
      prompts = boundPrompts(chatsDir);
    }
  } finally {
    await stopDaemon(second.daemon);
  }

  const watch = readJson(watchPath);
  const cursorAfter = readJson(cursorPath);
  const result = {
    group,
    expectMode,
    promptCount: prompts.length,
    prompts,
    commentSince: watch?.entries?.['owner/repo#42']?.commentSince,
    dispatchedComments: cursorAfter?.dispatchedComments ?? [],
  };
  fs.writeFileSync(
    path.join(ROOT, tag, 'result.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(`[fixture] bound prompts: ${prompts.length}`);

  const fail = (msg) => {
    console.error(`[fixture] FAIL: ${msg}`);
    process.exitCode = 1;
  };
  if (expectMode === 'individual') {
    if (prompts.length !== 5)
      fail(`expected 5 per-comment prompts, got ${prompts.length}`);
    if (prompts.some((p) => /offline|离线/.test(p)))
      fail('digest lead present in no-gap arm');
    // Pin WHICH comments arrived, not just the count: a wrong member set with
    // the right cardinality must fail too.
    for (let i = 1; i <= 5; i++)
      if (!prompts.some((p) => p.includes(`gap-comment-${i}`)))
        fail(`no-gap arm missing comment gap-comment-${i}`);
  } else if (expectMode === 'digest') {
    if (prompts.length !== 1)
      fail(`expected 1 digest prompt, got ${prompts.length}`);
    else {
      // Assert the whole lead: a bare /5/ also matches the member body and
      // URLs, so it could not fail on a wrong total count.
      if (!prompts[0].includes('Offline backlog: 5'))
        fail('digest lead missing total count 5');
      if (!prompts[0].includes('gap-comment-5'))
        fail('digest missing newest excerpt');
      // All five members fit the budget here, so every body must be present —
      // not just the newest one.
      for (let i = 1; i <= 4; i++)
        if (!prompts[0].includes(`gap-comment-${i}`))
          fail(`digest missing member gap-comment-${i}`);
    }
    for (let i = 1; i <= 5; i++)
      if (!result.dispatchedComments.includes(`IC_fixture_${i}`))
        fail(`member key IC_fixture_${i} not recorded`);
  } else if (expectMode === 'digest-full') {
    if (prompts.length !== 1)
      fail(`expected 1 digest prompt, got ${prompts.length}`);
    else {
      const p = prompts[0];
      if (!p.includes('Offline backlog: 20'))
        fail('digest missing total count 20');
      if (!p.includes('marker-19'))
        fail('newest member marker-19 lost to the body cap');
      if (!p.includes('issuecomment-319')) fail('newest member URL lost');
      if (p.includes('prompt truncated'))
        fail('shared body cap truncated the digest tail');
      if (!/comment\(s\) omitted/.test(p)) fail('omission notice missing');
    }
    if (!result.dispatchedComments.includes('IC_full_19'))
      fail('newest member key not recorded');
    if (result.dispatchedComments.includes('IC_full_0'))
      fail('omitted oldest member key recorded as delivered');
    // The omitted tail keeps the cursor held before the backlog head (the
    // oldest member sits ~1h back); a consumed cursor would sit near NOW.
    if (!(Date.parse(result.commentSince) < NOW - 30 * 60 * 1000))
      fail('digest-full cursor not held before the backlog head');
  } else if (expectMode === 'none') {
    if (prompts.length !== 0) fail(`expected 0 prompts, got ${prompts.length}`);
    if (!watch?.entries?.['owner/repo#42']?.commentBaseline)
      fail('first-observation baseline not written');
  } else {
    // Unreachable: expectMode is validated at parse. Guard anyway so the
    // assertion chain can never fall through and report PASS unverified.
    fail(`unknown --expect ${expectMode}`);
  }
  if (process.exitCode !== 1) console.log('[fixture] PASS');
  mock.close();
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error('[fixture] ERROR:', err.message);
  process.exit(1);
});
