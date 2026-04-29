/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core';

const cleanupFunctions: Array<(() => void) | (() => Promise<void>)> = [];

export function registerCleanup(fn: (() => void) | (() => Promise<void>)) {
  cleanupFunctions.push(fn);
}

/**
 * Per-cleanup ceiling. Caps any single hung cleanup (slow disk on
 * `chatRecording.flush`, MCP disconnect on a dead socket, telemetry HTTP
 * stall) so it can't starve the rest of the cleanup chain.
 */
const PER_CLEANUP_TIMEOUT_MS = 2_000;

/**
 * Wall-clock ceiling for the whole cleanup pass. Pre-async-jsonl, sync
 * fs writes were inherently bounded by their syscall return; with the
 * write queue moved off-thread, an unbounded `await flush()` could now
 * hang exit indefinitely. This ceiling guarantees the process always
 * exits within a bounded time, even if a cleanup never resolves.
 */
const OVERALL_CLEANUP_TIMEOUT_MS = 5_000;

/**
 * Awaits `promise`, but resolves to `undefined` if `ms` elapses first.
 * Rejection collapses to the same undefined resolution — caller treats
 * cleanup errors as best-effort. Timer is unrefed so it can't keep the
 * event loop alive on its own.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

export interface RunExitCleanupOptions {
  /** TEST ONLY — override per-cleanup-function timeout (default 2s). */
  _testPerFnTimeoutMs?: number;
  /** TEST ONLY — override overall wall-clock timeout (default 5s). */
  _testOverallTimeoutMs?: number;
}

export async function runExitCleanup(
  options: RunExitCleanupOptions = {},
): Promise<void> {
  const perFn = options._testPerFnTimeoutMs ?? PER_CLEANUP_TIMEOUT_MS;
  const overall = options._testOverallTimeoutMs ?? OVERALL_CLEANUP_TIMEOUT_MS;

  const drain = (async () => {
    for (const fn of cleanupFunctions) {
      try {
        await withTimeout(Promise.resolve().then(fn), perFn);
      } catch (_) {
        // Ignore errors during cleanup.
      }
    }
  })();

  // clearTimeout when drain wins; unref keeps the handle from blocking exit.
  let wallClockTimer: NodeJS.Timeout | undefined;
  const wallClock = new Promise<void>((resolve) => {
    wallClockTimer = setTimeout(() => resolve(), overall);
    wallClockTimer.unref?.();
  });

  try {
    await Promise.race([drain, wallClock]);
  } finally {
    if (wallClockTimer) clearTimeout(wallClockTimer);
    cleanupFunctions.length = 0; // Clear the array
  }
}

/**
 * Test-only: clear the registered cleanup functions array. Module-private
 * state otherwise leaks across vitest cases — the previous test isolation
 * via `global['cleanupFunctions']` was a no-op (the array isn't on global)
 * and only happened to work because `runExitCleanup` itself clears at the
 * end. Naming follows the `_reset*ForTest` convention from
 * d6485964c (paths, jsonl-utils, ripGrep).
 */
export function _resetCleanupFunctionsForTest(): void {
  cleanupFunctions.length = 0;
}

export async function cleanupCheckpoints() {
  const storage = new Storage(process.cwd());
  const tempDir = storage.getProjectTempDir();
  const checkpointsDir = join(tempDir, 'checkpoints');
  try {
    await fs.rm(checkpointsDir, { recursive: true, force: true });
  } catch {
    // Ignore errors if the directory doesn't exist or fails to delete.
  }
}
