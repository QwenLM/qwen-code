/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseSince,
  parseUntil,
  parseGroupBy,
  usageAttributionFilter,
  formatUsageCsv,
  computeEfficiency,
  USAGE_CSV_HEADER,
  type UsageResponseRow,
} from './usageQuery.js';
import { OWNER, WRITE, SESSION_READ, BRIDGE } from '../scopes.js';

const NOW = 1_000_000_000_000;
const MICRO = 1_000_000;

describe('parseSince', () => {
  it('subtracts relative durations from now', () => {
    expect(parseSince('24h', NOW)).toBe(NOW - 24 * 3_600_000);
    expect(parseSince('7d', NOW)).toBe(NOW - 7 * 86_400_000);
    expect(parseSince('30m', NOW)).toBe(NOW - 30 * 60_000);
    expect(parseSince('45s', NOW)).toBe(NOW - 45 * 1000);
  });

  it('parses an ISO-8601 absolute time', () => {
    expect(parseSince('2021-01-01T00:00:00.000Z', NOW)).toBe(
      Date.parse('2021-01-01T00:00:00.000Z'),
    );
  });

  it('throws on an unparseable value', () => {
    expect(() => parseSince('whenever', NOW)).toThrow(/invalid time/);
  });
});

describe('parseUntil', () => {
  it('defaults to now when absent', () => {
    expect(parseUntil(undefined, NOW)).toBe(NOW);
    expect(parseUntil('', NOW)).toBe(NOW);
  });
  it('parses a provided value', () => {
    expect(parseUntil('1h', NOW)).toBe(NOW - 3_600_000);
  });
});

describe('parseGroupBy', () => {
  it('accepts the four axes', () => {
    for (const g of ['session', 'client', 'sub_actor', 'model']) {
      expect(parseGroupBy(g)).toBe(g);
    }
  });
  it('rejects anything else', () => {
    expect(parseGroupBy('region')).toBeNull();
    expect(parseGroupBy(undefined)).toBeNull();
  });
});

describe('usageAttributionFilter', () => {
  it('owner sees all rows (no filter)', () => {
    expect(
      usageAttributionFilter({ id: 'tkn_o', scopes: [OWNER] }),
    ).toBeUndefined();
  });
  it('lesser scopes are filtered to their own token id', () => {
    expect(usageAttributionFilter({ id: 'tkn_w', scopes: [WRITE] })).toBe(
      'tkn_w',
    );
    expect(
      usageAttributionFilter({ id: 'tkn_r', scopes: [SESSION_READ] }),
    ).toBe('tkn_r');
    expect(usageAttributionFilter({ id: 'tkn_b', scopes: [BRIDGE] })).toBe(
      'tkn_b',
    );
  });
});

describe('computeEfficiency', () => {
  it('computes costCentsPer1kOutputTokens and tokensPerDollar', () => {
    // 5 cents total, 500 output tokens
    const eff = computeEfficiency(5 * MICRO, 500);
    expect(eff.costCentsPer1kOutputTokens).toBeCloseTo(10, 5); // 5/500*1000
    expect(eff.tokensPerDollar).toBeCloseTo(10000, 0); // 500/(5/100)
  });

  it('returns null costCentsPer1kOutputTokens when tokensOut is 0', () => {
    const eff = computeEfficiency(5 * MICRO, 0);
    expect(eff.costCentsPer1kOutputTokens).toBeNull();
  });

  it('returns null tokensPerDollar when cost is 0', () => {
    const eff = computeEfficiency(0, 500);
    expect(eff.tokensPerDollar).toBeNull();
  });

  it('both null when both zero', () => {
    const eff = computeEfficiency(0, 0);
    expect(eff.costCentsPer1kOutputTokens).toBeNull();
    expect(eff.tokensPerDollar).toBeNull();
  });
});

describe('formatUsageCsv', () => {
  const rows: UsageResponseRow[] = [
    {
      key: 's1',
      displayLabel: 's1',
      tokensIn: 10,
      tokensOut: 5,
      tokensCached: 0,
      costMicrocents: 600000,
      costCents: 0.6,
      efficiency: { costCentsPer1kOutputTokens: 120, tokensPerDollar: 833.33 },
    },
  ];

  it('emits the exact spec header', () => {
    expect(formatUsageCsv([]).split('\n')[0]).toBe(USAGE_CSV_HEADER);
    expect(USAGE_CSV_HEADER).toBe(
      'key,displayLabel,tokensIn,tokensOut,tokensCached,costMicrocents,costCents,costCentsPer1kOutputTokens,tokensPerDollar',
    );
  });

  it('renders a row with all fields', () => {
    const line = formatUsageCsv(rows).split('\n')[1];
    expect(line).toContain('s1');
    expect(line).toContain('600000');
    expect(line).toContain('0.6');
  });

  it('renders null efficiency fields as empty', () => {
    const noEff: UsageResponseRow[] = [
      {
        ...rows[0],
        efficiency: { costCentsPer1kOutputTokens: null, tokensPerDollar: null },
      },
    ];
    const line = formatUsageCsv(noEff).split('\n')[1];
    // Two trailing empty cells (null → '')
    expect(line.endsWith(',,')).toBe(true);
  });

  it('quotes and escapes cells with commas or quotes', () => {
    const out = formatUsageCsv([
      {
        ...rows[0],
        key: 'a,b',
        displayLabel: 'has "quote"',
      },
    ]);
    expect(out).toContain('"a,b"');
    expect(out).toContain('"has ""quote"""');
  });
});
