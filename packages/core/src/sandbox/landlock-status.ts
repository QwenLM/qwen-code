/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MAX_STATUS_BYTES, type SandboxStatus } from './sandbox-status.js';

export function parseLandlockStatus(
  wire: string,
  exitCode: number | null,
): SandboxStatus {
  if (
    Buffer.byteLength(wire) > MAX_STATUS_BYTES ||
    (wire !== '' && !wire.endsWith('\n'))
  ) {
    return { state: 'unconfirmed' };
  }
  if (wire === '') return { state: 'unconfirmed', payloadExitObserved: false };

  try {
    const records = wire
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const prepared = records[0];
    if (
      prepared?.['state'] !== 'prepared' ||
      typeof prepared['abi'] !== 'number' ||
      !Number.isInteger(prepared['abi']) ||
      prepared['abi'] < 3
    ) {
      return { state: 'unconfirmed' };
    }
    if (records[1]?.['state'] === 'exec-failed' && records.length === 2) {
      return { state: 'unconfirmed', payloadExitObserved: false };
    }
    if (
      records.length === 1 &&
      typeof exitCode === 'number' &&
      Number.isInteger(exitCode) &&
      exitCode >= 0 &&
      exitCode <= 255
    ) {
      return { state: 'confirmed', exitCode };
    }
  } catch {
    /* Malformed launcher evidence cannot establish whether exec happened. */
  }
  return { state: 'unconfirmed' };
}
