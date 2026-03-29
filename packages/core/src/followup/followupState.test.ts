/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  INITIAL_FOLLOWUP_STATE,
  followupReducers,
  createFollowupController,
} from './followupState.js';
import type { FollowupState } from './followupState.js';

describe('followupReducers', () => {
  describe('setSuggestions', () => {
    it('sets suggestions and makes first one visible', () => {
      const result = followupReducers.setSuggestions([
        { text: 'commit this', priority: 100 },
        { text: 'run tests', priority: 90 },
      ]);
      expect(result.isVisible).toBe(true);
      expect(result.suggestion).toBe('commit this');
      expect(result.suggestions).toHaveLength(2);
      expect(result.currentIndex).toBe(0);
    });

    it('returns initial state for empty suggestions', () => {
      const result = followupReducers.setSuggestions([]);
      expect(result).toEqual(INITIAL_FOLLOWUP_STATE);
    });
  });

  describe('clear', () => {
    it('returns initial state', () => {
      expect(followupReducers.clear()).toEqual(INITIAL_FOLLOWUP_STATE);
    });
  });

  describe('next', () => {
    it('cycles to next suggestion', () => {
      const state: FollowupState = {
        suggestion: 'a',
        suggestions: [
          { text: 'a', priority: 100 },
          { text: 'b', priority: 90 },
        ],
        isVisible: true,
        currentIndex: 0,
      };
      const result = followupReducers.next(state);
      expect(result).not.toBeNull();
      expect(result!.currentIndex).toBe(1);
      expect(result!.suggestion).toBe('b');
    });

    it('wraps around to first suggestion', () => {
      const state: FollowupState = {
        suggestion: 'b',
        suggestions: [
          { text: 'a', priority: 100 },
          { text: 'b', priority: 90 },
        ],
        isVisible: true,
        currentIndex: 1,
      };
      const result = followupReducers.next(state);
      expect(result!.currentIndex).toBe(0);
      expect(result!.suggestion).toBe('a');
    });

    it('returns null for empty suggestions', () => {
      expect(followupReducers.next(INITIAL_FOLLOWUP_STATE)).toBeNull();
    });
  });

  describe('previous', () => {
    it('cycles to previous suggestion', () => {
      const state: FollowupState = {
        suggestion: 'b',
        suggestions: [
          { text: 'a', priority: 100 },
          { text: 'b', priority: 90 },
        ],
        isVisible: true,
        currentIndex: 1,
      };
      const result = followupReducers.previous(state);
      expect(result!.currentIndex).toBe(0);
      expect(result!.suggestion).toBe('a');
    });

    it('wraps around to last suggestion', () => {
      const state: FollowupState = {
        suggestion: 'a',
        suggestions: [
          { text: 'a', priority: 100 },
          { text: 'b', priority: 90 },
        ],
        isVisible: true,
        currentIndex: 0,
      };
      const result = followupReducers.previous(state);
      expect(result!.currentIndex).toBe(1);
      expect(result!.suggestion).toBe('b');
    });

    it('returns null for empty suggestions', () => {
      expect(followupReducers.previous(INITIAL_FOLLOWUP_STATE)).toBeNull();
    });
  });

  describe('getAcceptText', () => {
    it('returns current suggestion text', () => {
      const state: FollowupState = {
        suggestion: 'commit this',
        suggestions: [
          { text: 'commit this', priority: 100 },
          { text: 'run tests', priority: 90 },
        ],
        isVisible: true,
        currentIndex: 0,
      };
      expect(followupReducers.getAcceptText(state)).toBe('commit this');
    });

    it('returns text at current index', () => {
      const state: FollowupState = {
        suggestion: 'run tests',
        suggestions: [
          { text: 'commit this', priority: 100 },
          { text: 'run tests', priority: 90 },
        ],
        isVisible: true,
        currentIndex: 1,
      };
      expect(followupReducers.getAcceptText(state)).toBe('run tests');
    });

    it('returns null for empty suggestions', () => {
      expect(followupReducers.getAcceptText(INITIAL_FOLLOWUP_STATE)).toBeNull();
    });

    it('returns null when index out of bounds', () => {
      const state: FollowupState = {
        suggestion: null,
        suggestions: [{ text: 'a', priority: 100 }],
        isVisible: true,
        currentIndex: 5,
      };
      expect(followupReducers.getAcceptText(state)).toBeNull();
    });
  });
});

describe('createFollowupController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets suggestions after delay', () => {
    const onStateChange = vi.fn();
    const ctrl = createFollowupController({ onStateChange });

    ctrl.setSuggestions([{ text: 'commit this', priority: 100 }]);

    // Not yet — delay hasn't elapsed
    expect(onStateChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);

    expect(onStateChange).toHaveBeenCalledTimes(1);
    const state = onStateChange.mock.calls[0][0] as FollowupState;
    expect(state.isVisible).toBe(true);
    expect(state.suggestion).toBe('commit this');

    ctrl.cleanup();
  });

  it('clears immediately when given empty suggestions', () => {
    const onStateChange = vi.fn();
    const ctrl = createFollowupController({ onStateChange });

    ctrl.setSuggestions([]);

    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange.mock.calls[0][0]).toEqual(INITIAL_FOLLOWUP_STATE);

    ctrl.cleanup();
  });

  it('does not set suggestions when disabled', () => {
    const onStateChange = vi.fn();
    const ctrl = createFollowupController({
      enabled: false,
      onStateChange,
    });

    ctrl.setSuggestions([{ text: 'commit this', priority: 100 }]);
    vi.advanceTimersByTime(300);

    expect(onStateChange).not.toHaveBeenCalled();

    ctrl.cleanup();
  });

  it('accept invokes onAccept callback and clears state', () => {
    const onStateChange = vi.fn();
    const onAccept = vi.fn();
    const ctrl = createFollowupController({
      onStateChange,
      getOnAccept: () => onAccept,
    });

    // Set suggestions and advance timer
    ctrl.setSuggestions([{ text: 'commit this', priority: 100 }]);
    vi.advanceTimersByTime(300);
    onStateChange.mockClear();

    ctrl.accept();

    // State should be cleared
    expect(onStateChange).toHaveBeenCalledWith(INITIAL_FOLLOWUP_STATE);

    // Callback fires via microtask — flush it
    vi.advanceTimersByTime(0);

    ctrl.cleanup();
  });

  it('dismiss clears state', () => {
    const onStateChange = vi.fn();
    const ctrl = createFollowupController({ onStateChange });

    ctrl.setSuggestions([{ text: 'a', priority: 100 }]);
    vi.advanceTimersByTime(300);
    onStateChange.mockClear();

    ctrl.dismiss();

    expect(onStateChange).toHaveBeenCalledWith(INITIAL_FOLLOWUP_STATE);

    ctrl.cleanup();
  });

  it('next cycles through suggestions', () => {
    const onStateChange = vi.fn();
    const ctrl = createFollowupController({ onStateChange });

    ctrl.setSuggestions([
      { text: 'a', priority: 100 },
      { text: 'b', priority: 90 },
    ]);
    vi.advanceTimersByTime(300);
    onStateChange.mockClear();

    ctrl.next();

    expect(onStateChange).toHaveBeenCalledTimes(1);
    const state = onStateChange.mock.calls[0][0] as FollowupState;
    expect(state.currentIndex).toBe(1);
    expect(state.suggestion).toBe('b');

    ctrl.cleanup();
  });

  it('previous cycles through suggestions', () => {
    const onStateChange = vi.fn();
    const ctrl = createFollowupController({ onStateChange });

    ctrl.setSuggestions([
      { text: 'a', priority: 100 },
      { text: 'b', priority: 90 },
    ]);
    vi.advanceTimersByTime(300);
    onStateChange.mockClear();

    ctrl.previous();

    expect(onStateChange).toHaveBeenCalledTimes(1);
    const state = onStateChange.mock.calls[0][0] as FollowupState;
    expect(state.currentIndex).toBe(1);
    expect(state.suggestion).toBe('b');

    ctrl.cleanup();
  });

  it('accept recovers when onAccept callback throws', async () => {
    const onStateChange = vi.fn();
    let callCount = 0;
    const onAccept = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        throw new Error('callback error');
      }
    });
    const ctrl = createFollowupController({
      onStateChange,
      getOnAccept: () => onAccept,
    });

    // Set suggestions and advance timer
    ctrl.setSuggestions([{ text: 'commit this', priority: 100 }]);
    vi.advanceTimersByTime(300);

    // First accept — callback throws, but lock should still be released
    ctrl.accept();
    // Flush the microtask that fires the callback
    await Promise.resolve();
    // Advance past debounce timer to release the accepting lock
    vi.advanceTimersByTime(100);

    // Set suggestions again for second accept
    ctrl.setSuggestions([{ text: 'run tests', priority: 90 }]);
    vi.advanceTimersByTime(300);

    // Second accept — should NOT be blocked
    ctrl.accept();
    await Promise.resolve();

    expect(onAccept).toHaveBeenCalledTimes(2);
    expect(onAccept).toHaveBeenNthCalledWith(1, 'commit this');
    expect(onAccept).toHaveBeenNthCalledWith(2, 'run tests');

    ctrl.cleanup();
  });

  it('cleanup prevents pending timers from firing', () => {
    const onStateChange = vi.fn();
    const ctrl = createFollowupController({ onStateChange });

    ctrl.setSuggestions([{ text: 'a', priority: 100 }]);
    ctrl.cleanup();

    vi.advanceTimersByTime(300);

    expect(onStateChange).not.toHaveBeenCalled();
  });
});
