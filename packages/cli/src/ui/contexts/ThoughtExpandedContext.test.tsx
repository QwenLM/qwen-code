/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  PENDING_THOUGHT_HEAD_ID,
  settlePendingExpansion,
} from './ThoughtExpandedContext.js';

describe('settlePendingExpansion', () => {
  it('returns prev unchanged when no pending entry exists', () => {
    const prev = new Set([100, 200]);
    expect(settlePendingExpansion(prev, 300)).toBe(prev);
    expect(settlePendingExpansion(prev, null)).toBe(prev);
  });

  it('migrates the pending entry to the committed head id', () => {
    const prev = new Set([PENDING_THOUGHT_HEAD_ID, 100]);
    const next = settlePendingExpansion(prev, 300);
    expect(next).not.toBe(prev);
    expect(next.has(PENDING_THOUGHT_HEAD_ID)).toBe(false);
    expect(next.has(300)).toBe(true);
    expect(next.has(100)).toBe(true);
    expect(next.size).toBe(2);
    // prev is React state and must not be mutated in place.
    expect(prev.has(PENDING_THOUGHT_HEAD_ID)).toBe(true);
  });

  it('drops the pending entry when the thought never committed', () => {
    const prev = new Set([PENDING_THOUGHT_HEAD_ID, 100]);
    const next = settlePendingExpansion(prev, null);
    expect(next).not.toBe(prev);
    expect(next.has(PENDING_THOUGHT_HEAD_ID)).toBe(false);
    expect(next.has(100)).toBe(true);
    expect(next.size).toBe(1);
  });
});
