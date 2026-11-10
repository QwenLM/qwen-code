// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonSessionStatsStatus } from '@qwen-code/web-shell/daemon-react-sdk';
import { I18nProvider } from '../i18n';
import {
  ComposerUsageStats,
  formatCacheHitPercent,
  formatSpeed,
} from './ComposerUsageStats';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted.length = 0;
  vi.useRealTimers();
});

function stats(
  overrides: Partial<DaemonSessionStatsStatus> = {},
): DaemonSessionStatsStatus {
  return {
    v: 1,
    sessionId: 's-1',
    workspaceCwd: '/ws',
    sessionStartTimeMs: 1_000,
    durationMs: 60_000,
    promptCount: 2,
    models: {
      'qwen-plus': {
        api: { totalRequests: 30, totalErrors: 0, totalLatencyMs: 3_200 },
        tokens: {
          prompt: 4_000_000,
          candidates: 150_000,
          total: 4_150_000,
          cached: 3_684_000,
          thoughts: 20_000,
        },
        generation: {
          timedRequests: 30,
          totalTtftMs: 30_000,
          totalGenerationDurationMs: 4_000,
          totalThroughputOutputTokens: 100_000,
          totalTimedGenerationDurationMs: 4_000,
          totalOutputSpeedTokens: 130_000,
          totalOutputSpeedDurationMs: 5_000_000,
        },
      },
      'qwen-max': {
        api: { totalRequests: 5, totalErrors: 0, totalLatencyMs: 1_200 },
        tokens: {
          prompt: 200_000,
          candidates: 10_000,
          total: 210_000,
          cached: 180_000,
          thoughts: 0,
        },
        generation: {
          timedRequests: 5,
          totalTtftMs: 5_000,
          totalGenerationDurationMs: 1_000,
          totalThroughputOutputTokens: 10_000,
          totalTimedGenerationDurationMs: 1_000,
          totalOutputSpeedTokens: 10_000,
          totalOutputSpeedDurationMs: 380_000,
        },
      },
      // A model with no request is not part of the session's usage.
      unused: {
        api: { totalRequests: 0, totalErrors: 0, totalLatencyMs: 0 },
        tokens: {
          prompt: 9_999_999,
          candidates: 0,
          total: 9_999_999,
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
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferredStats() {
  let resolve!: (value: DaemonSessionStatsStatus) => void;
  const promise = new Promise<DaemonSessionStatsStatus>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function render(
  props: Partial<Parameters<typeof ComposerUsageStats>[0]> = {},
  language: 'en' | 'zh-CN' = 'en',
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const loadStats =
    props.loadStats ?? vi.fn(async (id: string) => stats({ sessionId: id }));
  const update = (next: Partial<Parameters<typeof ComposerUsageStats>[0]>) =>
    act(() => {
      root.render(
        <I18nProvider language={language}>
          <ComposerUsageStats
            sessionId="s-1"
            running={false}
            loadStats={loadStats}
            {...props}
            {...next}
          />
        </I18nProvider>,
      );
    });
  update({});
  return { container, loadStats, update };
}

describe('formatCacheHitPercent', () => {
  it('rounds to a whole percent and never shows 100 for a partial hit', () => {
    expect(formatCacheHitPercent(92, 100)).toBe('92');
    expect(formatCacheHitPercent(9_996, 10_000)).toBe('99.96');
    expect(formatCacheHitPercent(10_000, 10_000)).toBe('100');
    expect(formatCacheHitPercent(12_000, 10_000)).toBe('100');
    expect(formatCacheHitPercent(0, 10_000)).toBe('0');
    expect(formatCacheHitPercent(5, 0)).toBeUndefined();
  });
});

describe('formatSpeed', () => {
  it('drops decimals from 10 tok/s up', () => {
    expect(formatSpeed(26.4)).toBe('26');
    expect(formatSpeed(9.46)).toBe('9.5');
  });
});

describe('ComposerUsageStats', () => {
  it('shows turns, output speed, total tokens and cache hit for the session', async () => {
    const { container } = render();
    await flush();
    const button = container.querySelector('button')!;
    // 140,000 tok over 5,380 s; 3,864,000 of 4,200,000 input tokens cached.
    expect(button.textContent).toBe('2 turns·26 tok/s4.36M tok·92% cache hit');
    expect(button.getAttribute('title')).toBe(
      'Total 4.36M · Input 4.2M · Cache 3.86M · Output 160K',
    );
  });

  it('localizes the reading', async () => {
    const { container } = render({}, 'zh-CN');
    await flush();
    expect(container.textContent).toBe('2 轮·26 tok/s4.36M tok·缓存命中 92%');
  });

  it('renders nothing before the session has used tokens', async () => {
    const { container } = render({
      loadStats: vi.fn(async () =>
        stats({
          promptCount: 0,
          models: {},
        }),
      ),
    });
    await flush();
    expect(container.innerHTML).toBe('');
  });

  it('leaves out the speed when no request was timed', async () => {
    const base = stats();
    const { container } = render({
      loadStats: vi.fn(async () =>
        stats({
          models: {
            'qwen-plus': {
              ...base.models['qwen-plus'],
              generation: undefined,
            },
          },
        }),
      ),
    });
    await flush();
    expect(container.textContent).not.toContain('tok/s');
    expect(container.textContent).toContain('2 turns');
  });

  it('uses the generation-window rate from a daemon without full-request speed', async () => {
    const base = stats();
    const { container } = render({
      loadStats: vi.fn(async () =>
        stats({
          models: {
            'qwen-plus': {
              ...base.models['qwen-plus'],
              generation: {
                timedRequests: 30,
                totalTtftMs: 30_000,
                totalGenerationDurationMs: 4_000_000,
                totalThroughputOutputTokens: 100_000,
              },
            },
          },
        }),
      ),
    });
    await flush();
    expect(container.textContent).toContain('25 tok/s');
  });

  it('ignores a reading that belongs to another session', async () => {
    const { container } = render({
      loadStats: vi.fn(async () => stats({ sessionId: 'other' })),
    });
    await flush();
    expect(container.innerHTML).toBe('');
  });

  it('keeps the last reading when a refresh fails', async () => {
    vi.useFakeTimers();
    let fail = false;
    const loadStats = vi.fn(async (id: string) => {
      if (fail) throw new Error('offline');
      return stats({ sessionId: id });
    });
    const { container, update } = render({ loadStats });
    await flush();
    expect(container.textContent).toContain('2 turns');
    fail = true;
    update({ refreshSignal: 1 });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await flush();
    expect(loadStats).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('2 turns');
  });

  it('refreshes when usage changes, at most once a second', async () => {
    vi.useFakeTimers();
    const { loadStats, update } = render();
    await flush();
    expect(loadStats).toHaveBeenCalledTimes(1);
    update({ refreshSignal: 1 });
    update({ refreshSignal: 2 });
    await flush();
    expect(loadStats).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await flush();
    expect(loadStats).toHaveBeenCalledTimes(2);
  });

  it('polls only while the session is running', async () => {
    vi.useFakeTimers();
    const { loadStats, update } = render();
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(loadStats).toHaveBeenCalledTimes(1);
    update({ running: true });
    await flush();
    expect(loadStats).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    await flush();
    expect(loadStats).toHaveBeenCalledTimes(3);
    // Settling reads once more, after the minimum gap since the last poll.
    update({ running: false });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await flush();
    expect(loadStats).toHaveBeenCalledTimes(4);
    const settled = loadStats.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    await flush();
    expect(loadStats).toHaveBeenCalledTimes(settled);
  });

  it('clears the reading and reads again for a new session', async () => {
    let resolveSecond: (value: DaemonSessionStatsStatus) => void = () => {};
    const loadStats = vi.fn((id: string) =>
      id === 's-1'
        ? Promise.resolve(stats({ sessionId: id }))
        : new Promise<DaemonSessionStatsStatus>((resolve) => {
            resolveSecond = resolve;
          }),
    );
    const { container, update } = render({ loadStats });
    await flush();
    expect(container.textContent).toContain('2 turns');
    update({ sessionId: 's-2' });
    await flush();
    expect(loadStats).toHaveBeenLastCalledWith('s-2');
    expect(container.innerHTML).toBe('');
    resolveSecond(stats({ sessionId: 's-2', promptCount: 7 }));
    await flush();
    expect(container.textContent).toContain('7 turns');
  });

  it('reads a new session without waiting for the previous request', async () => {
    vi.useFakeTimers();
    const first = deferredStats();
    const second = deferredStats();
    const loadStats = vi
      .fn<(id: string) => Promise<DaemonSessionStatsStatus>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue(stats({ sessionId: 's-2', promptCount: 8 }));
    const { container, update } = render({ loadStats });
    await flush();
    update({ sessionId: 's-2' });
    await flush();
    expect(loadStats).toHaveBeenCalledTimes(2);
    expect(loadStats).toHaveBeenLastCalledWith('s-2');

    update({ sessionId: 's-2', refreshSignal: 1 });
    first.resolve(stats({ promptCount: 99 }));
    await flush();
    expect(container.innerHTML).toBe('');
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await flush();
    expect(loadStats).toHaveBeenCalledTimes(2);

    second.resolve(stats({ sessionId: 's-2', promptCount: 7 }));
    await flush();
    expect(loadStats).toHaveBeenCalledTimes(3);
    expect(loadStats).toHaveBeenLastCalledWith('s-2');
    expect(container.textContent).toContain('8 turns');
  });

  it('ignores an old request after switching away and back', async () => {
    const first = deferredStats();
    const latest = deferredStats();
    const loadStats = vi
      .fn<(id: string) => Promise<DaemonSessionStatsStatus>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(stats({ sessionId: 's-2' }))
      .mockReturnValueOnce(latest.promise);
    const { container, update } = render({ loadStats });
    await flush();
    update({ sessionId: 's-2' });
    await flush();
    update({ sessionId: 's-1' });
    await flush();
    expect(loadStats).toHaveBeenCalledTimes(3);

    latest.resolve(stats({ promptCount: 7 }));
    await flush();
    expect(container.textContent).toContain('7 turns');
    first.resolve(stats({ promptCount: 99 }));
    await flush();
    expect(container.textContent).toContain('7 turns');
    expect(container.textContent).not.toContain('99 turns');
    expect(loadStats).toHaveBeenCalledTimes(3);
  });

  it('reads nothing while the page is hidden and catches up when shown', async () => {
    let visibility: DocumentVisibilityState = 'hidden';
    const spy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => visibility);
    try {
      const { container, loadStats, update } = render({ running: true });
      update({ refreshSignal: 1 });
      await flush();
      expect(loadStats).not.toHaveBeenCalled();
      expect(container.innerHTML).toBe('');
      visibility = 'visible';
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await flush();
      expect(loadStats).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain('2 turns');
    } finally {
      spy.mockRestore();
    }
  });

  it('survives a loader that throws synchronously', async () => {
    const loadStats = vi.fn(() => {
      throw new Error('no route');
    });
    const { container, update } = render({ loadStats });
    await flush();
    expect(container.innerHTML).toBe('');
    vi.useFakeTimers();
    update({ refreshSignal: 1 });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await flush();
    expect(loadStats).toHaveBeenCalledTimes(2);
  });

  it('opens the token usage panel on click', async () => {
    const onOpen = vi.fn();
    const { container } = render({ onOpen });
    await flush();
    act(() => container.querySelector('button')!.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
