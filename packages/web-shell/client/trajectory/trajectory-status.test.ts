/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isRetryableFailure,
  trajectoryPillState,
  trajectoryTopBoundary,
  trajectoryWarnings,
} from './trajectory-status';

describe('trajectoryPillState', () => {
  const base = {
    windowMode: 'latest' as const,
    following: true,
    returning: false,
    liveStatus: 'live' as const,
  };

  it.each([
    [{}, 'live'],
    [{ liveStatus: 'catching-up' as const }, 'connecting'],
    [{ liveStatus: 'stale' as const }, 'reconnecting'],
    [{ liveStatus: 'unavailable' as const }, 'none'],
    [{ following: false }, 'paused'],
    [{ following: false, liveStatus: 'unavailable' as const }, 'paused'],
    [{ windowMode: 'history' as const, following: false }, 'history'],
    [{ returning: true, windowMode: 'history' as const }, 'returning'],
  ])('maps %j to %s', (overrides, expected) => {
    expect(trajectoryPillState({ ...base, ...overrides })).toBe(expected);
  });
});

describe('trajectoryWarnings', () => {
  const quiet = {
    hasTrajectory: true,
    historyStale: false,
    lifecycleIncomplete: false,
  };

  it('is empty when nothing needs attention', () => {
    expect(trajectoryWarnings(quiet)).toEqual([]);
  });

  it('orders warnings by urgency', () => {
    expect(
      trajectoryWarnings({
        hasTrajectory: true,
        error: { kind: 'partial' },
        navigationError: { kind: 'expired' },
        historyStale: true,
        lifecycleIncomplete: true,
      }).map((warning) => warning.kind),
    ).toEqual([
      'refresh-failed',
      'navigation-failed',
      'history-gap',
      'lifecycle-incomplete',
    ]);
  });

  it('leaves a failed first read to the list', () => {
    expect(
      trajectoryWarnings({
        ...quiet,
        hasTrajectory: false,
        error: { kind: 'unreadable', message: 'boom' },
      }),
    ).toEqual([]);
  });
});

describe('trajectoryTopBoundary', () => {
  it('prefers a failure, then loading, then what precedes the window', () => {
    expect(
      trajectoryTopBoundary({
        truncated: true,
        loading: true,
        olderFailure: { kind: 'partial' },
      }),
    ).toBe('failed');
    expect(trajectoryTopBoundary({ truncated: true, loading: true })).toBe(
      'loading',
    );
    expect(trajectoryTopBoundary({ truncated: true, loading: false })).toBe(
      'earlier',
    );
    expect(trajectoryTopBoundary({ truncated: false, loading: false })).toBe(
      'start',
    );
  });
});

describe('isRetryableFailure', () => {
  it('retries only reads that can repeat with the same cursor', () => {
    expect(isRetryableFailure({ kind: 'partial' })).toBe(true);
    expect(isRetryableFailure({ kind: 'unreadable', message: 'x' })).toBe(true);
    expect(isRetryableFailure({ kind: 'expired' })).toBe(false);
    expect(isRetryableFailure({ kind: 'protocol' })).toBe(false);
    expect(isRetryableFailure({ kind: 'budget' })).toBe(false);
  });
});
