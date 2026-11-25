/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { RemainingTurnsAttachment } from '../attachments/models/turn-attachments.js';
import { createUserMessage } from '../protocol/transcript/conversions.js';
import { createQueryRequestMessages } from './query-request-messages.js';
import {
  createInitialQueryRuntimeState,
  getPendingUserMessage,
  getRequestBaseHistory,
} from './query-runtime-state.js';

describe('query request messages', () => {
  it('protects and restores the current attachments through compaction and retries', () => {
    const earlier = createUserMessage('Earlier task');
    const user = createUserMessage('Current task');
    const state = createInitialQueryRuntimeState({
      history: [earlier],
      userMessage: user,
    });
    const source = vi.fn((turns: number) => [
      new RemainingTurnsAttachment({
        type: 'remaining_turns',
        remainingTurns: 24 - turns,
      }),
    ]);
    const context = createQueryRequestMessages(source);
    const first = context.prepare(state);
    const hook = createUserMessage('Required verification', { isMeta: true });
    first.pendingTurnMessages.push(hook);
    const committed = context.commit(state);
    expect(committed.messages).toEqual([earlier, user, ...first.newMessages]);
    expect(getPendingUserMessage(committed)).toBe(user);
    const retry = context.prepare(committed);
    expect(retry.newMessages).toEqual([]);
    expect(retry.pendingTurnMessages).toEqual([user, ...first.newMessages]);
    expect(getRequestBaseHistory(committed, retry.pendingTurnMessages)).toEqual(
      [earlier],
    );
    expect(context.commit(committed).messages).toEqual(committed.messages);

    const summary = createUserMessage('Compacted history');
    const compacted = { ...committed, messages: [summary, user] };
    const restored = context.prepare(compacted);
    expect(restored.newMessages).toEqual([]);
    expect(restored.pendingTurnMessages).toEqual([user, ...first.newMessages]);
    expect(context.commit(compacted).messages).toEqual([
      summary,
      user,
      ...first.newMessages,
    ]);
    expect(source).toHaveBeenCalledTimes(1);
  });

  it('keeps prior request context in history without replaying it as a new tail', () => {
    const state = createInitialQueryRuntimeState({
      history: [],
      userMessage: createUserMessage('Task'),
    });
    const context = createQueryRequestMessages((turns) => [
      new RemainingTurnsAttachment({
        type: 'remaining_turns',
        remainingTurns: 24 - turns,
      }),
    ]);
    const first = context.prepare(state);
    const committed = context.commit(state);
    const next = {
      ...committed,
      turnCount: 1,
      pendingUserMessageUuid: undefined,
    };
    const second = context.prepare(next);
    expect(second.newMessages).toHaveLength(1);
    expect(second.pendingTurnMessages).toEqual(second.newMessages);
    expect(second.newMessages[0].uuid).not.toBe(first.newMessages[0].uuid);
    expect(getRequestBaseHistory(next, second.pendingTurnMessages)).toEqual(
      committed.messages,
    );
  });

  it('keeps hook output request-only when no attachment source is configured', () => {
    const state = {
      ...createInitialQueryRuntimeState({
        history: [],
        userMessage: createUserMessage('Task'),
      }),
      pendingUserMessageUuid: undefined,
      turnCount: 2,
    };
    const context = createQueryRequestMessages();
    const first = context.prepare(state);
    const hook = createUserMessage('Async hook evidence', { isMeta: true });
    first.pendingTurnMessages.push(hook);
    const committed = context.commit(state);
    expect(committed).toBe(state);
    const retry = context.prepare(committed);
    expect(retry.pendingTurnMessages).toEqual([]);
    expect(retry.newMessages).toEqual([]);
    expect(
      context.prepare({ ...committed, turnCount: 3 }).pendingTurnMessages,
    ).toEqual([]);
  });
});
