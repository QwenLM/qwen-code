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
   * armed exit (second press of the SAME guard key inside its own window —
   * ink keeps per-key windows, `ctrlCPressedOnce` vs `ctrlDPressedOnce`), or
   * `'armed'` when it starts a confirmation window for that key. A press of
   * the other key arms its own independent window.
   */
  press(key: ExitGuardKey): 'exit' | 'armed';
  /** Most recently armed key, or null when no confirmation is pending. */
  armedKey(): ExitGuardKey | null;
  /** Cancel all pending confirmations (e.g. the user took another action). */
  disarm(): void;
  /** Clear pending timers; call on unmount. */
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
  // One armed window per key, exactly like ink's ctrlCPressedOnce/ctrlD
  // pair — a different-key press must not drop the first key's window.
  const windows = new Map<ExitGuardKey, { timer: unknown }>();
  let lastArmed: ExitGuardKey | null = null;

  const disarmKey = (key: ExitGuardKey) => {
    const window = windows.get(key);
    if (window) {
      clearTimeoutFn(window.timer);
      windows.delete(key);
    }
    if (lastArmed === key) {
      lastArmed = [...windows.keys()].at(-1) ?? null;
    }
  };

  return {
    press(key: ExitGuardKey): 'exit' | 'armed' {
      if (windows.has(key)) {
        // Second press of the same key inside its own window exits.
        disarmKey(key);
        return 'exit';
      }
      windows.set(key, {
        timer: setTimeoutFn(() => {
          windows.delete(key);
          if (lastArmed === key) {
            lastArmed = [...windows.keys()].at(-1) ?? null;
          }
          options.onWindowExpired?.(key);
        }, windowMs),
      });
      lastArmed = key;
      return 'armed';
    },
    armedKey: () => lastArmed,
    disarm: () => {
      for (const key of [...windows.keys()]) disarmKey(key);
    },
    dispose: () => {
      for (const key of [...windows.keys()]) disarmKey(key);
    },
  };
}

/** Footer hint text for an armed exit (ink Footer.tsx / ExitWarning parity). */
export function exitGuardHint(key: ExitGuardKey): string {
  return key === 'ctrl-d'
    ? 'Press Ctrl+D again to exit.'
    : 'Press Ctrl+C again to exit.';
}
