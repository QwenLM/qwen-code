/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  INITIAL_FOLLOWUP_STATE,
  createFollowupController,
} from './followupState.js';
import type { FollowupState } from './followupState.js';

describe('createFollowupController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets suggestion after delay', () => {
    const onStateChange = vi.fn();
    const ctrl = createFollowupController({ onStateChange });

    ctrl.setSuggestion('commit this');

    // Not yet — delay hasn't elapsed
    expect(onStateChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);

    expect(onStateChange).toHaveBeenCalledTimes(1);
    const state = onStateChange.mock.calls[0][0] as FollowupState;
    expect(state.isVisible).toBe(true);
    expect(state.suggestion).toBe('commit this');

    ctrl.cleanup();
  });

  it('clears immediately when given null', () => {
    const onStateChange = vi.fn();
    const ctrl = createFollowupController({ onStateChange });

    ctrl.setSuggestion(null);

    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange.mock.calls[0][0]).toEqual(INITIAL_FOLLOWUP_STATE);

    ctrl.cleanup();
  });

  it('does not set suggestion when disabled', () => {
    const onStateChange = vi.fn();
    const ctrl = createFollowupController({
      enabled: false,
      onStateChange,
    });

    ctrl.setSuggestion('commit this');
    vi.advanceTimersByTime(300);

    expect(onStateChange).not.toHaveBeenCalled();

    ctrl.cleanup();
  });

  it('accept invokes onAccept callback and clears state', async () => {
    const onStateChange = vi.fn();
    const onAccept = vi.fn();
    const ctrl = createFollowupController({
      onStateChange,
      getOnAccept: () => onAccept,
    });

    ctrl.setSuggestion('commit this');
    vi.advanceTimersByTime(300);
    onStateChange.mockClear();

    ctrl.accept();

    // State should be cleared
    expect(onStateChange).toHaveBeenCalledWith(INITIAL_FOLLOWUP_STATE);

    // Callback fires via microtask — flush it
    await Promise.resolve();

    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalledWith('commit this');

    ctrl.cleanup();
  });

  it('dismiss clears state', () => {
    const onStateChange = vi.fn();
    const ctrl = createFollowupController({ onStateChange });

    ctrl.setSuggestion('commit this');
    vi.advanceTimersByTime(300);
    onStateChange.mockClear();

    ctrl.dismiss();

    expect(onStateChange).toHaveBeenCalledWith(INITIAL_FOLLOWUP_STATE);

    ctrl.cleanup();
  });

  it('accept recovers when onAccept callback throws', async () => {
    const onStateChange = vi.fn();
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

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

    ctrl.setSuggestion('commit this');
    vi.advanceTimersByTime(300);

    // First accept — callback throws, but lock should still be released
    ctrl.accept();
    await Promise.resolve();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[followup] onAccept callback threw:',
      expect.any(Error),
    );

    // Advance past debounce timer to release the accepting lock
    vi.advanceTimersByTime(100);

    // Set suggestion again for second accept
    ctrl.setSuggestion('run tests');
    vi.advanceTimersByTime(300);

    // Second accept — should NOT be blocked
    ctrl.accept();
    await Promise.resolve();

    expect(onAccept).toHaveBeenCalledTimes(2);
    expect(onAccept).toHaveBeenNthCalledWith(1, 'commit this');
    expect(onAccept).toHaveBeenNthCalledWith(2, 'run tests');

    ctrl.cleanup();
    consoleErrorSpy.mockRestore();
  });

  it('cleanup prevents pending timers from firing', () => {
    const onStateChange = vi.fn();
    const ctrl = createFollowupController({ onStateChange });

    ctrl.setSuggestion('commit this');
    ctrl.cleanup();

    vi.advanceTimersByTime(300);

    expect(onStateChange).not.toHaveBeenCalled();
  });
});
