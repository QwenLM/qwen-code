/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatsData } from '../utils/statsDataService.js';
import { buildHeatmapData } from '../utils/asciiCharts.js';
import { StatsHistory, statsMonths } from './StatsHistory.js';
import { OpenTuiStatsDialog } from './dialogs-stats-skills.js';
import { catalogKey } from '../../test-utils/opentui-catalog.js';
import { setLanguageAsync } from '../../i18n/index.js';

const mock = vi.hoisted(() => ({
  keys: [] as Array<(key: unknown) => void>,
  paste: [] as Array<(key: unknown) => void>,
  range: 'all',
  width: 120,
  height: 42,
  layouts: [] as Array<{ type: string; props: Record<string, unknown> }>,
  loading: false,
  error: undefined as string | undefined,
  data: undefined as StatsData | undefined,
}));
vi.mock('@opentui/react', async () => ({
  ...(await import('../../test-utils/opentui-catalog.js')).catalogHooks(
    mock.keys,
    mock.paste,
    () => ({ width: mock.width, height: mock.height }),
  ),
  useRenderer: () => ({
    addInputHandler: vi.fn(),
    removeInputHandler: vi.fn(),
  }),
}));
vi.mock(
  '@opentui/core',
  async () =>
    (await import('../../test-utils/opentui-catalog.js')).catalogNativeCore,
);
const captureRuntime = vi.hoisted(() => async () => {
  const runtime = (
    await import('../../test-utils/opentui-catalog.js')
  ).catalogRuntime();
  const jsx = (...args: Parameters<typeof runtime.jsx>) => {
    const [type, props] = args;
    if (typeof type === 'string' && props) mock.layouts.push({ type, props });
    return runtime.jsx(...args);
  };
  return { ...runtime, jsx, jsxs: jsx, jsxDEV: jsx };
});
vi.mock('@opentui/react/jsx-runtime', () => captureRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => captureRuntime());
vi.mock('./use-stats-history.js', () => ({
  useStatsHistory: (_config: unknown, _stats: unknown, range: string) => {
    mock.range = range;
    return { data: mock.data, loading: mock.loading, error: mock.error };
  },
}));

function report(): StatsData {
  return {
    report: {
      timeRange: 'all',
      periodStart: new Date(0),
      periodEnd: new Date(),
      sessionCount: 4,
      totalDurationMs: 900000,
      totalLatencyMs: 49000,
      totalRequests: 15,
      models: {
        alpha: {
          requests: 5,
          inputTokens: 555,
          outputTokens: 85,
          cachedTokens: 0,
          thoughtsTokens: 0,
          totalTokens: 640,
          totalLatencyMs: 13000,
        },
        beta: {
          requests: 10,
          inputTokens: 1110,
          outputTokens: 170,
          cachedTokens: 555,
          thoughtsTokens: 0,
          totalTokens: 1280,
          totalLatencyMs: 36000,
        },
      },
      tools: { totalCalls: 15, totalSuccess: 15, totalFail: 0, topTools: [] },
      files: { linesAdded: 30, linesRemoved: 15 },
      skills: { totalCalls: 0, topSkills: [] },
      projects: [
        {
          path: '/owned/p0',
          sessionCount: 2,
          totalTokens: 640,
          totalDurationMs: 300000,
        },
        {
          path: '/owned/p1',
          sessionCount: 2,
          totalTokens: 1280,
          totalDurationMs: 600000,
        },
      ],
    },
    heatmap: { '2026-09-16': 1024, '2026-11-15': 896 },
    currentStreak: 1,
    longestStreak: 2,
    tokensPerDay: [
      { date: '2026-09-16', model: 'alpha', tokens: 1024 },
      { date: '2026-11-15', model: 'beta', tokens: 896 },
    ],
    delta: null,
    efficiency: {
      cacheHitRate: 33.333,
      toolSuccessRate: 100,
      avgLatencyMs: 49000 / 15,
    },
    toolLeaderboard: [
      {
        name: 'owned-tool',
        count: 15,
        totalDurationMs: 15000,
        successRate: 100,
      },
    ],
  };
}
function press(name: string, shift = false) {
  for (const handler of [...mock.keys])
    handler({ ...catalogKey(name, name === 'tab' ? '\t' : name), shift });
}

afterEach(cleanup);
beforeEach(() => {
  mock.width = 120;
  mock.height = 42;
  mock.layouts.length = 0;
  mock.keys.length = 0;
  mock.paste.length = 0;
  mock.data = report();
  mock.loading = false;
  mock.error = undefined;
});

describe('native historical statistics', () => {
  it('shows history totals, project totals and actual available months', () => {
    const data = report();
    expect(statsMonths(data)).toEqual(['2026-11', '2026-09']);
    const view = render(
      <StatsHistory
        data={data}
        tab="activity"
        range="all"
        monthOffset={0}
        width={110}
      />,
    );
    const text = view.container.textContent;
    expect(text).toContain('Sessions 4');
    expect(text).toContain('Duration 15m');
    expect(text).toContain('Tokens 1.9k');
    expect(text).toContain('Token Trend  ← Nov 2026');
    expect(text).toContain('p0  2  640  5m');
    expect(text).toContain('p1  2  1.3k  10m');
    view.rerender(
      <StatsHistory
        data={data}
        tab="activity"
        range="all"
        monthOffset={99}
        width={30}
      />,
    );
    expect(view.container.textContent).toContain('Token Trend  Sep 2026 →');
  });

  it('shows independent weighted top/model latencies, tools and code impact', () => {
    const view = render(
      <StatsHistory
        data={report()}
        tab="efficiency"
        range="all"
        monthOffset={0}
        width={110}
      />,
    );
    const text = view.container.textContent;
    expect(text).toContain('Avg Latency 3.3s');
    expect(text).toContain('alpha  5  555/85  0  0%  2.6s');
    expect(text).toContain('beta  10  1.1k/170  0  50%  3.6s');
    expect(text).toContain('owned-tool  15  15.0s  100%');
    expect(text).toContain('Code Impact +30 / -15 (+15)');
  });

  it('sanitizes persisted control sequences without dropping readable names', () => {
    const data = report();
    data.toolLeaderboard[0]!.name = 'owned\x1b[2J-tool';
    const view = render(
      <StatsHistory
        data={data}
        tab="efficiency"
        range="today"
        monthOffset={0}
        width={20}
      />,
    );
    expect(view.container.textContent).toContain('owned');
    expect(view.container.textContent).toContain('-tool');
    expect(view.container.textContent).not.toContain('\x1b');
  });

  it('cycles range and tabs within one keyboard batch and clamps months', () => {
    const view = render(<OpenTuiStatsDialog config={null} onClose={vi.fn()} />);
    act(() => {
      press('tab');
      press('h');
      press('h');
    });
    expect(view.container.textContent).toContain('Sep 2026');
    act(() => {
      press('l');
      press('l');
      press('r');
      press('r');
    });
    expect(mock.range).toBe('week');
    act(() => {
      press('tab');
    });
    expect(view.container.textContent).toContain('Avg Latency 3.3s');
    act(() => {
      press('tab', true);
    });
    expect(view.container.textContent).toContain('Token Trend');
  });

  it.each([
    [120, 40, 27, 25],
    [80, 18, 5, 3],
    [40, 18, 8, 7],
    [20, 15, 3, 2],
    [40, 12, 2, 1],
  ])(
    'declares bounded Stats body rows at %ix%i',
    (width, height, sessionRows, historyRows) => {
      mock.width = width;
      mock.height = height;
      const view = render(
        <OpenTuiStatsDialog
          config={null}
          onClose={vi.fn()}
          availableTerminalHeight={height - 5}
        />,
      );
      const body = () =>
        mock.layouts.findLast((node) => node.type === 'scrollbox')!.props;
      const frame = mock.layouts.findLast(
        (node) => node.type === 'box' && node.props['border'] === true,
      )!.props;
      expect(body()['height']).toBe(sessionRows);
      expect(
        (body()['contentOptions'] as { paddingRight: number }).paddingRight,
      ).toBe(width < 80 ? 0 : 1);
      expect(frame['paddingTop']).toBe(width < 80 ? 0 : 1);
      expect(view.container.textContent).toContain('Session ID:');
      act(() => {
        press('tab');
      });
      expect(body()['height']).toBe(historyRows);
      expect(view.container.textContent).toContain('Activity');
      expect(view.container.textContent).toContain('All time');
      act(() => {
        press('tab');
      });
      expect(body()['height']).toBe(historyRows);
      expect(view.container.textContent).toContain('Efficiency');
      expect(view.container.textContent).toContain('PgUp/PgDn');
    },
  );

  it('keeps compact chrome independent of the scrollbar viewport width', () => {
    mock.width = 120;
    mock.height = 18;
    render(
      <OpenTuiStatsDialog
        config={null}
        onClose={vi.fn()}
        availableTerminalHeight={13}
      />,
    );
    const initialFrame = mock.layouts.findLast(
      (node) => node.type === 'box' && node.props['border'] === true,
    )!.props;
    const frameRef = initialFrame['ref'] as (node: unknown) => void;
    const frameResize = initialFrame['onSizeChange'] as () => void;
    frameRef({ width: 36 });
    act(() => {
      frameResize();
    });
    const scrollProps = mock.layouts.findLast(
      (node) => node.type === 'scrollbox',
    )!.props;
    const ref = scrollProps['ref'] as (node: unknown) => void;
    const resize = scrollProps['onSizeChange'] as () => void;
    const viewport = { width: 29 };
    ref({ viewport, scrollTo: vi.fn() });
    act(() => {
      resize();
    });
    viewport.width = 30;
    act(() => {
      resize();
    });
    const frame = mock.layouts.findLast(
      (node) => node.type === 'box' && node.props['border'] === true,
    )!.props;
    expect(frame['paddingTop']).toBe(0);
    expect(frame['paddingLeft']).toBe(1);
    expect(
      mock.layouts.findLast((node) => node.type === 'scrollbox')!.props[
        'height'
      ],
    ).toBe(8);
  });

  it('leaves Settings-owned keys alone and exposes loading and failure states', () => {
    mock.loading = true;
    const view = render(
      <OpenTuiStatsDialog config={null} isFocused={false} onClose={vi.fn()} />,
    );
    act(() => {
      press('tab');
      press('r');
    });
    expect(mock.range).toBe('all');
    expect(view.container.textContent).toContain('Interaction Summary');
    view.rerender(<OpenTuiStatsDialog config={null} onClose={vi.fn()} />);
    act(() => {
      press('tab');
    });
    expect(view.container.textContent).toContain('Loading stats');
    mock.loading = false;
    mock.error = 'Failed to load stats. Press r to retry.';
    view.rerender(<OpenTuiStatsDialog config={null} onClose={vi.fn()} />);
    expect(view.container.textContent).toContain('Failed to load stats');
    view.rerender(
      <OpenTuiStatsDialog config={null} isFocused={false} onClose={vi.fn()} />,
    );
    expect(view.container.textContent).not.toContain('PgUp/PgDn');
  });

  it('aligns heatmap cells under the axis labels like the ink view', () => {
    const data = report();
    const width = 110;
    const view = render(
      <StatsHistory
        data={data}
        tab="activity"
        range="all"
        monthOffset={0}
        width={width}
      />,
    );
    const heatmap = buildHeatmapData(
      data.heatmap,
      Math.max(1, Math.min(26, Math.floor((width - 4) / 2))),
      0,
    );
    const monRow = [...view.container.querySelectorAll('span')]
      .map((node) => node.textContent ?? '')
      .find((text) => text.startsWith('Mon'))!;
    expect(monRow.slice(0, 4)).toBe('Mon ');
    expect(monRow.slice(4, 6)).toBe(heatmap.rows[0]!.cells[0]!.char);
    expect(monRow.length).toBe(4 + 2 * heatmap.totalCols);
    let axis = '';
    for (const label of heatmap.colLabels) {
      axis = axis.padEnd(label.col * 2) + label.text;
    }
    const axisRow = [...view.container.querySelectorAll('span')]
      .map((node) => node.textContent ?? '')
      .find((text) => text.endsWith(axis))!;
    expect(axisRow).toBe(' '.repeat(heatmap.rows[0]!.label.length) + axis);
  });

  it('hides the Projects block on an empty report', () => {
    const data = report();
    data.report.projects = [];
    const view = render(
      <StatsHistory
        data={data}
        tab="activity"
        range="all"
        monthOffset={0}
        width={110}
      />,
    );
    const text = view.container.textContent;
    expect(text).not.toContain('Projects');
    expect(text).not.toContain('Project  Sessions');
  });

  it('hides the key hint and reclaims its rows while the host owns the keys', () => {
    mock.width = 120;
    mock.height = 40;
    const view = render(
      <OpenTuiStatsDialog
        config={null}
        onClose={vi.fn()}
        availableTerminalHeight={35}
      />,
    );
    act(() => {
      press('tab');
    });
    const body = () =>
      mock.layouts.findLast((node) => node.type === 'scrollbox')!.props;
    expect(view.container.textContent).toContain('PgUp/PgDn');
    expect(body()['height']).toBe(25);
    view.rerender(
      <OpenTuiStatsDialog
        config={null}
        isFocused={false}
        onClose={vi.fn()}
        availableTerminalHeight={35}
      />,
    );
    expect(view.container.textContent).not.toContain('PgUp/PgDn');
    expect(view.container.textContent).not.toContain('r dates');
    expect(body()['height']).toBe(27);
  });

  it('pages the history body by its declared height and resets scroll on navigation', () => {
    mock.width = 120;
    mock.height = 40;
    render(
      <OpenTuiStatsDialog
        config={null}
        onClose={vi.fn()}
        availableTerminalHeight={35}
      />,
    );
    const scrollProps = mock.layouts.findLast(
      (node) => node.type === 'scrollbox',
    )!.props;
    const ref = scrollProps['ref'] as (node: unknown) => void;
    const scrollTo = vi.fn();
    const scrollBy = vi.fn();
    ref({ viewport: { width: 113 }, scrollTo, scrollBy });
    act(() => {
      press('tab');
    });
    expect(scrollTo).toHaveBeenCalledWith(0);
    scrollTo.mockClear();
    act(() => {
      press('pagedown');
    });
    expect(scrollBy).toHaveBeenLastCalledWith(25);
    act(() => {
      press('pageup');
    });
    expect(scrollBy).toHaveBeenLastCalledWith(-25);
    act(() => {
      press('h');
    });
    expect(scrollTo).toHaveBeenCalledWith(0);
    scrollTo.mockClear();
    act(() => {
      press('r');
    });
    expect(scrollTo).toHaveBeenCalledWith(0);
  });

  it('keeps the paged month while a reload is in flight', () => {
    const view = render(<OpenTuiStatsDialog config={null} onClose={vi.fn()} />);
    act(() => {
      press('tab');
      press('h');
      press('h');
    });
    expect(view.container.textContent).toContain('Sep 2026');
    mock.data = undefined;
    mock.loading = true;
    view.rerender(<OpenTuiStatsDialog config={null} onClose={vi.fn()} />);
    act(() => {
      press('h');
    });
    mock.data = report();
    mock.loading = false;
    view.rerender(<OpenTuiStatsDialog config={null} onClose={vi.fn()} />);
    expect(view.container.textContent).toContain('Sep 2026');
  });

  it('marks the selected tab for the screen reader on per-tab text nodes', () => {
    render(<OpenTuiStatsDialog config={null} onClose={vi.fn()} />);
    const tabIds = () =>
      mock.layouts
        .filter(
          (node) =>
            node.type === 'text' &&
            String(node.props['id'] ?? '').endsWith('-tab'),
        )
        .slice(-3)
        .map((node) => node.props['id']);
    expect(tabIds()).toEqual([
      'screen-reader-selected-tab',
      'screen-reader-unselected-tab',
      'screen-reader-unselected-tab',
    ]);
    act(() => {
      press('tab');
    });
    expect(tabIds()).toEqual([
      'screen-reader-unselected-tab',
      'screen-reader-selected-tab',
      'screen-reader-unselected-tab',
    ]);
  });

  it('marks the compact header as the selected tab for the screen reader', () => {
    mock.width = 20;
    mock.height = 15;
    render(<OpenTuiStatsDialog config={null} onClose={vi.fn()} />);
    const compactTabs = mock.layouts.filter(
      (node) =>
        node.type === 'text' && String(node.props['id'] ?? '').endsWith('-tab'),
    );
    expect(compactTabs.length).toBeGreaterThan(0);
    expect(
      compactTabs.every(
        (node) => node.props['id'] === 'screen-reader-selected-tab',
      ),
    ).toBe(true);
  });

  it('resets the paged month when the range changes its window', () => {
    const view = render(<OpenTuiStatsDialog config={null} onClose={vi.fn()} />);
    const heatmapWindow = () =>
      /Activity Heatmap {2}\w+ \d+, \d{4} - \w+ \d+, \d{4}/.exec(
        view.container.textContent ?? '',
      )![0];
    act(() => {
      press('tab');
    });
    const current = heatmapWindow();
    act(() => {
      press('h');
    });
    expect(view.container.textContent).toContain('Sep 2026');
    expect(heatmapWindow()).not.toBe(current);
    act(() => {
      press('r');
    });
    expect(heatmapWindow()).toBe(current);
  });

  it('resets the paged month inside a held-key range burst', () => {
    // One act() is one held-key burst: no re-render resyncs monthRef between
    // keys, so the reset must come from the range branch's ref write. Three
    // months keep the clamp from hiding a stale offset.
    const data = report();
    data.heatmap['2026-10-16'] = 512;
    data.tokensPerDay.push({ date: '2026-10-16', model: 'alpha', tokens: 512 });
    mock.data = data;
    const view = render(<OpenTuiStatsDialog config={null} onClose={vi.fn()} />);
    act(() => {
      press('tab');
      press('h');
      press('h');
    });
    expect(view.container.textContent).toContain('Sep 2026');
    act(() => {
      press('r');
      press('r');
      press('r');
      press('r');
      press('h');
    });
    expect(mock.range).toBe('all');
    expect(view.container.textContent).toContain('Oct 2026');
  });

  it('pages months with the arrow keys the hint advertises', () => {
    const view = render(<OpenTuiStatsDialog config={null} onClose={vi.fn()} />);
    const trend = () =>
      /Token Trend {2}(?:← )?\w+ \d{4}(?: →)?/.exec(
        view.container.textContent ?? '',
      )![0];
    act(() => {
      press('tab');
      press('left');
      press('left');
    });
    expect(view.container.textContent).toContain('←→ month');
    expect(trend()).toBe('Token Trend  Sep 2026 →');
    act(() => {
      press('right');
      press('right');
    });
    expect(trend()).toBe('Token Trend  ← Nov 2026');
  });

  it('localizes the chart peak and the project overflow counter', async () => {
    const data = report();
    data.report.projects = Array.from({ length: 6 }, (_, index) => ({
      path: `/owned/p${index}`,
      sessionCount: 1,
      totalTokens: 100,
      totalDurationMs: 1000,
    }));
    await setLanguageAsync('zh');
    try {
      const view = render(
        <StatsHistory
          data={data}
          tab="activity"
          range="all"
          monthOffset={0}
          width={110}
        />,
      );
      const text = view.container.textContent;
      expect(text).toContain('峰值');
      expect(text).toContain('+1 个');
    } finally {
      await setLanguageAsync('en');
    }
  });
});
