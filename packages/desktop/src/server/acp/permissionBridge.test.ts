/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { PermissionBridge } from './permissionBridge.js';
import type { DesktopServerMessage } from '../../shared/desktopProtocol.js';

describe('PermissionBridge', () => {
  it('broadcasts permission requests and resolves selected options', async () => {
    const messages: DesktopServerMessage[] = [];
    const bridge = new PermissionBridge({
      timeoutMs: 1000,
      broadcast: (_sessionId, message) => messages.push(message),
    });

    const permission = bridge.requestPermission(createPermissionRequest());
    expect(messages[0]).toMatchObject({
      type: 'permission_request',
      request: {
        sessionId: 'session-1',
        toolCall: {
          toolCallId: 'tool-1',
          title: 'Run command',
        },
      },
    });

    const requestId = getRequestId(messages[0]);
    expect(
      bridge.handleClientMessage({
        type: 'permission_response',
        requestId,
        optionId: 'proceed_once',
      }),
    ).toBe(true);

    await expect(permission).resolves.toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'proceed_once',
      },
    });
  });

  it('normalizes ask-user-question requests and preserves answers', async () => {
    const messages: DesktopServerMessage[] = [];
    const bridge = new PermissionBridge({
      timeoutMs: 1000,
      broadcast: (_sessionId, message) => messages.push(message),
    });

    const permission = bridge.requestPermission({
      ...createPermissionRequest(),
      toolCall: {
        toolCallId: 'tool-question',
        title: 'Ask question',
        rawInput: {
          questions: [
            {
              header: 'Choice',
              question: 'Pick one',
              multiSelect: false,
              options: [{ label: 'A', description: 'Option A' }],
            },
          ],
          metadata: { source: 'test' },
        },
      },
    });

    expect(messages[0]).toMatchObject({
      type: 'ask_user_question',
      request: {
        sessionId: 'session-1',
        questions: [
          {
            header: 'Choice',
            question: 'Pick one',
            multiSelect: false,
          },
        ],
        metadata: { source: 'test' },
      },
    });

    const requestId = getRequestId(messages[0]);
    bridge.handleClientMessage({
      type: 'ask_user_question_response',
      requestId,
      optionId: 'proceed_once',
      answers: { Choice: 'A' },
    });

    await expect(permission).resolves.toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'proceed_once',
      },
      answers: { Choice: 'A' },
    });
  });

  it('cancels pending permission requests on timeout and session close', async () => {
    vi.useFakeTimers();
    const bridge = new PermissionBridge({
      timeoutMs: 50,
      broadcast: () => {},
    });

    const timedOut = bridge.requestPermission(createPermissionRequest());
    await vi.advanceTimersByTimeAsync(50);
    await expect(timedOut).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });

    const cancelled = bridge.requestPermission(createPermissionRequest());
    bridge.cancelSession('session-1');
    await expect(cancelled).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });
    vi.useRealTimers();
  });
});

function createPermissionRequest(): RequestPermissionRequest {
  return {
    sessionId: 'session-1',
    options: [
      { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
    ],
    toolCall: {
      toolCallId: 'tool-1',
      title: 'Run command',
      kind: 'execute',
      status: 'pending',
    },
  };
}

function getRequestId(message: DesktopServerMessage | undefined): string {
  if (
    message?.type !== 'permission_request' &&
    message?.type !== 'ask_user_question'
  ) {
    throw new Error('Expected permission request message.');
  }

  return message.requestId;
}
