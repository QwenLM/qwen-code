/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createUserMessage } from '../protocol/transcript/conversions.js';
import type { AttachmentMessage } from '../protocol/transcript/message.js';
import {
  createContinuationState,
  createInitialQueryRuntimeState,
  getPendingUserMessage,
  getPendingTurnMessages,
  getRequestBaseHistory,
} from './query-runtime-state.js';

describe('query-runtime-state', () => {
  it('creates initial state with pending user message and projected prefix metadata', () => {
    const history = [createUserMessage('Earlier prompt')];
    const userMessage = createUserMessage('Current prompt');

    const state = createInitialQueryRuntimeState({
      history,
      userMessage,
      maxOutputTokensOverride: 256,
      preProjectedMessages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Projected earlier prompt' }],
        },
      ],
      preProjectedMessageCount: history.length,
    });

    expect(state.messages).toEqual([...history, userMessage]);
    expect(getPendingUserMessage(state)?.uuid).toBe(userMessage.uuid);
    expect(getRequestBaseHistory(state)).toEqual(history);
    expect(state.maxOutputTokensOverride).toBe(256);
    expect(state.preProjectedMessageCount).toBe(1);
    expect(state.autoCompactTracking).toEqual({ consecutiveFailures: 0 });
    expect(state.malformedToolUseRetryCount).toBe(0);
    expect(state.compressionState?.promptTooLongRetryCount).toBe(0);
  });

  it('creates continuation state with explicit transition metadata', () => {
    const userMessage = createUserMessage('Current prompt');
    const state = createInitialQueryRuntimeState({
      history: [],
      userMessage,
    });
    const continuationMessage = createUserMessage('Continue from here');

    const nextState = createContinuationState(
      state,
      {
        messages: [...state.messages, continuationMessage],
        pendingUserMessageUuid: continuationMessage.uuid,
      },
      { reason: 'after_hook_continuation' },
    );

    expect(nextState.transition).toEqual({
      reason: 'after_hook_continuation',
    });
    expect(getPendingUserMessage(nextState)?.uuid).toBe(
      continuationMessage.uuid,
    );
    expect(getRequestBaseHistory(nextState)).toEqual(state.messages);
    expect(nextState.autoCompactTracking).toBe(state.autoCompactTracking);
  });

  it('keeps the pending user and following input attachments as one turn', () => {
    const history = [createUserMessage('Earlier prompt')];
    const userMessage = createUserMessage('Current prompt');
    const reminder: AttachmentMessage = {
      type: 'attachment',
      uuid: 'task-reminder',
      timestamp: '2026-08-03T00:00:00.000Z',
      attachment: {
        type: 'task_reminder',
        content: [],
        itemCount: 0,
      },
    };
    const state = createInitialQueryRuntimeState({
      history,
      userMessage,
      messagesAfterUser: [reminder],
    });

    expect(getPendingUserMessage(state)).toBe(userMessage);
    expect(getPendingTurnMessages(state)).toEqual([userMessage, reminder]);
    expect(getRequestBaseHistory(state)).toEqual(history);
  });

  it('creates fresh PTL and auto-compact budgets for each user query', () => {
    const firstState = createInitialQueryRuntimeState({
      history: [],
      userMessage: createUserMessage('First prompt'),
    });
    firstState.autoCompactTracking.consecutiveFailures = 3;
    firstState.compressionState = { promptTooLongRetryCount: 3 };

    const nextState = createInitialQueryRuntimeState({
      history: firstState.messages,
      userMessage: createUserMessage('Next prompt'),
    });

    expect(nextState.autoCompactTracking).toEqual({ consecutiveFailures: 0 });
    expect(nextState.autoCompactTracking).not.toBe(
      firstState.autoCompactTracking,
    );
    expect(nextState.compressionState?.promptTooLongRetryCount).toBe(0);
    expect(nextState.compressionState).not.toBe(firstState.compressionState);
  });
});
