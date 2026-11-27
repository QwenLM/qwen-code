/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Browser-safe runtime guard for `ShellResultDisplay` matching
 * `@qwen-code/qwen-code-core/shellResult` so shared tool-output renderers do
 * not pull `@qwen-code/sdk/daemon` into the managed-only bundle.
 */
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v['type'] === 'shell_result' &&
    v['version'] === 1 &&
    typeof v['text'] === 'string' &&
    typeof v['output'] === 'string' &&
    typeof v['directory'] === 'string' &&
    ['exitCode', 'signal', 'pid'].every(
      (k) =>
        v[k] === null ||
        (typeof v[k] === 'number' && Number.isSafeInteger(v[k])),
    ) &&
    (v['error'] === null || typeof v['error'] === 'string') &&
    typeof v['outcome'] === 'string' &&
    ['completed', 'failed', 'cancelled', 'timed_out'].includes(v['outcome']) &&
    typeof v['truncated'] === 'boolean' &&
    Array.isArray(v['notices']) &&
    v['notices'].length <= 32 &&
    v['notices'].every((s) => typeof s === 'string') &&
    Array.isArray(v['outputFiles']) &&
    v['outputFiles'].length <= 32 &&
    v['outputFiles'].every((s) => typeof s === 'string') &&
    v['directory'].length +
      (v['outputFiles'] as string[]).reduce((n, s) => n + s.length, 0) <=
      8192
  );
}
