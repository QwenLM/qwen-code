/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    testTimeout: 60000,
    hookTimeout: 60000,
    coverage: {
      enabled: process.env['COVERAGE'] === '1' || process.env['CI'] === 'true',
      provider: 'v8',
    },
  },
});
