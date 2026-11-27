/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createDaemonTranscriptStore } from '../../src/daemon/ui/store.js';

describe('transcript notification subscription changes', () => {
  it('notifies a resubscribing listener once per update', async () => {
    const store = createDaemonTranscriptStore();
    let calls = 0;
    let unsubscribe: () => void;
    const listener = () => {
      calls += 1;
      unsubscribe();
      // Bound the reproduction so the buggy live Set traversal terminates.
      if (calls < 3) unsubscribe = store.subscribe(listener);
    };
    unsubscribe = store.subscribe(listener);

    store.appendLocalUserMessage('first');
    await Promise.resolve();
    expect(calls).toBe(1);
    store.appendLocalUserMessage('second');
    await Promise.resolve();
    expect(calls).toBe(2);
    unsubscribe();
  });

  it('starts a newly added listener with the next update', async () => {
    const store = createDaemonTranscriptStore();
    const added = vi.fn();
    const first = store.subscribe(() => {
      store.subscribe(added);
    });

    store.appendLocalUserMessage('first');
    await Promise.resolve();
    expect(added).not.toHaveBeenCalled();
    store.appendLocalUserMessage('second');
    await Promise.resolve();
    expect(added).toHaveBeenCalledOnce();
    first();
  });

  it('keeps skipping listeners removed before their turn', async () => {
    const store = createDaemonTranscriptStore();
    const removed = vi.fn();
    store.subscribe(() => {
      unsubscribeRemoved();
    });
    const unsubscribeRemoved = store.subscribe(removed);

    store.appendLocalUserMessage('first');
    await Promise.resolve();
    expect(removed).not.toHaveBeenCalled();
  });
});
