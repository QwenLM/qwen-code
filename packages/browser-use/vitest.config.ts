/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const manifest = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { dependencies: Record<string, string> };

export default defineConfig({
  // Mirrors build.mjs: the pinned playwright-core version the SDK checks.
  define: {
    __QWEN_PLAYWRIGHT_CORE_VERSION__: JSON.stringify(
      manifest.dependencies['playwright-core'],
    ),
  },
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    // RPC-timeout exemption; see scripts/tests/unit-vitest-configs.test.ts.
    dangerouslyIgnoreUnhandledErrors: process.platform !== 'linux',
    // Shared-pool ceiling; see scripts/tests/unit-vitest-configs.test.ts.
    // Raised only on the ECS pool, where the same suite runs ~5x slower
    // depending on which host it lands on (#10490); off the pool this stays
    // `undefined` so vitest's 5s default keeps catching a genuine hang fast.
    testTimeout: process.env['RUNNER_NAME']?.startsWith('ecs-qwen-')
      ? 60_000
      : undefined,
  },
});
