/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drive a built `qwen serve` daemon through a fixed scenario set and capture
 * each endpoint's JSON response to `<outDir>/<scenario>.json`. Run once against
 * the PR-base build and once against the PR-head build; serve-ab-diff.mjs then
 * diffs the two capture dirs per scenario.
 *
 * Deterministic + credential-free: `/health` needs no auth; `/capabilities`
 * uses the local `--token`. No model is contacted (dummy OpenAI creds), so the
 * responses are stable and safe to diff.
 *
 * A scenario may also stage ON-DISK state before its request (`fixtures`) and
 * capture a reduced projection of the response (`project`). Without staging,
 * every probe hits an empty daemon and the whole session-admission surface —
 * case resolution, transcript integrity, archive conflicts, reserved sources —
 * is unreachable, so a PR that rewrites it diffs as "no response changes".
 *
 *   node serve-ab-drive.mjs <cliEntry> <outDir>
 */

import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Written into a capture dir once every scenario has been captured. Its absence
 * means the drive aborted part-way and the dir is only a partial baseline.
 */
export const DRIVE_COMPLETE_MARKER = '.drive-complete';

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Where the daemon persists a workspace's transcripts: `Storage.getProjectDir()`
 * (`<runtimeBaseDir>/projects/<sanitized cwd>`) plus SessionService's `chats`
 * leaf, with `archive/` under it. Kept in lockstep with `sanitizeCwd()` in
 * packages/core/src/utils/paths.ts. The daemon canonicalizes its workspace
 * path, so realpath first (`/tmp` is a symlink on some runners).
 *
 * If this ever drifts from the product code the staged fixtures land nowhere
 * and every staged scenario would quietly answer 404 on BOTH arms — which is
 * why `session-restore-healthy` below is a hard-failing canary.
 */
export function chatsDirFor(home, workspaceCwd) {
  const projectId = workspaceCwd.replace(/[^a-zA-Z0-9]/g, '-');
  return join(home, '.qwen', 'projects', projectId, 'chats');
}

/**
 * The committed transcript fixture, recorded from a real CLI turn (a genuine
 * `user` + `assistant` record pair) rather than hand-written: the loader
 * rejects synthesized records that get details like `message.role` wrong, and a
 * fixture that fails to load would silently neuter every scenario below.
 */
export function readTranscriptFixture() {
  const raw = readFileSync(
    join(HERE, 'fixtures', 'serve-ab-session.jsonl'),
    'utf8',
  );
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Re-point the fixture records at one session id + workspace. */
export function retargetTranscript(records, sessionId, cwd) {
  return (
    records.map((r) => JSON.stringify({ ...r, sessionId, cwd })).join('\n') +
    '\n'
  );
}

// Session ids are hardcoded per scenario, never random: the base and head
// daemons run as separate processes, so a random id would differ between the
// two captures and diff as noise. Distinct ids also keep each scenario from
// attaching to a live entry a previous scenario left behind — an attach also
// answers 200 and would mask a restore-path difference.
export const SID = {
  healthy: 'a0000000-0000-4000-8000-00000000da01',
  mixedCase: 'A0000000-0000-4000-8000-00000000DA02',
  twins: 'A0000000-0000-4000-8000-00000000DA03',
  unreadable: 'a0000000-0000-4000-8000-00000000da04',
  archived: 'a0000000-0000-4000-8000-00000000da05',
  archivedOnly: 'a0000000-0000-4000-8000-00000000da06',
};

/** Stage transcripts for a scenario; returns nothing, throws on IO failure. */
function stageTranscripts(ctx, entries) {
  const chats = chatsDirFor(ctx.home, ctx.workspace);
  mkdirSync(join(chats, 'archive'), { recursive: true });
  const records = readTranscriptFixture();
  for (const e of entries) {
    const dir = e.archived ? join(chats, 'archive') : chats;
    const body =
      e.raw !== undefined
        ? e.raw
        : retargetTranscript(records, e.sessionId, ctx.workspace);
    writeFileSync(join(dir, `${e.sessionId}.jsonl`), body);
  }
}

// A restore answer is a decision, not a payload: keep the status and the error
// discriminator and drop the session snapshot, whose replay ids, epochs and
// per-record timestamps churn on every run and would bury the signal.
export const admissionOnly = (json, res) => ({
  _status: res.status,
  ...(json?.code === undefined ? {} : { code: json.code }),
  ...(json?.error === undefined ? {} : { error: json.error }),
});

// The fixed scenarios. `auth` sends the bearer token; anything mutating the
// daemon would push requests here in order.
export const SCENARIOS = [
  { name: 'health', method: 'GET', path: '/health', auth: false },
  { name: 'health-deep', method: 'GET', path: '/health?deep=1', auth: false },
  { name: 'capabilities', method: 'GET', path: '/capabilities', auth: true },
  {
    // Create one session, THEN probe deep health — exercises the session
    // lifecycle and the cross-workspace session aggregation (#6961's exact
    // case). Runs last so the earlier probes see the idle daemon. The volatile
    // `lastActivityAt` / `idleSinceMs` in the response are masked by
    // serve-ab-diff.mjs; the meaningful counts (sessions, pendingPermissions,
    // activePrompts, connectedClients, channelAlive) are stable.
    name: 'health-deep-with-session',
    setup: [
      {
        method: 'POST',
        path: '/session',
        auth: true,
        // Empty on purpose. `cwd` is omitted so the route falls back to the
        // daemon's bound workspace, which is already canonicalized; the
        // previous `workspaceCwd` and `clientId` keys were both inert (the
        // route reads `cwd`, and the client id only from `X-Qwen-Client-Id`),
        // and an inert key reads like a probe that identifies itself.
        body: () => ({}),
      },
    ],
    method: 'GET',
    path: '/health?deep=1',
    auth: true,
  },

  // --- session admission -----------------------------------------------
  // These run last so the probes above still see the daemon they saw before.
  // Each stages transcripts on disk first; without that the restore path only
  // ever answers "no such session" and its guards are unreachable.
  {
    // Canary. A healthy transcript under its exact spelling must restore. If
    // this stops answering 200 the fixture or the on-disk layout has drifted
    // and every scenario below is meaningless — so the drive fails loudly
    // instead of publishing a reassuring all-clear.
    name: 'session-restore-healthy',
    fixtures: (ctx) => stageTranscripts(ctx, [{ sessionId: SID.healthy }]),
    method: 'POST',
    path: `/session/${SID.healthy}/load`,
    auth: true,
    body: () => ({}),
    project: admissionOnly,
    expectStatus: 200,
  },
  {
    // Second canary, for the archive leaf. The healthy restore above certifies
    // the sanitized project directory, the `chats` leaf and the fixture; only
    // this one certifies that the daemon reads the `chats/archive` leaf the
    // harness writes to. Without it, a drifted archive name would leave the
    // active/archived conflict scenario below loading from active on both arms
    // — identical captures, and a conflict-admission regression diffing clean.
    name: 'session-restore-archived-only',
    fixtures: (ctx) =>
      stageTranscripts(ctx, [{ sessionId: SID.archivedOnly, archived: true }]),
    method: 'POST',
    path: `/session/${SID.archivedOnly}/load`,
    auth: true,
    body: () => ({}),
    project: admissionOnly,
    expectStatus: 409,
  },
  {
    // Legacy `uuidgen` spelling: only the uppercase file exists, the caller
    // asks in lowercase.
    name: 'session-restore-mixed-case',
    fixtures: (ctx) => stageTranscripts(ctx, [{ sessionId: SID.mixedCase }]),
    method: 'POST',
    path: `/session/${SID.mixedCase.toLowerCase()}/load`,
    auth: true,
    body: () => ({}),
    project: admissionOnly,
  },
  {
    // Two persisted spellings of one id — possible on any case-sensitive
    // filesystem, which is what CI runs on.
    name: 'session-restore-case-twins',
    fixtures: (ctx) =>
      stageTranscripts(ctx, [
        { sessionId: SID.twins },
        { sessionId: SID.twins.toLowerCase() },
      ]),
    method: 'POST',
    path: `/session/${SID.twins.toLowerCase()}/load`,
    auth: true,
    body: () => ({}),
    project: admissionOnly,
  },
  {
    // Crash-shaped damage: nothing in the head of the file parses.
    name: 'session-restore-unreadable',
    fixtures: (ctx) =>
      stageTranscripts(ctx, [
        { sessionId: SID.unreadable, raw: 'not json at all\n{"broken":\n' },
      ]),
    method: 'POST',
    path: `/session/${SID.unreadable}/load`,
    auth: true,
    body: () => ({}),
    project: admissionOnly,
  },
  {
    // The same id persisted in both the active and the archive directory.
    name: 'session-restore-active-and-archived',
    fixtures: (ctx) =>
      stageTranscripts(ctx, [
        { sessionId: SID.archived },
        { sessionId: SID.archived, archived: true },
      ]),
    method: 'POST',
    path: `/session/${SID.archived}/load`,
    auth: true,
    body: () => ({}),
    project: admissionOnly,
  },
  {
    // The source today's daemon actually reserves: `default` +
    // `realtime_voice:`, refused with 400 reserved_session_source. This is the
    // scenario that pins the existing refusal — rewrite the predicate or the
    // response and it moves.
    name: 'session-create-reserved-source',
    method: 'POST',
    path: '/session',
    auth: true,
    body: () => ({
      sourceType: 'default',
      sourceId: 'realtime_voice:serve-ab',
    }),
    project: admissionOnly,
  },
  {
    // An ordinary, currently-unreserved source type. Admitted today; the point
    // is that a PR which starts reserving one shows up here as 200 → 400
    // instead of diffing clean, which is how the harness missed exactly that
    // change once already.
    name: 'session-create-unreserved-source',
    method: 'POST',
    path: '/session',
    auth: true,
    body: () => ({ sourceType: 'standalone' }),
    project: admissionOnly,
  },
];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`daemon did not become healthy within ${timeoutMs}ms`);
}

export async function driveCli(cliEntry, outDir) {
  // Start from an empty dir: a re-run (or a reused capture path) must not let
  // an earlier run's files stand in for scenarios this run never captured.
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), 'serve-ab-home-'));
  const token = 'serve-ab-token';
  const port = await freePort();
  const daemon = spawn(
    'node',
    [
      cliEntry,
      'serve',
      '--port',
      String(port),
      '--token',
      token,
      '--hostname',
      '127.0.0.1',
      '--workspace',
      home,
    ],
    {
      // No real model: dummy OpenAI creds so session auth never contacts a
      // backend. HOME/QWEN_HOME isolate any on-disk state per run.
      env: {
        ...process.env,
        HOME: home,
        QWEN_HOME: join(home, '.qwen'),
        OPENAI_API_KEY: 'fake-key',
        OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
        OPENAI_MODEL: 'fake-model',
        QWEN_MODEL: 'fake-model',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
  const base = `http://127.0.0.1:${port}`;
  // The daemon canonicalizes `--workspace`, and the on-disk project directory
  // is derived from that canonical path — so fixtures must be staged under the
  // realpath, not the (possibly symlinked) mkdtemp path.
  const workspace = realpathSync(home);
  const ctx = { home, workspace };
  try {
    await waitForHealth(base);
    const doRequest = (spec) => {
      const headers = spec.auth ? { Authorization: `Bearer ${token}` } : {};
      let body;
      if (spec.body) {
        headers['Content-Type'] = 'application/json';
        const b = typeof spec.body === 'function' ? spec.body(ctx) : spec.body;
        body = JSON.stringify(b);
      }
      return fetch(`${base}${spec.path}`, {
        method: spec.method,
        headers,
        body,
      });
    };
    for (const s of SCENARIOS) {
      // Stage on-disk state (transcripts) before anything is requested.
      s.fixtures?.(ctx);
      // Run any setup requests (e.g. create a session) before the capture.
      for (const step of s.setup ?? []) {
        const r = await doRequest(step);
        // A failed setup (e.g. POST /session non-2xx) would let the capture
        // reflect wrong state (0 sessions) and silently mask or fake a diff —
        // fail loudly instead.
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          throw new Error(
            `setup ${step.method} ${step.path} failed (HTTP ${r.status}) for "${s.name}": ${body.slice(0, 200)}`,
          );
        }
      }
      const res = await doRequest(s);
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { _nonJson: text.slice(0, 500) };
      }
      // `_status` is always recorded: a status-only change (404 → 409, say)
      // with an otherwise similar body is exactly the kind of admission
      // difference these scenarios exist to catch. A non-object body (scalar,
      // null, array) is nested rather than spread, which would drop or re-key
      // it — the capture has to survive whatever a future scenario probes.
      const captured = s.project
        ? s.project(json, res)
        : isPlainObject(json)
          ? { _status: res.status, ...json }
          : { _status: res.status, _body: json };
      writeFileSync(
        join(outDir, `${s.name}.json`),
        JSON.stringify(captured, null, 2) + '\n',
      );
      process.stderr.write(`  captured ${s.name} (HTTP ${res.status})\n`);
      // A canary scenario asserts its own precondition. Checked AFTER the
      // capture is written, so the deviating response is on disk and in the
      // log rather than lost to the abort. Failing beats publishing "no
      // response changes" from a scenario set that never created the state it
      // believed it was probing.
      if (s.expectStatus !== undefined && res.status !== s.expectStatus) {
        throw new Error(
          `scenario "${s.name}" expected HTTP ${s.expectStatus} but got ${res.status}: ${text.slice(0, 300)}`,
        );
      }
    }
    // Completion marker. An abort part-way through (a canary, a daemon crash)
    // leaves a capture dir that LOOKS like a full baseline, and the scenarios
    // it never reached would render as "this PR adds these responses". The
    // diff treats a marker-less baseline as degraded and says so. Not a
    // `.json` file: the diff enumerates those as scenarios.
    writeFileSync(join(outDir, DRIVE_COMPLETE_MARKER), '');
  } finally {
    daemon.kill('SIGTERM');
    // Await exit so a hung daemon (pending async / open WebSockets) can't
    // linger; escalate to SIGKILL if it doesn't stop promptly.
    await new Promise((resolve) => {
      daemon.on('exit', resolve);
      setTimeout(() => {
        daemon.kill('SIGKILL');
        resolve();
      }, 5000);
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cliEntry, outDir] = process.argv.slice(2);
  if (!cliEntry || !outDir) {
    process.stderr.write('usage: serve-ab-drive.mjs <cliEntry> <outDir>\n');
    process.exit(2);
  }
  driveCli(cliEntry, outDir).catch((e) => {
    process.stderr.write(`${e?.stack ?? e}\n`);
    process.exit(1);
  });
}
