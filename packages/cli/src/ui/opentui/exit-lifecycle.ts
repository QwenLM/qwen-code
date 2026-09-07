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
 * bailout) must go through `exitSession()`, which signals the client to stop
 * spawning background work, drains the shared cleanup chain first and only then
 * exits — with signal-style exit codes (130/143) for interrupt-like exits
 * instead of a bare 0.
 */

import type { Config } from '@qwen-code/qwen-code-core';
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
 * Tell the client to stop spawning background work, drain the registered
 * exit-cleanup chain, then `process.exit(code)`.
 *
 * `requestShutdown()` first: it sets the client's shutdown flag and cancels the
 * pending memory prefetch, so extract / dream / skill-review work cannot be
 * spawned *during* the drain — which is what makes the process able to exit.
 * ink signals it on its quit path only; every exit here means "this process is
 * going down", so the signal belongs to the shared drain rather than to one
 * handler.
 *
 * Idempotent: a second call while a drain is in flight hangs (returns a
 * promise that never resolves) instead of racing the first drain — the
 * process is going down either way, and the hanging branch never re-signals.
 */
export async function exitSession(
  config: Config,
  code: number,
): Promise<never> {
  if (exitInProgress) {
    // The first drain owns the exit; never run the chain twice.
    return new Promise<never>(() => {});
  }
  exitInProgress = true;
  config.getLlmClient()?.requestShutdown();
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
