/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Exit drain for the OpenTUI renderer (ink parity).
 *
 * The ink tree routes every exit through `runExitCleanup()` (utils/cleanup):
 * chat-recording flush, `config.shutdown()` (MCP subprocess stop + telemetry
 * shutdown), session-usage persisting, Kitty flag pop and the resume hint
 * echo are all registered cleanup steps (gemini.tsx + startInteractiveUI).
 * The original OpenTUI backend called `renderer.destroy()` +
 * `process.exit(0)` directly, so none of those ever ran: session jsonl
 * write queues were not flushed (hurting `--resume` recoverability), MCP
 * children leaked, and usage was never persisted.
 *
 * Every OpenTUI exit path (Ctrl+C/Ctrl+D double press, /quit, render-error
 * bailout) must go through `exitSession()`, which drains the shared cleanup
 * chain first and only then exits — with signal-style exit codes (130/143)
 * for interrupt-like exits instead of a bare 0.
 */

import { runExitCleanup } from '../../utils/cleanup.js';

/** Exit code for interrupt-style exits (Ctrl+C / Ctrl+D double press). */
export const EXIT_CODE_INTERRUPT = 130;
/** Exit code for termination-style exits (SIGTERM semantics). */
export const EXIT_CODE_TERMINATED = 143;

let exitInProgress = false;

/** True once an `exitSession` drain has started (guards re-entrancy). */
export function isExitInProgress(): boolean {
  return exitInProgress;
}

/**
 * Drain the registered exit-cleanup chain, then `process.exit(code)`.
 *
 * Idempotent: a second call while a drain is in flight hangs (returns a
 * promise that never resolves) instead of racing the first drain — the
 * process is going down either way.
 */
export async function exitSession(code: number): Promise<never> {
  if (exitInProgress) {
    // The first drain owns the exit; never run the chain twice.
    return new Promise<never>(() => {});
  }
  exitInProgress = true;
  try {
    await runExitCleanup();
  } catch {
    // runExitCleanup swallows per-cleanup errors already; belt and braces.
  }
  process.exit(code);
}

/** TEST ONLY: reset the module-level exit latch between cases. */
export function _resetExitLifecycleForTest(): void {
  exitInProgress = false;
}
