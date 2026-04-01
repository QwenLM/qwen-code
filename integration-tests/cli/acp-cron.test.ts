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
 * The two tests share one ACP session to stay within 2 minutes total:
 *   1. Fast smoke test — cron tools available (no cron fire needed)
 *   2. Combined test — create job, verify session responsive, wait for
 *      cron fire, check content + _meta.source, then clean up
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it, expect } from 'vitest';
import { TestRig } from '../test-helper.js';

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

/**
 * Sets up an ACP test environment with cron support enabled.
 */
function setupAcpCronTest(rig: TestRig) {
  const pending = new Map<number, PendingRequest>();
  let nextRequestId = 1;
  const sessionUpdates: (SessionUpdateNotification & {
    receivedAt: number;
  })[] = [];
  const stderr: string[] = [];

  const agent = spawn(
    'node',
    [rig.bundlePath, '--acp', '--no-chat-recording'],
    {
      cwd: rig.testDir!,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        QWEN_CODE_ENABLE_CRON: '1',
      },
    },
  );

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
    agent.kill();
    pending.forEach(({ timeout }) => clearTimeout(timeout));
    pending.clear();
    await waitForExit();
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
      rig.setup('acp-cron-e2e', {
        settings: { experimental: { cron: true } },
      });

      const {
        sendRequest,
        cleanup,
        stderr,
        // sessionUpdates available for debugging
        waitForSessionUpdate,
      } = setupAcpCronTest(rig);

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

        const promptDoneAt = Date.now();

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

        // --- Part 3: Wait for cron-fired notification (up to 75s) ---
        // The cron fires at the next minute boundary. The model response
        // should stream back as sessionUpdate notifications after the
        // originating prompt has already returned.

        // 3a: Check for user_message_chunk echoing the cron prompt with _meta.source
        const cronUserMsg = await waitForSessionUpdate(
          (u) =>
            u.update?.sessionUpdate === 'user_message_chunk' &&
            (u.update?.content?.text ?? '').includes('CRONFIRE7742') &&
            u.receivedAt > promptDoneAt,
          'cron-fired user_message_chunk with CRONFIRE7742',
          75_000,
        );
        expect(cronUserMsg.update?._meta).toBeDefined();
        expect(cronUserMsg.update?._meta?.source).toBe('cron');

        // 3b: Check for agent_message_chunk after the cron user message
        // (the model's response to the cron prompt)
        const cronAgentMsg = await waitForSessionUpdate(
          (u) =>
            u.update?.sessionUpdate === 'agent_message_chunk' &&
            u.receivedAt > cronUserMsg.receivedAt,
          'agent_message_chunk after cron fire',
          15_000, // should already be here by now
        );
        expect(cronAgentMsg.receivedAt).toBeGreaterThan(promptDoneAt);

        // --- Part 4: Clean up the cron job ---
        await sendRequest('session/prompt', {
          sessionId,
          prompt: [
            {
              type: 'text',
              text: 'Delete all cron jobs using cron_delete.',
            },
          ],
        });
      } catch (e) {
        if (stderr.length) console.error('Agent stderr:', stderr.join(''));
        throw e;
      } finally {
        await cleanup();
      }
    },
    { timeout: 120_000, retry: 0 },
  );
});
