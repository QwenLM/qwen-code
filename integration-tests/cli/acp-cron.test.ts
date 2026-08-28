/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ACP integration tests for in-session cron/loop scheduling.
 *
 * These verify that cron jobs created during an ACP session fire correctly
 * and stream results back to the client via sessionUpdate notifications,
 * even after the originating prompt has already returned.
 *
 * Uses fake-openai-server for deterministic model responses, eliminating
 * model output variance as a failure source. The QWEN_CODE_TEST_CRON_FAST
 * test seam auto-fires cron jobs after a short delay instead of waiting
 * for the wall-clock minute boundary.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it, expect } from 'vitest';
import { TestRig } from '../test-helper.js';
import {
  startFakeOpenAIServer,
  fakeToolCall,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';

const REQUEST_TIMEOUT_MS = 60_000;

const IS_SANDBOX =
  process.env['QWEN_SANDBOX'] &&
  process.env['QWEN_SANDBOX']!.toLowerCase() !== 'false';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
};

type SessionUpdateNotification = {
  sessionId?: string;
  update?: {
    sessionUpdate?: string;
    content?: {
      type: string;
      text?: string;
    };
    title?: string;
    toolCallId?: string;
    status?: string;
    _meta?: Record<string, unknown>;
    [key: string]: unknown;
  };
};

type PermissionRequest = {
  id: number;
  sessionId?: string;
  toolCall?: {
    toolCallId: string;
    title: string;
    kind: string;
    status: string;
  };
  options?: Array<{
    optionId: string;
    name: string;
    kind: string;
  }>;
};

const CRON_CREATE_INSTRUCTION = 'Call cron_create with cron expression';

function isCronCreateRequest(body: Record<string, unknown>): boolean {
  const messages = body['messages'];
  return (
    Array.isArray(messages) &&
    JSON.stringify(messages.at(-1))?.includes(CRON_CREATE_INSTRUCTION) === true
  );
}

/**
 * Sets up an ACP test environment with cron support enabled, backed by
 * a fake-openai-server for deterministic model responses.
 */
function setupAcpCronTest(rig: TestRig, fakeServer: FakeOpenAIServer) {
  const pending = new Map<number, PendingRequest>();
  let nextRequestId = 1;
  const sessionUpdates: (SessionUpdateNotification & {
    receivedAt: number;
  })[] = [];
  const stderr: string[] = [];

  // Keep the global config dir outside the agent's workspace cwd so workspace
  // scans (memory discovery, file tooling) never see it.
  const qwenHome = join(
    dirname(rig.testDir!),
    `${basename(rig.testDir!)}-home`,
  );
  rmSync(qwenHome, { recursive: true, force: true });
  mkdirSync(qwenHome, { recursive: true });

  const agent = spawn(
    'node',
    [rig.bundlePath, '--acp', '--no-chat-recording'],
    {
      cwd: rig.testDir!,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Run the CLI in its own process group so cleanup can signal the
      // whole tree. Grandchildren spawned by the CLI (MCP helpers, cron
      // internals) otherwise survive `agent.kill()` and keep writing
      // into QWEN_HOME while rmSync is deleting it (ENOTEMPTY flakes).
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        QWEN_HOME: qwenHome,
        OPENAI_API_KEY: 'fake-key',
        OPENAI_BASE_URL: fakeServer.baseUrl,
        OPENAI_MODEL: 'fake-model',
        QWEN_MODEL: 'fake-model',
        // Defends against an ambient proxy intercepting the local fake server.
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
        // Enable the CronScheduler test seam: newly created session-only
        // jobs auto-fire after 5s instead of waiting for the wall-clock
        // minute boundary (see cron-interactive.test.ts).
        QWEN_CODE_TEST_CRON_FAST: '1',
        QWEN_CODE_TEST_CRON_DELAY_MS: '5000',
      },
    },
  );

  // The group kill in cleanup() only works if the CLI actually leads its
  // own process group (detached above). Pin that precondition here: if it
  // ever stops holding, fail fast instead of silently degrading to the
  // pre-fix direct-child-only teardown and resurrecting the ENOTEMPTY flake.
  if (process.platform !== 'win32') {
    expect(() => process.kill(-agent.pid!, 0)).not.toThrow();
  }

  agent.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(chunk.toString());
  });

  const rl = createInterface({ input: agent.stdout });

  const send = (json: unknown) => {
    agent.stdin.write(`${JSON.stringify(json)}\n`);
  };

  const sendResponse = (id: number, result: unknown) => {
    send({ jsonrpc: '2.0', id, result });
  };

  const sendRequest = (method: string, params?: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextRequestId++;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Request ${id} (${method}) timed out`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timeout });
      send({ jsonrpc: '2.0', id, method, params });
    });

  const handleResponse = (msg: {
    id: number;
    result?: unknown;
    error?: { message?: string };
  }) => {
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    pending.delete(msg.id);
    if (msg.error) {
      const error = new Error(msg.error.message ?? 'Unknown error');
      (error as Error & { response?: unknown }).response = msg.error;
      waiter.reject(error);
    } else {
      waiter.resolve(msg.result);
    }
  };

  const handleMessage = (msg: {
    id?: number;
    method?: string;
    params?: SessionUpdateNotification & {
      path?: string;
      content?: string;
      sessionId?: string;
      toolCall?: PermissionRequest['toolCall'];
      options?: PermissionRequest['options'];
    };
    result?: unknown;
    error?: { message?: string };
  }) => {
    if (typeof msg.id !== 'undefined' && ('result' in msg || 'error' in msg)) {
      handleResponse(
        msg as {
          id: number;
          result?: unknown;
          error?: { message?: string };
        },
      );
      return;
    }

    if (msg.method === 'session/update') {
      sessionUpdates.push({
        sessionId: msg.params?.sessionId,
        update: msg.params?.update,
        receivedAt: Date.now(),
      });
      return;
    }

    if (
      msg.method === 'session/request_permission' &&
      typeof msg.id === 'number'
    ) {
      sendResponse(msg.id, {
        outcome: { optionId: 'proceed_once', outcome: 'selected' },
      });
      return;
    }

    if (msg.method === 'fs/read_text_file' && typeof msg.id === 'number') {
      try {
        const content = readFileSync(msg.params?.path ?? '', 'utf8');
        sendResponse(msg.id, { content });
      } catch (e) {
        sendResponse(msg.id, { content: `ERROR: ${(e as Error).message}` });
      }
      return;
    }

    if (msg.method === 'fs/write_text_file' && typeof msg.id === 'number') {
      try {
        writeFileSync(
          msg.params?.path ?? '',
          msg.params?.content ?? '',
          'utf8',
        );
        sendResponse(msg.id, null);
      } catch (e) {
        sendResponse(msg.id, { message: (e as Error).message });
      }
      return;
    }

    // JSON-RPC requires every request to get a response. Reject unknown
    // agent->client requests (e.g. optional extension methods like
    // craft/drainMidTurnQueue) with -32601 so the agent fails fast instead
    // of awaiting a reply that never comes.
    if (typeof msg.id === 'number' && typeof msg.method === 'string') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Method not found' },
      });
    }
  };

  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      handleMessage(msg);
    } catch {
      // Ignore non-JSON output
    }
  });

  /**
   * Polls sessionUpdates until a notification matching the predicate appears,
   * or the timeout expires.
   */
  const waitForSessionUpdate = async (
    predicate: (
      update: SessionUpdateNotification & { receivedAt: number },
    ) => boolean,
    description: string,
    timeoutMs: number,
  ): Promise<SessionUpdateNotification & { receivedAt: number }> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = sessionUpdates.find(predicate);
      if (match) return match;
      await delay(500);
    }
    throw new Error(
      `Timed out waiting for sessionUpdate: ${description} (after ${timeoutMs}ms, ` +
        `saw ${sessionUpdates.length} updates: ` +
        `[${sessionUpdates.map((u) => u.update?.sessionUpdate).join(', ')}])`,
    );
  };

  const waitForExit = () =>
    new Promise<void>((resolve) => {
      if (agent.exitCode !== null || agent.signalCode) {
        resolve();
        return;
      }
      agent.once('exit', () => resolve());
    });

  const cleanup = async () => {
    rl.close();
    pending.forEach(({ timeout }) => clearTimeout(timeout));
    pending.clear();
    // Signal the entire process group, not just the direct child: the CLI
    // spawns helpers that keep running after the parent dies and can drop
    // fresh files into the fake HOME while the final rmSync walks it.
    if (process.platform === 'win32') {
      // No POSIX process groups: taskkill /T walks the child tree instead.
      // Absolute System32 path per the #5873 hardening: a bare name resolves
      // via the CreateProcess search order, where CWD (rig.testDir here)
      // precedes System32. The sync form also means a launch failure cannot
      // escape as an unhandled 'error' event; agent.kill() below stays as
      // the fallback either way. taskkill /T /F terminates the root too.
      try {
        spawnSync(
          join(
            process.env['SystemRoot'] ?? 'C:\\Windows',
            'System32',
            'taskkill.exe',
          ),
          ['/t', '/f', '/pid', String(agent.pid)],
          { windowsHide: true },
        );
      } catch {
        // taskkill failed to launch — fall through to the direct kill below.
      }
      agent.kill();
    } else {
      try {
        process.kill(-agent.pid!, 'SIGTERM');
      } catch (e) {
        // Only a vanished process group is benign; anything else must
        // surface instead of silently degrading to a partial teardown.
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
      }
      agent.kill('SIGTERM');
    }
    await waitForExit();
    // The cron job is recurring and, under QWEN_CODE_TEST_CRON_FAST, re-fires
    // every ~5s. A second fire can race cleanup and drop a fresh file into the
    // fake HOME after the recursive walk has drained it, making the final
    // rmdir fail with ENOTEMPTY. rmSync's built-in retries only repeat the
    // failing rmdir and never re-walk for entries created mid-walk, so each
    // attempt below starts a fresh walk instead.
    const RM_ATTEMPTS = 5;
    const RM_RETRY_DELAY_MS = 200;
    for (let attempt = 0; attempt < RM_ATTEMPTS; attempt++) {
      try {
        rmSync(qwenHome, { recursive: true, force: true });
        return;
      } catch (e) {
        if (
          (e as NodeJS.ErrnoException).code !== 'ENOTEMPTY' ||
          attempt === RM_ATTEMPTS - 1
        ) {
          throw e;
        }
        await delay(RM_RETRY_DELAY_MS);
      }
    }
  };

  return {
    sendRequest,
    cleanup,
    stderr,
    sessionUpdates,
    waitForSessionUpdate,
  };
}

/** Standard ACP init + auth + new session sequence. */
async function initSession(
  sendRequest: (method: string, params?: unknown) => Promise<unknown>,
  testDir: string,
): Promise<string> {
  await sendRequest('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
    },
  });

  await sendRequest('authenticate', { methodId: 'openai' });

  const newSession = (await sendRequest('session/new', {
    cwd: testDir,
    mcpServers: [],
  })) as { sessionId: string };

  return newSession.sessionId;
}

(IS_SANDBOX ? describe.skip : describe)('acp cron integration', () => {
  it(
    'cron job fires and streams results via sessionUpdate after prompt returns',
    async () => {
      const rig = new TestRig();
      await rig.setup('acp-cron-e2e');

      const fakeServer = await startFakeOpenAIServer(({ body }) => {
        if (isCronCreateRequest(body)) {
          return {
            toolCalls: [
              fakeToolCall('cron_create', {
                cron: '*/1 * * * *',
                prompt: 'Say CRONFIRE7742 and nothing else',
                recurring: true,
              }),
            ],
          };
        }
        return { content: 'Done.' };
      });

      try {
        const { sendRequest, cleanup, stderr, waitForSessionUpdate } =
          setupAcpCronTest(rig, fakeServer);

        try {
          const sessionId = await initSession(sendRequest, rig.testDir!);

          // --- Part 1: Create a cron job that fires every minute ---
          const createResult = (await sendRequest('session/prompt', {
            sessionId,
            prompt: [
              {
                type: 'text',
                text: 'Call cron_create with cron expression "*/1 * * * *" and prompt "Say CRONFIRE7742 and nothing else" and recurring true. Confirm briefly.',
              },
            ],
          })) as { stopReason: string };
          expect(createResult.stopReason).toBe('end_turn');

          // Fail fast instead of surfacing a missing tool call as an opaque
          // 75s timeout in Part 3a.
          expect(
            fakeServer.requests.some(({ body }) => isCronCreateRequest(body)),
            'fake server did not receive the cron_create prompt',
          ).toBe(true);

          // --- Part 2: Session stays responsive while cron is pending ---
          const interactiveResult = (await sendRequest('session/prompt', {
            sessionId,
            prompt: [
              {
                type: 'text',
                text: 'Say INTERACTIVE8899 and nothing else.',
              },
            ],
          })) as { stopReason: string };
          expect(interactiveResult.stopReason).toBe('end_turn');

          // --- Part 3: Wait for cron-fired notification ---
          // With QWEN_CODE_TEST_CRON_FAST the job auto-fires ~5s after
          // creation. The model response should stream back as
          // sessionUpdate notifications after the originating prompt has
          // already returned.

          // 3a: Check for the user_message_chunk echoing the cron prompt.
          // Select it by _meta.source === 'cron' rather than a wall-clock
          // comparison: the Part 1 prompt text also contains CRONFIRE7742,
          // and the cron notification races the Part 1 RPC response over the
          // same stdout pipe, so a timestamp guard can non-deterministically
          // exclude the one fast fire. The cron-sourced echo is the only
          // user_message_chunk carrying _meta.source === 'cron'
          // (see Session.#executeCronPromptInner).
          const cronUserMsg = await waitForSessionUpdate(
            (u) =>
              u.update?.sessionUpdate === 'user_message_chunk' &&
              u.update?._meta?.source === 'cron',
            "cron-sourced user_message_chunk (_meta.source === 'cron')",
            75_000,
          );
          expect(cronUserMsg.update?.content?.text).toContain('CRONFIRE7742');

          // 3b: Check for agent_message_chunk after the cron user message
          // (the model's response to the cron prompt). The predicate matches
          // any agent_message_chunk after cronUserMsg; ordering is safe
          // because the fast fire lands ~5s in, well after Part 2 completes.
          await waitForSessionUpdate(
            (u) =>
              u.update?.sessionUpdate === 'agent_message_chunk' &&
              u.receivedAt > cronUserMsg.receivedAt,
            'agent_message_chunk after cron fire',
            15_000, // should already be here by now
          );
        } catch (e) {
          if (stderr.length) console.error('Agent stderr:', stderr.join(''));
          console.error(
            'Fake server requests:',
            fakeServer.requests.map((r, i) => ({
              index: i,
              model: r.body['model'],
              messages: JSON.stringify(r.body['messages']).slice(0, 300),
            })),
          );
          throw e;
        } finally {
          await cleanup();
        }
      } finally {
        await fakeServer.close();
      }
    },
    { timeout: 120_000, retry: 0 },
  );
});
