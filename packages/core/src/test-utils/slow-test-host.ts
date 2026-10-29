/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';

/**
 * RUNNER_NAME identifies the shared ECS pool in ordinary CI, but the
 * review-address verification gate re-runs package tests through an
 * `env -i` child that does not carry it. Fall back to measured contention
 * so the raised slow-host budgets still apply on an overloaded runner:
 * the gate clamps vitest to 25% of the cores, so its own workers never
 * lift the load average to the core count.
 *
 * Mirrors packages/cli/src/test-utils/slow-test-host.ts; keep both in sync.
 */
export function isSlowTestHost(): boolean {
  if (process.env['RUNNER_NAME']?.startsWith('ecs-qwen-')) {
    return true;
  }
  return os.loadavg()[0] >= os.availableParallelism() * 0.5;
}
