/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // RPC-timeout exemption; see scripts/tests/unit-vitest-configs.test.ts.
    dangerouslyIgnoreUnhandledErrors: process.platform !== 'linux',
    // Shared-pool ceiling; see scripts/tests/unit-vitest-configs.test.ts.
    // Raised only on the ECS pool, where the same suite runs ~5x slower
    // depending on which host it lands on (#10490); off the pool this stays
    // `undefined` so vitest's 5s default keeps catching a genuine hang fast.
    testTimeout: process.env['RUNNER_NAME']?.startsWith('ecs-qwen-')
      ? 60_000
      : undefined,
  },
});
