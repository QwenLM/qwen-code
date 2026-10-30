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
import type {
  FollowupControllerActions,
  FollowupControllerOptions,
  FollowupState,
} from './followupState.js';

describe('createFollowupController', () => {
  let controllers: FollowupControllerActions[];

  beforeEach(() => {
    vi.useFakeTimers();
    controllers = [];
  });

  afterEach(() => {
    for (const ctrl of controllers) ctrl.cleanup();
    vi.useRealTimers();
  });

  /** A controller with an onStateChange spy, cleaned up after the case. */
  function setup(
    options: Omit<FollowupControllerOptions, 'onStateChange'> = {},
  ) {
    const onStateChange = vi.fn();
    const ctrl = createFollowupController({ onStateChange, ...options });
    controllers.push(ctrl);
    return { onStateChange, ctrl };
  }

  /** Sets a suggestion and lets the 300ms display delay elapse. */
  function show(ctrl: FollowupControllerActions, text: string): void {
    ctrl.setSuggestion(text);
    vi.advanceTimersByTime(300);
  }

  it('sets suggestion after delay', () => {
    const { onStateChange, ctrl } = setup();

    ctrl.setSuggestion('commit this');

    // Not yet — delay hasn't elapsed
    expect(onStateChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);

    expect(onStateChange).toHaveBeenCalledTimes(1);
    const state = onStateChange.mock.calls[0][0] as FollowupState;
    expect(state.isVisible).toBe(true);
    expect(state.suggestion).toBe('commit this');
  });

  it('clears immediately when given null', () => {
    const { onStateChange, ctrl } = setup();

    ctrl.setSuggestion(null);

    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange.mock.calls[0][0]).toEqual(INITIAL_FOLLOWUP_STATE);
  });

  it('does not set suggestion when disabled', () => {
    const { onStateChange, ctrl } = setup({ enabled: false });

    show(ctrl, 'commit this');

    expect(onStateChange).not.toHaveBeenCalled();
  });

  it('accept invokes onAccept callback and clears state', async () => {
    const onAccept = vi.fn();
    const { onStateChange, ctrl } = setup({ getOnAccept: () => onAccept });

    show(ctrl, 'commit this');
    onStateChange.mockClear();

    ctrl.accept();

    expect(onStateChange).toHaveBeenCalledWith(INITIAL_FOLLOWUP_STATE);

    // Callback fires via microtask — flush it
    await Promise.resolve();

    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalledWith('commit this');
  });

  it('dismiss clears state', () => {
    const { onStateChange, ctrl } = setup();

    show(ctrl, 'commit this');
    onStateChange.mockClear();

    ctrl.dismiss();

    expect(onStateChange).toHaveBeenCalledWith(INITIAL_FOLLOWUP_STATE);
  });

  it('accept recovers when onAccept callback throws', async () => {
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
    const { ctrl } = setup({ getOnAccept: () => onAccept });

    show(ctrl, 'commit this');

    // First accept — callback throws, but lock should still be released
    ctrl.accept();
    await Promise.resolve();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[followup] onAccept callback threw:',
      expect.any(Error),
    );

    // Advance past debounce timer to release the accepting lock
    vi.advanceTimersByTime(100);

    show(ctrl, 'run tests');

    // Second accept — should NOT be blocked
    ctrl.accept();
    await Promise.resolve();

    expect(onAccept).toHaveBeenCalledTimes(2);
    expect(onAccept).toHaveBeenNthCalledWith(1, 'commit this');
    expect(onAccept).toHaveBeenNthCalledWith(2, 'run tests');

    consoleErrorSpy.mockRestore();
  });

  it('cleanup prevents pending timers from firing', () => {
    const { onStateChange, ctrl } = setup();

    ctrl.setSuggestion('commit this');
    ctrl.cleanup();

    vi.advanceTimersByTime(300);

    expect(onStateChange).not.toHaveBeenCalled();
  });

  it('onOutcome fires with accepted on accept', async () => {
    const onOutcome = vi.fn();
    const { ctrl } = setup({ onOutcome });

    show(ctrl, 'commit this');

    ctrl.accept('tab');

    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'accepted',
        accept_method: 'tab',
        suggestion_length: 11,
      }),
    );
  });

  it('accept with fallbackText logs telemetry and inserts when there is no live suggestion', async () => {
    const onOutcome = vi.fn();
    const onAccept = vi.fn();
    const { ctrl } = setup({ onOutcome, getOnAccept: () => onAccept });

    // No setSuggestion + advance, so currentState.suggestion stays null —
    // mirrors the InputPrompt type-then-delete / pre-delay fallback where the
    // placeholder text only lives in the `promptSuggestion` prop.
    ctrl.accept('right', { fallbackText: 'commit this' });

    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'accepted',
        accept_method: 'right',
        accept_source: 'fallback',
        suggestion_length: 11,
      }),
    );

    // onAccept still fires via microtask with the fallback text
    await Promise.resolve();
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalledWith('commit this');
  });

  it('accept prefers the live suggestion over fallbackText and reports source "live"', async () => {
    const onOutcome = vi.fn();
    const onAccept = vi.fn();
    const { ctrl } = setup({ onOutcome, getOnAccept: () => onAccept });

    show(ctrl, 'live suggestion');

    // A live suggestion is present; fallbackText must be ignored. Guards the
    // `currentState.suggestion ?? options.fallbackText` ordering — a flip would
    // silently corrupt the accepted text and telemetry length.
    ctrl.accept('tab', { fallbackText: 'fallback text' });

    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'accepted',
        accept_source: 'live',
        suggestion_length: 'live suggestion'.length,
      }),
    );

    await Promise.resolve();
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalledWith('live suggestion');
  });

  it('accept without a live suggestion or fallbackText is a no-op', async () => {
    const onOutcome = vi.fn();
    const onAccept = vi.fn();
    const { ctrl } = setup({ onOutcome, getOnAccept: () => onAccept });

    ctrl.accept('tab');

    await Promise.resolve();
    expect(onOutcome).not.toHaveBeenCalled();
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('onOutcome fires with ignored on dismiss', () => {
    const onOutcome = vi.fn();
    const { ctrl } = setup({ onOutcome });

    show(ctrl, 'commit this');

    ctrl.dismiss();

    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'ignored', suggestion_length: 11 }),
    );
  });

  it('onOutcome error does not block state clear', () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const onOutcome = vi.fn().mockImplementation(() => {
      throw new Error('telemetry crash');
    });
    const { onStateChange, ctrl } = setup({ onOutcome });

    show(ctrl, 'test');
    onStateChange.mockClear();

    ctrl.accept('enter');

    // State should still be cleared despite onOutcome throwing
    expect(onStateChange).toHaveBeenCalledWith(INITIAL_FOLLOWUP_STATE);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('dismiss does not fire onOutcome when already cleared', () => {
    const onOutcome = vi.fn();
    const { ctrl } = setup({ onOutcome });

    // No suggestion set — dismiss should be a no-op
    ctrl.dismiss();

    expect(onOutcome).not.toHaveBeenCalled();
  });

  it('clear resets the accepting lock', async () => {
    const onAccept = vi.fn();
    const { ctrl } = setup({ getOnAccept: () => onAccept });

    show(ctrl, 'first');

    ctrl.accept();
    // clear before debounce timeout releases lock
    ctrl.clear();

    // Set new suggestion and accept again — should work
    show(ctrl, 'second');
    ctrl.accept();
    await Promise.resolve();

    expect(onAccept).toHaveBeenCalledTimes(2);
  });

  it('double accept is blocked by debounce lock', async () => {
    const onAccept = vi.fn();
    const { ctrl } = setup({ getOnAccept: () => onAccept });

    show(ctrl, 'text');

    ctrl.accept();
    ctrl.accept(); // second call should be blocked
    await Promise.resolve();

    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('accept with skipOnAccept skips onAccept callback but still clears state and fires telemetry', async () => {
    const onAccept = vi.fn();
    const onOutcome = vi.fn();
    const { onStateChange, ctrl } = setup({
      getOnAccept: () => onAccept,
      onOutcome,
    });

    show(ctrl, 'run tests');
    onStateChange.mockClear();

    ctrl.accept('enter', { skipOnAccept: true });

    expect(onStateChange).toHaveBeenCalledWith(INITIAL_FOLLOWUP_STATE);
    // Telemetry should still fire
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'accepted', accept_method: 'enter' }),
    );

    // Flush microtask — onAccept should NOT be called
    await Promise.resolve();
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('setSuggestion replaces a pending suggestion', () => {
    const { onStateChange, ctrl } = setup();

    ctrl.setSuggestion('first');
    vi.advanceTimersByTime(150); // halfway through delay
    ctrl.setSuggestion('second'); // replace
    vi.advanceTimersByTime(300);

    // Only 'second' should have fired
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange.mock.calls[0][0].suggestion).toBe('second');
  });
});
