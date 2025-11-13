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

  it('returns literal matches unchanged and trims new_string trailing whitespace', () => {
    const result = normalizeEditStrings(
      file,
      'const two = 2;',
      '  const two = 42;  ',
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
      'const greeting = “Hello”;   ',
    );
    expect(result).toEqual({
      oldString: "const greeting = 'Don't';",
      newString: 'const greeting = “Hello”;',
    });
  });

  it('falls back to original strings when no match is found', () => {
    const result = normalizeEditStrings(file, 'missing text', 'replacement');
    expect(result).toEqual({
      oldString: 'missing text',
      newString: 'replacement',
    });
  });

  it('still trims new_string when editing a brand-new file', () => {
    const result = normalizeEditStrings(null, '', 'new file contents   ');
    expect(result).toEqual({
      oldString: '',
      newString: 'new file contents',
    });
  });

  it('matches unicode dash variants', () => {
    const result = normalizeEditStrings(
      'const range = "1-2";\n',
      'const range = "1\u20132";',
      'const range = "3\u20135";   ',
    );
    expect(result).toEqual({
      oldString: 'const range = "1-2";',
      newString: 'const range = "3\u20135";',
    });
  });

  it('matches when trailing whitespace differs only at line ends', () => {
    const result = normalizeEditStrings(
      'value = 1;\n',
      'value = 1;   \n',
      'value = 2;   \n',
    );
    expect(result).toEqual({
      oldString: 'value = 1;\n',
      newString: 'value = 2;\n',
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
