/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMetrics } from '../contexts/SessionContext.js';
import type { StatsData } from '../utils/statsDataService.js';
import { StatsDialog } from './StatsDialog.js';
import { DEFAULT_THEME, themeManager } from '../themes/theme-manager.js';

type KeypressTestKey = { name: string };
const keypressSubscribers = new Set<(key: KeypressTestKey) => void>();

vi.mock('../contexts/KeypressContext.js', () => ({
  useKeypressContext: () => ({
    subscribe: (handler: (key: KeypressTestKey) => void) => {
      keypressSubscribers.add(handler);
    },
    unsubscribe: (handler: (key: KeypressTestKey) => void) => {
      keypressSubscribers.delete(handler);
    },
  }),
}));

vi.mock('../contexts/ConfigContext.js', () => ({
  useConfig: () => ({ getProjectRoot: () => '/tmp/project' }),
}));

vi.mock('../contexts/SessionContext.js', () => ({
  useSessionStats: () => ({
    stats: {
      sessionId: 'session-1',
      sessionStartTime: new Date(0),
      metrics: {
        models: {},
        tools: {
          totalCalls: 0,
          totalSuccess: 0,
          totalFail: 0,
          totalDurationMs: 0,
          totalDecisions: { accept: 0, reject: 0, modify: 0, auto_accept: 0 },
          byName: {},
        },
        files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
      } as SessionMetrics,
      lastPromptTokenCount: 0,
      promptCount: 0,
    },
    getPromptCount: () => 0,
    startNewPrompt: vi.fn(),
    seedPromptCount: vi.fn(),
  }),
}));

const loadStatsDataMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/statsDataService.js', () => ({
  loadStatsData: loadStatsDataMock,
}));

function sendKey(key: KeypressTestKey) {
  act(() => {
    for (const handler of keypressSubscribers) {
      handler(key);
    }
  });
}

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

beforeEach(() => {
  process.env['NO_COLOR'] = '1';
});

afterEach(() => {
  delete process.env['NO_COLOR'];
  themeManager.setActiveTheme(DEFAULT_THEME.name);
  loadStatsDataMock.mockReset();
});

const modelEntry = (totalTokens: number) => ({
  requests: 10,
  inputTokens: Math.round(totalTokens * 0.6),
  outputTokens: Math.round(totalTokens * 0.3),
  cachedTokens: Math.round(totalTokens * 0.1),
  thoughtsTokens: 0,
  totalTokens,
  totalLatencyMs: 5000,
});

// Five models with descending token totals, so sort order is deterministic.
const makeData = (): StatsData => ({
  report: {
    timeRange: 'all',
    periodStart: new Date(0),
    periodEnd: new Date(0),
    sessionCount: 1,
    totalDurationMs: 1000,
    totalLatencyMs: 5000,
    totalRequests: 50,
    models: {
      'alpha-model': modelEntry(50000),
      'beta-model': modelEntry(40000),
      'gamma-model': modelEntry(30000),
      'delta-model': modelEntry(20000),
      'epsilon-model': modelEntry(10000),
    },
    tools: { totalCalls: 0, totalSuccess: 0, totalFail: 0, topTools: [] },
    files: { linesAdded: 0, linesRemoved: 0 },
    skills: { totalCalls: 0, topSkills: [] },
    projects: [],
  },
  heatmap: {},
  currentStreak: 0,
  longestStreak: 0,
  tokensPerDay: [],
  delta: null,
  efficiency: { cacheHitRate: 50, toolSuccessRate: 90, avgLatencyMs: 500 },
  toolLeaderboard: [],
});

const makeToolData = (): StatsData => ({
  ...makeData(),
  toolLeaderboard: [
    { name: 'grep', count: 60, totalDurationMs: 1000, successRate: 100 },
    { name: 'glob', count: 50, totalDurationMs: 1000, successRate: 100 },
    { name: 'bash', count: 40, totalDurationMs: 1000, successRate: 90 },
    { name: 'edit', count: 30, totalDurationMs: 1000, successRate: 80 },
    { name: 'write', count: 20, totalDurationMs: 1000, successRate: 70 },
    { name: 'read', count: 10, totalDurationMs: 1000, successRate: 60 },
  ],
});

describe('<StatsDialog /> height props', () => {
  it('lists every tool on the Efficiency tab when only sessionAvailableHeight is set', async () => {
    loadStatsDataMock.mockResolvedValue(makeToolData());
    const { lastFrame } = render(
      <StatsDialog onClose={vi.fn()} sessionAvailableHeight={20} />,
    );
    await flush();
    sendKey({ name: 'tab' });
    sendKey({ name: 'tab' });
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('read');
    expect(frame).not.toContain('more (run /stats');
    expect(frame).not.toContain('(Tab to switch)');
  });
});
