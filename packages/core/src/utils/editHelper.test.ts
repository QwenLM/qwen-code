/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  countOccurrences,
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
    });
  });

  it.each([
    {
      name: 'deleting a fuzzy line before a blank line',
      content: 'before\nremove-me \n\nafter\n',
      oldString: 'remove-me\n',
      newString: '',
      canonical: 'remove-me \n',
    },
    {
      name: 'replacing a fuzzy line before a blank line',
      content: 'before\nremove-me \n\nafter\n',
      oldString: 'remove-me\n',
      newString: 'replacement\n',
      canonical: 'remove-me \n',
    },
    {
      name: 'matching a multiline string before a blank line',
      content: 'before\nconst value = `first \nsecond`;\n\nafter\n',
      oldString: 'const value = `first\nsecond`;\n',
      newString: 'const value = `replacement`;\n',
      canonical: 'const value = `first \nsecond`;\n',
    },
    {
      name: 'consuming only the requested multiple newlines',
      content: 'before\nremove-me \n\n\nafter\n',
      oldString: 'remove-me\n\n',
      newString: '',
      canonical: 'remove-me \n\n',
    },
    {
      name: 'preserving a following whitespace-only line',
      content: 'before\nremove-me \n \nafter\n',
      oldString: 'remove-me\n',
      newString: '',
      canonical: 'remove-me \n',
    },
    {
      name: 'matching a fuzzy line at EOF with a newline',
      content: 'before\nremove-me \n',
      oldString: 'remove-me\n',
      newString: '',
      canonical: 'remove-me \n',
    },
    {
      name: 'preserving a literal match before a blank line',
      content: 'before\nremove-me\n\nafter\n',
      oldString: 'remove-me\n',
      newString: '',
      canonical: 'remove-me\n',
    },
    {
      name: 'matching without a requested final newline',
      content: 'before\nremove-me \n\nafter\n',
      oldString: 'remove-me  ',
      newString: '',
      canonical: 'remove-me ',
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
    });
  });

  it('keeps the fuzzy EOF fallback newline adjustment', () => {
    expect(
      normalizeEditStrings(
        'before\nremove-me ',
        'remove-me\n',
        'replacement\n',
      ),
    ).toEqual({ oldString: 'remove-me ', newString: 'replacement' });
  });

  it('keeps repeated fuzzy lines visible to occurrence counting', () => {
    const content = 'a \n\na \nb\n';
    const normalized = normalizeEditStrings(content, 'a\n', 'replacement\n');

    expect(normalized).toEqual({
      oldString: 'a \n',
      newString: 'replacement\n',
    });
    expect(countOccurrences(content, normalized.oldString)).toBe(2);
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
