/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * qwen-live M4 — steering semantics on the ACP backend: while a turn is
 * running on the acp child (the fake model handler holds the response on
 * a gate), a second handoff lands as a queued/joined instruction and its
 * text must reach the agent — drained mid-turn or delivered with the next
 * turn. Either way the steered text arrives in a model request payload.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sleep } from './cli/_daemon-harness.js';
import {
  contextTextOf,
  functionCallOutputOf,
  type FakeDashScopeConnection,
} from './fake-dashscope-server.js';
import {
  bootAcpLiveStack,
  deferred,
  startLiveCall,
  withTimeout,
  type AcpLiveStack,
  type Deferred,
} from './qwen-live-harness.js';

const SKIP =
  process.platform === 'win32' ||
  Boolean(
    process.env['QWEN_SANDBOX'] &&
      process.env['QWEN_SANDBOX'].toLowerCase() !== 'false',
  );
const describeE2E = SKIP ? describe.skip : describe;

const SLOW_MARKER = 'acp-steer-slow-task';
const STEER_MARKER = 'acp-steer-follow-up';

describeE2E('qwen-live M4 — ACP steering', () => {
  let stack: AcpLiveStack;
  let conn: FakeDashScopeConnection;
  let sessionHandle = '';
  const slowGate: Deferred = deferred();
  const slowRequestSeen: Deferred = deferred();
  /** Serialized `messages` of every model request the fake endpoint saw. */
  const modelRequests: string[] = [];

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

  const handoff = (callId: string, args: Record<string, unknown>) =>
    toolCall('handoff', callId, args);

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
        { session },
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
    stack = await bootAcpLiveStack({
      mode: 'acp',
      makeOpenAIHandler:
        () =>
        async ({ body }) => {
          const messages = JSON.stringify(body['messages'] ?? []);
          modelRequests.push(messages);
          if (messages.includes(SLOW_MARKER)) {
            slowRequestSeen.resolve();
            await slowGate.promise; // hold the turn until the test releases it
            return { content: 'slow acp task finished' };
          }
          return { content: 'ok' };
        },
    });
    conn = (await startLiveCall(stack)).conn;
  }, 180_000);

  afterAll(async () => {
    slowGate.resolve(); // never leave the agent hung on teardown
    await stack?.dispose();
  }, 60_000);

  it('delivers a steered instruction to the running ACP turn', async () => {
    const first = await handoff('call-s1', { task: SLOW_MARKER });
    expect(first['status']).toBe('accepted');
    sessionHandle = String(first['session']);
    expect(sessionHandle).toMatch(/^session_\d+$/);

    // The turn is really running: the model request is parked on the gate.
    await withTimeout(
      slowRequestSeen.promise,
      30_000,
      'the slow turn to reach the fake model endpoint',
    );

    const second = await handoff('call-s2', {
      task: STEER_MARKER,
      session: sessionHandle,
    });
    // Either the agent drained it into the running turn (joined) or it is
    // queued for the next one — both are honest receipts on ACP.
    expect(['accepted', 'queued']).toContain(second['status']);

    // Capture the baseline BEFORE releasing the gate: the slow turn's
    // completion fires immediately on release and would already be below
    // a later-captured index (R1-9).
    const inboxIndex = stack.fakeDash.inbox.length;

    // Release the turn; the steered text must reach the agent in some
    // subsequent model request (drained mid-turn or delivered after).
    slowGate.resolve();
    await withTimeout(
      (async () => {
        for (;;) {
          if (modelRequests.some((r) => r.includes(STEER_MARKER))) return;
          await sleep(200);
        }
      })(),
      60_000,
      'the steered instruction to reach the model endpoint',
    );

    // And the slow turn's conclusion flows back.
    const complete = await stack.fakeDash.waitForMessage(
      (message) => {
        const text = contextTextOf(message);
        return text !== undefined && /\[COMPLETE job_\d+\]/.test(text);
      },
      {
        timeoutMs: 60_000,
        fromIndex: inboxIndex,
        description: 'the [COMPLETE] injection for the steered turn',
      },
    );
    expect(contextTextOf(complete)).toContain('slow acp task finished');
  });

  it('accepts a plain handoff to the now-idle acp session', async () => {
    await waitForIdleSession(sessionHandle);
    const receipt = await handoff('call-s3', {
      task: 'one more acp task',
      session: sessionHandle,
    });
    expect(receipt['status']).toBe('accepted');
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
