/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    testTimeout: 10 * 60 * 1000,
    root: __dirname,
    globalSetup: './globalSetup.ts',
    reporters: ['default'],
    include: ['**/qwen-daemon-loadtest.test.ts'],
    retry: 0,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@qwen-code/sdk': resolve(
        __dirname,
        '../packages/sdk-typescript/dist/index.mjs',
      ),
    },
  },
});
