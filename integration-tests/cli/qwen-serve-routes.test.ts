/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `qwen serve` daemon — HTTP route + middleware integration tests.
 *
 * These exercise the daemon end-to-end without needing a working model
 * credential: they spawn a real `node packages/cli/dist/index.js serve`
 * (which itself spawns real `qwen --acp` children), then probe the HTTP
 * surface. The agent's `initialize` + `newSession` handshake works
 * without auth, so session creation, listing, cancellation, validation,
 * SSE wiring, the CORS guard, the bearer-auth guard and shutdown all
 * run here.
 *
 * Tests that require an actual model call (streaming prompts, real
 * permission flows, Last-Event-ID resume across a real reconnect) live
 * in `qwen-serve-streaming.test.ts` and skip when no auth is set.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DaemonClient,
  DaemonHttpError,
  type DaemonSessionSummary,
} from '@qwen-code/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Match the rest of the integration suite: prefer the bundled CLI
// path that `globalSetup.ts` configures via `TEST_CLI_PATH` (root
// `dist/cli.js`), falling back to the per-package output for direct
// `vitest run integration-tests/...` invocations that bypass
// globalSetup. Without this two-tier resolution the suite became
// sensitive to which build step (`npm run build` vs `npm run bundle`)
// last ran.
const CLI_BIN =
  process.env['TEST_CLI_PATH'] ??
  path.resolve(__dirname, '../../packages/cli/dist/index.js');
const TOKEN = 'integration-test-token';
const REPO_ROOT = path.resolve(__dirname, '../..');

let daemon: ChildProcess;
let port = 0;
let base = '';
let client: DaemonClient;

beforeAll(async () => {
  daemon = spawn(
    process.execPath,
    [
      CLI_BIN,
      'serve',
      '--port',
      '0',
      '--token',
      TOKEN,
      '--hostname',
      '127.0.0.1',
      // Per #3803 §02 (1 daemon = 1 workspace), pin the bound
      // workspace so test assertions that POST `workspaceCwd:
      // REPO_ROOT` succeed regardless of where the test runner
      // happens to be cwd'd. Without this the daemon would inherit
      // the test runner's cwd, which is brittle across CI / local
      // / IDE-launcher environments.
      '--workspace',
      REPO_ROOT,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // Read stdout until we see the listening line + parse the port.
  port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    // Capture the timeout handle so we can clear it on success — an
    // un-cleared 10s timer outlives the spawn promise and keeps the
    // vitest event loop alive past the test, manifesting as
    // intermittent `Test timed out` retries on slow CI.
    const bootTimer = setTimeout(
      () => reject(new Error('daemon boot timeout')),
      10_000,
    );
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        daemon.stdout?.off('data', onData);
        clearTimeout(bootTimer);
        resolve(Number(m[1]));
      }
    };
    daemon.stdout!.on('data', onData);
    daemon.once('exit', (c) => {
      clearTimeout(bootTimer);
      reject(new Error(`daemon exited with ${c}`));
    });
  });
  base = `http://127.0.0.1:${port}`;
  client = new DaemonClient({ baseUrl: base, token: TOKEN });
}, 30_000);

afterAll(async () => {
  if (!daemon || daemon.exitCode !== null) return;
  daemon.kill('SIGTERM');
  await new Promise((r) => daemon.once('exit', r));
}, 15_000);

describe('qwen serve — bearer auth (timing-safe compare)', () => {
  // Probe `/capabilities` for the rejection cases instead of `/health`
  // — `/health` is intentionally registered before the bearer middleware
  // so liveness probes work without credentials. `/capabilities` is the
  // cheapest route still gated by the bearer chain.
  it('right token → 200', async () => {
    const res = await fetch(`${base}/capabilities`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it('wrong same-length token → 401', async () => {
    const res = await fetch(`${base}/capabilities`, {
      headers: { Authorization: `Bearer ${'X'.repeat(TOKEN.length)}` },
    });
    expect(res.status).toBe(401);
  });

  it('wrong shorter token → 401', async () => {
    const res = await fetch(`${base}/capabilities`, {
      headers: { Authorization: 'Bearer x' },
    });
    expect(res.status).toBe(401);
  });

  it('missing Authorization header → 401', async () => {
    const res = await fetch(`${base}/capabilities`);
    expect(res.status).toBe(401);
  });

  it('Basic scheme (not Bearer) → 401', async () => {
    const res = await fetch(`${base}/capabilities`, {
      headers: { Authorization: `Basic ${TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it('/health exempt: missing Authorization header → 200', async () => {
    // Locks the auth-bypass exemption documented in
    // docs/developers/qwen-serve-protocol.md so a future middleware
    // ordering change can't silently break liveness probes.
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('qwen serve — CORS browser-origin denial', () => {
  it('GET with Origin header → 403 + JSON', async () => {
    const res = await fetch(`${base}/health`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: 'https://evil.example.com',
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({
      error: 'Request denied by CORS policy',
    });
  });

  it('GET without Origin header → 200', async () => {
    const res = await fetch(`${base}/health`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });
});

describe('qwen serve — capabilities envelope', () => {
  it('advertises all 9 Stage 1 features', async () => {
    const caps = await client.capabilities();
    expect(caps.v).toBe(1);
    expect(caps.mode).toBe('http-bridge');
    expect(caps.features).toEqual([
      'health',
      'capabilities',
      'session_create',
      'session_list',
      'session_prompt',
      'session_cancel',
      'session_events',
      'session_set_model',
      'permission_vote',
    ]);
  });
});

describe('qwen serve — POST /session validation + concurrent coalescing', () => {
  it('rejects relative cwd', async () => {
    const res = await fetch(`${base}/session`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ cwd: 'relative/path' }),
    });
    expect(res.status).toBe(400);
  });

  it('two parallel POSTs same workspace coalesce to one session', async () => {
    const cwd = REPO_ROOT;
    const [a, b] = await Promise.all([
      client.createOrAttachSession({ workspaceCwd: cwd }),
      client.createOrAttachSession({ workspaceCwd: cwd }),
    ]);
    expect(a.sessionId).toBe(b.sessionId);
    // Exactly one of the two reports `attached: false` (the spawn owner).
    expect([a.attached, b.attached].sort()).toEqual([false, true]);
  });

  it('bad modelServiceId keeps the session alive on the default model', async () => {
    // Per #3889 review A05Ym: when the requested model is rejected at
    // create-session time, the session stays operational on the
    // agent's default model. The caller gets a sessionId they can
    // retry the model switch against (via POST /session/:id/model).
    // Tearing the session down on model-switch failure would force
    // the caller into a 500 with no way to recover. The
    // `model_switch_failed` SSE event is the visible failure signal.
    //
    // Use REPO_ROOT (the daemon's bound workspace) — under #3803 §02
    // any other cwd would return 400 workspace_mismatch before the
    // session is even spawned.
    const cwd = REPO_ROOT;
    const session = await client.createOrAttachSession({
      workspaceCwd: cwd,
      modelServiceId: 'definitely-not-a-real-model',
    });
    expect(session.sessionId).toBeTypeOf('string');
    // `attached` may be true or false depending on whether earlier
    // tests in this file already created a REPO_ROOT session. The
    // shape of the response is what matters here (sessionId present,
    // listWorkspaceSessions sees it).
    expect(typeof session.attached).toBe('boolean');
    const sessions = await client.listWorkspaceSessions(cwd);
    expect(sessions.some((s) => s.sessionId === session.sessionId)).toBe(true);
    // No teardown — Stage 1 has no DELETE /session route, and the
    // session persists in `byId` until daemon shutdown.
  });

  it('rejects cross-workspace cwd with 400 workspace_mismatch (#3803 §02)', async () => {
    // The daemon is bound to REPO_ROOT (via `--workspace` in beforeAll).
    // A POST /session with `cwd: '/tmp'` (or any other absolute path
    // that doesn't canonicalize to REPO_ROOT) must reject with 400
    // `workspace_mismatch`, carrying both paths in the body so an
    // orchestrator-aware client can spawn / route to the right
    // daemon.
    const res = await fetch(`${base}/session`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ cwd: '/tmp' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      code?: string;
      boundWorkspace?: string;
      requestedWorkspace?: string;
    };
    expect(body.code).toBe('workspace_mismatch');
    expect(body.boundWorkspace).toBe(REPO_ROOT);
    // The bridge canonicalizes the requested cwd via `realpathSync.native`
    // so the response carries the on-disk canonical form, NOT the literal
    // we POSTed. On macOS `/tmp` is a symlink to `/private/tmp`, so the
    // hardcoded `/tmp` literal would diverge there. Resolve the same way
    // the bridge does to keep the assertion portable.
    expect(body.requestedWorkspace).toBe(realpathSync.native('/tmp'));
  });

  it('omits cwd → falls back to bound workspace (#3803 §02)', async () => {
    // The route accepts an empty body and falls back to the daemon's
    // bound workspace. Asserting this end-to-end through a real
    // daemon process verifies the runQwenServe → createServeApp →
    // bridge plumbing for the fallback path.
    const res = await fetch(`${base}/session`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const session = (await res.json()) as {
      sessionId?: string;
      workspaceCwd?: string;
    };
    expect(session.workspaceCwd).toBe(REPO_ROOT);
  });

  it('GET /capabilities surfaces workspaceCwd (#3803 §02)', async () => {
    const caps = await client.capabilities();
    expect(caps.workspaceCwd).toBe(REPO_ROOT);
  });
});

describe('qwen serve — POST /permission/:requestId validation', () => {
  it('400 on empty optionId', async () => {
    const res = await fetch(`${base}/permission/req-1`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        outcome: { outcome: 'selected', optionId: '' },
      }),
    });
    expect(res.status).toBe(400);
  });

  it('400 on missing optionId', async () => {
    const res = await fetch(`${base}/permission/req-1`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ outcome: { outcome: 'selected' } }),
    });
    expect(res.status).toBe(400);
  });

  it('404 when valid vote targets unknown requestId', async () => {
    const res = await fetch(`${base}/permission/never-existed`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        outcome: { outcome: 'selected', optionId: 'allow' },
      }),
    });
    expect(res.status).toBe(404);
  });
});

describe('qwen serve — SSE Content-Type guard (SDK side)', () => {
  it('throws DaemonHttpError when upstream returns 200 + JSON', async () => {
    const ghostFetch = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const ghost = new DaemonClient({
      baseUrl: 'http://daemon',
      fetch: ghostFetch,
    });
    let threw: unknown = null;
    try {
      const it2 = ghost.subscribeEvents('s-1');
      await it2.next();
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(DaemonHttpError);
    expect((threw as DaemonHttpError).message).toMatch(/text\/event-stream/);
  });
});

describe('qwen serve — Last-Event-ID strict parsing', () => {
  it('malformed Last-Event-ID accepted but ignored', async () => {
    // Spawn a session so /events has somewhere to attach.
    const session = await client.createOrAttachSession({
      workspaceCwd: REPO_ROOT,
    });
    const res = await fetch(`${base}/session/${session.sessionId}/events`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'text/event-stream',
        'Last-Event-ID': '1abc',
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    await res.body?.cancel();
  });
});

describe('qwen serve — cancel + list', () => {
  it('cancel called twice does not throw', async () => {
    const session = await client.createOrAttachSession({
      workspaceCwd: REPO_ROOT,
    });
    await client.cancel(session.sessionId);
    await client.cancel(session.sessionId);
  });

  it('listWorkspaceSessions returns the live session', async () => {
    await client.createOrAttachSession({ workspaceCwd: REPO_ROOT });
    const sessions = await client.listWorkspaceSessions(REPO_ROOT);
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    // Explicit `s` type because the reviewer's tsc run resolves
    // `@qwen-code/sdk` against a possibly-stale dist .d.ts (per
    // integration-tests/tsconfig.json `paths` mapping); without
    // the annotation `s` widens to `any` in that environment and
    // trips strict-mode TS7006.
    expect(
      sessions.every((s: DaemonSessionSummary) => s.workspaceCwd === REPO_ROOT),
    ).toBe(true);
  });
});
