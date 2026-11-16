/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { codePointBigrams, normalizeRecallText } from './recall-tokenizer.js';

describe('normalizeRecallText', () => {
  it('applies NFKC normalization and lowercasing', () => {
    expect(normalizeRecallText('ＡＢＣ ㍿')).toBe('abc 株式会社');
  });
});

describe('codePointBigrams', () => {
  it.each([
    ['empty input', '', []],
    ['one code point', '漢', []],
    ['BMP input', '漢字仮', ['漢字', '字仮']],
    ['supplementary-plane input', '😀漢字', ['😀漢', '漢字']],
  ])('%s', (_name, input, expected) => {
    expect(Array.from(codePointBigrams(input))).toEqual(expected);
  });
});
