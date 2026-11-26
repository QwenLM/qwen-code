/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { defineConfig } from 'vitest/config';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  test: {
    include: ['installed/npm-distribution.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 120_000,
    hookTimeout: 2_700_000,
    retry: 0,
    bail: 1,
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    dangerouslyIgnoreUnhandledErrors: false,
  },
});
