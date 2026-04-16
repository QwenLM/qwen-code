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

  it('onOutcome fires with accepted on accept', async () => {
    const onStateChange = vi.fn();
    const onOutcome = vi.fn();
    const ctrl = createFollowupController({ onStateChange, onOutcome });

    ctrl.setSuggestion('commit this');
    vi.advanceTimersByTime(300);

    ctrl.accept('tab');

    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'accepted',
        accept_method: 'tab',
        suggestion_length: 11,
      }),
    );

    ctrl.cleanup();
  });

  it('onOutcome fires with ignored on dismiss', () => {
    const onStateChange = vi.fn();
    const onOutcome = vi.fn();
    const ctrl = createFollowupController({ onStateChange, onOutcome });

    ctrl.setSuggestion('commit this');
    vi.advanceTimersByTime(300);

    ctrl.dismiss();

    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'ignored',
        suggestion_length: 11,
      }),
    );

    ctrl.cleanup();
  });

  it('onOutcome error does not block state clear', () => {
    const onStateChange = vi.fn();
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const onOutcome = vi.fn().mockImplementation(() => {
      throw new Error('telemetry crash');
    });
    const ctrl = createFollowupController({ onStateChange, onOutcome });

    ctrl.setSuggestion('test');
    vi.advanceTimersByTime(300);
    onStateChange.mockClear();

    ctrl.accept('enter');

    // State should still be cleared despite onOutcome throwing
    expect(onStateChange).toHaveBeenCalledWith(INITIAL_FOLLOWUP_STATE);
    expect(consoleErrorSpy).toHaveBeenCalled();

    ctrl.cleanup();
    consoleErrorSpy.mockRestore();
  });

  it('dismiss does not fire onOutcome when already cleared', () => {
    const onStateChange = vi.fn();
    const onOutcome = vi.fn();
    const ctrl = createFollowupController({ onStateChange, onOutcome });

    // No suggestion set — dismiss should be a no-op
    ctrl.dismiss();

    expect(onOutcome).not.toHaveBeenCalled();

    ctrl.cleanup();
  });

  it('clear resets the accepting lock', async () => {
    const onStateChange = vi.fn();
    const onAccept = vi.fn();
    const ctrl = createFollowupController({
      onStateChange,
      getOnAccept: () => onAccept,
    });

    ctrl.setSuggestion('first');
    vi.advanceTimersByTime(300);

    ctrl.accept();
    // clear before debounce timeout releases lock
    ctrl.clear();

    // Set new suggestion and accept again — should work
    ctrl.setSuggestion('second');
    vi.advanceTimersByTime(300);
    ctrl.accept();
    await Promise.resolve();

    expect(onAccept).toHaveBeenCalledTimes(2);

    ctrl.cleanup();
  });

  it('double accept is blocked by debounce lock', async () => {
    const onStateChange = vi.fn();
    const onAccept = vi.fn();
    const ctrl = createFollowupController({
      onStateChange,
      getOnAccept: () => onAccept,
    });

    ctrl.setSuggestion('text');
    vi.advanceTimersByTime(300);

    ctrl.accept();
    ctrl.accept(); // second call should be blocked
    await Promise.resolve();

    expect(onAccept).toHaveBeenCalledTimes(1);

    ctrl.cleanup();
  });

  it('accept with skipOnAccept skips onAccept callback but still clears state and fires telemetry', async () => {
    const onStateChange = vi.fn();
    const onAccept = vi.fn();
    const onOutcome = vi.fn();
    const ctrl = createFollowupController({
      onStateChange,
      getOnAccept: () => onAccept,
      onOutcome,
    });

    ctrl.setSuggestion('run tests');
    vi.advanceTimersByTime(300);
    onStateChange.mockClear();

    ctrl.accept('enter', { skipOnAccept: true });

    // State should be cleared
    expect(onStateChange).toHaveBeenCalledWith(INITIAL_FOLLOWUP_STATE);

    // Telemetry should still fire
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'accepted', accept_method: 'enter' }),
    );

    // Flush microtask — onAccept should NOT be called
    await Promise.resolve();
    expect(onAccept).not.toHaveBeenCalled();

    ctrl.cleanup();
  });

  it('setSuggestion replaces a pending suggestion', () => {
    const onStateChange = vi.fn();
    const ctrl = createFollowupController({ onStateChange });

    ctrl.setSuggestion('first');
    vi.advanceTimersByTime(150); // halfway through delay
    ctrl.setSuggestion('second'); // replace
    vi.advanceTimersByTime(300);

    // Only 'second' should have fired
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange.mock.calls[0][0].suggestion).toBe('second');

    ctrl.cleanup();
  });
});
