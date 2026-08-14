/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: packageDir,
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
