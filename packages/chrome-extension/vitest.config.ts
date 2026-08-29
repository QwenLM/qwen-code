/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';
import { unhandledErrorExemption } from '../../scripts/vitest-unhandled-error-exemption.js';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.js'],
    environment: 'jsdom',
    globals: true,
    dangerouslyIgnoreUnhandledErrors: unhandledErrorExemption,
  },
});
