/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';

/**
 * RUNNER_NAME identifies the shared ECS pool in ordinary CI, but the
 * review-address verification gate re-runs package tests through an
 * `env -i` child that keeps `CI` and drops both RUNNER_NAME and
 * RUNNER_ENVIRONMENT. Treat that markerless child as slow too; the load
 * fallback still catches an overloaded host that carries either marker.
 *
 * Mirrors packages/core/src/test-utils/slow-test-host.ts; keep both in sync.
 */
export function isSlowTestHost(): boolean {
  if (process.env['RUNNER_NAME']?.startsWith('ecs-qwen-')) {
    return true;
  }
  if (
    process.env['CI'] === 'true' &&
    process.env['RUNNER_NAME'] === undefined &&
    process.env['RUNNER_ENVIRONMENT'] === undefined
  ) {
    return true;
  }
  return os.loadavg()[0] >= os.availableParallelism();
}
