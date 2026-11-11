/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['scripts/tests/**/*.test.{js,ts}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.qwen*/**'],
    setupFiles: ['scripts/tests/test-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
        minForks: 2,
        maxForks: 4,
      },
    },
  },
});
