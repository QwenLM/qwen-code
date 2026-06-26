/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Tracks the wall-clock time of the user's last keyboard interaction so the
// background housekeeping scheduler can defer work when the user is active.
// Updated from the Ink keypress dispatcher (see KeypressContext.tsx).

let lastInteractionAt = Date.now();

export function noteInteraction(): void {
  lastInteractionAt = Date.now();
}

export function msSinceLastInteraction(): number {
  return Date.now() - lastInteractionAt;
}

export function _resetForTesting(): void {
  lastInteractionAt = Date.now();
}

export function _setLastInteractionForTesting(timestamp: number): void {
  lastInteractionAt = timestamp;
}
