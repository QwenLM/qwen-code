/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Recursive on purpose: the ordinary integration config excludes
    // `**\/managed-loop/**`, so a test in a subdirectory would otherwise be
    // collected by neither lane. `*` alone does not cross `/`.
    include: ['managed-loop/**/*.test.ts'],
    // Must stay above the sum of the ceilings each scenario declares for
    // itself, or this cap always fires first and reports a bare
    // "Test timed out" instead of the wait that was actually close.
    // `daemon.test.ts` declares 60s boot + 60s prompt abort + a 30s
    // `waitUntil` (150s); `hosted.test.ts` declares two 30s startup waits
    // plus two 30s `waitUntil` polls (120s). Worst case is 150s, so this
    // leaves ~90s of margin for a contended runner without letting the
    // 45-minute job budget (`managed-agent-loop.yml`) be spent on a hang.
    testTimeout: 240_000,
    hookTimeout: 30_000,
    retry: 0,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { minForks: 1, maxForks: 1 } },
  },
});
