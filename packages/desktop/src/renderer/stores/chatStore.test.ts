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
    expect(loaded.items).toHaveLength(2);
    expect(loaded.items[1]).toMatchObject({
      type: 'message',
      streaming: false,
      text: 'Recovered history',
    });
  });
});
