/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Read the SDK's TypeScript source directly so tests never depend on a
      // stale dist build (same rationale as packages/cli/vitest.config.ts).
      '@qwen-code/sdk': path.resolve(here, '../sdk-typescript/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Discovery tests exercise real file locking; orchestrator tests use fake
    // timers but spawn no processes. Keep generous ceilings for slow CI hosts.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
