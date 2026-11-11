/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { startupProfiler, type StartupPhaseHandle } from '@qwen-code/core';

/**
 * Process-wide entry clock.
 *
 * `main()` marks the clock early so later startup stages (and local structured
 * logs) can measure elapsed time without threading timestamps through their
 * parameters. The `cli_startup` and `parse_arguments` phases are marked on the
 * performance timeline for the local startup trace.
 */
let mainStartTime: number | undefined;
let cliStartupPhaseHandle: StartupPhaseHandle | undefined;
let parseArgsTimerHandle: StartupPhaseHandle | undefined;

/** Marks main() entry; safe to call again (tests, repeated main runs). */
export function markProcessStart(): void {
  mainStartTime = Date.now();
  cliStartupPhaseHandle = startupProfiler.start('cli_startup');
}

/** Milliseconds since main() started, or undefined when not yet marked. */
export function sinceProcessStartMs(): number | undefined {
  return mainStartTime === undefined ? undefined : Date.now() - mainStartTime;
}

/**
 * Ends the `cli_startup` phase. Idempotent: once ended (or when the profiler
 * refused a duplicate start) repeated calls stay silent.
 */
export function endCliStartup(): void {
  cliStartupPhaseHandle?.end();
  cliStartupPhaseHandle = undefined;
}

/** Starts timing the `parse_arguments` startup phase. */
export function startParseArgsTimer(): void {
  parseArgsTimerHandle = startupProfiler.start('parse_arguments');
}

/**
 * Stops timing the `parse_arguments` phase the moment argv is known.
 * Idempotent, so main() keeps a safety-net call for paths that never reach a
 * command action.
 */
export function stopParseArgsTimer(): void {
  parseArgsTimerHandle?.end();
  parseArgsTimerHandle = undefined;
}

/** Resets the clock for tests. */
export function resetProcessStartForTesting(): void {
  mainStartTime = undefined;
  cliStartupPhaseHandle = undefined;
  parseArgsTimerHandle = undefined;
}
