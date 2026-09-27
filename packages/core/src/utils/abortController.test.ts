/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from 'vitest';
import { combineAbortSignals } from './abortController.js';

it('honors an already-cancelled input synchronously and preserves its reason', () => {
  const active = new AbortController();
  const cancelled = new AbortController();
  const reason = new Error('user cancelled');
  cancelled.abort(reason);
  const combined = combineAbortSignals([active.signal, cancelled.signal]);
  expect(combined.signal.aborted).toBe(true);
  expect(combined.signal.reason).toBe(reason);
  combined.cleanup();
  expect(active.signal.aborted).toBe(false);
});
