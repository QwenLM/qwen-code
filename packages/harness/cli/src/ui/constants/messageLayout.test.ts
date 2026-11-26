/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  FoldLevel,
  getNextFoldLevel,
  getSpacingGap,
} from './messageLayout.js';

describe('getNextFoldLevel', () => {
  describe('2-level mode', () => {
    it('FullyExpanded → GroupExpandedToolCollapsed', () => {
      expect(getNextFoldLevel(FoldLevel.FullyExpanded, '2-level')).toBe(
        FoldLevel.GroupExpandedToolCollapsed,
      );
    });

    it('GroupExpandedToolCollapsed → FullyExpanded', () => {
      expect(
        getNextFoldLevel(FoldLevel.GroupExpandedToolCollapsed, '2-level'),
      ).toBe(FoldLevel.FullyExpanded);
    });

    it('GroupCollapsed → FullyExpanded (not reachable via cycle, but handles gracefully)', () => {
      expect(getNextFoldLevel(FoldLevel.GroupCollapsed, '2-level')).toBe(
        FoldLevel.FullyExpanded,
      );
    });
  });

  describe('3-level mode', () => {
    it('FullyExpanded → GroupCollapsed', () => {
      expect(getNextFoldLevel(FoldLevel.FullyExpanded, '3-level')).toBe(
        FoldLevel.GroupCollapsed,
      );
    });

    it('GroupCollapsed → GroupExpandedToolCollapsed', () => {
      expect(getNextFoldLevel(FoldLevel.GroupCollapsed, '3-level')).toBe(
        FoldLevel.GroupExpandedToolCollapsed,
      );
    });

    it('GroupExpandedToolCollapsed → FullyExpanded', () => {
      expect(
        getNextFoldLevel(FoldLevel.GroupExpandedToolCollapsed, '3-level'),
      ).toBe(FoldLevel.FullyExpanded);
    });

    it('full cycle returns to start', () => {
      let level = FoldLevel.FullyExpanded;
      level = getNextFoldLevel(level, '3-level');
      level = getNextFoldLevel(level, '3-level');
      level = getNextFoldLevel(level, '3-level');
      expect(level).toBe(FoldLevel.FullyExpanded);
    });
  });

  describe('defaults to FOLD_CYCLE_MODE when mode not specified', () => {
    it('cycles without explicit mode argument', () => {
      // Should not throw; uses the module-level FOLD_CYCLE_MODE constant
      const next = getNextFoldLevel(FoldLevel.FullyExpanded);
      expect(
        next === FoldLevel.GroupExpandedToolCollapsed ||
          next === FoldLevel.GroupCollapsed,
      ).toBe(true);
    });
  });
});

describe('getSpacingGap for top-level feed blocks', () => {
  it('attaches thinking directly to following assistant text or tool use', () => {
    expect(getSpacingGap('thinking', 'model-output')).toBe(0);
    expect(getSpacingGap('thinking', 'tool-group')).toBe(0);
  });

  it('separates user input from following assistant activity', () => {
    expect(getSpacingGap('user-input', 'thinking')).toBe(1);
    expect(getSpacingGap('user-input', 'model-output')).toBe(1);
    expect(getSpacingGap('user-input', 'tool-group')).toBe(1);
  });

  it('keeps one-line boundaries for non-activity messages', () => {
    expect(getSpacingGap('tool-group', 'system-notice')).toBe(1);
    expect(getSpacingGap('tool-group', 'structural')).toBe(1);
    expect(getSpacingGap('model-output', 'user-input')).toBe(1);
    expect(getSpacingGap('model-output', 'tool-group')).toBe(1);
    expect(getSpacingGap('tool-group', 'thinking')).toBe(1);
  });
});
