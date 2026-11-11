/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isAbortErrorDeep } from './errors.js';

export function observationMonotonicNow(): number | undefined {
  try {
    return performance.now();
  } catch {
    return undefined;
  }
}

export function observationElapsedMs(
  startedAt: number | undefined,
): number | undefined {
  const endedAt = observationMonotonicNow();
  return startedAt === undefined || endedAt === undefined
    ? undefined
    : Math.max(0, endedAt - startedAt);
}

export function observationWaitFailureStatus(
  error: unknown,
  signal?: AbortSignal,
): 'aborted' | 'failed' {
  try {
    return signal?.aborted || isAbortErrorDeep(error) ? 'aborted' : 'failed';
  } catch {
    return 'failed';
  }
}
