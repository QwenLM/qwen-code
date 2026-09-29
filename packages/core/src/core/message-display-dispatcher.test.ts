/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { MessageDisplayDispatcher } from './message-display-dispatcher.js';
import { MESSAGE_DISPLAY_DEBOUNCE_MS } from './message-display-buffer.js';
import { runWithHookExecutionOwner } from '../hooks/hook-execution-context.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';

const PAST_DEBOUNCE = MESSAGE_DISPLAY_DEBOUNCE_MS + 1;

describe('MessageDisplayDispatcher', () => {
  it('keeps its captured owner while queued delivery resumes under another agent', async () => {
    // Each hook request stays in flight until the test releases it.
    const pending: Array<() => void> = [];
    const request = vi.fn(
      (_message: { owner?: unknown; input: object }) =>
        new Promise((resolve) => pending.push(() => resolve({}))),
    );
    const release = async () => {
      pending.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    };
    const owner = { runtimeId: 'runtime', sessionId: 'session', agentId: 'A' };
    const dispatcher = new MessageDisplayDispatcher(
      { request } as unknown as MessageBus,
      new AbortController().signal,
      () => {},
      0,
      owner,
    );
    dispatcher.addChunk('first', PAST_DEBOUNCE);
    dispatcher.addChunk('second', PAST_DEBOUNCE * 2);
    const finished = runWithHookExecutionOwner({ ...owner, agentId: 'B' }, () =>
      dispatcher.finish(),
    );
    await release();
    await release();
    await finished;
    expect(request.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [message] of request.mock.calls) {
      expect(message).toHaveProperty('owner', owner);
      expect(message.input).not.toHaveProperty('owner');
    }
  });
});
