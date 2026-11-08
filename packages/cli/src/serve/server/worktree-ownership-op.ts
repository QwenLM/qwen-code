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
 *
 * Every caller must derive the key by the same rule: `fs.realpathSync` (the
 * JS implementation, not `.native`) of the sidecar's recorded worktree path.
 * Keys agree only while the checkout resolves to the same path, which is why
 * the restore re-checks under the lock before it attests a checkout, the
 * reset before it transfers one, and the cleanup before it removes one; a
 * caller using another rule could disagree even then and stop excluding the
 * others. The daemon-side containment checks compare these paths with
 * `fs.realpathSync` of the worktree roots and must keep the same rule. The
 * restore derives the key in `ownershipLockKeyForWorktree`
 * (`routes/session.ts`) and later compares it with the `realTarget` its
 * validation resolves; the orphan cleanup uses `canonicalPath`
 * (`worktree-orphan-cleanup.ts`); both fall back to the raw path when it does
 * not resolve. The reset route locks the `realTarget` from
 * `resolveWorktreeOwnershipTarget` (`routes/session.ts`), which refuses an
 * unresolvable checkout, so it only ever locks a resolved path.
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
