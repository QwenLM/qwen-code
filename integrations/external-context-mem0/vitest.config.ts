/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';
import { unhandledErrorExemption } from '../../scripts/vitest-unhandled-error-exemption.js';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    dangerouslyIgnoreUnhandledErrors: unhandledErrorExemption,
  },
});
