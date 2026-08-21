/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_DISPLAYED_QUEUED_MESSAGES,
  summarizeQueuedPrompt,
} from './queue-summary.js';

describe('summarizeQueuedPrompt (QueuedMessageDisplay parity)', () => {
  it('matches the ink displayed-message cap of three', () => {
    expect(MAX_DISPLAYED_QUEUED_MESSAGES).toBe(3);
  });

  it('collapses whitespace to single spaces', () => {
    expect(summarizeQueuedPrompt('a\n\nb\t c', 80)).toBe('a b c');
  });

  it('keeps short previews untouched', () => {
    expect(summarizeQueuedPrompt('hello world', 80)).toBe('hello world');
  });

  it('truncates long previews with an ellipsis at the width limit', () => {
    const summary = summarizeQueuedPrompt('x'.repeat(200), 20);
    expect([...summary].length).toBe(20);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('counts code points, not UTF-16 units', () => {
    const summary = summarizeQueuedPrompt('中'.repeat(30), 10);
    expect([...summary].length).toBe(10);
  });

  it('clamps to a minimum width for narrow terminals', () => {
    const summary = summarizeQueuedPrompt('y'.repeat(50), 1);
    expect([...summary].length).toBe(8);
  });

  it('trims surrounding whitespace', () => {
    expect(summarizeQueuedPrompt('  padded  ', 80)).toBe('padded');
  });
});
