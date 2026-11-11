/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../../config/config.js';
import type { Message } from '../../protocol/transcript/message.js';
import { cloneUsage } from '../../protocol/provider/empty-usage.js';
import {
  _resetQueueForTest,
  getCommandQueueSnapshot,
} from '../../services/messageQueueManager.js';
import {
  deriveTeammateIdleSummary,
  enqueueTeammateMessageForMain,
} from './agent-team-main-delivery.js';

function assistantWithSendMessage(input: Record<string, unknown>): Message {
  return {
    type: 'assistant',
    uuid: 'assistant-1',
    timestamp: '2026-08-03T00:00:00.000Z',
    message: {
      type: 'message',
      role: 'assistant',
      stop_sequence: null,
      container: null,
      context_management: null,
      id: 'message-1',

      model: 'test-model',
      content: [
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'SendMessage',
          input,
        },
      ],
      stop_reason: 'tool_use',

      usage: {
        ...cloneUsage(),
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

afterEach(() => {
  _resetQueueForTest();
});

describe('enqueueTeammateMessageForMain', () => {
  it('carries the teammate turn customContext into the main-thread continuation', () => {
    const customContext = Object.freeze({ tenant: 'alpha' });
    enqueueTeammateMessageForMain({
      config: { getSessionId: () => 'session-1' } as unknown as Config,
      from: 'reviewer',
      text: 'done',
      customContext,
    });

    expect(getCommandQueueSnapshot()).toEqual([
      expect.objectContaining({
        commandMode: 'prompt',
        sessionId: 'session-1',
        customContext,
      }),
    ]);
  });
});

describe('deriveTeammateIdleSummary', () => {
  it('uses the last SendMessage summary from the current teammate turn', () => {
    expect(
      deriveTeammateIdleSummary([
        assistantWithSendMessage({
          to: 'main',
          summary: 'Sending computed sum result',
          message: 'The result is 42.',
        }),
      ]),
    ).toBe('[to main] Sending computed sum result');
  });

  it('falls back to the message prefix and applies the detail limit', () => {
    expect(
      deriveTeammateIdleSummary([
        assistantWithSendMessage({
          to: 'reviewer',
          message: 'x'.repeat(120),
        }),
      ]),
    ).toBe(`[to reviewer] ${'x'.repeat(80)}`);
  });

  it('does not reuse a SendMessage from an earlier user turn', () => {
    const userMessage = {
      type: 'user',
      uuid: 'user-1',
      timestamp: '2026-08-03T00:00:01.000Z',
      message: { role: 'user', content: 'Continue.' },
    } as Message;
    expect(
      deriveTeammateIdleSummary([
        assistantWithSendMessage({
          to: 'main',
          summary: 'Old summary',
          message: 'Old message',
        }),
        userMessage,
      ]),
    ).toBeUndefined();
  });

  it('does not summarize an ordinary update addressed to team-lead', () => {
    expect(
      deriveTeammateIdleSummary([
        assistantWithSendMessage({
          to: 'team-lead',
          summary: 'Direct lead update',
          message: 'Done.',
        }),
      ]),
    ).toBeUndefined();
  });
});
