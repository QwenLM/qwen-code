/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { apiActivityTracker } from './api-activity-tracker.js';

describe('apiActivityTracker', () => {
  beforeEach(() => {
    // The tracker is a process-global singleton; clear it before each case.
    apiActivityTracker.drain();
  });

  it('accumulates errors and retries, then drains to zero', () => {
    apiActivityTracker.recordError();
    apiActivityTracker.recordError();
    apiActivityTracker.recordRetry();

    // peek() reports without consuming.
    expect(apiActivityTracker.peek()).toEqual({ errors: 2, retries: 1 });
    expect(apiActivityTracker.peek()).toEqual({ errors: 2, retries: 1 });

    // drain() returns the pending counts and resets them.
    expect(apiActivityTracker.drain()).toEqual({ errors: 2, retries: 1 });
    expect(apiActivityTracker.peek()).toEqual({ errors: 0, retries: 0 });
    expect(apiActivityTracker.drain()).toEqual({ errors: 0, retries: 0 });
  });

  it('counts errors and retries independently', () => {
    apiActivityTracker.recordRetry();
    apiActivityTracker.recordRetry();
    apiActivityTracker.recordRetry();
    expect(apiActivityTracker.drain()).toEqual({ errors: 0, retries: 3 });
  });

  it('starts a fresh window after each drain', () => {
    apiActivityTracker.recordError();
    expect(apiActivityTracker.drain()).toEqual({ errors: 1, retries: 0 });
    apiActivityTracker.recordError();
    apiActivityTracker.recordRetry();
    expect(apiActivityTracker.drain()).toEqual({ errors: 1, retries: 1 });
  });
});
