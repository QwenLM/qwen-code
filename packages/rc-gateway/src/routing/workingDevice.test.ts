/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import { WorkingDeviceTracker, recordActivity } from './workingDevice.js';

describe('WorkingDeviceTracker', () => {
  it('reports an unknown token as not working', () => {
    const tracker = new WorkingDeviceTracker();
    expect(tracker.isWorking('never-seen')).toBe(false);
  });

  it('reports a token working after touch and not working past the window', () => {
    let now = 1000;
    const tracker = new WorkingDeviceTracker(120000, () => now);
    tracker.touch('t1');
    expect(tracker.isWorking('t1')).toBe(true);

    // Just under the window → still working.
    now = 1000 + 119999;
    expect(tracker.isWorking('t1')).toBe(true);

    // At/past the window → no longer working.
    now = 1000 + 120000;
    expect(tracker.isWorking('t1')).toBe(false);

    // A second touch re-arms it.
    tracker.touch('t1');
    expect(tracker.isWorking('t1')).toBe(true);
  });
});

describe('recordActivity middleware', () => {
  it('touches the tracker for a req carrying rcClient.id and calls next', () => {
    const tracker = new WorkingDeviceTracker();
    const req = { rcClient: { id: 'tok-1', scopes: [] } } as unknown as Request;
    const res = {} as Response;
    let nextCalled = false;
    recordActivity(tracker)(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(tracker.isWorking('tok-1')).toBe(true);
  });

  it('does not throw and records nothing when rcClient is absent, still calling next', () => {
    const tracker = new WorkingDeviceTracker();
    const req = {} as Request;
    const res = {} as Response;
    let nextCalled = false;
    expect(() =>
      recordActivity(tracker)(req, res, () => {
        nextCalled = true;
      }),
    ).not.toThrow();
    expect(nextCalled).toBe(true);
  });
});
