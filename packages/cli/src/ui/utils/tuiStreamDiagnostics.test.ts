/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeOverlappingStreamDelta,
  normalizeSuffixOverlappingStreamDelta,
} from './tuiStreamDiagnostics.js';

describe('normalizeOverlappingStreamDelta', () => {
  it('drops an overlapping prefix from a continuation delta', () => {
    const result = normalizeOverlappingStreamDelta(
      'The answer ends with shared recovery suffix',
      'shared recovery suffix and then continues.',
    );

    expect(result).toMatchObject({
      text: ' and then continues.',
      action: 'overlap-suffix',
      suppressedPrefixChars: 'shared recovery suffix'.length,
    });
  });

  it('drops a fully stale continuation delta', () => {
    const result = normalizeOverlappingStreamDelta(
      'Intro\n| Syntax | Description |',
      '| Syntax | Description |',
    );

    expect(result).toMatchObject({
      text: '',
      action: 'stale',
      suppressedPrefixChars: '| Syntax | Description |'.length,
    });
  });

  it('leaves unrelated text unchanged', () => {
    const result = normalizeOverlappingStreamDelta('alpha beta', 'gamma delta');

    expect(result).toMatchObject({
      text: 'gamma delta',
      action: 'unchanged',
      suppressedPrefixChars: 0,
    });
  });

  it('drops a continuation prefix replayed from the previous tail', () => {
    const result = normalizeOverlappingStreamDelta(
      [
        'Intro',
        '### 常用语法速查',
        '| 语法 | 说明 |',
        'tail that was truncated',
      ].join('\n'),
      ['### 常用语法速查', '| 语法 | 说明 |', 'new suffix'].join('\n'),
    );

    expect(result).toMatchObject({
      text: '\nnew suffix',
      action: 'contained-prefix-suffix',
      suppressedPrefixChars:
        ['### 常用语法速查', '| 语法 | 说明 |'].join('\n').length + 1,
    });
  });
});

describe('normalizeSuffixOverlappingStreamDelta', () => {
  it('drops a replayed suffix prefix without using contained-prefix recovery', () => {
    const result = normalizeSuffixOverlappingStreamDelta(
      'Intro\nBase <|-- Child',
      'Base <|-- Child\nNext line',
    );

    expect(result).toMatchObject({
      text: '\nNext line',
      action: 'overlap-suffix',
      suppressedPrefixChars: 'Base <|-- Child'.length,
    });
  });

  it('drops a fully stale suffix replay', () => {
    const result = normalizeSuffixOverlappingStreamDelta(
      'Intro\n| 语法 | 说明 |',
      '| 语法 | 说明 |',
    );

    expect(result).toMatchObject({
      text: '',
      action: 'stale',
      suppressedPrefixChars: '| 语法 | 说明 |'.length,
    });
  });

  it('does not drop content replayed from an earlier non-tail anchor', () => {
    const result = normalizeSuffixOverlappingStreamDelta(
      ['Intro', '### 常用语法速查', '| 语法 | 说明 |', 'current tail'].join(
        '\n',
      ),
      ['### 常用语法速查', '| 语法 | 说明 |', 'new suffix'].join('\n'),
    );

    expect(result).toMatchObject({
      text: ['### 常用语法速查', '| 语法 | 说明 |', 'new suffix'].join('\n'),
      action: 'unchanged',
      suppressedPrefixChars: 0,
    });
  });
});
