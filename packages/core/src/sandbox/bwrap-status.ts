/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type BwrapStatus =
  | { state: 'confirmed'; exitCode: number }
  | { state: 'unconfirmed' | 'interrupted' | 'running' };

export const MAX_STATUS_BYTES = 16 * 1024;

export function sandboxStatusError(status: BwrapStatus): Error | undefined {
  if (status.state === 'unconfirmed') {
    return new Error(
      'Sandbox execution status could not be confirmed. The command may have run; do not automatically retry it.',
    );
  }
  if (status.state === 'interrupted') {
    return new Error('Sandbox execution was interrupted.');
  }
  return undefined;
}

export function parseBwrapStatus(
  wire: string,
  exitCode: number | null,
): BwrapStatus {
  if (Buffer.byteLength(wire) > MAX_STATUS_BYTES || !wire.endsWith('\n')) {
    return { state: 'unconfirmed' };
  }
  try {
    const lines = wire.trim().split('\n');
    if (lines.length !== 2) return { state: 'unconfirmed' };
    const initial = JSON.parse(lines[0]) as Record<string, unknown>;
    const final = JSON.parse(lines[1]) as Record<string, unknown>;
    const pid = initial['child-pid'];
    const code = final['exit-code'];
    if (
      typeof pid === 'number' &&
      Number.isInteger(pid) &&
      pid > 0 &&
      typeof code === 'number' &&
      Number.isInteger(code) &&
      code >= 0 &&
      code <= 255 &&
      code === exitCode
    ) {
      return { state: 'confirmed', exitCode: code };
    }
  } catch {
    // A partial or incompatible status stream cannot prove successful exec.
  }
  return { state: 'unconfirmed' };
}
