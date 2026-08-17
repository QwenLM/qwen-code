/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `qwen serve` daemon — streaming / multi-client / recovery integration.
 *
 * These tests fire real daemon prompts and observe the resulting SSE stream,
 * but the model side is backed by a local OpenAI-compatible fake server so
 * the suite can run without API keys. They cover five flows that unit tests
 * can't fully exercise:
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
 *   4. An admitted prompt keeps running with no SSE subscriber while the Todo
 *      Stop Guard performs its bounded continuations; a later subscriber
 *      replays each discrete status event.
 *   5. A same-host ACP child reads text outside the workspace only after the
 *      daemon permission request is approved, and never returns the content
 *      after rejection.
 *   6. Built-in text writes approved by the tool permission layer can commit
 *      outside the workspace without falling back to shell, while rejection
 *      still prevents the final ACP write and YOLO needs no second prompt.
 *
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPathWithinRoot } from '@qwen-code/qwen-code-core';
import { DaemonClient, parseSseStream } from '@qwen-code/sdk';
import type { DaemonEvent, DaemonSessionSummary } from '@qwen-code/sdk';
import {
  isNonBlockingAccepted,
  type NonBlockingPromptAccepted,
} from '@qwen-code/sdk/daemon';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
// Match the rest of the integration suite: prefer `TEST_CLI_PATH`
// from `globalSetup.ts` (root `dist/cli.js` bundle), fall back to
// the per-package output for direct vitest invocations. See the same
// note in qwen-serve-routes.test.ts for full rationale.
const CLI_BIN =
  process.env['TEST_CLI_PATH'] ??
  path.resolve(__dirname, '../../packages/cli/dist/index.js');
const TOKEN = 'streaming-integ-secret';

// Windows: this suite shells out to `pgrep` / `kill -KILL` to simulate
// child-process crashes for the SIGKILL → `session_died` test, and those
// binaries are POSIX-only. A Windows-equivalent (`taskkill`) would need
// different test scaffolding.
//
// Container sandbox (QWEN_SANDBOX=docker/podman): the model side is a fake
// OpenAI server bound to the host's 127.0.0.1, but under the sandbox the
// daemon's `qwen --acp` child runs inside the container and cannot reach the
// host loopback — every prompt turn fails with "Connection error", so the
// permission fan-out and Last-Event-ID flows below never fire. (The host
// `pgrep -P` in the SIGKILL test can't see the in-container PID either.) Skip
// under any container sandbox, matching the existing qwen-serve-baseline /
// acp-integration / cron-tools precedent.
const SKIP =
  process.platform === 'win32' ||
  Boolean(
    process.env['QWEN_SANDBOX'] &&
      process.env['QWEN_SANDBOX']!.toLowerCase() !== 'false',
  );
const describePOSIX = SKIP ? describe.skip : describe;

// The base only has to sit outside both the workspace and the `/tmp` local-read
// root, so the test reads a genuinely external path. The real `$HOME` is
// excluded deliberately: cleanup lives in `afterAll`, so a Ctrl-C, `--bail`, or
// CI timeout leaks the fixture dir. `/var/tmp` leaks the same way — the leak is
// relocated somewhere harmless, not eliminated.
function findExternalReadBase(): string | undefined {
  if (SKIP) return undefined;
  const candidates = [
    // Escape hatch for images where /var/tmp is absent or read-only.
    process.env['QWEN_TEST_EXTERNAL_READ_BASE'],
    '/var/tmp',
  ].filter((value): value is string => Boolean(value));
  // Carry each rejection reason into the diagnostics below. A bare `catch {}`
  // here cannot tell "no /var/tmp on this image" (expected) from a bug in this
  // function (not expected), and the latter reads as a green skip.
  const rejections: string[] = [];
  for (const candidate of candidates) {
    try {
      const resolved = realpathSync(candidate);
      accessSync(resolved, constants.W_OK);
      if (
        isPathWithinRoot(resolved, realpathSync('/tmp')) ||
        isPathWithinRoot(resolved, realpathSync(REPO_ROOT))
      ) {
        rejections.push(`${candidate}: inside the /tmp read root or the repo`);
        continue;
      }
      return resolved;
    } catch (error) {
      rejections.push(`${candidate}: ${error}`);
    }
  }
  // Skipping is acceptable on a developer box, but on CI a silently disabled
  // security regression test is indistinguishable from a passing one. Fail
  // loudly instead and let the operator point QWEN_TEST_EXTERNAL_READ_BASE at
  // a writable directory outside both the workspace and the /tmp read root.
  const diagnostics = `no usable external-read fixture base (${rejections.join('; ')})`;
  if (process.env['CI']) {
    throw new Error(
      `${diagnostics}. Set QWEN_TEST_EXTERNAL_READ_BASE to a writable ` +
        'directory outside the repo and outside /tmp.',
    );
  }
  console.warn(
    `[qwen-serve-streaming] skipping external read tests: ${diagnostics}`,
  );
  return undefined;
}

const externalReadBase = findExternalReadBase();

function asAccepted(
  result: Awaited<ReturnType<DaemonClient['promptNonBlocking']>>,
): NonBlockingPromptAccepted | undefined {
  return isNonBlockingAccepted(result) ? result : undefined;
}

let daemon: ChildProcess;
let port = 0;
let base = '';
let client: DaemonClient;
let fakeServer: FakeOpenAIServer;
let homeDir = '';
let externalReadDir = '';
let workspaceDir = '';
let pendingWritePath = '';
let pendingReadPath = '';
let pendingReadMarker = '';
let pendingReadSentinel = '';
let pendingExternalWritePath = '';
let pendingExternalWriteMarker = '';
let pendingExternalWriteSentinel = '';

beforeAll(async () => {
  if (SKIP) return;
  fakeServer = await startFakeOpenAIServer(({ body }) => {
    const messages = JSON.stringify(body['messages'] ?? []);
    const hasToolResult =
      messages.includes('"role":"tool"') || messages.includes('"tool_call_id"');

    const guardMarker = messages.match(/todo-guard-e2e-\d+/g)?.at(-1);
    if (guardMarker) {
      const guardTodoId = `${guardMarker}-item`;
      if (!messages.includes(guardTodoId)) {
        return {
          toolCalls: [
            fakeToolCall('todo_write', {
              todos: [
                {
                  id: guardTodoId,
                  content: 'Keep this item unfinished for the guard test',
                  status: 'pending',
                },
              ],
            }),
          ],
        };
      }
      return { content: 'The test Todo remains unfinished.' };
    }

    if (pendingWritePath && messages.includes('fan-out') && !hasToolResult) {
      return {
        toolCalls: [
          fakeToolCall('write_file', {
            file_path: pendingWritePath,
            content: 'fan-out',
          }),
        ],
      };
    }

    if (
      pendingExternalWritePath &&
      pendingExternalWriteMarker &&
      messages.includes(pendingExternalWriteMarker)
    ) {
      if (!hasToolResult) {
        return {
          toolCalls: [
            fakeToolCall('write_file', {
              file_path: pendingExternalWritePath,
              content: pendingExternalWriteSentinel,
            }),
          ],
        };
      }
      return { content: 'external write completed' };
    }

    if (
      pendingReadPath &&
      pendingReadMarker &&
      messages.includes(pendingReadMarker)
    ) {
      if (!hasToolResult) {
        return {
          toolCalls: [
            fakeToolCall('read_file', {
              file_path: pendingReadPath,
            }),
          ],
        };
      }

      return {
        content: messages.includes(pendingReadSentinel)
          ? `external read observed: ${pendingReadSentinel}`
          : 'external read content not observed',
      };
    }

    return { content: 'fake response complete' };
  });
  homeDir = mkdtempSync(path.join(tmpdir(), 'qwen-serve-streaming-home-'));
  if (externalReadBase) {
    let candidateDir = '';
    try {
      candidateDir = mkdtempSync(
        path.join(externalReadBase, '.qwen-serve-external-read-'),
      );
      externalReadDir = realpathSync(candidateDir);
    } catch {
      if (candidateDir) {
        rmSync(candidateDir, { recursive: true, force: true });
      }
      externalReadDir = '';
    }
  }
  const qwenHome = path.join(homeDir, '.qwen');
  mkdirSync(qwenHome, { recursive: true });
  writeFileSync(
    path.join(qwenHome, 'settings.json'),
    JSON.stringify({
      experimental: { todoStopGuard: true },
      ui: { enableFollowupSuggestions: false },
    }),
  );
  workspaceDir = mkdtempSync(path.join(tmpdir(), 'qwen-serve-streaming-ws-'));
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
      // workspace so every `createOrAttachSession({ workspaceCwd })`
      // below matches. Without this the daemon inherits the test
      // runner's cwd (CI / IDE-launcher / direct vitest invocations
      // all differ) and every session create returns 400
      // workspace_mismatch — the SSE / permission / Last-Event-ID
      // tests below would all silently 404. A scratch workspace (not
      // the checkout) also keeps sessions hermetic: the daemon merges
      // the workspace's `.qwen/settings.json` into every session, and
      // a stray one on a shared runner (e.g. a `tools.sandbox` mode or
      // a `tools.core` allowlist missing `todo_write`) silently breaks
      // the Stop Guard flow below.
      '--workspace',
      workspaceDir,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !/^(https?|all)_proxy$/i.test(key),
          ),
        ),
        HOME: homeDir,
        QWEN_HOME: path.join(homeDir, '.qwen'),
        QWEN_ACP_LOCAL_READ_ROOTS: '',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
        OPENAI_API_KEY: 'fake-key',
        OPENAI_BASE_URL: fakeServer.baseUrl,
        OPENAI_MODEL: 'fake-model',
        QWEN_MODEL: 'fake-model',
      },
    },
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
  if (!SKIP && daemon && daemon.exitCode === null) {
    daemon.kill('SIGTERM');
    await new Promise((r) => daemon.once('exit', r));
  }
  await fakeServer?.close();
  if (homeDir) {
    rmSync(homeDir, { recursive: true, force: true });
  }
  if (externalReadDir) {
    rmSync(externalReadDir, { recursive: true, force: true });
  }
  if (workspaceDir) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
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

describePOSIX('qwen serve — child-crash recovery (real SIGKILL)', () => {
  it('publishes session_died after the qwen --acp child is SIGKILL-ed', async () => {
    const session = await client.createOrAttachSession({
      workspaceCwd: workspaceDir,
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
    const remaining = await client.listWorkspaceSessions(workspaceDir);
    // Explicit `s` type for resilience against a stale dist .d.ts
    // in the reviewer's tsc env (see same note in routes.test.ts).
    expect(
      remaining.find(
        (s: DaemonSessionSummary) => s.sessionId === session.sessionId,
      ),
    ).toBeUndefined();

    // Retry must spawn fresh, not reuse the corpse.
    const fresh = await client.createOrAttachSession({
      workspaceCwd: workspaceDir,
    });
    expect(fresh.sessionId).not.toBe(session.sessionId);
    expect(fresh.attached).toBe(false);
  }, 60_000);
});

describePOSIX('qwen serve — multi-client first-responder permission', () => {
  it('fans out permission_request to both subscribers; only one vote wins', async () => {
    const session = await client.createOrAttachSession({
      workspaceCwd: workspaceDir,
    });

    // Pin the session to `default` approval mode. The ACP child
    // inherits the host's user-level settings — a developer machine
    // with `approvalMode: yolo` auto-approves the write below, no
    // permission_request ever fires, and this test fails only
    // locally. CI passes because its HOME has no user settings.
    await client.setSessionApprovalMode(session.sessionId, 'default');

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
    pendingWritePath = tmp;
    let promptTask: Promise<unknown> | undefined;
    try {
      promptTask = client.prompt(session.sessionId, {
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
    } finally {
      // The race above tolerates the turn still running (slow model).
      // But ABANDONING an in-flight turn wedges the shared session: if
      // the model asks for a SECOND permission after the allow_once
      // vote, nobody is left to answer it, the pending request blocks
      // the turn forever, and the per-session prompt FIFO holds every
      // later prompt behind it — the Last-Event-ID resume test below
      // then times out waiting for a turn_complete that never comes
      // (the exact 60s × 3-retry hang from the 2026-06-12 nightly).
      // Cancel the active prompt so the session is clean for the next
      // test; harmless when the turn already finished.
      await client.cancel(session.sessionId).catch(() => undefined);
      if (promptTask) {
        await Promise.race([
          promptTask.catch(() => undefined),
          new Promise((r) => setTimeout(r, 5_000)),
        ]);
      }
      ac1.abort();
      ac2.abort();
      await Promise.all([sub1, sub2]);
      rmSync(tmp, { force: true });
      pendingWritePath = '';
    }
  }, 90_000);
});

describePOSIX('qwen serve — same-host external text reads', () => {
  async function runExternalRead(
    decision: 'allow_once' | 'reject_once',
  ): Promise<void> {
    const suffix = `${decision}-${Date.now()}`;
    const marker = `external-read-${suffix}`;
    const sentinel = `external-read-sentinel-${suffix}`;
    const externalPath = path.join(externalReadDir, 'outside-workspace.txt');
    writeFileSync(externalPath, sentinel);
    pendingReadPath = externalPath;
    pendingReadMarker = marker;
    pendingReadSentinel = sentinel;

    const session = await client.createOrAttachSession({
      // The daemon is bound to `workspaceDir` by `beforeAll`, so any other
      // value is rejected with 400 Workspace mismatch. The read under test is
      // external because `externalReadDir` sits outside this workspace, not
      // because the session claims a wider one.
      workspaceCwd: workspaceDir,
      sessionScope: 'thread',
    });
    await client.setSessionApprovalMode(session.sessionId, 'default');

    const events: DaemonEvent[] = [];
    const ac = new AbortController();
    let promptId: string | undefined;
    const subscriber = (async () => {
      try {
        for await (const event of sseFrames(session.sessionId, {
          signal: ac.signal,
        })) {
          events.push(event);
          const data = event.data as { promptId?: string } | undefined;
          if (event.type === 'turn_complete' && data?.promptId === promptId) {
            break;
          }
        }
      } catch {
        /* aborted */
      }
    })();
    const findReadPermission = () =>
      events.find((event) => {
        if (event.type !== 'permission_request') return false;
        const data = event.data as {
          toolCall?: {
            rawInput?: { file_path?: string };
            _meta?: { toolName?: string };
          };
        };
        return (
          data.toolCall?._meta?.toolName === 'read_file' &&
          data.toolCall.rawInput?.file_path === externalPath
        );
      });

    const requestStart = fakeServer.requests.length;
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const accepted = asAccepted(
        await client.promptNonBlocking(session.sessionId, {
          prompt: [{ type: 'text', text: marker }],
        }),
      );
      expect(accepted).toBeDefined();
      if (!accepted) return;
      promptId = accepted.promptId;

      await expect.poll(findReadPermission, { timeout: 30_000 }).toBeDefined();
      const permission = findReadPermission();
      const permissionData = permission!.data as {
        requestId: string;
        options: Array<{ optionId: string; kind: string }>;
      };
      const optionId = permissionData.options.find(
        (option) => option.kind === decision,
      )?.optionId;
      expect(optionId).toBeDefined();
      expect(
        await client.respondToPermission(permissionData.requestId, {
          outcome: { outcome: 'selected', optionId: optionId! },
        }),
      ).toBe(true);

      await expect
        .poll(
          () =>
            events.some((event) => {
              const data = event.data as { promptId?: string } | undefined;
              return (
                event.type === 'turn_complete' && data?.promptId === promptId
              );
            }),
          { timeout: 30_000 },
        )
        .toBe(true);

      const modelRequests = fakeServer.requests
        .slice(requestStart)
        .map((request) => JSON.stringify(request.body['messages'] ?? []))
        .filter((messages) => messages.includes(marker));

      const serializedEvents = JSON.stringify(events);
      if (decision === 'allow_once') {
        expect(modelRequests.length).toBeGreaterThanOrEqual(2);
        expect(
          modelRequests.some((messages) => messages.includes(sentinel)),
        ).toBe(true);
        expect(serializedEvents).toContain(
          `external read observed: ${sentinel}`,
        );
      } else {
        expect(modelRequests).toHaveLength(1);
        expect(
          modelRequests.every((messages) => !messages.includes(sentinel)),
        ).toBe(true);
        expect(
          events.some((event) => {
            if (event.type !== 'session_update') return false;
            const data = event.data as {
              update?: { sessionUpdate?: string; status?: string };
            };
            return (
              data.update?.sessionUpdate === 'tool_call_update' &&
              data.update.status === 'failed'
            );
          }),
        ).toBe(true);
        // The failed `tool_call_update` above and the sentinel absence below
        // carry the whole meaning. Asserting the user-facing rejection copy
        // would fail on a wording change or a non-English locale for reasons
        // unrelated to the capability under test.
        expect(serializedEvents).not.toContain(sentinel);
      }
    } finally {
      await client.cancel(session.sessionId).catch(() => undefined);
      ac.abort();
      await subscriber;
      await client.closeSession(session.sessionId).catch(() => undefined);
      pendingReadPath = '';
      pendingReadMarker = '';
      pendingReadSentinel = '';
      rmSync(externalPath, { force: true });
    }
  }

  it('returns approved content and withholds rejected content', async (ctx) => {
    if (!externalReadDir) {
      ctx.skip('no writable fixture root outside the workspace and /tmp');
    }
    await runExternalRead('allow_once');
    await runExternalRead('reject_once');
  }, 150_000);
});

describePOSIX('qwen serve — same-host external built-in text writes', () => {
  async function runExternalWrite(
    mode: 'allow_once' | 'reject_once' | 'yolo',
  ): Promise<void> {
    const suffix = `${mode}-${Date.now()}`;
    const marker = `external-write-${suffix}`;
    const sentinel = `external-write-sentinel-${suffix}`;
    const externalPath = path.join(externalReadDir, `${suffix}.txt`);
    pendingExternalWritePath = externalPath;
    pendingExternalWriteMarker = marker;
    pendingExternalWriteSentinel = sentinel;

    const session = await client.createOrAttachSession({
      workspaceCwd: workspaceDir,
      sessionScope: 'thread',
    });
    await client.setSessionApprovalMode(
      session.sessionId,
      mode === 'yolo' ? 'yolo' : 'default',
    );

    const events: DaemonEvent[] = [];
    const ac = new AbortController();
    let promptId: string | undefined;
    const subscriber = (async () => {
      try {
        for await (const event of sseFrames(session.sessionId, {
          signal: ac.signal,
        })) {
          events.push(event);
          const data = event.data as { promptId?: string } | undefined;
          if (event.type === 'turn_complete' && data?.promptId === promptId) {
            break;
          }
        }
      } catch {
        /* aborted */
      }
    })();
    const findWritePermission = () =>
      events.find((event) => {
        if (event.type !== 'permission_request') return false;
        const data = event.data as {
          toolCall?: {
            rawInput?: { file_path?: string };
            _meta?: { toolName?: string };
          };
        };
        return (
          data.toolCall?._meta?.toolName === 'write_file' &&
          data.toolCall.rawInput?.file_path === externalPath
        );
      });
    const hasToolStatus = (status: 'completed' | 'failed') =>
      events.some((event) => {
        if (event.type !== 'session_update') return false;
        const data = event.data as {
          update?: {
            sessionUpdate?: string;
            status?: string;
            _meta?: { toolName?: string };
          };
        };
        return (
          data.update?.sessionUpdate === 'tool_call_update' &&
          data.update._meta?.toolName === 'write_file' &&
          data.update.status === status
        );
      });

    const requestStart = fakeServer.requests.length;
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const accepted = asAccepted(
        await client.promptNonBlocking(session.sessionId, {
          prompt: [{ type: 'text', text: marker }],
        }),
      );
      expect(accepted).toBeDefined();
      if (!accepted) return;
      promptId = accepted.promptId;

      if (mode !== 'yolo') {
        await expect
          .poll(findWritePermission, { timeout: 30_000 })
          .toBeDefined();
        const permission = findWritePermission();
        const permissionData = permission!.data as {
          requestId: string;
          options: Array<{ optionId: string; kind: string }>;
        };
        const optionId = permissionData.options.find(
          (option) => option.kind === mode,
        )?.optionId;
        expect(optionId).toBeDefined();
        expect(
          await client.respondToPermission(permissionData.requestId, {
            outcome: { outcome: 'selected', optionId: optionId! },
          }),
        ).toBe(true);
      }

      await expect
        .poll(
          () =>
            events.some((event) => {
              const data = event.data as { promptId?: string } | undefined;
              return (
                event.type === 'turn_complete' && data?.promptId === promptId
              );
            }),
          { timeout: 30_000 },
        )
        .toBe(true);

      const modelRequests = fakeServer.requests
        .slice(requestStart)
        .map((request) => JSON.stringify(request.body['messages'] ?? []))
        .filter((messages) => messages.includes(marker));
      const serializedEvents = JSON.stringify(events);

      if (mode === 'reject_once') {
        expect(modelRequests).toHaveLength(1);
        expect(existsSync(externalPath)).toBe(false);
        expect(hasToolStatus('failed')).toBe(true);
      } else {
        expect(modelRequests.length).toBeGreaterThanOrEqual(2);
        expect(readFileSync(externalPath, 'utf8')).toBe(sentinel);
        expect(hasToolStatus('completed')).toBe(true);
      }
      if (mode === 'yolo') {
        expect(
          events.some((event) => event.type === 'permission_request'),
        ).toBe(false);
      }
      expect(serializedEvents).not.toContain('"toolName":"shell"');
    } finally {
      await client.cancel(session.sessionId).catch(() => undefined);
      ac.abort();
      await subscriber;
      await client.closeSession(session.sessionId).catch(() => undefined);
      pendingExternalWritePath = '';
      pendingExternalWriteMarker = '';
      pendingExternalWriteSentinel = '';
      rmSync(externalPath, { force: true });
    }
  }

  it('closes approve/reject/YOLO write authorization without shell fallback', async (ctx) => {
    if (!externalReadDir) {
      ctx.skip('no writable fixture root outside the workspace and /tmp');
    }
    await runExternalWrite('allow_once');
    await runExternalWrite('reject_once');
    await runExternalWrite('yolo');
  }, 180_000);
});

describePOSIX('qwen serve — Last-Event-ID resume', () => {
  it('reconnect with Last-Event-ID:N yields events with id > N', async () => {
    const session = await client.createOrAttachSession({
      workspaceCwd: workspaceDir,
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

describePOSIX('qwen serve — historical Assistant response branch', () => {
  it('creates, opens, and continues a branch through the real daemon', async () => {
    const source = await client.createOrAttachSession({
      workspaceCwd: workspaceDir,
      sessionScope: 'thread',
    });
    const first = await client.prompt(source.sessionId, {
      prompt: [{ type: 'text', text: 'historical branch turn one' }],
    });
    expect(first.branchPoint).toBeDefined();
    if (!first.branchPoint) return;

    await client.prompt(source.sessionId, {
      prompt: [{ type: 'text', text: 'historical branch turn two' }],
    });
    await client.prompt(source.sessionId, {
      prompt: [{ type: 'text', text: 'historical branch turn three' }],
    });

    const branched = await client.branchSession(source.sessionId, {
      atRecordId: first.branchPoint.checkpointUuid,
    });
    const branchBeforeContinue = await client.getSessionTranscriptPage(
      branched.sessionId,
      { limit: 500 },
    );
    const branchBeforeText = JSON.stringify(branchBeforeContinue.events);
    expect(branchBeforeText).toContain('historical branch turn one');
    expect(branchBeforeText).not.toContain('historical branch turn two');
    expect(branchBeforeText).not.toContain('historical branch turn three');

    const sourceAfterBranch = await client.getSessionTranscriptPage(
      source.sessionId,
      { limit: 500 },
    );
    const sourceText = JSON.stringify(sourceAfterBranch.events);
    expect(sourceText).toContain('historical branch turn one');
    expect(sourceText).toContain('historical branch turn two');
    expect(sourceText).toContain('historical branch turn three');

    const loadedBranch = await client.loadSession(branched.sessionId);
    await client.prompt(
      branched.sessionId,
      {
        prompt: [{ type: 'text', text: 'continue the historical branch' }],
      },
      undefined,
      loadedBranch.clientId,
    );
    const branchAfterContinue = await client.getSessionTranscriptPage(
      branched.sessionId,
      { limit: 500 },
    );
    expect(JSON.stringify(branchAfterContinue.events)).toContain(
      'continue the historical branch',
    );

    // The source session must stay untouched by the fork's continuation.
    const sourceAfterContinue = await client.getSessionTranscriptPage(
      source.sessionId,
      { limit: 500 },
    );
    const sourceAfterContinueText = JSON.stringify(sourceAfterContinue.events);
    expect(sourceAfterContinueText).not.toContain(
      'continue the historical branch',
    );
    expect(sourceAfterContinueText).toContain('historical branch turn one');
    expect(sourceAfterContinueText).toContain('historical branch turn two');
    expect(sourceAfterContinueText).toContain('historical branch turn three');
  }, 90_000);
});

describePOSIX('qwen serve — daemon Todo Stop Guard replay', () => {
  it('continues after prompt admission without an SSE client and replays the bounded attempts', async () => {
    const session = await client.createOrAttachSession({
      workspaceCwd: workspaceDir,
    });
    const requestStart = fakeServer.requests.length;
    const guardMarker = `todo-guard-e2e-${requestStart}`;
    const accepted = asAccepted(
      await client.promptNonBlocking(session.sessionId, {
        prompt: [{ type: 'text', text: guardMarker }],
      }),
    );
    expect(accepted).toBeDefined();
    if (!accepted) return;

    await expect
      .poll(
        () =>
          fakeServer.requests
            .slice(requestStart)
            .filter((request) =>
              JSON.stringify(request.body['messages'] ?? []).includes(
                guardMarker,
              ),
            ).length,
        { timeout: 30_000 },
      )
      .toBe(4);

    const events: DaemonEvent[] = [];
    const ac = new AbortController();
    for await (const event of sseFrames(session.sessionId, {
      lastEventId: accepted.lastEventId,
      signal: ac.signal,
    })) {
      events.push(event);
      if (event.type === 'turn_complete') break;
    }
    ac.abort();

    const guardUpdates = events.filter((event) => {
      if (event.type !== 'session_update') return false;
      const update = (event.data as { update?: Record<string, unknown> })
        .update;
      const meta = update?.['_meta'] as Record<string, unknown> | undefined;
      return meta?.['source'] === 'todo_stop_guard';
    });
    expect(guardUpdates).toHaveLength(3);
    expect(
      guardUpdates.map((event) => {
        const update = (event.data as { update: Record<string, unknown> })
          .update;
        return (update['_meta'] as Record<string, unknown>)['attempt'];
      }),
    ).toEqual([1, 2, 2]);
    expect(events.some((event) => event.type === 'turn_complete')).toBe(true);
    expect(JSON.stringify(guardUpdates)).not.toContain(
      'Keep this item unfinished for the guard test',
    );
  }, 60_000);
});
