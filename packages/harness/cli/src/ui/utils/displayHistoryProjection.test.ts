/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { HistoryItemWithoutId } from '../types.js';
import {
  applyDisplayHistoryChange,
  prepareMessageHistory,
  type DisplayHistoryTarget,
} from './displayHistoryProjection.js';

function createTarget() {
  const state = {
    available: false,
    history: [] as HistoryItemWithoutId[],
    pending: null as HistoryItemWithoutId[] | null,
  };
  const calls: string[] = [];
  const target: DisplayHistoryTarget = {
    isHistoryAvailable: () => state.available,
    markHistoryAvailable: () => {
      calls.push('available');
      state.available = true;
    },
    addHistoryItem: (item) => {
      calls.push('history');
      state.history.push(item);
    },
    setPendingHistory: (items) => {
      calls.push('pending');
      state.pending = items;
    },
  };
  return { target, state, calls };
}

describe('display history projection', () => {
  it('adds only the first snapshot and marks availability after adding history', () => {
    const { target, state, calls } = createTarget();
    const item: HistoryItemWithoutId = { type: 'gemini', text: 'first' };
    applyDisplayHistoryChange({ type: 'snapshot', items: [item] }, target);
    expect(calls).toEqual(['history', 'available']);
    expect(state.history[0]).toBe(item);
    applyDisplayHistoryChange(
      { type: 'snapshot', items: [{ type: 'gemini', text: 'later' }] },
      target,
    );
    expect(state.history).toEqual([item]);
  });

  it('marks append availability before adding the original item', () => {
    const { target, state, calls } = createTarget();
    const item: HistoryItemWithoutId = { type: 'gemini', text: 'next' };
    applyDisplayHistoryChange({ type: 'append', item }, target);
    expect(calls).toEqual(['available', 'history']);
    expect(state.history[0]).toBe(item);
  });

  it('does not mark a snapshot available if adding its history throws', () => {
    const { target, state } = createTarget();
    target.addHistoryItem = () => {
      throw new Error('display failed');
    };
    expect(() =>
      applyDisplayHistoryChange(
        { type: 'snapshot', items: [{ type: 'gemini', text: 'x' }] },
        target,
      ),
    ).toThrow('display failed');
    expect(state.available).toBe(false);
  });

  it('deep-copies pending items while retaining the existing history', () => {
    const { target, state, calls } = createTarget();
    const item: HistoryItemWithoutId = {
      type: 'thinking',
      thought: { subject: 'subject', description: 'before' },
    };
    applyDisplayHistoryChange({ type: 'pending', items: [item] }, target);
    expect(calls).toEqual(['available', 'pending']);
    expect(state.pending).toEqual([item]);
    expect(state.pending?.[0]).not.toBe(item);
    item.thought.description = 'after';
    expect(state.pending?.[0]).toMatchObject({
      thought: { description: 'before' },
    });
    expect(state.history).toEqual([]);
    applyDisplayHistoryChange({ type: 'pending', items: [] }, target);
    expect(state.pending).toEqual([]);
  });

  it.each([
    {
      historyAvailable: false,
      preferDisplayEvents: false,
      allowDurableDisplayFallback: false,
      suppressed: false,
    },
    {
      historyAvailable: true,
      preferDisplayEvents: false,
      allowDurableDisplayFallback: false,
      suppressed: true,
    },
    {
      historyAvailable: false,
      preferDisplayEvents: true,
      allowDurableDisplayFallback: false,
      suppressed: true,
    },
    {
      historyAvailable: true,
      preferDisplayEvents: true,
      allowDurableDisplayFallback: true,
      suppressed: false,
    },
    {
      historyAvailable: false,
      preferDisplayEvents: false,
      allowDurableDisplayFallback: true,
      suppressed: false,
    },
  ])(
    'keeps display priority and replay fallback for %j',
    ({ suppressed, ...options }) => {
      const { target, state, calls } = createTarget();
      const pending: HistoryItemWithoutId[] = [
        { type: 'gemini', text: 'pending' },
      ];
      state.pending = pending;
      expect(prepareMessageHistory(options, target.setPendingHistory)).toBe(
        suppressed,
      );
      expect(state.pending).toBe(
        options.allowDurableDisplayFallback ? null : pending,
      );
      expect(calls).toEqual(
        options.allowDurableDisplayFallback ? ['pending'] : [],
      );
    },
  );
});
