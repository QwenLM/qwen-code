/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
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

export function mapShellResultText(
  result: ShellResultDisplay,
  map: (text: string) => string,
): ShellResultDisplay {
  let truncated = result.truncated;
  const apply = (value: string) => {
    const next = map(value);
    truncated ||= next !== value;
    return next;
  };
  return {
    type: result.type,
    version: result.version,
    directory: result.directory,
    exitCode: result.exitCode,
    signal: result.signal,
    pid: result.pid,
    outcome: result.outcome,
    outputFiles: [...result.outputFiles],
    output: apply(result.output),
    text: apply(result.text),
    error: result.error === null ? null : apply(result.error),
    notices: result.notices.map(apply),
    truncated,
  };
}

export function shellResultText(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value
    : isShellResultDisplay(value)
      ? value.text
      : undefined;
}
