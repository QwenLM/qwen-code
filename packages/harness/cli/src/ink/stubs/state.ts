/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

let lastInteractionTime = Date.now();

export function updateLastInteractionTime(_immediate?: boolean): void {
  lastInteractionTime = Date.now();
}

export function getLastInteractionTime(): number {
  return lastInteractionTime;
}

export function flushInteractionTime(): void {
  lastInteractionTime = Date.now();
}

let isScrollDraining = false;
let scrollTimer: ReturnType<typeof setTimeout> | undefined;

export function markScrollActivity(): void {
  isScrollDraining = true;
  if (scrollTimer) clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    isScrollDraining = false;
  }, 150);
}

export function getIsScrollDraining(): boolean {
  return isScrollDraining;
}

export function waitForScrollIdle(): Promise<void> {
  if (!isScrollDraining) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (!isScrollDraining) resolve();
      else setTimeout(check, 50);
    };
    check();
  });
}
