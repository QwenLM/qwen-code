/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MAX_STATUS_BYTES,
  sandboxStatusError,
  type SandboxStatus,
} from './sandbox-status.js';

export type BwrapStatus = SandboxStatus;
export { MAX_STATUS_BYTES, sandboxStatusError };
export type { SandboxStatus };

export function parseBwrapStatus(
  wire: string,
  exitCode: number | null,
): SandboxStatus {
  if (Buffer.byteLength(wire) > MAX_STATUS_BYTES || !wire.endsWith('\n')) {
    return { state: 'unconfirmed' };
  }
  // Whether the wire carries any well-formed bwrap exit-code record,
  // independent of correlation — bwrap only emits it once the payload is
  // past exec, so its presence is proof the payload process ran to an exit.
  const payloadExitObserved = wire
    .trim()
    .split('\n')
    .some((line) => {
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        const code = record['exit-code'];
        return (
          typeof code === 'number' &&
          Number.isInteger(code) &&
          code >= 0 &&
          code <= 255
        );
      } catch {
        return false;
      }
    });
  try {
    const lines = wire.trim().split('\n');
    if (lines.length !== 2)
      return { state: 'unconfirmed', payloadExitObserved };
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
  return { state: 'unconfirmed', payloadExitObserved };
}
