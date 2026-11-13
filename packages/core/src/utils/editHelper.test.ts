/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  countOccurrences,
  findLineBasedMatchOffsets,
  maybeAugmentOldStringForDeletion,
  normalizeEditStrings,
} from './editHelper.js';

describe('normalizeEditStrings', () => {
  const file = `const one = 1;
const two = 2;
`;

  it('returns literal matches unchanged', () => {
    const result = normalizeEditStrings(
      file,
      'const two = 2;',
      '  const two = 42;',
    );
    expect(result).toEqual({
      oldString: 'const two = 2;',
      newString: '  const two = 42;',
    });
  });

  describe('Unicode escape recovery', () => {
    it.each([
      ['你好', String.raw`\u4f60\u597d`, String.raw`\u518d\u89c1`, '再见'],
      [String.raw`\u4f60\u597d`, '你好', '再见', String.raw`\u518d\u89c1`],
      [String.raw`\u4F60\u597D`, '你好', '你们', String.raw`\u4F60\u4EEC`],
      ['😀', String.raw`\ud83d\ude00`, String.raw`\ud83d\ude01`, '😁'],
      [String.raw`\ud83d\ude00`, '😀', '😁', String.raw`\ud83d\ude01`],
    ])('preserves the representation in %j', (disk, old, next, expected) => {
      expect(normalizeEditStrings(disk, old, next)).toEqual({
        oldString: disk,
        newString: expected,
      });
    });

    it.each(['你好', String.raw`\u4f60\u597d`])(
      'keeps an exact %j match and replacement unchanged',
      (old) => {
        const next = String.raw`\u518d\u89c1`;
        expect(
          normalizeEditStrings(`你好\n${String.raw`\u4f60\u597d`}`, old, next),
        ).toEqual({ oldString: old, newString: next });
      },
    );

    it.each([
      ['你好\n' + String.raw`\u4F60\u597D`, String.raw`\u4f60\u597d`],
      [String.raw`\u4f60\u597d` + '\n' + String.raw`\u4F60\u597D`, '你好'],
      [String.raw`\u4f60好`, '你好'],
      ['你好', String.raw`\\u4f60\\u597d`],
      [String.raw`\\u4f60\\u597d`, '你好'],
      [String.raw`\u4f60\u597d` + '\n' + String.raw`\\u4f60\u597d`, '你好'],
      [String.raw`\\u4f60\u4f60\u4f60`, '你你'],
      [String.raw`\u4f60\u597d\u518d`, '你好\\'],
      [String.raw`\u4f60\u4f60`, '60你'],
      [String.raw`a\x41\u4f60\u597d`, '41你好'],
      [String.raw`a\x41\u4f60\u597d`, '1你好'],
      [String.raw`a\u{4f60}\u4f60\u597d`, 'f60}你好'],
      ['你好\\\\', String.raw`\u4f60\u597d` + '\\'],
      ['你好', String.raw`\u4f6\u597d`],
      ['你好', String.raw`\u{4f60}\u{597d}`],
      ['a\n', String.raw`\u0061\u000a`],
      ['label = “你好”;', String.raw`label = "\u4f60\u597d";`],
    ])('leaves unsupported or ambiguous %j matches unchanged', (disk, old) => {
      expect(normalizeEditStrings(disk, old, 'replacement')).toEqual({
        oldString: old,
        newString: 'replacement',
      });
    });

    it('keeps identical recovered occurrences visible to the caller', () => {
      const result = normalizeEditStrings(
        '你好\n你好',
        String.raw`\u4f60\u597d`,
        String.raw`\u518d\u89c1`,
      );
      expect(result).toEqual({ oldString: '你好', newString: '再见' });
      expect(countOccurrences('你好\n你好', result.oldString)).toBe(2);
    });

    it.each([
      'n',
      't',
      'r',
      'b',
      'f',
      'v',
      '0',
      '"',
      "'",
      '/',
      '\\',
      'x',
      's',
      'd',
      'w',
      'q',
    ])('refuses recovery inside a backslash-%s escape', (escape) => {
      for (const [disk, old] of [
        [`a\\${escape}${String.raw`\u4f60\u597d`}`, `${escape}你好`],
        [`${String.raw`\u4f60\u597d`}\\${escape}`, '你好\\'],
      ]) {
        expect(normalizeEditStrings(disk, old, 'X')).toEqual({
          oldString: old,
          newString: 'X',
        });
      }
    });

    it.each([
      [String.raw`p = "\u4f60\u597d";`, '你好', 'C:\\路径'],
      [String.raw`{"a": "\u4f60\u597d\n"}`, '你好', 'X\\'],
      [String.raw`\u4f60\u597d`, '你', 'C:\\'],
      [String.raw`\u4f60;\u4f60\n`, '你', 'X\\'],
      [String.raw`{"a": "\u4f60"}`, '你', 'C:\\'],
      [String.raw`x = \u4f60north;`, '你', 'X\\'],
      [String.raw`\u4f60test`, '你', 'X\\'],
      ['你north', String.raw`\u4f60`, 'X\\'],
    ])('refuses replacement escape fusion in %j', (disk, old, next) => {
      expect(normalizeEditStrings(disk, old, next)).toEqual({
        oldString: old,
        newString: next,
      });
    });

    it.each([
      [String.raw`C:\\路径`, String.raw`C:\\\u8def\u5f84`],
      [String.raw`X\\`, String.raw`X\\`],
      [String.raw`\n\t\u0022 $&`, String.raw`\n\t\u0022 $&`],
    ])('preserves balanced replacement escapes in %j', (next, expected) => {
      const disk = String.raw`\u4f60\u597d\n`;
      expect(normalizeEditStrings(disk, '你好', next)).toEqual({
        oldString: String.raw`\u4f60\u597d`,
        newString: expected,
      });
    });

    it.each([
      [String.raw`\s`, String.raw`\d`],
      [String.raw`\x41`, String.raw`\x42`],
      [String.raw`\u{4f60}`, String.raw`\u{597d}`],
    ])('preserves complete %j tokens in recovered slices', (before, after) => {
      const disk = before + String.raw`\u4f60\u597d`;
      expect(
        normalizeEditStrings(disk, before + '你好', after + '再见'),
      ).toEqual({
        oldString: disk,
        newString: after + String.raw`\u518d\u89c1`,
      });
    });

    it('allows a trailing replacement backslash at end of file', () => {
      const disk = String.raw`\u4f60`;
      expect(normalizeEditStrings(disk, '你', 'X\\')).toEqual({
        oldString: disk,
        newString: 'X\\',
      });
    });

    it('preserves other escapes and regex characters in recovered text', () => {
      const disk = 'label = "你好"; // [a-z]+ ($&)';
      const old = String.raw`label = "\u4f60\u597d"; // [a-z]+ ($&)`;
      const next = String.raw`label = "\u518d\u89c1"; // \\u4f60 \n \t \u0022 $&`;
      expect(normalizeEditStrings(disk, old, next)).toEqual({
        oldString: disk,
        newString: String.raw`label = "再见"; // \\u4f60 \n \t \u0022 $&`,
      });
    });

    it('does not decode an unpaired surrogate in replacement text', () => {
      expect(
        normalizeEditStrings(
          '你好',
          String.raw`\u4f60\u597d`,
          String.raw`\ud800`,
        ),
      ).toEqual({ oldString: '你好', newString: String.raw`\ud800` });
    });

    it.each([256, 257])(
      'bounds recovery at %i decoded code units',
      (length) => {
        const old = '你'.repeat(length);
        const disk = String.raw`\u4f60`.repeat(length);

        expect(normalizeEditStrings(disk, old, '好')).toEqual(
          length === 256
            ? { oldString: disk, newString: String.raw`\u597d` }
            : { oldString: old, newString: '好' },
        );
      },
    );

    it('keeps large escaped arguments outside the recovery budget', () => {
      const old = String.raw`\u4f60`.repeat(4_000);

      expect(normalizeEditStrings('你'.repeat(4_000), old, '好')).toEqual({
        oldString: old,
        newString: '好',
      });
    });

    it('returns a normal miss for an engine-sized Unicode needle', () => {
      const old = '你'.repeat(64_000) + '好';
      expect(normalizeEditStrings(String.raw`\u4f60`, old, 'new')).toEqual({
        oldString: old,
        newString: 'new',
      });
    });

    it('preserves exact matching above the recovery budget', () => {
      const old = '你'.repeat(4_000);
      expect(normalizeEditStrings(old, old, '好')).toEqual({
        oldString: old,
        newString: '好',
      });
    });
  });

  it('normalizes smart quotes to match on-disk text', () => {
    const result = normalizeEditStrings(
      "const greeting = 'Don't';\n",
      'const greeting = ‘Don’t’;',
      'const greeting = "Hello";',
    );
    expect(result).toEqual({
      oldString: "const greeting = 'Don't';",
      newString: 'const greeting = "Hello";',
    });
  });

  it('falls back to original strings when no match is found', () => {
    const result = normalizeEditStrings(file, 'missing text', 'replacement');
    expect(result).toEqual({
      oldString: 'missing text',
      newString: 'replacement',
    });
  });

  it('matches unicode dash variants and preserves newString', () => {
    const result = normalizeEditStrings(
      'const range = "1-2";\n',
      'const range = "1\u20132";',
      'const range = "3\u20135";   ',
    );
    expect(result).toEqual({
      oldString: 'const range = "1-2";',
      newString: 'const range = "3\u20135";   ',
    });
  });

  it('treats non-breaking spaces as regular spaces', () => {
    const result = normalizeEditStrings(
      'const label = "hello world";\n',
      'const label = "hello\u00a0world";',
      'const label = "hi\u00a0world";',
    );
    expect(result).toEqual({
      oldString: 'const label = "hello world";',
      newString: 'const label = "hi\u00a0world";',
    });
  });

  it('drops trailing newline from new content when the file lacks it', () => {
    const result = normalizeEditStrings(
      'console.log("hi")',
      'console.log("hi")\n',
      'console.log("bye")\n',
    );
    expect(result).toEqual({
      oldString: 'console.log("hi")',
      newString: 'console.log("bye")',
      lineBasedMatch: true,
    });
  });

  it.each([
    {
      name: 'deleting a fuzzy line before a blank line',
      content: 'before\nremove-me \n\nafter\n',
      oldString: 'remove-me\n',
      newString: '',
      canonical: 'remove-me \n',
      lineBasedMatch: true,
    },
    {
      name: 'replacing a fuzzy line before a blank line',
      content: 'before\nremove-me \n\nafter\n',
      oldString: 'remove-me\n',
      newString: 'replacement\n',
      canonical: 'remove-me \n',
      lineBasedMatch: true,
    },
    {
      name: 'matching a multiline string before a blank line',
      content: 'before\nconst value = `first \nsecond`;\n\nafter\n',
      oldString: 'const value = `first\nsecond`;\n',
      newString: 'const value = `replacement`;\n',
      canonical: 'const value = `first \nsecond`;\n',
      lineBasedMatch: true,
    },
    {
      name: 'consuming only the requested multiple newlines',
      content: 'before\nremove-me \n\n\nafter\n',
      oldString: 'remove-me\n\n',
      newString: '',
      canonical: 'remove-me \n\n',
      lineBasedMatch: true,
    },
    {
      name: 'preserving a following whitespace-only line',
      content: 'before\nremove-me \n \nafter\n',
      oldString: 'remove-me\n',
      newString: '',
      canonical: 'remove-me \n',
      lineBasedMatch: true,
    },
    {
      name: 'matching a fuzzy line at EOF with a newline',
      content: 'before\nremove-me \n',
      oldString: 'remove-me\n',
      newString: '',
      canonical: 'remove-me \n',
      lineBasedMatch: true,
    },
    {
      name: 'preserving a literal match before a blank line',
      content: 'before\nremove-me\n\nafter\n',
      oldString: 'remove-me\n',
      newString: '',
      canonical: 'remove-me\n',
      lineBasedMatch: false,
    },
    {
      name: 'matching without a requested final newline',
      content: 'before\nremove-me \n\nafter\n',
      oldString: 'remove-me  ',
      newString: '',
      canonical: 'remove-me ',
      lineBasedMatch: true,
    },
  ])('does not extend the matched slice when $name', (testCase) => {
    expect(
      normalizeEditStrings(
        testCase.content,
        testCase.oldString,
        testCase.newString,
      ),
    ).toEqual({
      oldString: testCase.canonical,
      newString: testCase.newString,
      ...(testCase.lineBasedMatch ? { lineBasedMatch: true } : {}),
    });
  });

  it('keeps the fuzzy EOF fallback newline adjustment', () => {
    expect(
      normalizeEditStrings(
        'before\nremove-me ',
        'remove-me\n',
        'replacement\n',
      ),
    ).toEqual({
      oldString: 'remove-me ',
      newString: 'replacement',
      lineBasedMatch: true,
    });
  });

  it('keeps repeated fuzzy lines visible to occurrence counting', () => {
    const content = 'a \n\na \nb\n';
    const normalized = normalizeEditStrings(content, 'a\n', 'replacement\n');

    expect(normalized).toEqual({
      oldString: 'a \n',
      newString: 'replacement\n',
      lineBasedMatch: true,
    });
    expect(countOccurrences(content, normalized.oldString)).toBe(2);
    expect(findLineBasedMatchOffsets(content, normalized.oldString)).toEqual([
      0, 4,
    ]);
  });

  // Tests for issue #1618: Preserve trailing whitespace in newString
  describe('trailing whitespace preservation in newString', () => {
    it('preserves trailing whitespace when intentionally adding to end of line', () => {
      // Test with tab
      const result1 = normalizeEditStrings(
        'value = 1;\n',
        'value = 1;\n',
        'value = 1;\t\n',
      );
      expect(result1.newString).toBe('value = 1;\t\n');

      // Test with spaces (same behavior, just different whitespace char)
      const result2 = normalizeEditStrings('text\n', 'text\n', 'text   \n');
      expect(result2.newString).toBe('text   \n');
    });

    it('preserves newString trailing whitespace even when oldString is fuzzy matched', () => {
      const result = normalizeEditStrings(
        'value = 1;\n', // File has no trailing spaces
        'value = 1;   \n', // LLM copied with extra spaces (will be fuzzy matched)
        'value = 2;   \n', // LLM replacement also has spaces
      );
      expect(result).toEqual({
        oldString: 'value = 1;\n', // Canonical from file
        newString: 'value = 2;   \n', // Preserved as LLM intended
        lineBasedMatch: true,
      });
    });

    it('preserves trailing whitespace in multi-line template literals', () => {
      const file = 'const s = "";\n';
      const result = normalizeEditStrings(
        file,
        'const s = "";',
        'const s = `line1  \nline2`;', // Trailing spaces after line1 are significant
      );
      expect(result.newString).toBe('const s = `line1  \nline2`;');
    });

    it('preserves trailing whitespace when creating new file', () => {
      const result = normalizeEditStrings(
        null,
        '',
        'content with trailing tab\t\n',
      );
      expect(result).toEqual({
        oldString: '',
        newString: 'content with trailing tab\t\n',
      });
    });

    it('still supports fuzzy matching after trailing whitespace was added in previous edit', () => {
      // Round 1: Add trailing spaces to a line
      let fileContent = 'value = 1;\n';
      const round1 = normalizeEditStrings(
        fileContent,
        'value = 1;\n',
        'value = 1;   \n', // Adding trailing spaces
      );
      expect(round1.newString).toBe('value = 1;   \n');

      // Simulate the edit being applied
      fileContent = fileContent.replace(round1.oldString, round1.newString);
      expect(fileContent).toBe('value = 1;   \n'); // File now has trailing spaces

      // Round 2: LLM tries to edit again, but its oldString doesn't have trailing spaces
      // (because LLM context may not preserve exact whitespace)
      const round2 = normalizeEditStrings(
        fileContent,
        'value = 1;\n', // LLM thinks there's no trailing spaces
        'value = 2;\n',
      );
      // Fuzzy matching should still find the line and return canonical slice WITH trailing spaces
      expect(round2.oldString).toBe('value = 1;   \n');
      expect(round2.newString).toBe('value = 2;\n');
    });
  });
});

describe('findLineBasedMatchOffsets', () => {
  it.each([
    [' a \na \n', 'a \n', [4]],
    ['a extra\na \n', 'a ', [8]],
    [' a \na ', 'a ', [4]],
    [' a\na\na', 'a\na', [3]],
    ['x\n\n\n', '\n\n', [2]],
    ['abc', '', []],
  ])(
    'keeps whole-line canonical matches in %j',
    (source, canonical, expected) => {
      expect(findLineBasedMatchOffsets(source, canonical)).toEqual(expected);
    },
  );
});

describe('countOccurrences', () => {
  it('returns zero when substring empty or missing', () => {
    expect(countOccurrences('abc', '')).toBe(0);
    expect(countOccurrences('abc', 'z')).toBe(0);
  });

  it('counts non-overlapping occurrences', () => {
    expect(countOccurrences('aaaa', 'aa')).toBe(2);
  });
});

describe('maybeAugmentOldStringForDeletion', () => {
  const file = 'console.log("hi")\nconsole.log("bye")\n';

  it('appends newline when deleting text followed by newline', () => {
    expect(
      maybeAugmentOldStringForDeletion(file, 'console.log("hi")', ''),
    ).toBe('console.log("hi")\n');
  });

  it('leaves strings untouched when not deleting', () => {
    expect(
      maybeAugmentOldStringForDeletion(
        file,
        'console.log("hi")',
        'replacement',
      ),
    ).toBe('console.log("hi")');
  });

  it('does not append newline when file lacks the variant', () => {
    expect(
      maybeAugmentOldStringForDeletion(
        'console.log("hi")',
        'console.log("hi")',
        '',
      ),
    ).toBe('console.log("hi")');
  });

  it('no-ops when the old string already ends with a newline', () => {
    expect(
      maybeAugmentOldStringForDeletion(file, 'console.log("bye")\n', ''),
    ).toBe('console.log("bye")\n');
  });
});
