/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { StreamingState } from './types.js';
import {
  aggregateModelTokens,
  buildStatusLinePresetData,
  buildStatusLinePresetLines,
  DEFAULT_STATUS_LINE_PRESET_CONFIG,
  formatTokenCount,
  getRunStateLabel,
  inferPullRequestNumber,
  normalizeStatusLinePresetConfig,
  orderStatusLinePresetItems,
  STATUS_LINE_PRESET_ITEM_IDS,
  STATUS_LINE_PRESET_ITEMS,
} from './statusLinePresets.js';

describe('statusLinePresets', () => {
  it('normalizes valid preset configs and orders items by priority', () => {
    expect(
      normalizeStatusLinePresetConfig({
        type: 'preset',
        useThemeColors: false,
        items: ['model', 'bogus', 'git-branch', 'model'],
      }),
    ).toEqual({
      type: 'preset',
      useThemeColors: false,
      items: ['model', 'git-branch'],
    });
  });

  it('keeps an explicit empty item list', () => {
    expect(
      normalizeStatusLinePresetConfig({
        type: 'preset',
        items: [],
      }),
    ).toEqual({
      type: 'preset',
      useThemeColors: true,
      items: [],
    });
  });

  it('falls back to defaults when preset items are missing', () => {
    expect(
      normalizeStatusLinePresetConfig({
        type: 'preset',
      }),
    ).toEqual(DEFAULT_STATUS_LINE_PRESET_CONFIG);
  });

  it('keeps default preset items in priority order', () => {
    expect(DEFAULT_STATUS_LINE_PRESET_CONFIG.items).toEqual(
      orderStatusLinePresetItems(
        [...DEFAULT_STATUS_LINE_PRESET_CONFIG.items].reverse(),
      ),
    );
  });

  it('labels the plain model preset as model-only', () => {
    expect(
      STATUS_LINE_PRESET_ITEMS.find((item) => item.id === 'model')?.label,
    ).toBe('model-only');
  });

  it('renders available preset items in priority order', () => {
    const data = buildStatusLinePresetData({
      sessionId: 'session-123',
      version: '1.2.3',
      modelDisplayName: 'qwen3-code-plus',
      currentDir: '/repo/project',
      branch: 'feature/pr-4087-statusline',
      contextWindowSize: 1000,
      currentUsage: 250,
      totalInputTokens: 1200,
      totalOutputTokens: 340,
      totalLinesAdded: 12,
      totalLinesRemoved: 3,
      streamingState: StreamingState.Idle,
    });

    expect(
      buildStatusLinePresetLines(
        {
          type: 'preset',
          items: [
            'run-state',
            'model',
            'branch-changes',
            'pull-request-number',
            'current-dir',
            'context-remaining',
          ],
        },
        data,
      ),
    ).toEqual([
      'qwen3-code-plus | Context 75% left | /repo/project | #4087 | +12 -3 | Ready',
    ]);
  });

  it('renders every preset item with representative data', () => {
    const data = buildStatusLinePresetData({
      sessionId: 'session-123',
      version: '1.2.3',
      modelDisplayName: 'qwen3-code-plus',
      reasoning: { effort: 'high' },
      currentDir: '/repo/project',
      branch: 'feature/pr-4087-statusline',
      contextWindowSize: 1000,
      currentUsage: 250,
      totalInputTokens: 1200,
      totalOutputTokens: 340,
      totalLinesAdded: 12,
      totalLinesRemoved: 3,
      streamingState: StreamingState.Idle,
    });

    expect(
      buildStatusLinePresetLines(
        {
          type: 'preset',
          items: [...STATUS_LINE_PRESET_ITEM_IDS],
        },
        data,
      ),
    ).toEqual([
      'qwen3-code-plus high | qwen3-code-plus | feature/pr-4087-statusline | Context 75% left | 1.2k in | 340 out | /repo/project | project | #4087 | +12 -3 | Context 25% used | Ready | v1.2.3 | 1.0k window | 250 used | session-123',
    ]);
  });

  it('renders model and model-with-reasoning together', () => {
    const data = buildStatusLinePresetData({
      sessionId: 'session-123',
      version: '1.2.3',
      modelDisplayName: 'qwen3-code-plus',
      reasoning: { effort: 'high' },
      currentDir: '/repo/project',
      branch: undefined,
      contextWindowSize: 0,
      currentUsage: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      streamingState: StreamingState.Idle,
    });

    expect(
      buildStatusLinePresetLines(
        {
          type: 'preset',
          items: ['model', 'model-with-reasoning'],
        },
        data,
      ),
    ).toEqual(['qwen3-code-plus high | qwen3-code-plus']);
  });

  it('shows when reasoning is disabled', () => {
    const data = buildStatusLinePresetData({
      sessionId: 'session-123',
      version: '1.2.3',
      modelDisplayName: 'qwen3-code-plus',
      reasoning: false,
      currentDir: '/repo/project',
      branch: undefined,
      contextWindowSize: 0,
      currentUsage: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      streamingState: StreamingState.Idle,
    });

    expect(
      buildStatusLinePresetLines(
        {
          type: 'preset',
          items: ['model-with-reasoning'],
        },
        data,
      ),
    ).toEqual(['qwen3-code-plus reasoning off']);
  });

  it('falls back to the model name when reasoning is unset', () => {
    const data = buildStatusLinePresetData({
      sessionId: 'session-123',
      version: '1.2.3',
      modelDisplayName: 'qwen3-code-plus',
      currentDir: '/repo/project',
      branch: undefined,
      contextWindowSize: 0,
      currentUsage: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      streamingState: StreamingState.Idle,
    });

    expect(
      buildStatusLinePresetLines(
        {
          type: 'preset',
          items: ['model-with-reasoning'],
        },
        data,
      ),
    ).toEqual(['qwen3-code-plus']);
  });

  it('renders an explicit pull request number before branch-name inference', () => {
    const data = buildStatusLinePresetData({
      sessionId: 'session-123',
      version: '1.2.3',
      modelDisplayName: 'qwen3-code-plus',
      currentDir: '/repo/project',
      branch: 'feature/pr-1',
      pullRequestNumber: '4087',
      contextWindowSize: 1000,
      currentUsage: 250,
      totalInputTokens: 1200,
      totalOutputTokens: 340,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      streamingState: StreamingState.Idle,
    });

    expect(
      buildStatusLinePresetLines(
        {
          type: 'preset',
          items: ['pull-request-number'],
        },
        data,
      ),
    ).toEqual(['#4087']);
  });

  it('aggregates model token counts', () => {
    expect(
      aggregateModelTokens({
        models: {
          qwen: { tokens: { prompt: 100, candidates: 20 } },
          coder: { tokens: { prompt: 300, candidates: 40 } },
        },
      }),
    ).toEqual({ totalInputTokens: 400, totalOutputTokens: 60 });
  });

  it('formats token counts compactly', () => {
    expect(formatTokenCount(Number.NaN)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1200)).toBe('1.2k');
    expect(formatTokenCount(2_400_000)).toBe('2.4m');
  });

  it('labels run states', () => {
    expect(getRunStateLabel(StreamingState.Idle)).toBe('Ready');
    expect(getRunStateLabel(StreamingState.Responding)).toBe('Working');
    expect(getRunStateLabel(StreamingState.WaitingForConfirmation)).toBe(
      'Confirm',
    );
  });

  it('infers pull request numbers from branch names', () => {
    expect(inferPullRequestNumber('feature/pr-4087-statusline')).toBe('4087');
    expect(inferPullRequestNumber('dragon/pull-request_99')).toBe('99');
    expect(inferPullRequestNumber('main')).toBeUndefined();
    expect(inferPullRequestNumber(undefined)).toBeUndefined();
  });
});
