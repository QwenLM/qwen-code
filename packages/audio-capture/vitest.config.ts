/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';
import { unhandledErrorExemption } from '../../scripts/vitest-unhandled-error-exemption.js';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    dangerouslyIgnoreUnhandledErrors: unhandledErrorExemption,
  },
});
