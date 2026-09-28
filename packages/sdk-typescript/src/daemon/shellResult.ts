/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isShellResultDisplay as isCoreShellResult } from '@qwen-code/qwen-code-core/shellResult';

export interface ShellResultDisplay {
  type: 'shell_result';
  version: 1;
  text: string;
  output: string;
  directory: string;
  exitCode: number | null;
  signal: number | null;
  pid: number | null;
  error: string | null;
  outcome: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  notices: string[];
  truncated: boolean;
  outputFiles: string[];
}

export function isShellResultDisplay(
  value: unknown,
): value is ShellResultDisplay {
  return isCoreShellResult(value);
}
