/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const SHELL_EXIT_CODE_PREFIX = 'Exit Code: ';

export function formatShellExitCode(exitCode: number | null): string {
  return `${SHELL_EXIT_CODE_PREFIX}${exitCode ?? '(none)'}`;
}
