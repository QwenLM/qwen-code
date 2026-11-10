/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  BILL_DEFAULTS,
  BILL_SCENARIO,
  COMPARATOR_SCENARIO,
  PLANS,
  billShares,
  billTotal,
  comparatorPayment,
} from './fixtures.js';
import { formatCents, parseAmounts, parseLastAmount } from './money.js';

describe('acceptance fixtures reproduce the figures stated in #14019', () => {
  it('bill splitter defaults: CNY 924 total, CNY 154 each for six people', () => {
    expect(formatCents(billTotal(BILL_DEFAULTS))).toBe('924.00');
    expect(billShares(BILL_DEFAULTS).map(formatCents)).toEqual(
      Array(6).fill('154.00'),
    );
  });

  it('bill splitter scenario: CNY 964.85, four pay 137.84 and three 137.83', () => {
    const shares = billShares(BILL_SCENARIO);
    expect(formatCents(billTotal(BILL_SCENARIO))).toBe('964.85');
    expect(shares.map(formatCents)).toEqual([
      ...Array(4).fill('137.84'),
      ...Array(3).fill('137.83'),
    ]);
    expect(shares.reduce((sum, share) => sum + share, 0)).toBe(
      billTotal(BILL_SCENARIO),
    );
  });

  it('comparator: 13 seats, annual, support undiscounted', () => {
    expect(
      PLANS.map((plan) =>
        formatCents(comparatorPayment(plan, COMPARATOR_SCENARIO)),
      ),
    ).toEqual(['6739.20', '10483.20', '14227.20']);
  });
});

describe('money parsing', () => {
  it('reads currency-decorated, grouped and full-width amounts as cents', () => {
    expect(parseAmounts('¥1,234.50 / CNY 964.85')).toEqual([123_450, 96_485]);
    expect(parseAmounts('合计：９２４元')).toEqual([92_400]);
    expect(parseAmounts('10 483.20')).toEqual([1_048_320]);
    expect(parseLastAmount('Person 3: 137.84')).toBe(13_784);
  });
});
