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
  },
});
