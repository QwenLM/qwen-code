/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { timeAgo } from './timeAgo';

const NOW = 1_800_000_000;

describe('timeAgo', () => {
  it.each([
    [0, 'en', 'now'],
    [30, 'en', 'now'],
    [60, 'en', '1 minute ago'],
    [120, 'en', '2 minutes ago'],
    [3600, 'en', '1 hour ago'],
    [7200, 'en', '2 hours ago'],
    [86_400, 'en', 'yesterday'],
    [259_200, 'en', '3 days ago'],
    [604_800, 'en', 'last week'],
    [1_814_400, 'en', '3 weeks ago'],
    [2_592_000, 'en', '4 weeks ago'],
    [7_776_000, 'en', '3 months ago'],
    [31_536_000, 'en', 'last year'],
    [63_072_000, 'en', '2 years ago'],
  ])('%s seconds ago → "%s"', (seconds, lang, expected) => {
    expect(timeAgo(NOW - seconds, NOW, lang)).toBe(expected);
  });

  it('uses weeks below the 5-week threshold and months at or above it', () => {
    expect(timeAgo(NOW - 4 * 7 * 86_400, NOW, 'en')).toBe('4 weeks ago');
    expect(timeAgo(NOW - 5 * 7 * 86_400, NOW, 'en')).toBe('last month');
  });

  it('uses months below 12 and years at or above 12', () => {
    expect(timeAgo(NOW - 330 * 86_400, NOW, 'en')).toBe('11 months ago');
    expect(timeAgo(NOW - 365 * 86_400, NOW, 'en')).toBe('last year');
  });

  it('clamps negative deltas to now', () => {
    expect(timeAgo(NOW + 100, NOW, 'en')).toBe('now');
  });

  it('localizes output', () => {
    expect(timeAgo(NOW - 120, NOW, 'zh-CN')).toBe('2分钟前');
  });
});
