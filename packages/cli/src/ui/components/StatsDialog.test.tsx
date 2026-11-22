/** @vitest-environment jsdom */
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type React from 'react';
import type { SessionMetrics } from '@qwen-code/qwen-code-core';
import type { useSessionStats } from '../contexts/SessionContext.js';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  getLiveMetrics: vi.fn(),
  getRunStartTime: vi.fn(),
  stats: {} as ReturnType<typeof useSessionStats>,
}));

vi.mock('@qwen-code/qwen-code-core/telemetry/uiTelemetry.js', () => ({
  uiTelemetryService: {
    getLiveMetrics: mocks.getLiveMetrics,
    getRunStartTime: mocks.getRunStartTime,
  },
  getRequestExecutionIds: () => undefined,
}));
vi.mock('../utils/statsDataService.js', () => ({
  loadStatsData: mocks.load,
}));
vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));
vi.mock('ink', () => ({
  Box: ({ children }: React.PropsWithChildren) => children,
  Text: ({ children }: React.PropsWithChildren) => children,
}));
vi.mock('../contexts/SessionContext.js', () => ({
  useSessionStats: () => mocks.stats,
}));
vi.mock('../contexts/ConfigContext.js', () => ({
  useConfig: () => ({ getProjectRoot: () => '/project' }),
}));

import { buildCurrentSessionRecord, StatsDialog } from './StatsDialog.js';

const metrics = (requests: number, tokens: number): SessionMetrics =>
  ({
    models: {
      'qwen-max': {
        api: { totalRequests: requests, totalErrors: 0, totalLatencyMs: 10 },
        bySource: {},
        tokens: {
          prompt: tokens,
          candidates: 0,
          total: tokens,
          cached: 0,
          thoughts: 0,
        },
      },
    },
    tools: {
      totalCalls: 0,
      totalSuccess: 0,
      totalFail: 0,
      totalDurationMs: 0,
      byName: {},
    },
    files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
  }) as unknown as SessionMetrics;

describe('buildCurrentSessionRecord', () => {
  it('does not turn replayed history into a live run record', () => {
    expect(
      buildCurrentSessionRecord(
        'replay',
        new Date(1_000),
        '/project',
        metrics(0, 100_000),
      ),
    ).toBeUndefined();
  });

  it('marks a skills-only run without inventing model tokens', () => {
    const live = metrics(0, 0);
    live.skills = {
      totalCalls: 1,
      totalSuccess: 1,
      totalFail: 0,
      byName: { review: { count: 1, success: 1, fail: 0 } },
    };

    const record = buildCurrentSessionRecord(
      'skills-only',
      new Date(1_000),
      '/project',
      live,
    );

    expect(record?.runScoped).toBe(true);
    expect(record?.skills?.totalCalls).toBe(1);
    expect(record?.models['qwen-max']?.totalTokens).toBe(0);
  });

  it('marks the live run and its independent start time', () => {
    const start = new Date(1_000);
    const record = buildCurrentSessionRecord(
      'live',
      start,
      '/project',
      metrics(1, 7),
    );

    expect(record?.runScoped).toBe(true);
    expect(record?.startTime).toBe(1_000);
    expect(record?.models['qwen-max']?.totalTokens).toBe(7);
    expect(record?.timestamp).toBeGreaterThanOrEqual(start.getTime());
  });
});

describe('StatsDialog data loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stats = {
      stats: {
        sessionId: 'resumed',
        sessionStartTime: new Date(1_000),
        lastPromptTokenCount: 0,
        promptCount: 1,
        userPromptCount: 1,
        metrics: metrics(0, 100_000),
      },
      startNewSession: vi.fn(),
      startNewPrompt: vi.fn(),
      recordUserPrompt: vi.fn(),
      getPromptCount: vi.fn(() => 1),
      seedPromptCount: vi.fn(),
    };
    mocks.getLiveMetrics.mockReturnValue(metrics(1, 7));
    mocks.getRunStartTime.mockReturnValue(new Date(2_000));
    mocks.load.mockImplementation(() => new Promise(() => {}));
  });

  it('loads the live run, not replayed display metrics or session time', async () => {
    const { unmount } = renderHook(() => StatsDialog({ onClose: () => {} }));
    try {
      await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1));

      expect(mocks.load).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          runScoped: true,
          startTime: 2_000,
          models: {
            'qwen-max': expect.objectContaining({ totalTokens: 7 }),
          },
        }),
        'resumed',
        '/project',
      );
    } finally {
      unmount();
    }
  });
});
