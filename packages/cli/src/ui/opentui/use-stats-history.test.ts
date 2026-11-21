// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { uiTelemetryService } from '@qwen-code/qwen-code-core/telemetry/uiTelemetry.js';
import type { TimeRange } from '@qwen-code/qwen-code-core/services/usageHistoryService.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import { loadStatsData, type StatsData } from '../utils/statsDataService.js';
import { useStatsHistory } from './use-stats-history.js';

vi.mock('../utils/statsDataService.js', () => ({ loadStatsData: vi.fn() }));
const load = vi.mocked(loadStatsData);
function fixture(session = 'A') {
  const state = { session, project: '/owned/project' };
  const config = {
    getSessionId: () => state.session,
    getProjectRoot: () => state.project,
  } as unknown as Config;
  const stats: SessionStatsState = {
    sessionId: session,
    sessionStartTime: new Date('2026-11-15T00:00:00Z'),
    metrics: uiTelemetryService.getMetricsForSession(`stats-test-${session}`),
    lastPromptTokenCount: 0,
    promptCount: 0,
    userPromptCount: 0,
  };
  return { state, config, stats };
}
function deferred() {
  let resolve!: (data: StatsData) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<StatsData>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const data = { report: { sessionCount: 4 } } as StatsData;
const newer = { report: { sessionCount: 1 } } as StatsData;

afterEach(cleanup);

describe('useStatsHistory', () => {
  beforeEach(() => {
    load.mockReset();
  });

  it('excludes a zero-model live session and keeps disk loads off telemetry ticks', async () => {
    load.mockResolvedValue(data);
    const f = fixture();
    const view = renderHook(
      ({ stats }) => useStatsHistory(f.config, stats, 'all'),
      {
        initialProps: { stats: f.stats },
      },
    );
    await act(async () => {});
    expect(load).toHaveBeenCalledWith('all', undefined);
    expect(view.result.current.data).toBe(data);
    view.rerender({ stats: { ...f.stats, promptCount: 1 } });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('projects the selected session with independent per-model latency', async () => {
    load.mockResolvedValue(data);
    const f = fixture();
    f.stats.metrics.models = {
      alpha: {
        api: { totalRequests: 2, totalErrors: 0, totalLatencyMs: 7000 },
        tokens: {
          prompt: 100,
          candidates: 20,
          cached: 40,
          thoughts: 3,
          total: 123,
        },
        bySource: {},
      },
      beta: {
        api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 11000 },
        tokens: {
          prompt: 50,
          candidates: 10,
          cached: 0,
          thoughts: 0,
          total: 60,
        },
        bySource: {},
      },
    };
    renderHook(() => useStatsHistory(f.config, f.stats, 'week'));
    await act(async () => {});
    expect(load.mock.calls[0]?.[1]).toMatchObject({
      sessionId: 'A',
      project: '/owned/project',
      totalLatencyMs: 18000,
      models: {
        alpha: { totalLatencyMs: 7000 },
        beta: { totalLatencyMs: 11000 },
      },
    });
  });

  it.each(['success', 'failure'])(
    'ignores late range %s after the newer report',
    async (outcome) => {
      const old = deferred();
      load.mockReturnValueOnce(old.promise).mockResolvedValueOnce(newer);
      const f = fixture();
      const view = renderHook(
        ({ range }) => useStatsHistory(f.config, f.stats, range),
        {
          initialProps: { range: 'all' as TimeRange },
        },
      );
      view.rerender({ range: 'today' });
      await act(async () => {});
      await act(async () => {
        if (outcome === 'success') old.resolve(data);
        else old.reject(new Error('old'));
      });
      expect(view.result.current.data).toBe(newer);
      expect(view.result.current.error).toBeUndefined();
    },
  );

  it('does not reuse an already loaded A report after a range A→B→A', async () => {
    load.mockResolvedValueOnce(data);
    const f = fixture();
    const view = renderHook(
      ({ range }) => useStatsHistory(f.config, f.stats, range),
      {
        initialProps: { range: 'all' as TimeRange },
      },
    );
    await act(async () => {});
    const oldB = deferred();
    const newA = deferred();
    load.mockReturnValueOnce(oldB.promise).mockReturnValueOnce(newA.promise);
    view.rerender({ range: 'month' });
    view.rerender({ range: 'all' });
    expect(view.result.current.data).toBeUndefined();
    expect(view.result.current.loading).toBe(true);
    await act(async () => {
      oldB.resolve(data);
      newA.resolve(newer);
    });
    expect(view.result.current.data).toBe(newer);
  });

  it('permanently revokes a getter mismatch even when the getter returns to A', async () => {
    const old = deferred();
    load.mockReturnValue(old.promise);
    const f = fixture();
    const view = renderHook(() => useStatsHistory(f.config, f.stats, 'all'));
    f.state.session = 'B';
    await act(async () => {
      old.resolve(data);
    });
    f.state.session = 'A';
    view.rerender();
    expect(view.result.current.data).toBeUndefined();
    expect(view.result.current.error).toContain('unavailable');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('allows a real replacement owner without accepting the former response', async () => {
    const old = deferred();
    load.mockReturnValueOnce(old.promise).mockResolvedValueOnce(newer);
    const a = fixture('A');
    const b = fixture('B');
    const view = renderHook(
      ({ owner }) => useStatsHistory(owner.config, owner.stats, 'all'),
      {
        initialProps: { owner: a },
      },
    );
    view.rerender({ owner: b });
    await act(async () => {
      old.resolve(data);
    });
    expect(view.result.current.data).toBe(newer);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not load an unknown or mismatched snapshot', () => {
    const f = fixture();
    renderHook(() => useStatsHistory(undefined, f.stats, 'all'));
    renderHook(() =>
      useStatsHistory(f.config, { ...f.stats, sessionId: 'other' }, 'all'),
    );
    expect(load).not.toHaveBeenCalled();
  });

  it('settles a load error and reloads on a new range', async () => {
    load.mockRejectedValueOnce(new Error('read')).mockResolvedValueOnce(data);
    const f = fixture();
    const view = renderHook(
      ({ range }) => useStatsHistory(f.config, f.stats, range),
      {
        initialProps: { range: 'all' as TimeRange },
      },
    );
    await act(async () => {});
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.error).toContain('Failed to load stats');
    view.rerender({ range: 'month' });
    await act(async () => {});
    expect(view.result.current.data).toBe(data);
  });

  it('discards an in-flight load when the snapshot turns invalid mid-load', async () => {
    const old = deferred();
    const reload = deferred();
    load.mockReturnValueOnce(old.promise).mockReturnValueOnce(reload.promise);
    const f = fixture();
    const view = renderHook(
      ({ stats }) => useStatsHistory(f.config, stats, 'all'),
      { initialProps: { stats: f.stats } },
    );
    view.rerender({ stats: { ...f.stats, sessionId: 'other' } });
    await act(async () => {
      old.resolve(data);
    });
    view.rerender({ stats: f.stats });
    expect(view.result.current.data).toBeUndefined();
    expect(view.result.current.loading).toBe(true);
    await act(async () => {
      reload.resolve(newer);
    });
    expect(view.result.current.data).toBe(newer);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
