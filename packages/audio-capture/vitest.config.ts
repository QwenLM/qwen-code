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
    // RPC-timeout exemption; see scripts/tests/unit-vitest-configs.test.ts.
    dangerouslyIgnoreUnhandledErrors:
      process.platform !== 'linux' ||
      process.env['RUNNER_ENVIRONMENT'] === 'self-hosted',
  },
});
