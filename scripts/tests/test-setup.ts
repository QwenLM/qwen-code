/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, vi } from 'vitest';

// A self-hosted runner operated from a qwen session inherits its stamps, and
// test:scripts runs this suite right after the standalone regression in the
// same job. They hijack the production wrapper's --version fast path and
// inject preloads; scripts/test-standalone-runtimes.mjs clears the same keys.
for (const key of [
  'NODE_OPTIONS',
  'BUN_OPTIONS',
  'CLI_VERSION',
  'QWEN_CODE_RELAUNCH_ARGS',
])
  delete process.env[key];

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const appendFileSync = vi.fn();
  return {
    ...actual,
    appendFileSync,
    default: {
      ...actual,
      appendFileSync,
    },
  };
});

// Captured before any test can install fake timers, so this yield always
// uses the real timer. Suites made of synchronous spawnSync tests can keep
// a worker's event loop blocked for the whole file (>60s), which makes
// vitest's fixed 60s worker->main `onTaskUpdate` RPC timeout fire and the
// run exit 1 with every test green. Yielding between tests bounds any
// continuous stall to a single test, so the RPC response drains well before
// the deadline. (A single test, beforeAll, or module-level block stalling
// for 60s would still trip it: testTimeout cannot interrupt synchronous
// bodies.)
const realSetTimeout = setTimeout;
beforeEach(() => new Promise((resolve) => realSetTimeout(resolve, 0)));
