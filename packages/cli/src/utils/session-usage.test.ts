/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMetrics } from '@qwen-code/qwen-code-core';
import { registerCleanup } from './cleanup.js';
import {
  flushSessionUsageSnapshot,
  startSessionUsageSnapshots,
} from './session-usage.js';

vi.mock('./cleanup.js', () => ({ registerCleanup: vi.fn() }));

function makeSessionMetrics(totalRequests: number): SessionMetrics {
  return {
    models:
      totalRequests > 0
        ? {
            'qwen-max': {
              api: {
                totalRequests,
                totalErrors: 0,
                totalLatencyMs: 100,
              },
              tokens: {
                prompt: 10,
                candidates: 20,
                total: 30,
                cached: 0,
                thoughts: 0,
              },
              bySource: {},
            },
          }
        : {},
    tools: {
      totalCalls: 0,
      totalSuccess: 0,
      totalFail: 0,
      totalDurationMs: 0,
      totalDecisions: {
        accept: 0,
        reject: 0,
        modify: 0,
        auto_accept: 0,
      },
      byName: {},
    },
    files: {
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
    },
  };
}

describe('session usage snapshots', () => {
  const config = {
    getSessionId: () => 'session-1',
    getProjectRoot: () => '/workspace',
  } as const;
  const registerCleanupMock = vi.mocked(registerCleanup);

  beforeEach(() => {
    registerCleanupMock.mockClear();
  });

  it('skips snapshot writes when no API requests ran', () => {
    const persist = vi.fn();

    const wrote = flushSessionUsageSnapshot(
      config,
      {},
      {
        getMetrics: () => makeSessionMetrics(0),
        persist,
      },
    );

    expect(wrote).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });

  it('writes an active session snapshot with per-session timing data', () => {
    const persist = vi.fn();
    const metrics = makeSessionMetrics(2);
    const getMetrics = vi.fn(() => metrics);
    const getSessionStartTime = vi.fn(() => new Date('2026-07-06T00:00:00Z'));
    const endTime = new Date('2026-07-06T00:05:00Z');

    const wrote = flushSessionUsageSnapshot(
      config,
      {},
      {
        getMetrics,
        getSessionStartTime,
        now: () => endTime,
        persist,
      },
    );

    expect(wrote).toBe(true);
    expect(getMetrics).toHaveBeenCalledWith('session-1');
    expect(getSessionStartTime).toHaveBeenCalledWith('session-1');
    expect(persist).toHaveBeenCalledWith({
      sessionId: 'session-1',
      startTime: new Date('2026-07-06T00:00:00Z'),
      endTime,
      project: '/workspace',
      metrics,
    });
  });

  it('flushes on recurring intervals and once more during cleanup', () => {
    vi.useFakeTimers();
    const persist = vi.fn();
    let requestCount = 0;
    try {
      startSessionUsageSnapshots(config, {
        getMetrics: () => makeSessionMetrics(++requestCount),
        getSessionStartTime: () => new Date('2026-07-06T00:00:00Z'),
        now: () => new Date('2026-07-06T00:05:00Z'),
        persist,
      });

      expect(vi.getTimerCount()).toBe(1);
      expect(registerCleanupMock).toHaveBeenCalledOnce();

      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(persist).toHaveBeenCalledTimes(2);
      expect(persist.mock.calls[0]![0]).toMatchObject({ isPartial: true });
      expect(persist.mock.calls[1]![0]).toMatchObject({ isPartial: true });

      registerCleanupMock.mock.calls[0]![0]();

      expect(vi.getTimerCount()).toBe(0);
      expect(persist).toHaveBeenCalledTimes(3);
      expect(persist.mock.calls[2]![0]).not.toHaveProperty('isPartial');
      expect(persist.mock.calls.map(([record]) => record.startTime)).toEqual([
        new Date('2026-07-06T00:00:00Z'),
        new Date('2026-07-06T00:00:00Z'),
        new Date('2026-07-06T00:00:00Z'),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not append another partial snapshot when metrics are unchanged', () => {
    vi.useFakeTimers();
    const persist = vi.fn();
    try {
      startSessionUsageSnapshots(config, {
        getMetrics: () => makeSessionMetrics(1),
        persist,
      });

      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(persist).toHaveBeenCalledTimes(1);

      registerCleanupMock.mock.calls[0]![0]();
      expect(persist).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses snapshot errors during interval and cleanup flushes', () => {
    vi.useFakeTimers();
    const persist = vi.fn(() => {
      throw new Error('disk full');
    });
    try {
      startSessionUsageSnapshots(config, {
        getMetrics: () => makeSessionMetrics(1),
        persist,
      });

      expect(() => vi.advanceTimersByTime(5 * 60 * 1000)).not.toThrow();
      expect(() => registerCleanupMock.mock.calls[0]![0]()).not.toThrow();
      expect(persist).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses metrics lookup errors during interval and cleanup flushes', () => {
    vi.useFakeTimers();
    try {
      startSessionUsageSnapshots(config, {
        getMetrics: () => {
          throw new Error('metrics unavailable');
        },
      });

      expect(() => vi.advanceTimersByTime(5 * 60 * 1000)).not.toThrow();
      expect(() => registerCleanupMock.mock.calls[0]![0]()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
