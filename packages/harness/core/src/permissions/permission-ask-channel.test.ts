/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-session permission side-channel state.
 *
 * The point of these tests is the isolation, not the bookkeeping: the ask facts
 * used to be one process-wide map, so the interesting failure is a second
 * session reading what the first one recorded.
 */

import { describe, it, expect } from 'vitest';
import { PermissionAskChannel } from './permission-ask-channel.js';
import { createAskFactsStore } from './ask-handler/ask-facts.js';

describe('PermissionAskChannel — ask facts', () => {
  it('merges a later record into the facts already held for that call', () => {
    const { askFacts } = new PermissionAskChannel();

    askFacts.record('call-1', { winnerParty: 'prompt' });
    askFacts.record('call-1', { winnerParty: 'hook' });

    expect(askFacts.peek('call-1')).toEqual({ winnerParty: 'hook' });
  });

  it('ignores a record with no tool call id to key it by', () => {
    const { askFacts } = new PermissionAskChannel();

    askFacts.record('', { winnerParty: 'prompt' });

    expect(askFacts.peek('')).toBeUndefined();
  });

  it('keeps one session from reading another session ask facts', () => {
    const first = new PermissionAskChannel();
    const second = new PermissionAskChannel();
    first.askFacts.record('call-1', { winnerParty: 'hook' });

    // The collision a process-wide map allowed: the same tool call id in two
    // sessions, where one session could read what the other recorded.
    expect(second.askFacts.peek('call-1')).toBeUndefined();
    expect(first.askFacts.peek('call-1')).toEqual({ winnerParty: 'hook' });
  });

  it('clear drops everything the session recorded', () => {
    const { askFacts } = new PermissionAskChannel();
    askFacts.record('call-1', { winnerParty: 'prompt' });
    askFacts.record('call-2', { winnerParty: 'recheck' });

    askFacts.clear();

    expect(askFacts.peek('call-1')).toBeUndefined();
    expect(askFacts.peek('call-2')).toBeUndefined();
  });
});

describe('createAskFactsStore', () => {
  it('evicts the oldest entry past the cap rather than growing without limit', () => {
    const store = createAskFactsStore();
    for (let i = 0; i <= 2000; i++) {
      store.record(`call-${i}`, { winnerParty: 'prompt' });
    }

    expect(store.peek('call-0')).toBeUndefined();
    expect(store.peek('call-2000')).toEqual({ winnerParty: 'prompt' });
  });
});
