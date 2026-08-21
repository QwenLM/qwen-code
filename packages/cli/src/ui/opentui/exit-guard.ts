/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Two-press exit confirmation for the OpenTUI backend (ink parity).
 *
 * The ink tree never exits on a single Ctrl+C / Ctrl+D: the first press only
 * arms a confirmation window (`useDoublePress` + Footer "Press Ctrl+C again
 * to exit." hint, `CTRL_EXIT_PROMPT_DURATION_MS` in
 * `ui/utils/platformConstants.ts`), and only a second press inside that
 * window actually quits. The original OpenTUI backend exited on the first
 * press, losing unsent input and skipping the cleanup chain.
 *
 * This module is a framework-free state machine so the guard semantics can
 * be unit tested without the native renderer; `backend.tsx` drives it from
 * its keyboard handler and renders the hint in the footer.
 */

import { CTRL_EXIT_PROMPT_DURATION_MS } from '../utils/platformConstants.js';

export type ExitGuardKey = 'ctrl-c' | 'ctrl-d';

export interface ExitGuardOptions {
  /** Confirmation window in ms (ink: CTRL_EXIT_PROMPT_DURATION_MS). */
  windowMs?: number;
  /**
   * Fired when an armed window lapses without a confirming second press.
   * The backend uses it to hide the footer hint.
   */
  onWindowExpired?: (key: ExitGuardKey) => void;
  /** Injectable timer for tests. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface ExitGuard {
  /**
   * Register a press. Returns `'exit'` when this press confirms a pending
   * armed exit (second press of ANY guard key inside the window), or
   * `'armed'` when it starts a new confirmation window.
   */
  press(key: ExitGuardKey): 'exit' | 'armed';
  /** Currently armed key, or null when no confirmation is pending. */
  armedKey(): ExitGuardKey | null;
  /** Cancel a pending confirmation (e.g. the user took another action). */
  disarm(): void;
  /** Clear the pending timer; call on unmount. */
  dispose(): void;
}

export function createExitGuard(options: ExitGuardOptions = {}): ExitGuard {
  const windowMs = options.windowMs ?? CTRL_EXIT_PROMPT_DURATION_MS;
  const setTimeoutFn =
    options.setTimeoutFn ??
    ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimeoutFn =
    options.clearTimeoutFn ??
    ((handle: unknown): void =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  let armed: ExitGuardKey | null = null;
  let timer: unknown = null;

  const disarm = () => {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
    armed = null;
  };

  return {
    press(key: ExitGuardKey): 'exit' | 'armed' {
      if (armed !== null) {
        // Second press inside the window — ink exits regardless of whether
        // the confirming key matches the arming one.
        disarm();
        return 'exit';
      }
      armed = key;
      timer = setTimeoutFn(() => {
        timer = null;
        const expired = armed;
        armed = null;
        if (expired !== null) options.onWindowExpired?.(expired);
      }, windowMs);
      return 'armed';
    },
    armedKey: () => armed,
    disarm,
    dispose: disarm,
  };
}

/** Footer hint text for an armed exit (ink Footer.tsx / ExitWarning parity). */
export function exitGuardHint(key: ExitGuardKey): string {
  return key === 'ctrl-d'
    ? 'Press Ctrl+D again to exit.'
    : 'Press Ctrl+C again to exit.';
}
