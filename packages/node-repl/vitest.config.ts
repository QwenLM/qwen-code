/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Kernel integration tests spawn real Node child processes.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // RPC-timeout exemption; see scripts/tests/unit-vitest-configs.test.ts.
    // Self-hosted (ECS) runners share CPU with neighbours, so the fixed 60s
    // worker→main onTaskUpdate budget can expire under contention even when
    // every test passes (#12902).
    dangerouslyIgnoreUnhandledErrors:
      process.platform !== 'linux' ||
      process.env['RUNNER_ENVIRONMENT'] === 'self-hosted',
  },
});
