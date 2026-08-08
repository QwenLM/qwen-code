/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Whether this process has started exiting.
 *
 * Exit is a chain, not an instant: the CLI runs every registered cleanup
 * in registration order under a per-function and an overall budget, then
 * calls `process.exit()`. Anything that must stop accepting new work at
 * exit cannot wait for its own cleanup to be reached — by the time that
 * happens it has already taken on work that dies unfinished, and may have
 * told a peer otherwise.
 *
 * This flag marks the start of that window so such code can fail closed
 * from its first moment instead of from its own turn in the chain.
 */
let exitStarted = false;

/** Called once, at the top of the exit-cleanup chain. */
export function markExitStarted(): void {
  exitStarted = true;
}

export function hasExitStarted(): boolean {
  return exitStarted;
}

/** Test-only: module-private state otherwise leaks across cases. */
export function _resetExitStateForTest(): void {
  exitStarted = false;
}
