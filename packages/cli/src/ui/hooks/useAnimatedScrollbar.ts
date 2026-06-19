/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 *
 * Inspired by gemini-cli's `useAnimatedScrollbar` (Google LLC,
 * Apache-2.0). Simplified for stock ink 7 — instead of interpolating
 * RGB colors via a theme + per-frame setInterval, this hook exposes a
 * binary "is the thumb glyph currently emphasised" flag. The terminal
 * doesn't render smooth color fades anyway; the visual benefit is the
 * thumb pop-in / pop-out, which the binary signal already delivers
 * with a fraction of the bookkeeping.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseAnimatedScrollbarOptions {
  /**
   * How long the scrollbar thumb stays emphasised after the most recent
   * `flashScrollbar()` call. Defaults to 1.5s, matching the perceptual
   * window in which a user expects feedback after a scroll input.
   */
  idleHideMs?: number;
}

export interface AnimatedScrollbarState {
  /**
   * `true` while the user has scrolled recently and the thumb should
   * stand out. Falls back to `false` after `idleHideMs` of inactivity,
   * fading the thumb into the dim track so the bar stops competing
   * with the conversation.
   */
  isVisible: boolean;
  /**
   * Call from a scroll handler (keyboard, wheel, programmatic) to set
   * `isVisible = true` and reset the idle timer. Idempotent — safe to
   * call on every scroll tick.
   */
  flashScrollbar: () => void;
}

export function useAnimatedScrollbar(
  options: UseAnimatedScrollbarOptions = {},
): AnimatedScrollbarState {
  const { idleHideMs = 1500 } = options;
  const [isVisible, setIsVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashScrollbar = useCallback(() => {
    setIsVisible(true);
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    // idleHideMs <= 0 disables the auto-hide; useful for tests that want
    // the thumb to stay emphasised so they can assert on it without
    // racing the timer.
    if (idleHideMs <= 0) {
      timerRef.current = null;
      return;
    }
    timerRef.current = setTimeout(() => {
      setIsVisible(false);
      timerRef.current = null;
    }, idleHideMs);
  }, [idleHideMs]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    [],
  );

  return { isVisible, flashScrollbar };
}
