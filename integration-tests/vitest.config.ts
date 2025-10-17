/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';

const timeoutMinutes = Number(process.env.TB_TIMEOUT_MINUTES || '5');
const testTimeoutMs = timeoutMinutes * 60 * 1000;

export default defineConfig({
  test: {
    testTimeout: testTimeoutMs,
    globalSetup: './globalSetup.ts',
    reporters: ['default'],
    include: ['**/*.test.ts'],
    exclude: ['**/terminal-bench/*.test.ts', '**/node_modules/**'],
    retry: 2,
    fileParallelism: false,
  },
});
