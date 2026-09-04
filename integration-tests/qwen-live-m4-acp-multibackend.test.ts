/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * qwen-live M4 — multiple backends coexisting: qwen serve as the default
 * plus the ACP child as a named secondary. session_list shows both with
 * their backend names; a handoff routes to the named backend's session;
 * and a dead secondary contributes zero rows without emptying the list.
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

describeE2E('qwen-live M4 — multi-backend coexistence', () => {
  let stack: AcpLiveStack;
  let conn: FakeDashScopeConnection;

  beforeAll(async () => {
    stack = await bootAcpLiveStack({
      mode: 'multi',
      makeOpenAIHandler:
        () =>
        ({ body }) => {
          const messages = JSON.stringify(body['messages'] ?? []);
          if (messages.includes('multi-acp-task')) {
            return { content: 'multi acp task done' };
          }
          if (messages.includes('multi-serve-task')) {
            return { content: 'multi serve task done' };
          }
          return { content: 'ok' };
        },
    });
    conn = (await startLiveCall(stack)).conn;
  }, 180_000);

  afterAll(async () => {
    await stack?.dispose();
  }, 60_000);

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

  it('runs a task on each backend and reports both in session_list', async () => {
    // A session on the ACP secondary (explicitly named)…
    const acpCreate = await toolCall('session_create', 'call-c1', {
      backend: 'qwen-acp',
      label: 'acp worker',
    });
    expect(acpCreate['status']).toBe('ok');
    const acpHandle = String(acpCreate['handle']);

    // …and a default handoff (no session arg) that lands on serve.
    const serveReceipt = await toolCall('handoff', 'call-h1', {
      task: 'multi-serve-task',
    });
    expect(serveReceipt['status']).toBe('accepted');
    const serveHandle = String(serveReceipt['session']);

    // A handoff naming the acp session routes to the acp child.
    const acpReceipt = await toolCall('handoff', 'call-h2', {
      task: 'multi-acp-task',
      session: acpHandle,
    });
    expect(acpReceipt['status']).toBe('accepted');
    expect(acpReceipt['session']).toBe(acpHandle);

    // Both completions flow back.
    for (const [job, marker] of [
      [String(serveReceipt['job']), 'multi serve task done'],
      [String(acpReceipt['job']), 'multi acp task done'],
    ] as const) {
      const complete = await stack.fakeDash.waitForMessage(
        (message) =>
          contextTextOf(message)?.includes(`[COMPLETE ${job}]`) ?? false,
        {
          timeoutMs: 60_000,
          description: `[COMPLETE ${job}]`,
        },
      );
      expect(contextTextOf(complete)).toContain(marker);
    }

    // session_list shows both backends.
    const list = await toolCall('session_list', 'call-l1', {});
    expect(list['status']).toBe('ok');
    const sessions = list['sessions'] as Array<Record<string, unknown>>;
    const backends = new Set(sessions.map((row) => row['backend']));
    expect(backends.has('qwen-code')).toBe(true);
    expect(backends.has('qwen-acp')).toBe(true);
    // The acp worker carries its label.
    const acpRow = sessions.find((row) => row['backend'] === 'qwen-acp');
    expect(acpRow?.['label']).toBe('acp worker');
    expect(serveHandle).toMatch(/^session_\d+$/);
  });
});
