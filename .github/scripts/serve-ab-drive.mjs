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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
 * Build the capture for one scenario.
 *
 * `_status` is always recorded, and always the HTTP status the harness saw: a
 * status-only change (404 → 409, say) under an otherwise similar body is
 * exactly the admission difference these scenarios exist to catch, so neither
 * a body nor a scenario projection can overwrite it with its own `_status`
 * key. A non-object body (scalar, null, array) is nested rather than spread —
 * spreading would drop a scalar and re-key an array — because the capture has
 * to survive whatever a future scenario probes.
 */
export function composeCapture(scenario, json, res) {
  if (scenario.project) {
    return { ...scenario.project(json, res), _status: res.status };
  }
  return isPlainObject(json)
    ? { ...json, _status: res.status }
    : { _status: res.status, _body: json };
}

/**
 * Empty a capture directory before a drive writes into it, so a re-run cannot
 * let an earlier run's files stand in for scenarios this run never captured.
 *
 * Guarded, because `outDir` comes straight off the command line and the
 * documented local usage invites a mistyped or reused path: only a directory
 * that already looks like a capture dir is deleted. In CI the capture dirs are
 * also cleared by an unconditional workflow step, which covers the runs where
 * an arm is skipped entirely and this function never executes at all.
 */
export function clearCaptureDir(outDir) {
  if (!existsSync(outDir)) return;
  const entries = readdirSync(outDir);
  const looksLikeCaptures = entries.every(
    (f) => f.endsWith('.json') || f === DRIVE_COMPLETE_MARKER,
  );
  if (!looksLikeCaptures) {
    throw new Error(
      `refusing to clear ${outDir}: it holds files that are not serve-ab captures (${entries
        .slice(0, 5)
        .join(', ')})`,
    );
  }
  rmSync(outDir, { recursive: true, force: true });
}

/**
 * Run every scenario against one daemon and write its capture.
 *
 * Extracted from {@link driveCli} so the ordering that matters can be tested
 * without a daemon: the completion marker is written only after the LAST
 * capture, so an abort part-way through leaves a capture dir the diff can
 * recognise as truncated. Moving that write into a `finally` — a plausible
 * "make sure the marker is always there" edit — would silently re-introduce the
 * misreport the marker exists to prevent.
 */
export async function captureScenarios(scenarios, { request, ctx, outDir }) {
  for (const s of scenarios) {
    // Stage on-disk state (transcripts) before anything is requested.
    s.fixtures?.(ctx);
    // Run any setup requests (e.g. create a session) before the capture.
    for (const step of s.setup ?? []) {
      const r = await request(step);
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
    const res = await request(s);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { _nonJson: text.slice(0, 500) };
    }
    const captured = composeCapture(s, json, res);
    writeFileSync(
      join(outDir, `${s.name}.json`),
      JSON.stringify(captured, null, 2) + '\n',
    );
    process.stderr.write(`  captured ${s.name} (HTTP ${res.status})\n`);
    // Checked AFTER the capture is written, so a deviating response is on
    // disk and in the log rather than lost to the abort.
    assertCanaryStatus(s, res.status, text, captured);
  }
  // Completion marker, written only once every scenario is captured. An abort
  // part-way through (a canary, a daemon crash) leaves a capture dir that LOOKS
  // like a full baseline, and the scenarios it never reached would render as
  // "this PR adds these responses". The diff treats a marker-less baseline as
  // degraded and says so. Not a `.json` file: the diff enumerates those as
  // scenarios.
  writeFileSync(join(outDir, DRIVE_COMPLETE_MARKER), '');
}

/**
 * A canary scenario asserts its own precondition and aborts the drive when it
 * fails — publishing "no response changes" from a scenario set that never
 * created the state it believed it was probing is the failure this whole
 * harness exists to prevent.
 *
 * Two shapes, because the two canaries guard different things:
 *
 * - `expectStatus` — the answer must be exactly this. For a precondition every
 *   later scenario shares (the project directory, the `chats` leaf, the fixture
 *   loading at all): if it moved, nothing below it means anything.
 * - `rejectStatus` — only this answer is a failure, anything else is data. For
 *   a precondition that just asks "did the daemon see the file I staged?": a
 *   404 says it did not, while any other answer proves it did and is a product
 *   decision worth capturing rather than a reason to suppress the whole report.
 * - `expectReplay` — the restore must carry at least one replay entry. A status
 *   check alone cannot see fixture rot: the product validates transcripts
 *   record by record and fails OPEN (an unrecognised record is skipped), so a
 *   fixture whose records stop validating restores as an EMPTY session and
 *   still answers 200. Every staged scenario would then probe an empty daemon
 *   identically on both arms and the A/B would report no changes.
 */
export function assertCanaryStatus(scenario, status, bodyText = '', captured) {
  const fail = (expectation) => {
    throw new Error(
      `scenario "${scenario.name}" ${expectation} but got ${status}: ${String(
        bodyText,
      ).slice(0, 300)}`,
    );
  };
  if (scenario.expectStatus !== undefined && status !== scenario.expectStatus) {
    fail(`expected HTTP ${scenario.expectStatus}`);
  }
  if (scenario.rejectStatus !== undefined && status === scenario.rejectStatus) {
    fail(`must not answer HTTP ${scenario.rejectStatus}`);
  }
  if (scenario.expectReplay && !(captured?._replayItems > 0)) {
    throw new Error(
      `scenario "${scenario.name}" restored an EMPTY transcript (_replayItems=${
        captured?._replayItems
      }). The staged fixture no longer validates against this build — record ` +
        `validation fails open, so every staged scenario below is probing an ` +
        `empty daemon and would diff clean.`,
    );
  }
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
  // sanitizeCwd lowercases on Windows only; the mirror must take the same
  // branch, or fixtures staged on one platform land where the daemon built
  // for the other one will never read them.
  const normalized =
    process.platform === 'win32' ? workspaceCwd.toLowerCase() : workspaceCwd;
  const projectId = normalized.replace(/[^a-zA-Z0-9]/g, '-');
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
    // Keeps a replay-size witness on top of the admission decision. The count
    // is stable (it is derived from the committed fixture), and it is the only
    // field in any capture that would move if the fixture stopped validating.
    project: (json, res) => ({
      ...admissionOnly(json, res),
      _replayItems: Array.isArray(json?.compactedReplay)
        ? json.compactedReplay.length
        : 0,
    }),
    expectStatus: 200,
    expectReplay: true,
  },
  {
    // Second canary, for the archive leaf. The healthy restore above certifies
    // the sanitized project directory, the `chats` leaf and the fixture; only
    // this one certifies that the daemon reads the `chats/archive` leaf the
    // harness writes to. Without it, a drifted archive name would leave the
    // active/archived conflict scenario below loading from active on both arms
    // — identical captures, and a conflict-admission regression diffing clean.
    //
    // `rejectStatus`, not `expectStatus`: the only answer that means "the
    // staged file was never seen" is 404. Today the daemon refuses an
    // archived-only load with 409, but if that ever becomes loadable the
    // precondition still held, and pinning the exact status would abort the
    // drive and suppress the very `409 → 200` row the captures already hold.
    name: 'session-restore-archived-only',
    fixtures: (ctx) =>
      stageTranscripts(ctx, [{ sessionId: SID.archivedOnly, archived: true }]),
    method: 'POST',
    path: `/session/${SID.archivedOnly}/load`,
    auth: true,
    body: () => ({}),
    project: admissionOnly,
    rejectStatus: 404,
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
    // An ordinary, currently-unreserved source type — a real one, not an
    // invented string: the daemon's own scheduler creates sessions under it.
    // Admitted today; the point is that a PR which starts reserving it shows
    // up here as 200 → 400 instead of diffing clean, which is how the harness
    // missed exactly that change once already.
    name: 'session-create-unreserved-source',
    method: 'POST',
    path: '/session',
    auth: true,
    body: () => ({ sourceType: 'scheduled_task', sourceId: 'serve-ab' }),
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
  clearCaptureDir(outDir);
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
    await captureScenarios(SCENARIOS, { request: doRequest, ctx, outDir });
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
