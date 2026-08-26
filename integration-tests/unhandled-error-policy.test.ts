/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from 'vitest';
import config from './vitest.config.js';

// Pins the unhandled-error exemption that keeps the off-Linux E2E lanes
// from exiting red with every test green: runner resource pressure can
// stall a worker past vitest's fixed 60s worker->main `onTaskUpdate` RPC
// budget, and the resulting unhandled error must not fail the run off
// Linux (see vitest.config.ts). Dropping the flag reintroduces the
// red-all-green failure it was added for.
it('keeps unhandled errors fatal only on Linux', () => {
  expect(config.test?.dangerouslyIgnoreUnhandledErrors).toBe(
    process.platform !== 'linux',
  );
});
