/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from 'vitest';

// Pins the invariant established by test-setup.ts's beforeEach yield:
// between two tests the worker's event loop must turn far enough to drain
// pending macrotasks. Without that yield a fully synchronous file never
// reaches the timer phase between tests, the flag armed below never flips,
// and the same unbroken stall is what lets vitest's fixed 60s worker->main
// `onTaskUpdate` RPC timeout fire (see test-setup.ts).
let macrotaskRan = false;

it('arms a flag from a real macrotask callback', () => {
  setTimeout(() => {
    macrotaskRan = true;
  }, 0);
});

it('observes the event loop turned between tests', () => {
  expect(macrotaskRan).toBe(true);
});
