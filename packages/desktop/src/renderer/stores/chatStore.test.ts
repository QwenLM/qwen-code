/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { chatReducer, createInitialChatState } from './chatStore.js';

describe('chatStore', () => {
  it('resets conversation state for local draft threads', () => {
    const withMessage = chatReducer(createInitialChatState(), {
      type: 'append_user_message',
      content: 'hello',
    });

    expect(chatReducer(withMessage, { type: 'reset' })).toEqual(
      createInitialChatState(),
    );
  });

  it('marks replayed history as loaded without adding a completion event', () => {
    const connected = chatReducer(createInitialChatState(), {
      type: 'server_message',
      message: {
        type: 'connected',
        sessionId: 'session-1',
      },
    });
    const replaying = chatReducer(connected, {
      type: 'server_message',
      message: {
        type: 'message_delta',
        role: 'assistant',
        text: 'Recovered history',
      },
    });

    const loaded = chatReducer(replaying, { type: 'history_loaded' });

    expect(loaded.streaming).toBe(false);
    expect(loaded.items).toHaveLength(1);
    expect(loaded.items[0]).toMatchObject({
      type: 'message',
      streaming: false,
      text: 'Recovered history',
    });
  });

  it('keeps protocol connection and stop reasons out of the timeline', () => {
    const connected = chatReducer(createInitialChatState(), {
      type: 'server_message',
      message: {
        type: 'connected',
        sessionId: 'session-e2e-1',
      },
    });

    expect(connected.connection).toBe('connected');
    expect(connected.items).toHaveLength(0);

    const streaming = chatReducer(connected, {
      type: 'server_message',
      message: {
        type: 'message_delta',
        role: 'assistant',
        text: 'Work finished',
      },
    });
    const complete = chatReducer(streaming, {
      type: 'server_message',
      message: {
        type: 'message_complete',
        stopReason: 'end_turn',
      },
    });

    expect(complete.streaming).toBe(false);
    expect(complete.items).toHaveLength(1);
    expect(complete.items[0]).toMatchObject({
      type: 'message',
      streaming: false,
      text: 'Work finished',
    });
    expect(JSON.stringify(complete.items)).not.toContain('session-e2e-1');
    expect(JSON.stringify(complete.items)).not.toContain('end_turn');
  });

  it('tracks pending approvals without adding protocol request events', () => {
    const state = chatReducer(createInitialChatState(), {
      type: 'server_message',
      message: {
        type: 'permission_request',
        requestId: 'permission-1',
        request: {
          sessionId: 'session-1',
          toolCall: {
            toolCallId: 'tool-1',
            kind: 'execute',
            title: 'Run tests',
            rawInput: 'npm test',
          },
          options: [
            {
              optionId: 'approve_once',
              name: 'Approve Once',
              kind: 'allow_once',
            },
          ],
        },
      },
    });

    expect(state.pendingPermission?.requestId).toBe('permission-1');
    expect(state.items).toHaveLength(0);
    expect(JSON.stringify(state.items)).not.toContain('Permission requested');
  });
});
