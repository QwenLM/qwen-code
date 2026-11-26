/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

/**
 * Callbacks that need fresh yoga layout but must not force one.
 *
 * Yoga layout used to run inside the reconciler's `resetAfterCommit`, so a
 * `useLayoutEffect` reading `getComputedHeight()` was guaranteed fresh values.
 * With layout moved to frame time, those readers register here instead: Ink
 * runs them right after each frame's `calculateLayout`, then flushes whatever
 * state they set, and re-lays out if that dirtied the tree again.
 *
 * The registry is per-Ink-root, not module-global: tests create several roots,
 * and a shared set would run one root's React updates while a different root
 * was laying out.
 */

export interface AfterLayoutRegistry {
  /**
   * Register a callback. Lower priority runs first — parents before children,
   * because a parent's measurement usually feeds its children's props and the
   * reverse order costs an extra settle pass.
   *
   * Returns an unregister function; callers must invoke it on unmount, or the
   * callback will later set state on a dead fiber and read a freed yoga node.
   */
  register(callback: () => void, priority: number): () => void;
  /**
   * Mark a callback as needing to run at the next layout. Callbacks are gated
   * on this so a registered component is only measured when it actually
   * committed, matching the per-commit `useLayoutEffect` they replaced.
   */
  markPending(callback: () => void): void;
  /** True when at least one registered callback is waiting to run. */
  hasPending(): boolean;
  /** Run and clear every pending callback, lowest priority first. */
  runPending(): void;
}

interface Entry {
  callback: () => void;
  priority: number;
  pending: boolean;
}

export function createAfterLayoutRegistry(): AfterLayoutRegistry {
  const entries = new Map<() => void, Entry>();

  return {
    register(callback, priority) {
      entries.set(callback, { callback, priority, pending: true });
      return () => {
        entries.delete(callback);
      };
    },
    markPending(callback) {
      const entry = entries.get(callback);
      if (entry) entry.pending = true;
    },
    hasPending() {
      for (const entry of entries.values()) {
        if (entry.pending) return true;
      }
      return false;
    },
    runPending() {
      if (entries.size === 0) return;
      const due: Entry[] = [];
      for (const entry of entries.values()) {
        if (entry.pending) {
          entry.pending = false;
          due.push(entry);
        }
      }
      if (due.length === 0) return;
      due.sort((a, b) => a.priority - b.priority);
      for (const entry of due) {
        entry.callback();
      }
    },
  };
}
