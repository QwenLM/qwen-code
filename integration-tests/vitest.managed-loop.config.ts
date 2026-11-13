/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['managed-loop/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    retry: 0,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { minForks: 1, maxForks: 1 } },
  },
});
