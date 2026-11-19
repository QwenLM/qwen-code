/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Component, act, type ReactNode, type ComponentProps } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { DialogSizeProvider } from '../contexts/DialogSizeContext.js';
import type { Key } from '../hooks/useKeypress.js';
import { StatsDialog } from './StatsDialog.js';
import type { StatsData } from '../utils/statsDataService.js';

const { keys, activity } = vi.hoisted(() => ({
  keys: vi.fn(),
  activity: vi.fn(),
}));
vi.mock('../hooks/useKeypress.js', () => ({ useKeypress: keys }));
vi.mock('../contexts/ConfigContext.js', () => ({
  useConfig: () => ({ getProjectRoot: () => '/tmp' }),
}));
vi.mock('../contexts/SessionContext.js', () => ({
  useSessionStats: () => ({
    stats: {
      sessionId: 'sizing-test',
      sessionStartTime: new Date(0),
      metrics: { models: {} },
    },
  }),
}));
vi.mock('./StatsSessionTab.js', () => ({ SessionTab: () => null }));
vi.mock('./StatsActivityTab.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./StatsActivityTab.js')>();
  return {
    ...actual,
    ActivityTab: (props: ComponentProps<typeof actual.ActivityTab>) => {
      activity(props);
      return <actual.ActivityTab {...props} />;
    },
  };
});
vi.mock('../utils/statsDataService.js', () => ({
  loadStatsData: async (): Promise<StatsData> => ({
    report: {
      timeRange: 'all',
      periodStart: new Date(0),
      periodEnd: new Date(0),
      sessionCount: 1,
      totalDurationMs: 1000,
      totalLatencyMs: 10,
      totalRequests: 1,
      models: {},
      tools: { totalCalls: 0, totalSuccess: 0, totalFail: 0, topTools: [] },
      files: { linesAdded: 0, linesRemoved: 0 },
      skills: { totalCalls: 0, topSkills: [] },
      projects: [],
    },
    heatmap: {},
    currentStreak: 0,
    longestStreak: 0,
    tokensPerDay: [{ date: '2026-11-01', model: 'test', tokens: 10 }],
    delta: null,
    efficiency: { cacheHitRate: 0, toolSuccessRate: 0, avgLatencyMs: 10 },
    toolLeaderboard: [],
  }),
}));

class CaptureError extends Component<
  { children: ReactNode },
  { error: string }
> {
  override state = { error: '' };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  override render() {
    return this.state.error ? (
      <Text>RENDER_ERROR:{this.state.error}</Text>
    ) : (
      this.props.children
    );
  }
}

describe('Stats dialog review regression', () => {
  it('PR17541 R1-8 renders activity in a twelve-column dialog without crashing', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    try {
      const view = render(
        <CaptureError>
          <DialogSizeProvider value={{ columns: 12, rows: 20 }}>
            <StatsDialog onClose={vi.fn()} />
          </DialogSizeProvider>
        </CaptureError>,
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const handler = keys.mock.calls.at(-1)?.[0] as (key: Key) => void;
      await act(async () => {
        handler({ name: 'tab', shift: false } as Key);
      });
      expect(view.lastFrame()).not.toContain('RENDER_ERROR');
      expect(activity).toHaveBeenCalledWith(
        expect.objectContaining({
          bodyWidth: 6,
          data: expect.objectContaining({
            tokensPerDay: [{ date: '2026-11-01', model: 'test', tokens: 10 }],
          }),
        }),
      );
      view.unmount();
    } finally {
      consoleError.mockRestore();
    }
  });
});
