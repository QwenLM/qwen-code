/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { performance } from 'node:perf_hooks';

export function createSettleTimeout(
  testTimeoutMs: number,
  waitTimeoutMs: number,
): () => number {
  // Sequential waits share the test deadline, leaving time to report their
  // assertion instead of being interrupted by Vitest's runner timeout.
  const deadline =
    testTimeoutMs === 0
      ? Number.POSITIVE_INFINITY
      : performance.now() + testTimeoutMs - 1_000;

  return () =>
    Math.max(1, Math.min(waitTimeoutMs, deadline - performance.now()));
}
