/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseReceiptIds } from './receipt.js';

describe('parseReceiptIds', () => {
  it('reads the current reviewIds array', () => {
    expect(parseReceiptIds(JSON.stringify({ reviewIds: [1, 2, 3] }))).toEqual([
      1, 2, 3,
    ]);
  });

  it('migrates a legacy single reviewId', () => {
    expect(parseReceiptIds(JSON.stringify({ reviewId: 7 }))).toEqual([7]);
  });

  it('prefers reviewIds over a legacy reviewId when both are present', () => {
    expect(
      parseReceiptIds(JSON.stringify({ reviewIds: [1], reviewId: 9 })),
    ).toEqual([1]);
  });

  it('drops non-numeric entries rather than trusting them', () => {
    expect(
      parseReceiptIds(JSON.stringify({ reviewIds: [1, 'x', null, 2] })),
    ).toEqual([1, 2]);
  });

  it('returns [] for malformed JSON, a missing field, or a wrong-typed field', () => {
    expect(parseReceiptIds('not json {')).toEqual([]);
    expect(parseReceiptIds(JSON.stringify({}))).toEqual([]);
    expect(parseReceiptIds(JSON.stringify({ reviewId: 'nope' }))).toEqual([]);
    expect(parseReceiptIds(JSON.stringify({ reviewIds: 'nope' }))).toEqual([]);
  });
});
