/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI composer history navigation mirrors the original
 * useInputHistory hook semantics (newest-first traversal, draft stash and
 * restore, reset after submit).
 */

import { describe, it, expect } from 'vitest';
import { InputHistory } from './input-history.js';

function makeHistory(messages: string[]): InputHistory {
  return new InputHistory(() => messages);
}

describe('opentui InputHistory (useInputHistory parity)', () => {
  it('returns null when there is no history', () => {
    const history = makeHistory([]);
    expect(history.navigateUp('draft')).toBeNull();
    expect(history.navigateDown()).toBeNull();
  });

  it('navigateUp walks from newest to oldest', () => {
    const history = makeHistory(['first', 'second', 'third']);
    expect(history.navigateUp('draft')).toBe('third');
    expect(history.navigateUp('third')).toBe('second');
    expect(history.navigateUp('second')).toBe('first');
    // already at the oldest entry — no further navigation
    expect(history.navigateUp('first')).toBeNull();
    expect(history.navigateUp('first')).toBeNull();
  });

  it('navigateDown walks back to newest and restores the draft', () => {
    const history = makeHistory(['first', 'second']);
    expect(history.navigateUp('my draft')).toBe('second');
    expect(history.navigateUp('second')).toBe('first');
    expect(history.navigateDown()).toBe('second');
    // past the newest entry → the original in-progress query comes back
    expect(history.navigateDown()).toBe('my draft');
    // no longer navigating
    expect(history.navigateDown()).toBeNull();
  });

  it('navigateDown is a no-op when not navigating', () => {
    const history = makeHistory(['a', 'b']);
    expect(history.navigateDown()).toBeNull();
  });

  it('reset restarts navigation at the newest entry', () => {
    const history = makeHistory(['a', 'b']);
    expect(history.navigateUp('')).toBe('b');
    expect(history.navigateUp('b')).toBe('a');
    history.reset();
    expect(history.isNavigating).toBe(false);
    expect(history.navigateUp('')).toBe('b');
  });

  it('tracks live message updates (e.g. after a submit)', () => {
    const messages: string[] = ['a'];
    const history = new InputHistory(() => messages);
    expect(history.navigateUp('')).toBe('a');
    history.reset();
    messages.push('b');
    expect(history.navigateUp('')).toBe('b');
  });
});
