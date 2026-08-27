/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * qwen-live M2 — result-injection window discipline (orchestrator/injector):
 *
 *   1. a backend turn_complete that arrives while a realtime response is in
 *      flight is NOT injected; it is delivered right after the response
 *      settles (`response.done`);
 *   2. several jobs finishing while the window is closed are batched into a
 *      single conversation.item.create context injection (Injector.flush
 *      joins the whole batch into one silent context message).
 *
 * The fake OpenAI handler gates each backend turn on a marker-keyed deferred
 * so the test controls exactly when qwen serve finishes each turn. The
 * daemon-side "turn_complete reached the orchestrator" edge is observed
 * through the daemon's session JSONL log.
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
  waitForLiveLogEvents,
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

const isTurnComplete = (event: {
  type: string;
  payload: Record<string, unknown>;
}) =>
  event.type === 'backend.event' && event.payload['type'] === 'turn_complete';

describeE2E('qwen-live M2 — injection window', () => {
  const gates = new Map<string, Deferred>();
  let stack: LiveStack;
  let conn: FakeDashScopeConnection;
  let callSeq = 0;

  const gatedHandoff = async (
    task: string,
    extraArgs: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    gates.set(task, deferred());
    const callId = `call-h${++callSeq}`;
    conn.functionCall({
      name: 'handoff',
      argumentsJson: JSON.stringify({ task, ...extraArgs }),
      callId,
    });
    const receiptMessage = await stack.fakeDash.waitForMessage(
      (message) => functionCallOutputOf(message)?.callId === callId,
      { timeoutMs: 30_000, description: `handoff receipt for ${task}` },
    );
    const receipt = JSON.parse(
      functionCallOutputOf(receiptMessage)!.output,
    ) as Record<string, unknown>;
    expect(receipt['status']).toBe('accepted');
    expect(typeof receipt['job']).toBe('string');
    return receipt;
  };

  /** Open a held response and wait until the daemon has registered it. */
  const holdResponse = async (): Promise<string> => {
    const stateIndex = stack.host.states.length;
    const holdId = conn.beginResponse();
    await stack.host.waitForState(
      (entry) => entry.status['state'] === 'speaking',
      { timeoutMs: 10_000, fromIndex: stateIndex },
    );
    return holdId;
  };

  beforeAll(async () => {
    stack = await bootLiveStack({
      makeOpenAIHandler:
        () =>
        async ({ body }) => {
          const messages = JSON.stringify(body['messages'] ?? []);
          for (const [marker, gate] of gates) {
            if (messages.includes(marker)) {
              await gate.promise;
              return { content: `finished ${marker}` };
            }
          }
          return { content: 'ok' };
        },
    });
    conn = (await startLiveCall(stack)).conn;
  }, 180_000);

  afterAll(async () => {
    for (const gate of gates.values()) gate.resolve(); // never leave serve hung
    await stack?.dispose();
  }, 60_000);

  it('holds [COMPLETE] while a response is in flight and injects after response.done', async () => {
    const inboxIndex = stack.fakeDash.inbox.length;
    const receipt = await gatedHandoff('inject-window-task');
    const job = String(receipt['job']);

    // Close the injection window: a response is now in flight.
    const holdId = await holdResponse();

    // Let the backend turn finish and wait until the daemon's orchestrator
    // has consumed the turn_complete event (session-log sync point).
    gates.get('inject-window-task')!.resolve();
    await waitForLiveLogEvents(stack.dataDir, isTurnComplete, {
      minCount: 1,
      timeoutMs: 30_000,
      description: 'backend.event turn_complete (inject-window-task)',
    });
    // Negative assertion needs a bounded settle window: a (buggy) premature
    // injection would be written to this loopback socket within milliseconds
    // of the log line above — there is no further event to await when the
    // implementation is correct.
    await sleep(250);
    const premature = stack.fakeDash.inbox
      .slice(inboxIndex)
      .map((message) => contextTextOf(message) ?? '')
      .filter((text) => text.includes('[COMPLETE'));
    expect(premature).toEqual([]);

    // Reopen the window: the queued conclusion must now arrive.
    conn.finishResponse(holdId);
    const complete = await stack.fakeDash.waitForMessage(
      (message) => {
        const text = contextTextOf(message);
        return text !== undefined && text.includes(`[COMPLETE ${job}]`);
      },
      {
        timeoutMs: 15_000,
        fromIndex: inboxIndex,
        description: `[COMPLETE ${job}] after response.done`,
      },
    );
    expect(contextTextOf(complete)).toContain('finished inject-window-task');
  });

  it('batches multiple completions into one context injection', async () => {
    // A second backend session so two independent turns can complete.
    conn.functionCall({
      name: 'session_create',
      argumentsJson: JSON.stringify({ label: 'second workstream' }),
      callId: 'call-sc',
    });
    const createdMessage = await stack.fakeDash.waitForMessage(
      (message) => functionCallOutputOf(message)?.callId === 'call-sc',
      { timeoutMs: 30_000, description: 'session_create receipt' },
    );
    const created = JSON.parse(
      functionCallOutputOf(createdMessage)!.output,
    ) as Record<string, unknown>;
    expect(created['status']).toBe('ok');
    const secondSession = String(created['handle']);

    const receiptA = await gatedHandoff('batch-task-a');
    const receiptB = await gatedHandoff('batch-task-b', {
      session: secondSession,
    });
    expect(receiptB['session']).toBe(secondSession);
    const jobA = String(receiptA['job']);
    const jobB = String(receiptB['job']);
    expect(jobA).not.toBe(jobB);

    const inboxIndex = stack.fakeDash.inbox.length;
    const holdId = await holdResponse();

    gates.get('batch-task-a')!.resolve();
    gates.get('batch-task-b')!.resolve();
    // 1 turn_complete from the previous test + 2 here.
    await waitForLiveLogEvents(stack.dataDir, isTurnComplete, {
      minCount: 3,
      timeoutMs: 30_000,
      description: 'backend.event turn_complete (batch-task-a/b)',
    });
    await sleep(250); // bounded settle window for the negative assertion
    const premature = stack.fakeDash.inbox
      .slice(inboxIndex)
      .map((message) => contextTextOf(message) ?? '')
      .filter((text) => text.includes('[COMPLETE'));
    expect(premature).toEqual([]);

    conn.finishResponse(holdId);
    // The injector flushes the whole queue as ONE combined context item:
    // both job conclusions must land in the same conversation.item.create.
    const merged = await stack.fakeDash.waitForMessage(
      (message) => {
        const text = contextTextOf(message);
        return text !== undefined && text.includes(`[COMPLETE ${jobA}]`);
      },
      {
        timeoutMs: 15_000,
        fromIndex: inboxIndex,
        description: `the merged [COMPLETE ${jobA}]/[COMPLETE ${jobB}] injection`,
      },
    );
    const mergedText = contextTextOf(merged)!;
    expect(mergedText).toContain(`[COMPLETE ${jobA}]`);
    expect(mergedText).toContain(`[COMPLETE ${jobB}]`);
  });
});
