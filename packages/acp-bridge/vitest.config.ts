/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    reporters: ['default'],
    silent: true,
    coverage: {
      enabled: false,
      provider: 'v8',
      include: ['src/**/*'],
    },
  },
});
