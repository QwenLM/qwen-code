/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Content } from '@google/genai';
import { extractTextFromContents } from './extract-text-from-contents.js';

describe('extractTextFromContents', () => {
  it('extracts text from a single Content', () => {
    expect(
      extractTextFromContents({
        role: 'user',
        parts: [{ text: 'hello' }, { text: 'world' }],
      }),
    ).toBe('hello world');
  });

  it('extracts text across an array of Contents', () => {
    expect(
      extractTextFromContents([
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'world' }] },
      ]),
    ).toBe('hello world');
  });

  it('passes through bare strings, in both the single and array forms', () => {
    expect(extractTextFromContents('plain')).toBe('plain');
    expect(extractTextFromContents(['a', 'b'])).toBe('a b');
  });

  it('yields empty strings for non-text parts rather than dropping them', () => {
    // The join is over every part, so a non-text part contributes '' and
    // still produces a separator -- pinning this keeps the embedding input
    // stable if the part-shape helper is ever rewritten.
    expect(
      extractTextFromContents({
        role: 'user',
        parts: [
          { text: 'before' },
          { inlineData: { mimeType: 'image/png', data: 'BASE64' } },
          { text: 'after' },
        ],
      }),
    ).toBe('before  after');
  });

  it('treats a missing/empty text field as an empty string', () => {
    expect(
      extractTextFromContents({
        role: 'user',
        parts: [{ text: '' }, { text: 'kept' }],
      }),
    ).toBe(' kept');
  });

  it('returns the same text for one Content whether passed bare or wrapped in an array', () => {
    // Regression guard for the duplication this helper exists to remove: the
    // array branch and the single-content branch previously each carried
    // their own copy of the part->text lambda, and the pre-extraction code
    // had already let the two drift apart. Any future edit that touches only
    // one branch turns this red.
    const content: Content = {
      role: 'user',
      parts: [
        { text: 'alpha' },
        { inlineData: { mimeType: 'image/png', data: 'BASE64' } },
        { text: '' },
        { text: 'omega' },
      ],
    };

    expect(extractTextFromContents([content])).toBe(
      extractTextFromContents(content),
    );
  });
});
