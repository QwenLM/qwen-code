/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseReceiptCommentIds, parseReceiptIds } from './receipt.js';

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

  it('does not throw on valid JSON that is not an object (null, number, array, string)', () => {
    // `JSON.parse('null')` succeeds; dereferencing it would break the
    // never-throws contract.
    expect(parseReceiptIds('null')).toEqual([]);
    expect(parseReceiptIds('42')).toEqual([]);
    expect(parseReceiptIds('"x"')).toEqual([]);
    expect(parseReceiptIds('[1,2]')).toEqual([]);
  });
});

describe('parseReceiptCommentIds', () => {
  it('reads the commentIds array', () => {
    expect(
      parseReceiptCommentIds(JSON.stringify({ commentIds: [1, 2, 3] })),
    ).toEqual([1, 2, 3]);
  });

  it('reads nothing from the review-id axis — the two axes never blur', () => {
    expect(
      parseReceiptCommentIds(JSON.stringify({ reviewIds: [1, 2, 3] })),
    ).toEqual([]);
    expect(parseReceiptIds(JSON.stringify({ commentIds: [1, 2, 3] }))).toEqual(
      [],
    );
  });

  it('drops non-numeric entries rather than trusting them', () => {
    expect(
      parseReceiptCommentIds(JSON.stringify({ commentIds: [1, 'x', null, 2] })),
    ).toEqual([1, 2]);
  });

  it('returns [] for malformed JSON, a missing field, or a wrong-typed field', () => {
    expect(parseReceiptCommentIds('not json {')).toEqual([]);
    expect(parseReceiptCommentIds(JSON.stringify({}))).toEqual([]);
    expect(
      parseReceiptCommentIds(JSON.stringify({ commentIds: 'nope' })),
    ).toEqual([]);
  });

  it('does not throw on valid JSON that is not an object (null, number, array, string)', () => {
    expect(parseReceiptCommentIds('null')).toEqual([]);
    expect(parseReceiptCommentIds('42')).toEqual([]);
    expect(parseReceiptCommentIds('"x"')).toEqual([]);
    expect(parseReceiptCommentIds('[1,2]')).toEqual([]);
  });
});
