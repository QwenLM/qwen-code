/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { StreamingState } from './types.js';
import {
  buildStatusLinePresetData,
  buildStatusLinePresetLines,
  DEFAULT_STATUS_LINE_PRESET_CONFIG,
  normalizeStatusLinePresetConfig,
} from './statusLinePresets.js';

describe('statusLinePresets', () => {
  it('normalizes valid preset configs and drops unknown items', () => {
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

  it('renders available preset items and omits unavailable optional fields', () => {
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
            'model',
            'context-remaining',
            'current-dir',
            'pull-request-number',
            'branch-changes',
            'run-state',
          ],
        },
        data,
      ),
    ).toEqual([
      'qwen3-code-plus | Context 75% left | /repo/project | #4087 | +12 -3 | Ready',
    ]);
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
});
