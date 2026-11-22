/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Marks scroll-position writes as programmatic so scroll listeners can
 * distinguish them from user scrolling. The pinned plan strip shifts the
 * transcript offset to compensate its own height changes; without the mark,
 * a shift near the top is indistinguishable from the user scrolling to the
 * older-history edge and triggers a page fetch.
 */
const PROGRAMMATIC_SCROLL_WINDOW_MS = 64;

const programmaticUntil = new WeakMap<HTMLElement, number>();

/** Mark the next scroll events on `target` as programmatic (not user input). */
export function markProgrammaticScrollTarget(target: HTMLElement): void {
  programmaticUntil.set(target, Date.now() + PROGRAMMATIC_SCROLL_WINDOW_MS);
}

/** True while scroll events on `target` stem from a marked programmatic write. */
export function isProgrammaticScrollTarget(target: HTMLElement): boolean {
  return Date.now() < (programmaticUntil.get(target) ?? 0);
}
