/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * qwen-live M2 — steering semantics of `handoff` receipts:
 *
 *   1. while a serve turn is running (the fake OpenAI handler holds the
 *      model response on a gate), a second handoff targeting the same
 *      session is delivered as a mid-turn message — the receipt reads
 *      `status:"accepted"` with the 'joined the currently running task'
 *      note (qwen-code-adaptor's steer path);
 *   2. once the session is idle again, a handoff with an explicit `session`
 *      argument is a plain accepted prompt (new job, no 'joined' note).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sleep } from './cli/_daemon-harness.js';
import {
  contextTextOf,
  functionCallOutputOf,
  type FakeDashScopeConnection,
} from './fake-dashscope-server.js';
import {
  bootLiveStack,
  deferred,
  startLiveCall,
  withTimeout,
  type Deferred,
  type LiveStack,
} from './qwen-live-harness.js';

const SKIP =
  process.platform === 'win32' ||
  Boolean(
    process.env['QWEN_SANDBOX'] &&
      process.env['QWEN_SANDBOX'].toLowerCase() !== 'false',
  );
const describeE2E = SKIP ? describe.skip : describe;

const SLOW_MARKER = 'steer-slow-task';

describeE2E('qwen-live M2 — mid-turn steering', () => {
  let stack: LiveStack;
  let conn: FakeDashScopeConnection;
  let sessionHandle = '';
  const slowGate: Deferred = deferred();
  const slowRequestSeen: Deferred = deferred();

  const toolCall = async (
    name: string,
    callId: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    conn.functionCall({
      name,
      argumentsJson: JSON.stringify(args),
      callId,
    });
    const receiptMessage = await stack.fakeDash.waitForMessage(
      (message) => functionCallOutputOf(message)?.callId === callId,
      { timeoutMs: 30_000, description: `${name} receipt ${callId}` },
    );
    return JSON.parse(functionCallOutputOf(receiptMessage)!.output) as Record<
      string,
      unknown
    >;
  };

  const handoff = (
    callId: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => toolCall('handoff', callId, args);

  /**
   * Poll the session through the protocol's own probe (session_monitor)
   * until the orchestrator reports it idle. A steered mid-turn message can
   * legitimately be promoted into a follow-up turn after the first one
   * completes, so "the [COMPLETE] arrived" does not imply "idle".
   */
  let monitorSeq = 0;
  const waitForIdleSession = async (
    session: string,
    timeoutMs = 30_000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const snapshot = await toolCall(
        'session_monitor',
        `call-mon-${++monitorSeq}`,
        {
          session,
        },
      );
      expect(snapshot['status']).toBe('ok');
      if (snapshot['state'] === 'idle') return;
      if (Date.now() > deadline) {
        throw new Error(
          `session ${session} still ${String(snapshot['state'])} after ${timeoutMs}ms`,
        );
      }
      await sleep(200);
    }
  };

  beforeAll(async () => {
    stack = await bootLiveStack({
      makeOpenAIHandler:
        () =>
        async ({ body }) => {
          const messages = JSON.stringify(body['messages'] ?? []);
          if (messages.includes(SLOW_MARKER)) {
            slowRequestSeen.resolve();
            await slowGate.promise; // hang the turn until the test releases it
            return { content: 'slow task finished' };
          }
          return { content: 'ok' };
        },
    });
    conn = (await startLiveCall(stack)).conn;
  }, 180_000);

  afterAll(async () => {
    slowGate.resolve(); // never leave serve hung on teardown
    await stack?.dispose();
  }, 60_000);

  it('joins the running turn when handing off to a busy session', async () => {
    const first = await handoff('call-s1', { task: SLOW_MARKER });
    expect(first['status']).toBe('accepted');
    expect(typeof first['job']).toBe('string');
    sessionHandle = String(first['session']);
    expect(sessionHandle).toMatch(/^session_\d+$/);

    // The serve turn is really running: the model request is parked on the
    // gate inside the fake OpenAI handler.
    await withTimeout(
      slowRequestSeen.promise,
      30_000,
      'the slow turn to reach the fake model endpoint',
    );

    const second = await handoff('call-s2', {
      task: 'also update the changelog',
      session: sessionHandle,
    });
    expect(second['status']).toBe('accepted');
    expect(second['session']).toBe(sessionHandle);
    expect(String(second['note'])).toContain('joined');

    // Release the turn; its conclusion must flow back as [COMPLETE].
    const inboxIndex = stack.fakeDash.inbox.length;
    slowGate.resolve();
    const complete = await stack.fakeDash.waitForMessage(
      (message) => {
        const text = contextTextOf(message);
        return text !== undefined && /\[COMPLETE job_\d+\]/.test(text);
      },
      {
        timeoutMs: 30_000,
        fromIndex: inboxIndex,
        description: 'the [COMPLETE] injection for the steered turn',
      },
    );
    expect(contextTextOf(complete)).toContain('slow task finished');
  });

  it('accepts a plain handoff to the now-idle session', async () => {
    // The joined instruction may be promoted into a follow-up turn after the
    // first turn completes; wait until the orchestrator reports idle.
    await waitForIdleSession(sessionHandle);

    const receipt = await handoff('call-s3', {
      task: 'one more quick task',
      session: sessionHandle,
    });
    expect(receipt['status']).toBe('accepted');
    expect(receipt['session']).toBe(sessionHandle);
    expect(typeof receipt['job']).toBe('string');
    // Idle session ⇒ a fresh prompt, not a mid-turn join.
    expect(String(receipt['note'] ?? '')).not.toContain('joined');
    expect(String(receipt['note'] ?? '')).not.toContain('queued');

    const job = String(receipt['job']);
    await stack.fakeDash.waitForMessage(
      (message) =>
        contextTextOf(message)?.includes(`[COMPLETE ${job}]`) ?? false,
      {
        timeoutMs: 30_000,
        description: `[COMPLETE ${job}] for the idle handoff`,
      },
    );
  });
});
