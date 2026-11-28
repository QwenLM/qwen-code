/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createPendingAssistantTextStore } from './pendingAssistantTextStore.js';

describe('createPendingAssistantTextStore', () => {
  it('reads restored text without changing it', () => {
    const state = createPendingAssistantTextStore(' restored ');
    expect(state.getSnapshot()).toBe(' restored ');
  });

  it('appends in order and notifies after updating the snapshot', () => {
    const state = createPendingAssistantTextStore();
    const snapshots: string[] = [];
    state.subscribe(() => snapshots.push(state.getSnapshot()));
    state.append('你');
    state.append('好');
    expect(snapshots).toEqual(['你', '你好']);
  });

  it('replaces restored text and clears pending text', () => {
    const state = createPendingAssistantTextStore('old');
    const snapshots: string[] = [];
    state.subscribe(() => snapshots.push(state.getSnapshot()));
    state.replace('new');
    state.replace('');
    expect(snapshots).toEqual(['new', '']);
  });

  it('does not notify when text is unchanged', () => {
    const state = createPendingAssistantTextStore('same');
    const listener = vi.fn();
    state.subscribe(listener);
    state.replace('same');
    state.append('');
    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribes one listener while retaining other subscribers', () => {
    const state = createPendingAssistantTextStore();
    const removed = vi.fn();
    const retained = vi.fn();
    const unsubscribe = state.subscribe(removed);
    state.subscribe(retained);
    unsubscribe();
    state.append('text');
    expect(removed).not.toHaveBeenCalled();
    expect(retained).toHaveBeenCalledOnce();
  });

  it('keeps separate session instances isolated', () => {
    const first = createPendingAssistantTextStore('first');
    const second = createPendingAssistantTextStore('second');
    const listener = vi.fn();
    second.subscribe(listener);
    first.append('!');
    expect(first.getSnapshot()).toBe('first!');
    expect(second.getSnapshot()).toBe('second');
    expect(listener).not.toHaveBeenCalled();
  });

  it('allows a listener to subscribe again after cleanup', () => {
    const state = createPendingAssistantTextStore();
    const listener = vi.fn();
    const unsubscribe = state.subscribe(listener);
    unsubscribe();
    state.subscribe(listener);
    state.append('text');
    expect(listener).toHaveBeenCalledOnce();
  });
});
