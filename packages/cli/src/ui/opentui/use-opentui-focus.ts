/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Terminal focus detection for the OpenTUI backend (ink `useFocus` parity).
 *
 * The OpenTUI renderer parses `\x1b[I` / `\x1b[O` natively and emits
 * CliRenderEvents FOCUS / BLUR, but never enables DEC mode 1004 itself —
 * this hook owns the enable/disable writes exactly like ink's `useFocus`.
 * A keypress fallback recovers focus on terminals (e.g. tmux) that swallow
 * focus reports: any keystroke implies the terminal is focused.
 */

import { useEffect, useState } from 'react';

// ANSI escape codes to enable/disable terminal focus reporting
export const ENABLE_FOCUS_REPORTING = '\x1b[?1004h';
export const DISABLE_FOCUS_REPORTING = '\x1b[?1004l';

/** Structural view of the OpenTUI renderer's focus/keypress event APIs. */
export interface OpenTuiFocusHost {
  on(event: 'focus', listener: () => void): unknown;
  on(event: 'blur', listener: () => void): unknown;
  off(event: 'focus', listener: () => void): unknown;
  off(event: 'blur', listener: () => void): unknown;
  keyInput: {
    on(event: 'keypress', listener: (key: unknown) => void): unknown;
    off(event: 'keypress', listener: (key: unknown) => void): unknown;
  };
}

export function useOpenTuiFocus(renderer: OpenTuiFocusHost): boolean {
  const [isFocused, setIsFocused] = useState(true);

  useEffect(() => {
    // Enable focus reporting; a broken stdout must not crash the UI.
    try {
      process.stdout.write(ENABLE_FOCUS_REPORTING);
    } catch {
      // Best-effort (EPIPE during teardown).
    }
    const onFocus = () => setIsFocused(true);
    const onBlur = () => setIsFocused(false);
    // Ink useFocus keypress workaround parity: a keystroke means the
    // terminal must be focused even if its focus reports never arrive.
    const onKeypress = () => setIsFocused(true);
    renderer.on('focus', onFocus);
    renderer.on('blur', onBlur);
    renderer.keyInput.on('keypress', onKeypress);
    // The OpenTUI exit chain destroys the renderer without unmounting the
    // React tree, so the effect cleanup below never runs on process exit.
    // Belt-and-braces: restore the mode from an exit listener too (ink
    // relies on its tree unmount for this).
    const disableOnExit = () => {
      try {
        process.stdout.write(DISABLE_FOCUS_REPORTING);
      } catch {
        // Best-effort (stdout already torn down).
      }
    };
    process.on('exit', disableOnExit);
    return () => {
      try {
        process.stdout.write(DISABLE_FOCUS_REPORTING);
      } catch {
        // Best-effort (EPIPE during teardown).
      }
      renderer.off('focus', onFocus);
      renderer.off('blur', onBlur);
      renderer.keyInput.off('keypress', onKeypress);
      process.removeListener('exit', disableOnExit);
    };
  }, [renderer]);

  return isFocused;
}
