/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseUsageArgs,
  parsePruneArgs,
  formatUsageTable,
} from './usageCli.js';
import type { UsageResponseRow } from './usageQuery.js';

const NOW = 1_000_000_000_000;

describe('parseUsageArgs', () => {
  it('defaults to 24h / session / table', () => {
    const a = parseUsageArgs([], NOW);
    expect(a.groupBy).toBe('session');
    expect(a.format).toBe('table');
    expect(a.sinceMs).toBe(NOW - 24 * 3_600_000);
    expect(a.subActor).toBeUndefined();
  });

  it('reads --group-by, --since, --sub-actor, --format (space and = forms)', () => {
    const a = parseUsageArgs(
      [
        '--group-by',
        'client',
        '--since=7d',
        '--sub-actor',
        'telegram:42',
        '--format',
        'csv',
      ],
      NOW,
    );
    expect(a.groupBy).toBe('client');
    expect(a.sinceMs).toBe(NOW - 7 * 86_400_000);
    expect(a.subActor).toBe('telegram:42');
    expect(a.format).toBe('csv');
  });

  it('rejects a bad group-by or format', () => {
    expect(() => parseUsageArgs(['--group-by', 'region'], NOW)).toThrow(
      /group-by/,
    );
    expect(() => parseUsageArgs(['--format', 'xml'], NOW)).toThrow(/format/);
  });
});

describe('parsePruneArgs', () => {
  it('parses --before and --yes', () => {
    const a = parsePruneArgs(['--before', '2021-01-01T00:00:00Z', '--yes']);
    expect(a.beforeMs).toBe(Date.parse('2021-01-01T00:00:00Z'));
    expect(a.yes).toBe(true);
  });

  it('defaults --yes to false', () => {
    expect(parsePruneArgs(['--before=2021-01-01T00:00:00Z']).yes).toBe(false);
  });

  it('throws without --before or on a bad timestamp', () => {
    expect(() => parsePruneArgs([])).toThrow(/--before/);
    expect(() => parsePruneArgs(['--before', 'whenever'])).toThrow(/invalid/);
  });
});

describe('formatUsageTable', () => {
  const rows: UsageResponseRow[] = [
    {
      key: 's1',
      displayLabel: 'Session one',
      tokensIn: 1000,
      tokensOut: 500,
      tokensCached: 0,
      costMicrocents: 600_000,
      costCents: 0.6,
      efficiency: { costCentsPer1kOutputTokens: 1.2, tokensPerDollar: 83333 },
    },
  ];

  it('renders an aligned table with the currency in the header', () => {
    const out = formatUsageTable(rows, 'USD');
    expect(out.split('\n')[0]).toContain('COST(USD¢)');
    expect(out).toContain('s1');
    expect(out).toContain('0.60');
  });

  it('shows a placeholder when there are no rows', () => {
    expect(formatUsageTable([], 'USD')).toContain('(no usage in window)');
  });
});
