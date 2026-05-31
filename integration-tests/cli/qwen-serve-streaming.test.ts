/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `qwen serve` daemon — streaming / multi-client / recovery integration.
 *
 * These tests need a working model credential because they fire real
 * prompts and observe the resulting SSE stream. They cover three flows
 * that unit tests can't fully exercise:
 *
 *   1. Real `qwen --acp` child crash → daemon publishes `session_died`,
 *      removes the dead entry from the maps, and a subsequent
 *      `createOrAttachSession` for the same workspace spawns fresh.
 *   2. Two SSE subscribers + a tool that needs permission → both see
 *      the SAME `permission_request` event (cross-client fan-out);
 *      two concurrent votes resolve as 200/404 (first-responder wins).
 *   3. SSE consumer disconnects after seeing N events; reconnect with
 *      `Last-Event-ID: N` resumes the stream from id N+1 via the bus's
 *      replay ring.
 *
 * Skip on CI / no-auth via `SKIP_LLM_TESTS=1`.
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DaemonClient, parseSseStream } from '@qwen-code/sdk';
import type { DaemonEvent, DaemonSessionSummary } from '@qwen-code/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Match the rest of the integration suite: prefer `TEST_CLI_PATH`
// from `globalSetup.ts` (root `dist/cli.js` bundle), fall back to
// the per-package output for direct vitest invocations. See the same
// note in qwen-serve-routes.test.ts for full rationale.
const CLI_BIN =
  process.env['TEST_CLI_PATH'] ??
  path.resolve(__dirname, '../../packages/cli/dist/index.js');
const TOKEN = 'streaming-integ-secret';
const REPO_ROOT = path.resolve(__dirname, '../..');

// Skip when:
//   - explicit `SKIP_LLM_TESTS=1` (CI envs without provider API keys), OR
//   - Windows: this suite shells out to `pgrep` / `kill -KILL` to
//     simulate child-process crashes for the SIGKILL → `session_died`
//     test, and those binaries are POSIX-only. A Windows-equivalent
//     (`taskkill`) would need different test scaffolding; deferred to
//     a follow-up rather than smuggling shell-shape divergence into
//     the existing assertions.
const SKIP =
  process.env['SKIP_LLM_TESTS'] === '1' || process.platform === 'win32';
const describeLLM = SKIP ? describe.skip : describe;

let daemon: ChildProcess;
let port = 0;
let base = '';
let client: DaemonClient;

beforeAll(async () => {
  if (SKIP) return;
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
      // workspace so every `createOrAttachSession({ workspaceCwd:
      // REPO_ROOT })` below matches. Without this the daemon inherits
      // the test runner's cwd (CI / IDE-launcher / direct vitest
      // invocations all differ) and every session create returns
      // 400 workspace_mismatch — the SSE / permission / Last-Event-ID
      // tests below would all silently 404 once `SKIP_LLM_TESTS` is
      // unset. Same fix the sibling routes test received earlier in
      // this PR — missed in this file in the original §02 pass.
      '--workspace',
      REPO_ROOT,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    // Capture the timeout handle so we can clear it on success — an
    // un-cleared 10s timer outlives the spawn promise and keeps the
    // vitest event loop alive past the test, manifesting as
    // intermittent flakes on slow CI.
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
  if (SKIP || !daemon || daemon.exitCode !== null) return;
  daemon.kill('SIGTERM');
  await new Promise((r) => daemon.once('exit', r));
}, 15_000);

/** Open an authenticated SSE stream and yield parsed frames. */
async function* sseFrames(
  sessionId: string,
  opts: { signal?: AbortSignal; lastEventId?: number } = {},
): AsyncGenerator<DaemonEvent> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'text/event-stream',
  };
  if (opts.lastEventId !== undefined) {
    headers['Last-Event-ID'] = String(opts.lastEventId);
  }
  const res = await fetch(`${base}/session/${sessionId}/events`, {
    headers,
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`SSE open failed: ${res.status}`);
  // Forward the abort signal into parseSseStream so a post-connect
  // abort stops iteration immediately. Without this, the parser
  // stays parked on `reader.read()` until the upstream actually
  // closes — fine for happy-path tests but flaky for any test that
  // wants to abort mid-stream.
  yield* parseSseStream(res.body!, opts.signal);
}

describeLLM('qwen serve — child-crash recovery (real SIGKILL)', () => {
  it('publishes session_died after the qwen --acp child is SIGKILL-ed', async () => {
    const session = await client.createOrAttachSession({
      workspaceCwd: REPO_ROOT,
    });

    // Find the daemon's direct `--acp` child PID.
    const childPids = execSync(`pgrep -P ${daemon.pid} -f "qwen.*--acp"`, {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(childPids.length).toBeGreaterThanOrEqual(1);

    const ac = new AbortController();
    const collected: DaemonEvent[] = [];
    const consumer = (async () => {
      try {
        for await (const e of sseFrames(session.sessionId, {
          signal: ac.signal,
        })) {
          collected.push(e);
          if (e.type === 'session_died') break;
        }
      } catch {
        /* aborted */
      }
    })();

    // Kill the child outright.
    for (const pid of childPids) {
      try {
        execSync(`kill -KILL ${pid}`);
      } catch {
        /* already gone */
      }
    }

    // Wait up to 5s for the daemon to detect + publish session_died.
    const deadline = Date.now() + 5000;
    while (
      Date.now() < deadline &&
      !collected.some((e) => e.type === 'session_died')
    ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    ac.abort();
    await consumer;

    const died = collected.find((e) => e.type === 'session_died');
    expect(died).toBeDefined();
    expect((died?.data as { sessionId?: string })?.sessionId).toBe(
      session.sessionId,
    );

    // Listing must NOT show the dead session.
    const remaining = await client.listWorkspaceSessions(REPO_ROOT);
    // Explicit `s` type for resilience against a stale dist .d.ts
    // in the reviewer's tsc env (see same note in routes.test.ts).
    expect(
      remaining.find(
        (s: DaemonSessionSummary) => s.sessionId === session.sessionId,
      ),
    ).toBeUndefined();

    // Retry must spawn fresh, not reuse the corpse.
    const fresh = await client.createOrAttachSession({
      workspaceCwd: REPO_ROOT,
    });
    expect(fresh.sessionId).not.toBe(session.sessionId);
    expect(fresh.attached).toBe(false);
  }, 60_000);
});

describeLLM('qwen serve — multi-client first-responder permission', () => {
  it('fans out permission_request to both subscribers; only one vote wins', async () => {
    const session = await client.createOrAttachSession({
      workspaceCwd: REPO_ROOT,
    });

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const seen1: DaemonEvent[] = [];
    const seen2: DaemonEvent[] = [];
    const sub1 = (async () => {
      try {
        for await (const e of sseFrames(session.sessionId, {
          signal: ac1.signal,
        })) {
          seen1.push(e);
          if (e.type === 'permission_resolved') break;
        }
      } catch {
        /* aborted */
      }
    })();
    const sub2 = (async () => {
      try {
        for await (const e of sseFrames(session.sessionId, {
          signal: ac2.signal,
        })) {
          seen2.push(e);
          if (e.type === 'permission_resolved') break;
        }
      } catch {
        /* aborted */
      }
    })();
    // Let the subscribers register before firing the prompt.
    await new Promise((r) => setTimeout(r, 200));

    const tmp = `/tmp/qwen-serve-mc-${Date.now()}.txt`;
    const promptTask = client.prompt(session.sessionId, {
      prompt: [
        {
          type: 'text',
          text: `Please create a file at ${tmp} with contents "fan-out". After the tool runs, stop.`,
        },
      ],
    });

    // Wait for both subscribers to see permission_request.
    const t0 = Date.now();
    let req1: DaemonEvent | undefined;
    let req2: DaemonEvent | undefined;
    while (Date.now() - t0 < 30_000 && (!req1 || !req2)) {
      req1 = req1 ?? seen1.find((e) => e.type === 'permission_request');
      req2 = req2 ?? seen2.find((e) => e.type === 'permission_request');
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(req1).toBeDefined();
    expect(req2).toBeDefined();
    const data1 = req1!.data as {
      requestId: string;
      options: Array<{ optionId: string; kind: string }>;
    };
    const data2 = req2!.data as { requestId: string };
    expect(data1.requestId).toBe(data2.requestId);

    const optionId =
      data1.options.find((o) => o.kind === 'allow_once')?.optionId ??
      data1.options[0]?.optionId;

    // Race two concurrent votes — exactly one should win.
    const [voteA, voteB] = await Promise.all([
      fetch(`${base}/permission/${data1.requestId}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ outcome: { outcome: 'selected', optionId } }),
      }),
      fetch(`${base}/permission/${data1.requestId}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ outcome: { outcome: 'selected', optionId } }),
      }),
    ]);
    expect([voteA.status, voteB.status].sort()).toEqual([200, 404]);

    // Wait for the prompt to complete (either succeed or time out).
    await Promise.race([
      promptTask.catch(() => undefined),
      new Promise((r) => setTimeout(r, 30_000)),
    ]);
    ac1.abort();
    ac2.abort();
    await Promise.all([sub1, sub2]);
    try {
      execSync(`rm -f ${tmp}`);
    } catch {
      /* file may not exist if the tool didn't run */
    }
  }, 90_000);
});

describeLLM('qwen serve — Last-Event-ID resume', () => {
  it('reconnect with Last-Event-ID:N yields events with id > N', async () => {
    const session = await client.createOrAttachSession({
      workspaceCwd: REPO_ROOT,
    });

    // Fire a short prompt to populate the bus.
    await client.prompt(session.sessionId, {
      prompt: [{ type: 'text', text: 'just say hi briefly, no tool calls' }],
    });

    // First connection: replay everything from lastEventId=0; pick up 2.
    const ac1 = new AbortController();
    const replay: DaemonEvent[] = [];
    for await (const e of sseFrames(session.sessionId, {
      lastEventId: 0,
      signal: ac1.signal,
    })) {
      replay.push(e);
      if (replay.length === 2) break;
    }
    ac1.abort();
    expect(replay.length).toBe(2);
    expect(replay[0].id).toBeDefined();
    expect(replay[1].id).toBeDefined();
    expect(replay[1].id!).toBeGreaterThan(replay[0].id!);

    // Reconnect with Last-Event-ID = the second frame's id; first event
    // received MUST have id > that.
    const lastId = replay[1].id!;
    const ac2 = new AbortController();
    let resumedFirst: DaemonEvent | undefined;
    for await (const e of sseFrames(session.sessionId, {
      lastEventId: lastId,
      signal: ac2.signal,
    })) {
      resumedFirst = e;
      break;
    }
    ac2.abort();
    expect(resumedFirst).toBeDefined();
    expect(resumedFirst!.id).toBeDefined();
    expect(resumedFirst!.id!).toBeGreaterThan(lastId);
  }, 60_000);
});
