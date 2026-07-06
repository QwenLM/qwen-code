/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HooksConfigSource, HookType } from '@qwen-code/qwen-code-core';

vi.mock('../../../i18n/index.js', () => ({
  t: vi.fn((key: string) => key),
}));

import {
  formatSourceLabel,
  formatSourceLabels,
  getConfigSourceDisplay,
} from './sourceLabels.js';
import type { HookConfigDisplayInfo } from './types.js';

function makeConfig(
  source: HooksConfigSource,
  sourceDisplay = '',
): HookConfigDisplayInfo {
  return {
    config: { type: HookType.Command, command: '/x.sh' },
    source,
    sourceDisplay,
    enabled: true,
  };
}

describe('sourceLabels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('formatSourceLabel', () => {
    it('returns short label for each known source', () => {
      expect(formatSourceLabel(HooksConfigSource.User)).toBe('User');
      expect(formatSourceLabel(HooksConfigSource.Project)).toBe('Project');
      expect(formatSourceLabel(HooksConfigSource.System)).toBe('System');
      expect(formatSourceLabel(HooksConfigSource.Extensions)).toBe('Extension');
      expect(formatSourceLabel(HooksConfigSource.Session)).toBe('Session');
    });

    it('falls back to the raw source string for unknown values', () => {
      expect(formatSourceLabel('mystery' as HooksConfigSource)).toBe('mystery');
    });
  });

  describe('formatSourceLabels', () => {
    it('returns a single label for a single-source group', () => {
      const configs = [
        makeConfig(HooksConfigSource.User),
        makeConfig(HooksConfigSource.User),
      ];
      expect(formatSourceLabels(configs)).toBe('User');
    });

    it('joins distinct labels with comma + space for multi-source groups', () => {
      const configs = [
        makeConfig(HooksConfigSource.User),
        makeConfig(HooksConfigSource.Project),
        makeConfig(HooksConfigSource.Extensions),
      ];
      expect(formatSourceLabels(configs)).toBe('User, Project, Extension');
    });

    it('preserves insertion order across distinct sources', () => {
      const configs = [
        makeConfig(HooksConfigSource.Project),
        makeConfig(HooksConfigSource.User),
      ];
      expect(formatSourceLabels(configs)).toBe('Project, User');
    });

    it('returns empty string when there are no configs', () => {
      expect(formatSourceLabels([])).toBe('');
    });
  });

  describe('getConfigSourceDisplay', () => {
    it('returns the translated long label for non-extension sources', () => {
      expect(getConfigSourceDisplay(makeConfig(HooksConfigSource.User))).toBe(
        'User Settings',
      );
      expect(
        getConfigSourceDisplay(makeConfig(HooksConfigSource.Project)),
      ).toBe('Local Settings');
      expect(getConfigSourceDisplay(makeConfig(HooksConfigSource.System))).toBe(
        'System Settings',
      );
    });

    it('appends the extension name for Extensions-source configs', () => {
      expect(
        getConfigSourceDisplay(
          makeConfig(HooksConfigSource.Extensions, 'my-ext'),
        ),
      ).toBe('Extensions (my-ext)');
    });

    it('uses the long "Session (temporary)" label for session-source configs', () => {
      expect(
        getConfigSourceDisplay(makeConfig(HooksConfigSource.Session)),
      ).toBe('Session (temporary)');
    });

    it('falls back to the raw source string for unknown sources', () => {
      const config = makeConfig('mystery' as HooksConfigSource);
      expect(getConfigSourceDisplay(config)).toBe('mystery');
    });
  });
});
