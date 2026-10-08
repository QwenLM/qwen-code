/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Terminal focus tracking for the OpenTUI leg (ink `useFocus` parity).
 *
 * @opentui/core already parses the focus events — its renderer consumes
 * `\x1b[I` / `\x1b[O` as an input handler and re-emits them as `focus` /
 * `blur` — but nothing switches focus reporting on, so a terminal never
 * sends them. This hook owns the `?1004` mode for the OpenTUI leg; ink's
 * `useFocus` writes the same escapes for the ink leg, and only one leg is
 * ever mounted.
 *
 * The keypress re-assertion is ink's tmux workaround: a session that does not
 * forward focus events would otherwise stay blurred forever, so any key means
 * the terminal is focused.
 */
import { useEffect, useState } from 'react';
import { useKeyboard, useRenderer } from '@opentui/react';
import { CliRenderEvents } from '@opentui/core';

const ENABLE_FOCUS_REPORTING = '\x1b[?1004h';
const DISABLE_FOCUS_REPORTING = '\x1b[?1004l';

export function useTerminalFocus(): boolean {
  const renderer = useRenderer();
  const [isFocused, setIsFocused] = useState(true);

  useEffect(() => {
    const onFocus = (): void => setIsFocused(true);
    const onBlur = (): void => setIsFocused(false);
    renderer.on(CliRenderEvents.FOCUS, onFocus);
    renderer.on(CliRenderEvents.BLUR, onBlur);
    // A write can still throw with isTTY set (ERR_STREAM_DESTROYED during a
    // fast exit); losing focus events is the same degradation ink has.
    try {
      process.stdout.write(ENABLE_FOCUS_REPORTING);
    } catch {
      // No focus reporting on this stream.
    }
    return () => {
      renderer.off(CliRenderEvents.FOCUS, onFocus);
      renderer.off(CliRenderEvents.BLUR, onBlur);
      try {
        process.stdout.write(DISABLE_FOCUS_REPORTING);
      } catch {
        // Nothing left to restore.
      }
    };
  }, [renderer]);

  useKeyboard(() => {
    setIsFocused(true);
  });

  return isFocused;
}
