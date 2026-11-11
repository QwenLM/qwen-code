/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

// Terminal focus state signal — non-React access to DECSET 1004 focus events.
// 'unknown' is the default for terminals that don't support focus reporting;
// consumers treat 'unknown' identically to 'focused' (no throttling).
// Subscribers are notified synchronously when focus changes, used by
// TerminalFocusProvider to avoid polling.
export type TerminalFocusState = 'focused' | 'blurred' | 'unknown';

let focusState: TerminalFocusState = 'unknown';
const resolvers: Set<() => void> = new Set();
const subscribers: Set<() => void> = new Set();

export function setTerminalFocused(v: boolean): void {
  focusState = v ? 'focused' : 'blurred';
  // Notify useSyncExternalStore subscribers
  for (const cb of subscribers) {
    cb();
  }
  if (!v) {
    for (const resolve of resolvers) {
      resolve();
    }
    resolvers.clear();
  }
}

export function getTerminalFocused(): boolean {
  return focusState !== 'blurred';
}

export function getTerminalFocusState(): TerminalFocusState {
  return focusState;
}

// For useSyncExternalStore
export function subscribeTerminalFocus(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export function resetTerminalFocusState(): void {
  focusState = 'unknown';
  for (const cb of subscribers) {
    cb();
  }
}
