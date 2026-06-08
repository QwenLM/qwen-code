/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { applyDraftSource } from './AutoImproveSourceDialog.js';
import {
  MAX_CUSTOM_SOURCE_LENGTH,
  MAX_CUSTOM_SOURCES,
  normalizeStringList,
} from '../commands/autoImproveState.js';

describe('AutoImproveSourceDialog helpers', () => {
  it('normalizes and deduplicates custom sources', () => {
    expect(
      normalizeStringList([
        ' review PR comments ',
        '',
        'review PR comments',
        'check CI',
      ]),
    ).toEqual(['review PR comments', 'check CI']);
  });

  it('adds a committed draft without saving blank input', () => {
    expect(applyDraftSource(['check CI'], ' review comments ', null)).toEqual([
      'check CI',
      'review comments',
    ]);
    expect(applyDraftSource(['check CI'], '   ', null)).toEqual(['check CI']);
  });

  it('edits an existing committed source', () => {
    expect(
      applyDraftSource(['check CI', 'review comments'], 'scan docs', 1),
    ).toEqual(['check CI', 'scan docs']);
  });

  it('truncates sources exceeding MAX_CUSTOM_SOURCE_LENGTH', () => {
    const longSource = 'a'.repeat(MAX_CUSTOM_SOURCE_LENGTH + 50);
    const result = normalizeStringList([longSource]);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(MAX_CUSTOM_SOURCE_LENGTH);
  });

  it('limits output to MAX_CUSTOM_SOURCES entries', () => {
    const sources = Array.from(
      { length: MAX_CUSTOM_SOURCES + 5 },
      (_, i) => `source-${i}`,
    );
    const result = normalizeStringList(sources);
    expect(result).toHaveLength(MAX_CUSTOM_SOURCES);
    expect(result).toEqual(sources.slice(0, MAX_CUSTOM_SOURCES));
  });
});
