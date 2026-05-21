/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  applyDraftSource,
  normalizeCustomSources,
} from './AutoImproveSourceDialog.js';

describe('AutoImproveSourceDialog helpers', () => {
  it('normalizes and deduplicates custom sources', () => {
    expect(
      normalizeCustomSources([
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
});
