/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.js'],
    environment: 'jsdom',
    globals: true,
    // RPC-timeout exemption; see scripts/tests/unit-vitest-configs.test.ts.
    // Self-hosted (ECS) runners share CPU with neighbours, so the fixed 60s
    // worker→main onTaskUpdate budget can expire under contention even when
    // every test passes (#12902).
    dangerouslyIgnoreUnhandledErrors:
      process.platform !== 'linux' ||
      process.env['RUNNER_ENVIRONMENT'] === 'self-hosted',
    // Shared-pool ceiling; see scripts/tests/unit-vitest-configs.test.ts.
    // Raised only on the ECS pool, where the same suite runs ~5x slower
    // depending on which host it lands on (#10490); off the pool this stays
    // `undefined` so vitest's 5s default keeps catching a genuine hang fast.
    testTimeout: process.env['RUNNER_NAME']?.startsWith('ecs-qwen-')
      ? 60_000
      : undefined,
  },
});
