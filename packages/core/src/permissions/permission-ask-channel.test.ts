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
import { PermissionTelemetry } from './permission-ask-channel.js';
import { createAskMetricsStore } from './ask-handler/ask-facts.js';

describe('PermissionTelemetry — ask facts', () => {
  it('merges a later record into the facts already held for that call', () => {
    const { askMetrics } = new PermissionTelemetry();

    askMetrics.record('call-1', { winnerParty: 'prompt' });
    askMetrics.record('call-1', { winnerParty: 'hook' });

    expect(askMetrics.peek('call-1')).toEqual({ winnerParty: 'hook' });
  });

  it('ignores a record with no tool call id to key it by', () => {
    const { askMetrics } = new PermissionTelemetry();

    askMetrics.record('', { winnerParty: 'prompt' });

    expect(askMetrics.peek('')).toBeUndefined();
  });

  it('keeps one session from reading another session ask facts', () => {
    const first = new PermissionTelemetry();
    const second = new PermissionTelemetry();
    first.askMetrics.record('call-1', { winnerParty: 'hook' });

    // The collision a process-wide map allowed: the same tool call id in two
    // sessions, where one session could read what the other recorded.
    expect(second.askMetrics.peek('call-1')).toBeUndefined();
    expect(first.askMetrics.peek('call-1')).toEqual({ winnerParty: 'hook' });
  });

  it('clear drops everything the session recorded', () => {
    const { askMetrics } = new PermissionTelemetry();
    askMetrics.record('call-1', { winnerParty: 'prompt' });
    askMetrics.record('call-2', { winnerParty: 'recheck' });

    askMetrics.clear();

    expect(askMetrics.peek('call-1')).toBeUndefined();
    expect(askMetrics.peek('call-2')).toBeUndefined();
  });
});

describe('createAskMetricsStore', () => {
  it('consume returns the settled record once, so a later check of the same call starts clean', () => {
    const store = createAskMetricsStore();
    store.record('call-1', { winnerParty: 'prompt' });

    expect(store.consume('call-1')).toEqual({ winnerParty: 'prompt' });
    expect(store.consume('call-1')).toBeUndefined();
    expect(store.peek('call-1')).toBeUndefined();
  });

  it('evicts the oldest entry past the cap rather than growing without limit', () => {
    const store = createAskMetricsStore();
    for (let i = 0; i <= 2000; i++) {
      store.record(`call-${i}`, { winnerParty: 'prompt' });
    }

    expect(store.peek('call-0')).toBeUndefined();
    expect(store.peek('call-2000')).toEqual({ winnerParty: 'prompt' });
  });
});
