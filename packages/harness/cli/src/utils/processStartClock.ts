/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Process-wide entry clock.
 *
 * `main()` marks the clock early so later startup stages (and local structured
 * logs) can measure elapsed time without threading timestamps through their
 * parameters.
 */
import { startupProfiler, type StartupPhaseHandle } from '@qwen-code/core';

let mainStartTime: number | undefined;
let cliStartupPhaseHandle: StartupPhaseHandle | undefined;
let parseArgsTimerHandle: StartupPhaseHandle | undefined;

/** Marks main() entry; safe to call again (tests, repeated main runs). */
export function markProcessStart(): void {
  stopParseArgsTimer();
  endCliStartup();
  mainStartTime = Date.now();
  cliStartupPhaseHandle = startupProfiler.start('cli_startup');
}

/** Milliseconds since main() started, or undefined when not yet marked. */
export function sinceProcessStartMs(): number | undefined {
  return mainStartTime === undefined ? undefined : Date.now() - mainStartTime;
}

export function endCliStartup(): void {
  cliStartupPhaseHandle?.end();
  cliStartupPhaseHandle = undefined;
}

export function startParseArgsTimer(): void {
  stopParseArgsTimer();
  parseArgsTimerHandle = startupProfiler.start('parse_arguments');
}

export function stopParseArgsTimer(): void {
  parseArgsTimerHandle?.end();
  parseArgsTimerHandle = undefined;
}

/** Resets the clock for tests. */
export function resetProcessStartForTesting(): void {
  stopParseArgsTimer();
  endCliStartup();
  mainStartTime = undefined;
  cliStartupPhaseHandle = undefined;
  parseArgsTimerHandle = undefined;
}
