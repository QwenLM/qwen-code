#!/usr/bin/env node
// PR-watch + bound-session (slice 1, private-only) hermetic E2E.
// Real CLI process (node dist/cli.js channel managed-github) + real Octokit
// against a local fake GitHub whose PR/CI state the test mutates, plus a
// recording fake control plane that mirrors the pr-watch wire shapes of
// managed-channel-client.ts and derives the idempotent input id with the REAL
// core prWatchInputId (cross-language parity witness). No real GitHub, no real
// ~/.qwen, no daemon. Run from the repo root after build+bundle:
//   node scripts/run-managed-pr-watch-e2e.mjs
//
// Coverage: G1 binding-driven observation + baseline; G3 ci_failure /
// head_change / merge_conflict detection with durable episode; G2 inject
// idempotency + SIGKILL crash-replay (same derived input id, replayed); G5
// private-only (never a public comment, never a channel_delivery); terminal
// merged/closed PR drives no transition and retires its binding. G4 dormant
// wake is the Harness/Java funnel, covered by ManagedPrWatchServiceTest and the
// Harness unit suites, not this adapter<->control-plane wire rig.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prWatchInputId } from '../packages/core/dist/src/managed-runtime/managed-pr-watch-operations.js';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');
const cli = join(repoRoot, 'dist', 'cli.js');
const TENANT = 't1';
const CHANNEL = 'gh-e2e';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const cleanups = [];
const failures = [];
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok ${label}`);
  } else {
    failures.push(label);
    console.log(
      `  FAIL ${label}${detail ? ` — ${JSON.stringify(detail)}` : ''}`,
    );
  }
}
function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function inputIdFor(body) {
  return prWatchInputId({
    tenantId: TENANT,
    channelInstanceId: CHANNEL,
    owner: body.owner,
    repo: body.repo,
    prNumber: body.prNumber,
    transition: body.transition,
    headSha: body.headSha,
    episode: body.episode,
  });
}

// The mutable PR the fake GitHub serves. The test flips headSha / mergeableState
// / checks between ticks to drive edge-triggered transitions.
function prState(overrides = {}) {
  return {
    headSha: SHA_A,
    mergeable: true,
    mergeableState: 'clean',
    state: 'open',
    checks: [{ name: 'build', status: 'completed', conclusion: 'success' }],
    combinedState: 'success',
    combinedCount: 1,
    ...overrides,
  };
}

async function fakeGithub(pr) {
  const state = {
    pr,
    posted: [],
    pullsGets: 0,
    ciReads: 0,
    ciRefs: [],
    statusRefs: [],
    journal: [],
    port: 0,
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const send = (status, body, headers = {}) => {
        res.writeHead(status, {
          'content-type': 'application/json',
          ...headers,
        });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && url.pathname === '/user') {
        return send(200, { login: 'bot-user' });
      }
      if (req.method === 'GET' && url.pathname === '/notifications') {
        // No @mention inbound: this rig isolates the PR-watch path.
        return send(200, [], { 'x-poll-interval': '1' });
      }
      const pullMatch = url.pathname.match(/^\/repos\/Owner\/Repo\/pulls\/7$/);
      if (req.method === 'GET' && pullMatch) {
        state.pullsGets += 1;
        state.journal.push('pulls.get');
        return send(200, {
          number: 7,
          state: state.pr.state,
          head: { sha: state.pr.headSha },
          mergeable: state.pr.mergeable,
          mergeable_state: state.pr.mergeableState,
        });
      }
      const checksMatch = url.pathname.match(
        /^\/repos\/Owner\/Repo\/commits\/([0-9a-f]+)\/check-runs$/,
      );
      if (req.method === 'GET' && checksMatch) {
        state.ciReads += 1;
        state.ciRefs.push(checksMatch[1]);
        state.journal.push('checks');
        return send(200, {
          total_count: state.pr.checks.length,
          check_runs: state.pr.checks,
        });
      }
      const statusMatch = url.pathname.match(
        /^\/repos\/Owner\/Repo\/commits\/([0-9a-f]+)\/status$/,
      );
      if (req.method === 'GET' && statusMatch) {
        state.statusRefs.push(statusMatch[1]);
        return send(200, {
          state: state.pr.combinedState,
          total_count: state.pr.combinedCount,
          statuses: [],
        });
      }
      if (
        req.method === 'POST' &&
        url.pathname === '/repos/Owner/Repo/issues/7/comments'
      ) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        state.posted.push(body.body);
        state.journal.push('postComment');
        return send(201, { id: 9000 + state.posted.length });
      }
      return send(404, { message: `unexpected ${req.method} ${url.pathname}` });
    });
  });
  const port = await listen(server);
  state.port = port;
  cleanups.push(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return { baseUrl: `http://127.0.0.1:${port}`, state };
}

async function fakeControlPlane(opts = {}) {
  const state = {
    register: [],
    disconnects: 0,
    injects: [],
    injectSeen: 0,
    retires: [],
    admitted: new Set(opts.preadmitted ?? []),
    queue: [],
    deliveriesServed: 0,
    claims: 0,
    journal: [],
    injectDelayMs: opts.injectDelayMs ?? 0,
    bindings: opts.bindings ?? [
      {
        owner: 'Owner',
        repo: 'Repo',
        prNumber: 7,
        sessionId: 'session-1',
        events: ['ci_failure', 'merge_conflict', 'head_change'],
      },
    ],
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const root = `/internal/managed-channels/v1/channels/${CHANNEL}`;
      if (req.method === 'PUT' && url.pathname === root) {
        state.register.push(body);
        state.journal.push('register');
        return send(200, {});
      }
      if (req.method === 'POST' && url.pathname === `${root}/disconnect`) {
        state.disconnects += 1;
        return send(200, {});
      }
      if (req.method === 'POST' && url.pathname === `${root}/pr-watch:list`) {
        return send(200, { bindings: state.bindings });
      }
      if (req.method === 'POST' && url.pathname === `${root}/pr-watch:retire`) {
        state.journal.push('retire');
        const before = state.bindings.length;
        state.bindings = state.bindings.filter(
          (b) =>
            !(
              b.owner === body.owner &&
              b.repo === body.repo &&
              b.prNumber === body.prNumber
            ),
        );
        if (state.bindings.length === before) {
          return send(404, { error: { code: 'pr_watch_binding_not_found' } });
        }
        state.retires.push(body);
        return send(200, {});
      }
      if (req.method === 'POST' && url.pathname === `${root}/pr-watch:inject`) {
        state.injectSeen += 1;
        state.journal.push('inject');
        const answer = () => {
          const inputId = inputIdFor(body);
          const replayed = state.admitted.has(inputId);
          state.admitted.add(inputId);
          state.injects.push({ ...body, inputId, replayed });
          // Private-only: a pr_event input plans NO channel_delivery.
          return send(200, {
            inputId,
            turnId: `turn-${state.injects.length}`,
            sessionId: 'session-1',
            bindingId: `prb-${inputId.slice(4, 20)}`,
            replayed,
          });
        };
        if (state.injectDelayMs > 0) setTimeout(answer, state.injectDelayMs);
        else answer();
        return;
      }
      if (
        req.method === 'POST' &&
        url.pathname === `${root}/deliveries:claim`
      ) {
        // The queue is never written, so deliveriesServed alone is identically
        // 0; counting claims witnesses that the adapter actually polled the
        // delivery lane (the half of private-only that can otherwise not fail).
        state.claims += 1;
        const claimed = state.queue.splice(0);
        state.deliveriesServed += claimed.length;
        return send(200, { deliveries: claimed });
      }
      if (req.method === 'POST' && url.pathname === `${root}/inbound`) {
        return send(200, {
          inputId: 'chin-x',
          sessionId: 'session-1',
          replayed: false,
        });
      }
      return send(404, { error: { code: 'not_found' } });
    });
  });
  const port = await listen(server);
  cleanups.push(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return { baseUrl: `http://127.0.0.1:${port}`, state };
}

function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), 'mgh-prw-cwd-'));
  const home = mkdtempSync(join(tmpdir(), 'mgh-prw-home-'));
  mkdirSync(join(cwd, '.qwen'), { recursive: true });
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return { cwd, home };
}
function writeSettings(ws, gh) {
  writeFileSync(
    join(ws.cwd, '.qwen', 'settings.json'),
    JSON.stringify(
      {
        channels: {
          [CHANNEL]: {
            type: 'github',
            token: 'ghp_e2e_token',
            baseUrl: gh.baseUrl,
            pollInterval: 1000,
            allowedUsers: ['alice'],
          },
        },
      },
      null,
      2,
    ),
  );
}
function startCli(ws, controlPlaneUrl) {
  const child = spawn(
    process.execPath,
    [
      cli,
      'channel',
      'managed-github',
      CHANNEL,
      '--control-plane',
      controlPlaneUrl,
      '--tenant',
      TENANT,
      '--actor',
      'owner',
      '--workspace',
      'ws-1',
      '--cwd',
      ws.cwd,
    ],
    {
      cwd: ws.cwd,
      env: { ...process.env, QWEN_HOME: ws.home },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c.toString()));
  child.stdout.on('data', () => {});
  cleanups.push(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  return { child, stderr: () => stderr };
}
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timeout waiting for ${label}`);
}
function stateFile(ws) {
  const channelsDir = join(ws.home, 'channels');
  if (!existsSync(channelsDir)) return null;
  for (const scope of readdirSync(channelsDir)) {
    const base = join(channelsDir, scope);
    for (const entry of readdirSync(base)) {
      if (entry.startsWith('github-')) {
        const file = join(base, entry, 'managed-state.json');
        if (existsSync(file)) return file;
      }
    }
  }
  return null;
}
function watchEntry(ws) {
  const file = stateFile(ws);
  if (!file) return undefined;
  const state = JSON.parse(readFileSync(file, 'utf8'));
  return state.watch?.prs?.['owner/repo#7'];
}

async function scenarioP1() {
  console.log(
    'Scenario P1: baseline → ci_failure, episode 1, private-only, id parity',
  );
  const gh = await fakeGithub(prState());
  const cp = await fakeControlPlane();
  const ws = workspace();
  writeSettings(ws, gh);
  const proc = startCli(ws, cp.baseUrl);
  // First observation establishes the baseline (no injection).
  await waitFor(
    () => watchEntry(ws)?.headSha === SHA_A && !watchEntry(ws)?.pending?.length,
    60_000,
    'baseline persisted',
  ).catch((e) => {
    console.log(proc.stderr());
    throw e;
  });
  check(
    'register platform=github accountId=bot-user',
    cp.state.register[0]?.platform === 'github' &&
      cp.state.register[0]?.accountId === 'bot-user',
    cp.state.register[0],
  );
  check(
    'baseline fired nothing',
    cp.state.injects.length === 0,
    cp.state.injects,
  );
  // Flip CI to failing on the same head.
  gh.state.pr.checks = [
    { name: 'build', status: 'completed', conclusion: 'failure' },
  ];
  await waitFor(
    () => cp.state.injects.length >= 1,
    60_000,
    'ci_failure inject',
  ).catch((e) => {
    console.log(proc.stderr());
    throw e;
  });
  const inj = cp.state.injects[0];
  check(
    'ci_failure transition on head A',
    inj.transition === 'ci_failure' && inj.headSha === SHA_A,
    inj,
  );
  check('episode starts at 1', inj.episode === 1, inj);
  check(
    'binding identity carried',
    inj.owner === 'Owner' && inj.repo === 'Repo' && inj.prNumber === 7,
    inj,
  );
  check(
    'evidence names the failed check',
    /CI failed/.test(inj.evidence) && /build/.test(inj.evidence),
    inj.evidence,
  );
  check(
    'text is the model-facing prompt',
    typeof inj.text === 'string' &&
      inj.text.includes('Owner/Repo#7') &&
      inj.text.includes('ci_failure') &&
      inj.text.includes(SHA_A) &&
      inj.evidence.length > 0 &&
      !inj.text.includes(inj.evidence),
    inj.text,
  );
  // Independent witness: the id the adapter's fields derive must equal the
  // expected identity for THIS known transition (not a re-derivation of the
  // same recorded body, which would be tautological).
  const expectedId = prWatchInputId({
    tenantId: TENANT,
    channelInstanceId: CHANNEL,
    owner: 'Owner',
    repo: 'Repo',
    prNumber: 7,
    transition: 'ci_failure',
    headSha: SHA_A,
    episode: 1,
  });
  check(
    'input id equals the expected derived identity',
    inj.inputId === expectedId && /^prw-[0-9a-f]{64}:input$/.test(inj.inputId),
    { got: inj.inputId, expectedId },
  );
  check('first admission not replayed', inj.replayed === false, inj);
  check(
    'PRIVATE-ONLY: no public comment posted',
    gh.state.posted.length === 0,
    gh.state.posted,
  );
  check(
    'PRIVATE-ONLY: delivery lane ran and served nothing',
    cp.state.claims > 0 && cp.state.deliveriesServed === 0,
    { claims: cp.state.claims, deliveriesServed: cp.state.deliveriesServed },
  );
  // The CI read must target the head the adapter reports, not an arbitrary
  // ref: every recorded check-runs ref equals the injected head.
  check(
    'CI read for the reported head',
    gh.state.ciRefs.length > 0 && gh.state.ciRefs.every((r) => r === SHA_A),
    gh.state.ciRefs,
  );
  // The fired pin keeps ci_failure once-per-head: a flapping aggregate on the
  // same head must not re-fire, and the pin must also suppress the CI re-read.
  const ciReadsAfterFire = gh.state.ciReads;
  gh.state.pr.checks = [
    { name: 'build', status: 'completed', conclusion: 'success' },
  ];
  await new Promise((r) => setTimeout(r, 2500));
  gh.state.pr.checks = [
    { name: 'build', status: 'completed', conclusion: 'failure' },
  ];
  await new Promise((r) => setTimeout(r, 2500));
  check(
    'ci_failure once-per-head (flap does not re-fire)',
    cp.state.injects.length === 1,
    cp.state.injects,
  );
  check(
    'once-per-head pin suppresses the CI re-read on the same head',
    gh.state.ciReads === ciReadsAfterFire,
    { ciReadsAfterFire, now: gh.state.ciReads },
  );
  proc.child.kill('SIGTERM');
  await waitFor(() => proc.child.exitCode !== null, 30_000, 'cli exit');
  check(
    'disconnect on SIGTERM',
    cp.state.disconnects === 1,
    cp.state.disconnects,
  );
}

async function scenarioP2() {
  console.log(
    'Scenario P2: head_change + ci_failure + merge_conflict, episodes increment',
  );
  const gh = await fakeGithub(prState());
  const cp = await fakeControlPlane();
  const ws = workspace();
  writeSettings(ws, gh);
  const proc = startCli(ws, cp.baseUrl);
  await waitFor(
    () => watchEntry(ws)?.headSha === SHA_A && !watchEntry(ws)?.pending?.length,
    60_000,
    'baseline persisted',
  ).catch((e) => {
    console.log(proc.stderr());
    throw e;
  });
  // One tick: new head, failing CI on the new head, and a merge conflict.
  gh.state.pr.headSha = SHA_B;
  gh.state.pr.mergeableState = 'dirty';
  gh.state.pr.mergeable = false;
  gh.state.pr.checks = [
    { name: 'build', status: 'completed', conclusion: 'failure' },
  ];
  await waitFor(
    () => cp.state.injects.length >= 3,
    60_000,
    'three transitions',
  ).catch((e) => {
    console.log(proc.stderr());
    throw e;
  });
  const byTransition = Object.fromEntries(
    cp.state.injects.map((i) => [i.transition, i]),
  );
  check(
    'all three transitions detected',
    ['head_change', 'ci_failure', 'merge_conflict'].every(
      (t) => byTransition[t],
    ),
    cp.state.injects.map((i) => i.transition),
  );
  check(
    'episodes are 1,2,3 (durable counter)',
    cp.state.injects
      .map((i) => i.episode)
      .sort()
      .join(',') === '1,2,3',
    cp.state.injects.map((i) => i.episode),
  );
  check(
    'head_change carries the new head',
    byTransition.head_change?.headSha === SHA_B,
    byTransition.head_change,
  );
  check(
    'head_change evidence names old→new',
    byTransition.head_change?.evidence.includes(SHA_A) &&
      byTransition.head_change?.evidence.includes(SHA_B),
    byTransition.head_change?.evidence,
  );
  check(
    'ci_failure re-arms on the new head',
    byTransition.ci_failure?.headSha === SHA_B,
    byTransition.ci_failure,
  );
  check(
    'merge_conflict evidence cites dirty',
    /dirty/.test(byTransition.merge_conflict?.evidence ?? ''),
    byTransition.merge_conflict?.evidence,
  );
  check(
    'each inject id is distinct (episode in identity)',
    new Set(cp.state.injects.map((i) => i.inputId)).size === 3,
    cp.state.injects.map((i) => i.inputId),
  );
  check(
    'PRIVATE-ONLY: no public comment',
    gh.state.posted.length === 0,
    gh.state.posted,
  );
  proc.child.kill('SIGTERM');
  await waitFor(() => proc.child.exitCode !== null, 30_000, 'cli exit');
}

async function scenarioP3() {
  console.log(
    'Scenario P3: SIGKILL between persist and inject answer → idempotent replay',
  );
  const gh = await fakeGithub(prState());
  const cp1 = await fakeControlPlane({ injectDelayMs: 15_000 });
  const ws = workspace();
  writeSettings(ws, gh);
  const proc1 = startCli(ws, cp1.baseUrl);
  await waitFor(
    () => watchEntry(ws)?.headSha === SHA_A && !watchEntry(ws)?.pending?.length,
    60_000,
    'baseline persisted',
  ).catch((e) => {
    console.log(proc1.stderr());
    throw e;
  });
  gh.state.pr.checks = [
    { name: 'build', status: 'completed', conclusion: 'failure' },
  ];
  // The inject is in flight (answer delayed past the kill); the pending entry
  // is already durable because observePr persists before any injection.
  await waitFor(
    () => cp1.state.injectSeen >= 1,
    60_000,
    'inject in flight',
  ).catch((e) => {
    console.log(proc1.stderr());
    throw e;
  });
  const entry = watchEntry(ws);
  check(
    'pending persisted before inject answer',
    entry?.pending?.length === 1 &&
      entry.pending[0].transition === 'ci_failure',
    entry?.pending,
  );
  const pending = entry.pending[0];
  const replayId = inputIdFor(pending);
  check('pending carries a durable episode', pending.episode >= 1, pending);
  proc1.child.kill('SIGKILL');
  await waitFor(
    () => proc1.child.exitCode !== null || proc1.child.signalCode !== null,
    10_000,
    'kill',
  );
  // A SIGKILLed holder leaves its lock; proper-lockfile reaps it after the
  // stale window (default 10s). Wait it out (mgh-g2 hygiene).
  await new Promise((r) => setTimeout(r, 12_000));

  // The replacement control plane already holds the admission (committed,
  // answer lost): the re-drive must derive the SAME id and replay.
  const cp2 = await fakeControlPlane({ preadmitted: [replayId] });
  const proc2 = startCli(ws, cp2.baseUrl);
  await waitFor(
    () => cp2.state.injects.length >= 1,
    60_000,
    're-driven inject',
  ).catch((e) => {
    console.log(proc2.stderr());
    throw e;
  });
  const inj = cp2.state.injects[0];
  check(
    're-drive sent the identical event',
    inj.transition === pending.transition &&
      inj.headSha === pending.headSha &&
      inj.episode === pending.episode,
    { inj, pending },
  );
  check('re-drive derived the SAME input id', inj.inputId === replayId, {
    got: inj.inputId,
    want: replayId,
  });
  check(
    'control plane replayed (no second admission)',
    inj.replayed === true,
    inj,
  );
  check(
    'PRIVATE-ONLY across the crash: no public comment',
    gh.state.posted.length === 0,
    gh.state.posted,
  );
  // The pending drained and the fired key recorded after the replay.
  await waitFor(
    () => !watchEntry(ws)?.pending?.length,
    30_000,
    'pending drained',
  );
  check(
    'pending drained after replay',
    (watchEntry(ws)?.pending?.length ?? 0) === 0,
    watchEntry(ws)?.pending,
  );
  proc2.child.kill('SIGTERM');
  await waitFor(() => proc2.child.exitCode !== null, 30_000, 'cli exit');
}

async function scenarioP4() {
  console.log(
    'Scenario P4: merged/closed PR is terminal — no injection, binding retired',
  );
  const gh = await fakeGithub(prState());
  const cp = await fakeControlPlane();
  const ws = workspace();
  writeSettings(ws, gh);
  const proc = startCli(ws, cp.baseUrl);
  await waitFor(
    () => watchEntry(ws)?.headSha === SHA_A && !watchEntry(ws)?.pending?.length,
    60_000,
    'baseline persisted',
  ).catch((e) => {
    console.log(proc.stderr());
    throw e;
  });
  // Merge the PR and flip CI to failing: a check concluding after the merge
  // must not drive a CI-failure turn, and the binding must be retired so the
  // PR stops consuming an observation slot and can be rebound.
  gh.state.pr.state = 'closed';
  gh.state.pr.checks = [
    { name: 'build', status: 'completed', conclusion: 'failure' },
  ];
  await waitFor(
    () => cp.state.retires.length >= 1,
    60_000,
    'terminal retire',
  ).catch((e) => {
    console.log(proc.stderr());
    throw e;
  });
  check(
    'terminal PR drove no injection',
    cp.state.injects.length === 0,
    cp.state.injects,
  );
  check(
    'terminal PR binding retired',
    cp.state.retires.length === 1 && cp.state.retires[0].prNumber === 7,
    cp.state.retires,
  );
  check(
    'PRIVATE-ONLY: no public comment',
    gh.state.posted.length === 0,
    gh.state.posted,
  );
  // The binding is gone, so the watch prunes the baseline and stops observing.
  await waitFor(
    () => watchEntry(ws) === undefined,
    30_000,
    'baseline pruned after retire',
  );
  check(
    'baseline pruned after retire',
    watchEntry(ws) === undefined,
    watchEntry(ws),
  );
  proc.child.kill('SIGTERM');
  await waitFor(() => proc.child.exitCode !== null, 30_000, 'cli exit');
}

try {
  await scenarioP1();
  await scenarioP2();
  await scenarioP3();
  await scenarioP4();
} finally {
  for (const cleanup of cleanups.reverse())
    await Promise.resolve(cleanup()).catch(() => {});
}
if (failures.length > 0) {
  console.log(
    `\nPR-WATCH E2E FAILED: ${failures.length} check(s): ${failures.join('; ')}`,
  );
  process.exit(1);
}
console.log('\nPR-WATCH E2E PASSED: all checks green');
