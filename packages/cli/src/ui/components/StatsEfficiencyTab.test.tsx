/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { EfficiencyTab } from './StatsEfficiencyTab.js';
import type { StatsData } from '../utils/statsDataService.js';
import { DEFAULT_THEME, themeManager } from '../themes/theme-manager.js';

const originalNoColor = process.env['NO_COLOR'];

beforeEach(() => {
  // Disable color so assertions match the raw label text.
  process.env['NO_COLOR'] = '1';
});

afterEach(() => {
  if (originalNoColor === undefined) {
    delete process.env['NO_COLOR'];
  } else {
    process.env['NO_COLOR'] = originalNoColor;
  }
  themeManager.setActiveTheme(DEFAULT_THEME.name);
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

describe('EfficiencyTab model table capping', () => {
  it('lists only the top N models and collapses the rest into a "+N more" line', () => {
    const { lastFrame } = render(
      <EfficiencyTab data={makeData()} bodyWidth={80} maxModelRows={2} />,
    );
    const frame = lastFrame() ?? '';

    // Top two by token count are shown.
    expect(frame).toContain('alpha-model');
    expect(frame).toContain('beta-model');
    // The remaining three are hidden.
    expect(frame).not.toContain('gamma-model');
    expect(frame).not.toContain('delta-model');
    expect(frame).not.toContain('epsilon-model');
    // ...and summarized by the overflow line.
    expect(frame).toContain('+3 more');
    expect(frame).toContain('run /stats for the full list');
  });

  it('lists every model and shows no overflow line when maxModelRows is unset', () => {
    const { lastFrame } = render(
      <EfficiencyTab data={makeData()} bodyWidth={80} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('alpha-model');
    expect(frame).toContain('epsilon-model');
    expect(frame).not.toContain('more (run /stats');
  });
});
