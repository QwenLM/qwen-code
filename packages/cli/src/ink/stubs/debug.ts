/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { diagnosticLogger } from '@qwen-code/core';

export type DebugLogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error';

export function logForDebugging(
  message: string,
  { level }: { level: DebugLogLevel } = { level: 'debug' },
): void {
  // warn/error always go to the log file so render-tree crashes
  // are never silently lost. Lower severities only under DEBUG
  // to avoid inflating log size.
  if (level === 'error' || level === 'warn') {
    diagnosticLogger.debugMessage(level, [`[ink] ${message}`]);
  }

  if (process.env['DEBUG']) {
    if (level !== 'error' && level !== 'warn') {
      const diagLevel = level === 'verbose' ? 'debug' : level;
      diagnosticLogger.debugMessage(diagLevel, [`[ink] ${message}`]);
    }
    const method =
      level === 'verbose' ? 'log' : level === 'debug' ? 'log' : level;
    console[method](`[ink] ${message}`);
  }
}
