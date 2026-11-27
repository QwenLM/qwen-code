/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { renderHook } from '../../test-utils/render.js';
import { useUserMessageQueue } from './useUserMessageQueue.js';

interface QueueItem {
  prompt: string;
  commandMode: string;
  targetAgentId?: string;
  skipSlashCommands?: boolean;
  suppressWorkflowKeyword?: boolean;
}

const queueState: { items: QueueItem[]; subscribers: Set<() => void> } = {
  items: [],
  subscribers: new Set(),
};

function notify() {
  for (const s of queueState.subscribers) s();
}

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    enqueue: vi.fn((cmd: QueueItem) => {
      queueState.items = [...queueState.items, cmd];
      notify();
    }),
    clearCommandQueue: vi.fn(() => {
      queueState.items = [];
      notify();
    }),
    dequeueAllMatching: vi.fn((pred: (cmd: QueueItem) => boolean) => {
      const matched = queueState.items.filter(pred);
      queueState.items = queueState.items.filter((c) => !pred(c));
      notify();
      return matched;
    }),
    subscribeToCommandQueue: vi.fn((cb: () => void) => {
      queueState.subscribers.add(cb);
      return () => queueState.subscribers.delete(cb);
    }),
    getCommandQueueSnapshot: vi.fn(() => queueState.items),
  };
});

describe('useUserMessageQueue', () => {
  beforeEach(() => {
    queueState.items = [];
    queueState.subscribers = new Set();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts empty', async () => {
    const { result } = await renderHook(() => useUserMessageQueue());
    expect(result.current.messageQueue).toEqual([]);
    expect(result.current.getQueuedMessagesText()).toBe('');
  });

  it('addMessage trims and enqueues a user prompt; messageQueue projects it', async () => {
    const { result } = await renderHook(() => useUserMessageQueue());

    act(() => {
      result.current.addMessage('  hello  ');
    });

    expect(result.current.messageQueue).toEqual(['hello']);
    expect(result.current.getQueuedMessagesText()).toBe('hello');
  });

  it('addMessage drops empty / whitespace-only messages', async () => {
    const { result } = await renderHook(() => useUserMessageQueue());

    act(() => {
      result.current.addMessage('   ');
    });

    expect(result.current.messageQueue).toEqual([]);
  });

  it('marks path-like queued prompts to bypass slash routing', async () => {
    const shouldSkipSlashCommands = vi.fn(() => true);
    const { result } = await renderHook(() =>
      useUserMessageQueue(shouldSkipSlashCommands),
    );

    act(() => {
      result.current.addMessage('/Users/me/project 这里面有啥');
    });

    expect(shouldSkipSlashCommands).toHaveBeenCalledWith(
      '/Users/me/project 这里面有啥',
    );
    expect(queueState.items[0]).toMatchObject({
      skipSlashCommands: true,
    });
  });

  it('preserves the per-prompt ultracode suppression choice', async () => {
    const { result } = await renderHook(() => useUserMessageQueue());

    act(() => {
      result.current.addMessage('ultracode inspect this', {
        suppressWorkflowKeyword: true,
      });
    });

    expect(queueState.items[0]).toMatchObject({
      prompt: 'ultracode inspect this',
      suppressWorkflowKeyword: true,
    });
  });

  it('messageQueue filters out agent-targeted commands', async () => {
    const { result } = await renderHook(() => useUserMessageQueue());

    act(() => {
      queueState.items = [
        { prompt: 'hi', commandMode: 'prompt' },
        { prompt: 'agent', commandMode: 'prompt', targetAgentId: 'a1' },
        { prompt: 'cmd', commandMode: 'slash' },
      ];
      for (const s of queueState.subscribers) s();
    });

    expect(result.current.messageQueue).toEqual(['hi']);
  });

  it('popAllMessages drains user prompts and joins them with double-newline', async () => {
    const { result } = await renderHook(() => useUserMessageQueue());

    act(() => {
      result.current.addMessage('one');
      result.current.addMessage('two');
    });

    let popped: string | undefined;
    act(() => {
      popped = result.current.popAllMessages();
    });

    expect(popped).toBe('one\n\ntwo');
    expect(result.current.messageQueue).toEqual([]);
  });

  it('popAllMessages returns undefined when nothing matches', async () => {
    const { result } = await renderHook(() => useUserMessageQueue());

    let popped: string | undefined = 'sentinel';
    act(() => {
      popped = result.current.popAllMessages();
    });

    expect(popped).toBeUndefined();
  });
});
