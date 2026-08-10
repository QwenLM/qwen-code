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
 *
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isPathWithinRoot,
  TURN_RESULT_TEXT_MAX_CHARS,
} from '@qwen-code/qwen-code-core';
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
let blockedPromptMarker = '';
let blockedPromptGate: Promise<void> | undefined;
let releaseBlockedPrompt: (() => void) | undefined;
let repeatedFailureMarker = '';
let repeatedFailureRequestCount = 0;
let rewritePromptMarker = '';
let delayedRewriteMarker = '';
let delayedRewriteGate: Promise<void> | undefined;
let releaseDelayedRewrite: (() => void) | undefined;
let providerErrorMarker = '';

const defaultSettings = {
  experimental: { todoStopGuard: true },
  ui: { enableFollowupSuggestions: false },
};

function writeUserSettings(settings: Record<string, unknown>): void {
  writeFileSync(
    path.join(homeDir, '.qwen', 'settings.json'),
    JSON.stringify(settings),
  );
}

async function startDaemon(
  options: { promptDeadlineMs?: number } = {},
): Promise<void> {
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
      // Pin a scratch workspace so the daemon and every child session share
      // one hermetic settings/trust boundary across direct and CI runs.
      '--workspace',
      workspaceDir,
      ...(options.promptDeadlineMs !== undefined
        ? ['--prompt-deadline-ms', String(options.promptDeadlineMs)]
        : []),
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
        QWEN_CODE_ACP_REPEATED_TOOL_FAILURE_GUARD: repeatedFailureMarker
          ? 'enforce'
          : 'shadow',
      },
    },
  );
  port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    // Clear the boot timeout on success so it cannot keep vitest alive.
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
}

async function stopDaemon(): Promise<void> {
  if (daemon && daemon.exitCode === null) {
    daemon.kill('SIGTERM');
    await new Promise((resolve) => daemon.once('exit', resolve));
  }
}

async function turnStatus(
  sessionId: string,
  promptId: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `${base}/session/${sessionId}/turns/${promptId}`,
    { headers: { Authorization: `Bearer ${TOKEN}` } },
  );
  return response.ok
    ? ((await response.json()) as Record<string, unknown>)
    : { status: response.status };
}

beforeAll(async () => {
  if (SKIP) return;
  fakeServer = await startFakeOpenAIServer(async ({ body }) => {
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

    if (rewritePromptMarker && messages.includes(rewritePromptMarker)) {
      if (delayedRewriteMarker) {
        await delayedRewriteGate;
        return { content: 'late rewritten text' };
      }
      return { content: 'rewritten framework diagnostic' };
    }

    if (delayedRewriteMarker && messages.includes(delayedRewriteMarker)) {
      return { content: 'raw answer before cancellation' };
    }

    if (blockedPromptMarker && messages.includes(blockedPromptMarker)) {
      await blockedPromptGate;
      return { content: 'blocking turn complete' };
    }

    if (repeatedFailureMarker && messages.includes(repeatedFailureMarker)) {
      repeatedFailureRequestCount += 1;
      const callCount = repeatedFailureRequestCount < 3 ? 4 : 1;
      return {
        toolCalls: Array.from({ length: callCount }, (_, index) =>
          fakeToolCall('read_file', {
            file_path: path.join(
              workspaceDir,
              `missing-${repeatedFailureRequestCount}-${index}.txt`,
            ),
          }),
        ),
      };
    }

    if (providerErrorMarker && messages.includes(providerErrorMarker)) {
      return {
        httpError: {
          status: 400,
          message: 'simulated provider failure',
          code: 'invalid_request',
        },
      };
    }

    if (messages.includes('turn-final-answer-boundary-e2e')) {
      const toolCallId = 'call_turn_final_answer_boundary';
      if (!messages.includes(toolCallId)) {
        return {
          content: 'I will inspect the fixture first. ',
          toolCalls: [
            fakeToolCall(
              'read_file',
              {
                file_path: path.join(
                  workspaceDir,
                  'turn-final-answer-boundary.txt',
                ),
              },
              toolCallId,
            ),
          ],
        };
      }
      return { content: 'The strict final answer is 42.' };
    }

    if (messages.includes('turn-result-truncation-e2e')) {
      return {
        content: 'z'.repeat(TURN_RESULT_TEXT_MAX_CHARS + 100),
      };
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
    JSON.stringify(defaultSettings),
  );
  workspaceDir = mkdtempSync(path.join(tmpdir(), 'qwen-serve-streaming-ws-'));
  writeFileSync(
    path.join(workspaceDir, 'turn-final-answer-boundary.txt'),
    '42',
  );
  await startDaemon();
}, 30_000);

afterAll(async () => {
  if (!SKIP) await stopDaemon();
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

describePOSIX('qwen serve — turn result polling', () => {
  it('returns the completed turn result by promptId', async () => {
    const session = await client.createOrAttachSession({
      workspaceCwd: workspaceDir,
    });

    try {
      const accepted = asAccepted(
        await client.promptNonBlocking(session.sessionId, {
          prompt: [
            {
              type: 'text',
              text: 'return the fake response for turn polling',
            },
          ],
        }),
      );
      expect(accepted).toBeDefined();
      if (!accepted) return;

      await expect
        .poll(
          async () => {
            const response = await fetch(
              `${base}/session/${session.sessionId}/turns/${accepted.promptId}`,
              { headers: { Authorization: `Bearer ${TOKEN}` } },
            );
            if (!response.ok) return { status: response.status };
            return response.json();
          },
          { timeout: 30_000 },
        )
        .toMatchObject({
          sessionId: session.sessionId,
          promptId: accepted.promptId,
          state: 'completed',
          resultText: 'fake response complete',
        });
    } finally {
      await client.cancel(session.sessionId).catch(() => undefined);
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  }, 45_000);

  it('returns only the final answer after the last tool boundary', async () => {
    const session = await client.createOrAttachSession({
      workspaceCwd: workspaceDir,
    });

    try {
      const accepted = asAccepted(
        await client.promptNonBlocking(session.sessionId, {
          prompt: [
            {
              type: 'text',
              text: 'turn-final-answer-boundary-e2e',
            },
          ],
        }),
      );
      expect(accepted).toBeDefined();
      if (!accepted) return;

      await expect
        .poll(() => turnStatus(session.sessionId, accepted.promptId), {
          timeout: 30_000,
        })
        .toMatchObject({
          sessionId: session.sessionId,
          promptId: accepted.promptId,
          state: 'completed',
          stopReason: 'end_turn',
          resultText: 'The strict final answer is 42.',
        });
    } finally {
      await client.cancel(session.sessionId).catch(() => undefined);
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  }, 45_000);

  it('returns a stable code when the final answer exceeds the cap', async () => {
    const session = await client.createOrAttachSession({
      workspaceCwd: workspaceDir,
    });

    try {
      const accepted = asAccepted(
        await client.promptNonBlocking(session.sessionId, {
          prompt: [
            {
              type: 'text',
              text: 'turn-result-truncation-e2e',
            },
          ],
        }),
      );
      expect(accepted).toBeDefined();
      if (!accepted) return;

      let settled: Record<string, unknown> = {};
      await expect
        .poll(
          async () => {
            settled = await turnStatus(session.sessionId, accepted.promptId);
            return settled['state'];
          },
          { timeout: 30_000 },
        )
        .toBe('completed');

      expect(settled).toMatchObject({
        sessionId: session.sessionId,
        promptId: accepted.promptId,
        stopReason: 'end_turn',
        resultTruncated: true,
        resultCode: 'RESULT_TEXT_TRUNCATED',
      });
      expect(settled['resultText']).toBe(
        'z'.repeat(TURN_RESULT_TEXT_MAX_CHARS),
      );
    } finally {
      await client.cancel(session.sessionId).catch(() => undefined);
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  }, 45_000);
});

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

describePOSIX('qwen serve — turn result blocker regressions', () => {
  it('keeps a dispatched deadline error across daemon restart', async () => {
    await stopDaemon();
    await startDaemon({ promptDeadlineMs: 100 });
    const session = await client.createOrAttachSession({
      workspaceCwd: workspaceDir,
      sessionScope: 'thread',
    });
    blockedPromptMarker = `deadline-turn-${Date.now()}`;
    blockedPromptGate = new Promise<void>((resolve) => {
      releaseBlockedPrompt = resolve;
    });

    try {
      const accepted = asAccepted(
        await client.promptNonBlocking(session.sessionId, {
          prompt: [{ type: 'text', text: blockedPromptMarker }],
        }),
      );
      expect(accepted).toBeDefined();
      if (!accepted) return;

      await expect
        .poll(() => turnStatus(session.sessionId, accepted.promptId), {
          timeout: 30_000,
        })
        .toMatchObject({
          promptId: accepted.promptId,
          state: 'error',
          error: { code: 'prompt_deadline_exceeded' },
        });

      releaseBlockedPrompt?.();
      await stopDaemon();
      await startDaemon();
      await client.resumeSession(session.sessionId, {
        workspaceCwd: workspaceDir,
      });
      await expect(
        turnStatus(session.sessionId, accepted.promptId),
      ).resolves.toMatchObject({
        promptId: accepted.promptId,
        state: 'error',
        error: { code: 'prompt_deadline_exceeded' },
      });
    } finally {
      releaseBlockedPrompt?.();
      blockedPromptMarker = '';
      blockedPromptGate = undefined;
      releaseBlockedPrompt = undefined;
      await client.cancel(session.sessionId).catch(() => undefined);
      await client.closeSession(session.sessionId).catch(() => undefined);
      await stopDaemon();
      await startDaemon();
    }
  }, 90_000);

  it('keeps exact queued cancellation and prior completion across daemon restart', async () => {
    const session = await client.createOrAttachSession({
      workspaceCwd: workspaceDir,
      sessionScope: 'thread',
    });
    blockedPromptMarker = `blocked-turn-${Date.now()}`;
    blockedPromptGate = new Promise<void>((resolve) => {
      releaseBlockedPrompt = resolve;
    });

    try {
      const idleResponse = await fetch(
        `${base}/session/${session.sessionId}/turns/current`,
        { headers: { Authorization: `Bearer ${TOKEN}` } },
      );
      await expect(idleResponse.json()).resolves.toMatchObject({
        sessionId: session.sessionId,
        state: 'idle',
      });

      const unknownResponse = await fetch(
        `${base}/session/${session.sessionId}/turns/not-a-prompt`,
        { headers: { Authorization: `Bearer ${TOKEN}` } },
      );
      expect(unknownResponse.status).toBe(404);
      await expect(unknownResponse.json()).resolves.toMatchObject({
        code: 'prompt_not_found',
        promptId: 'not-a-prompt',
      });

      const running = asAccepted(
        await client.promptNonBlocking(session.sessionId, {
          prompt: [{ type: 'text', text: blockedPromptMarker }],
        }),
      );
      expect(running).toBeDefined();
      if (!running) return;
      await expect
        .poll(() => turnStatus(session.sessionId, running.promptId))
        .toMatchObject({
          promptId: running.promptId,
          state: 'running',
          startedAt: expect.any(Number),
        });

      const queued = asAccepted(
        await client.promptNonBlocking(session.sessionId, {
          prompt: [{ type: 'text', text: 'cancel this queued prompt' }],
        }),
      );
      expect(queued).toBeDefined();
      if (!queued) return;
      await expect
        .poll(() => turnStatus(session.sessionId, queued.promptId))
        .toMatchObject({
          promptId: queued.promptId,
          state: 'queued',
        });
      expect(
        await turnStatus(session.sessionId, queued.promptId),
      ).not.toHaveProperty('startedAt');

      await expect(
        client.removePendingPrompt(session.sessionId, queued.promptId),
      ).resolves.toMatchObject({ removed: true });
      await expect
        .poll(() => turnStatus(session.sessionId, queued.promptId))
        .toMatchObject({
          promptId: queued.promptId,
          state: 'cancelled',
        });
      expect(
        await turnStatus(session.sessionId, queued.promptId),
      ).not.toHaveProperty('startedAt');

      releaseBlockedPrompt?.();
      await expect
        .poll(() => turnStatus(session.sessionId, running.promptId), {
          timeout: 30_000,
        })
        .toMatchObject({
          promptId: running.promptId,
          state: 'completed',
          resultText: 'blocking turn complete',
        });

      await stopDaemon();
      await startDaemon();
      await client.resumeSession(session.sessionId, {
        workspaceCwd: workspaceDir,
      });
      await expect(
        turnStatus(session.sessionId, running.promptId),
      ).resolves.toMatchObject({
        state: 'completed',
        resultText: 'blocking turn complete',
      });
      await expect(
        turnStatus(session.sessionId, queued.promptId),
      ).resolves.toMatchObject({ state: 'cancelled' });
      expect(
        await turnStatus(session.sessionId, queued.promptId),
      ).not.toHaveProperty('startedAt');
    } finally {
      releaseBlockedPrompt?.();
      blockedPromptMarker = '';
      blockedPromptGate = undefined;
      releaseBlockedPrompt = undefined;
      await client.cancel(session.sessionId).catch(() => undefined);
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  }, 90_000);

  it('rewrites repeated-tool diagnostics without recording them as the answer', async () => {
    repeatedFailureMarker = `repeated-failure-${Date.now()}`;
    repeatedFailureRequestCount = 0;
    rewritePromptMarker = `rewrite-framework-diagnostic-${Date.now()}`;
    writeUserSettings({
      ...defaultSettings,
      messageRewrite: {
        enabled: true,
        target: 'message',
        prompt: rewritePromptMarker,
        contextTurns: 0,
      },
    });
    await stopDaemon();
    await startDaemon();
    const session = await client.createOrAttachSession({
      workspaceCwd: workspaceDir,
      sessionScope: 'thread',
    });

    try {
      const accepted = asAccepted(
        await client.promptNonBlocking(session.sessionId, {
          prompt: [{ type: 'text', text: repeatedFailureMarker }],
        }),
      );
      expect(accepted).toBeDefined();
      if (!accepted) return;

      await expect
        .poll(() => turnStatus(session.sessionId, accepted.promptId), {
          timeout: 60_000,
        })
        .toMatchObject({
          state: 'completed',
        });
      const status = await turnStatus(session.sessionId, accepted.promptId);
      expect(status['resultText']).toBeUndefined();

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
      expect(JSON.stringify(events)).toContain(
        'rewritten framework diagnostic',
      );
    } finally {
      repeatedFailureMarker = '';
      repeatedFailureRequestCount = 0;
      rewritePromptMarker = '';
      writeUserSettings(defaultSettings);
      await client.cancel(session.sessionId).catch(() => undefined);
      await client.closeSession(session.sessionId).catch(() => undefined);
      await stopDaemon();
      await startDaemon();
    }
  }, 90_000);

  it('drops a rewrite that finishes after its turn is cancelled', async () => {
    delayedRewriteMarker = `delayed-rewrite-${Date.now()}`;
    rewritePromptMarker = `rewrite-cancelled-turn-${Date.now()}`;
    delayedRewriteGate = new Promise<void>((resolve) => {
      releaseDelayedRewrite = resolve;
    });
    writeUserSettings({
      ...defaultSettings,
      messageRewrite: {
        enabled: true,
        target: 'message',
        prompt: rewritePromptMarker,
        contextTurns: 0,
        timeoutMs: 60_000,
      },
    });
    await stopDaemon();
    await startDaemon();
    const session = await client.createOrAttachSession({
      workspaceCwd: workspaceDir,
      sessionScope: 'thread',
    });

    try {
      const accepted = asAccepted(
        await client.promptNonBlocking(session.sessionId, {
          prompt: [{ type: 'text', text: delayedRewriteMarker }],
        }),
      );
      expect(accepted).toBeDefined();
      if (!accepted) return;

      await expect
        .poll(
          () =>
            fakeServer.requests.some((request) => {
              const messages = JSON.stringify(request.body['messages'] ?? []);
              return messages.includes(rewritePromptMarker);
            }),
          { timeout: 30_000 },
        )
        .toBe(true);
      const cancellation = client.cancel(session.sessionId);
      await expect
        .poll(() => turnStatus(session.sessionId, accepted.promptId), {
          timeout: 30_000,
        })
        .toMatchObject({ state: 'cancelled' });
      releaseDelayedRewrite?.();
      await cancellation;

      const status = await turnStatus(session.sessionId, accepted.promptId);
      expect(JSON.stringify(status)).not.toContain('late rewritten text');

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
      expect(JSON.stringify(events)).not.toContain('late rewritten text');
    } finally {
      releaseDelayedRewrite?.();
      delayedRewriteMarker = '';
      delayedRewriteGate = undefined;
      releaseDelayedRewrite = undefined;
      rewritePromptMarker = '';
      writeUserSettings(defaultSettings);
      await client.cancel(session.sessionId).catch(() => undefined);
      await client.closeSession(session.sessionId).catch(() => undefined);
      await stopDaemon();
      await startDaemon();
    }
  }, 90_000);

  it('returns provider failures as pollable turn errors', async () => {
    providerErrorMarker = `provider-error-${Date.now()}`;
    const session = await client.createOrAttachSession({
      workspaceCwd: workspaceDir,
      sessionScope: 'thread',
    });

    try {
      const accepted = asAccepted(
        await client.promptNonBlocking(session.sessionId, {
          prompt: [{ type: 'text', text: providerErrorMarker }],
        }),
      );
      expect(accepted).toBeDefined();
      if (!accepted) return;
      await expect
        .poll(() => turnStatus(session.sessionId, accepted.promptId), {
          timeout: 30_000,
        })
        .toMatchObject({
          state: 'error',
          error: {
            message: expect.any(String),
            code: expect.any(String),
          },
        });
    } finally {
      providerErrorMarker = '';
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  }, 60_000);
});
