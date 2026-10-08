/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Process-wide serialization for worktree-ownership operations: Part 4A
 * restores, Part 4B resets, and the delete-path orphan cleanup. A restore
 * must not pass ownership validation while a marker transfer for the same
 * checkout is mid-flight, a transfer must not race a cleanup's removal,
 * and two transfers for one checkout must not race the flip.
 *
 * The serialized resource is the on-disk checkout, so the chain is keyed
 * by the canonical worktree path alone — callers holding different bridge
 * facades for the same workspace still serialize with each other. The map
 * only grows while an operation is in flight (the release callback
 * deletes the entry).
 */
const worktreeOwnershipOpTails = new Map<string, Promise<void>>();

export async function acquireWorktreeOwnershipOp(
  worktreeKey: string,
): Promise<() => void> {
  const previous = worktreeOwnershipOpTails.get(worktreeKey);
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const tail = (previous ?? Promise.resolve()).then(() => gate);
  worktreeOwnershipOpTails.set(worktreeKey, tail);
  if (previous) {
    await previous;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate();
    if (worktreeOwnershipOpTails.get(worktreeKey) === tail) {
      worktreeOwnershipOpTails.delete(worktreeKey);
    }
  };
}
