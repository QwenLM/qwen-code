/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { cleanSummary } from './worker-summary.js';

describe('cleanSummary', () => {
  it('keeps the first non-empty line without markdown or a trailing period', () => {
    expect(cleanSummary('\n"**Found one README file.**"\nextra')).toBe(
      'Found one README file',
    );
  });

  it('returns undefined for empty output', () => {
    expect(cleanSummary('  \n ')).toBeUndefined();
    expect(cleanSummary(undefined)).toBeUndefined();
  });

  it('caps long lines', () => {
    const summary = cleanSummary('x'.repeat(300));
    expect(summary?.length).toBe(120);
    expect(summary?.endsWith('…')).toBe(true);
  });
});
