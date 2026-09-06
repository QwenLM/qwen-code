/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * qwen-live M4 — the ACP backend as the ONLY backend: a voice handoff
 * drives a real `qwen --acp` child (fake OpenAI-compatible model
 * endpoint), and its completion flows back to the voice conversation.
 * The session log must record the acp backend name.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contextTextOf,
  functionCallOutputOf,
  type FakeDashScopeConnection,
} from './fake-dashscope-server.js';
import {
  bootAcpLiveStack,
  startLiveCall,
  type AcpLiveStack,
} from './qwen-live-harness.js';

const SKIP =
  process.platform === 'win32' ||
  Boolean(
    process.env['QWEN_SANDBOX'] &&
      process.env['QWEN_SANDBOX'].toLowerCase() !== 'false',
  );
const describeE2E = SKIP ? describe.skip : describe;

describeE2E('qwen-live M4 — ACP backend call loop', () => {
  let stack: AcpLiveStack;
  let conn: FakeDashScopeConnection;

  beforeAll(async () => {
    stack = await bootAcpLiveStack({
      mode: 'acp',
      makeOpenAIHandler:
        () =>
        ({ body }) => {
          const messages = JSON.stringify(body['messages'] ?? []);
          if (messages.includes('acp-call-task')) {
            return { content: 'acp call task complete' };
          }
          return { content: 'ok' };
        },
    });
    conn = (await startLiveCall(stack)).conn;
  }, 180_000);

  afterAll(async () => {
    await stack?.dispose();
  }, 60_000);

  it('hands off to the ACP backend and speaks the completion', async () => {
    const inboxIndex = stack.fakeDash.inbox.length;
    conn.functionCall({
      name: 'handoff',
      argumentsJson: JSON.stringify({ task: 'acp-call-task' }),
      callId: 'call-m4-1',
    });
    const receiptMessage = await stack.fakeDash.waitForMessage(
      (message) => functionCallOutputOf(message)?.callId === 'call-m4-1',
      {
        timeoutMs: 30_000,
        fromIndex: inboxIndex,
        description: 'the acp handoff receipt',
      },
    );
    const receipt = JSON.parse(
      functionCallOutputOf(receiptMessage)!.output,
    ) as Record<string, unknown>;
    expect(receipt['status']).toBe('accepted');
    const job = String(receipt['job']);

    const complete = await stack.fakeDash.waitForMessage(
      (message) =>
        contextTextOf(message)?.includes(`[COMPLETE ${job}]`) ?? false,
      {
        timeoutMs: 60_000,
        fromIndex: inboxIndex,
        description: `[COMPLETE ${job}] from the acp backend`,
      },
    );
    expect(contextTextOf(complete)).toContain('acp call task complete');
  });

  it('lists the acp session with its backend name', async () => {
    conn.functionCall({
      name: 'session_list',
      argumentsJson: '{}',
      callId: 'call-m4-2',
    });
    const listMessage = await stack.fakeDash.waitForMessage(
      (message) => functionCallOutputOf(message)?.callId === 'call-m4-2',
      {
        timeoutMs: 30_000,
        description: 'the session_list receipt',
      },
    );
    const list = JSON.parse(
      functionCallOutputOf(listMessage)!.output,
    ) as Record<string, unknown>;
    expect(list['status']).toBe('ok');
    const sessions = list['sessions'] as Array<Record<string, unknown>>;
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions.every((row) => row['backend'] === 'qwen-acp')).toBe(true);
  });
});
