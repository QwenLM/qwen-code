/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';

/**
 * Matches devices whose primary interaction is a touchscreen with no hover —
 * phones and tablets. The AND of both features deliberately excludes touch
 * laptops (hover-capable trackpad + touchscreen), which keep the desktop
 * CodeMirror editor.
 */
export const TOUCH_COMPOSER_QUERY = '(hover: none) and (pointer: coarse)';

/**
 * Raw device detection, ignoring the URL override. Used to gate programmatic
 * (non-gesture) `view.focus()` calls: on iOS, focusing an editable element
 * outside a user gesture does not open the keyboard but does claim
 * `document.activeElement`, after which user taps may no longer fire a fresh
 * focus event — the keyboard never appears. That must stay suppressed even
 * when the user forces the CodeMirror path via `?composer=codemirror`.
 *
 * The media query alone decides — deliberately no `navigator.maxTouchPoints`
 * requirement: Playwright's stock WebKit iPhone profiles (and some TV
 * browsers) match the query while reporting zero touch points, and the
 * textarea is a safe fallback wherever the primary pointer is coarse and
 * cannot hover.
 */
export function isCoarsePointerDevice(): boolean {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return false;
  }
  return window.matchMedia(TOUCH_COMPOSER_QUERY).matches;
}

function resolveTouchComposer(): boolean {
  if (typeof window !== 'undefined') {
    // Escape hatch for debugging and rollback: ?composer=textarea forces the
    // mobile backend, ?composer=codemirror forces the desktop editor.
    const override = new URLSearchParams(window.location.search).get(
      'composer',
    );
    if (override === 'textarea') return true;
    if (override === 'codemirror') return false;
  }
  return isCoarsePointerDevice();
}

/**
 * Decides once, at mount, whether the composer should use the plain
 * `<textarea>` backend instead of CodeMirror. Intentionally NOT reactive:
 * swapping editor backends mid-session would drop the draft, tags, and
 * pasted images, so the choice is frozen for the lifetime of the component.
 * Degrades to `false` (CodeMirror) when `matchMedia` is unavailable
 * (SSR / the jsdom test default).
 */
export function useIsTouchComposer(): boolean {
  const [isTouch] = useState<boolean>(resolveTouchComposer);
  return isTouch;
}
