/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  detectLineEnding,
  ensureCrlfLineEndings,
} from '../services/fileSystemService.js';
import { safeLiteralReplace } from './textUtils.js';
import {
  applyReplacementPreservingLineEndings,
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

describe('applyReplacementPreservingLineEndings', () => {
  /** The LF-normalized copy EditTool matches against. */
  const normalized = (raw: string) => raw.replace(/\r\n/g, '\n');

  const splice = (raw: string, oldString: string, newString: string) =>
    applyReplacementPreservingLineEndings(
      raw,
      normalized(raw),
      oldString,
      newString,
    );

  it('leaves every line the edit did not touch byte-identical', () => {
    expect(splice('one\ntwo\nthree\r\nfour\n', 'two', 'TWO')).toBe(
      'one\nTWO\nthree\r\nfour\n',
    );
  });

  it('gives inserted text the ending of the text it replaced', () => {
    expect(splice('one\r\ntwo\r\nthree\r\n', 'two', 'TWO\nAGAIN')).toBe(
      'one\r\nTWO\r\nAGAIN\r\nthree\r\n',
    );
  });

  it('is a no-op on a file that is already uniformly LF', () => {
    expect(splice('one\ntwo\nthree\n', 'two', 'TWO\nAGAIN')).toBe(
      'one\nTWO\nAGAIN\nthree\n',
    );
  });

  it('is a no-op on a file that is already uniformly CRLF', () => {
    expect(splice('one\r\ntwo\r\nthree\r\n', 'two', 'TWO\r\nAGAIN')).toBe(
      'one\r\nTWO\r\nAGAIN\r\nthree\r\n',
    );
  });

  it('replaces every occurrence, each taking its own ending', () => {
    expect(splice('a\nb\r\nc\nb\r\n', 'b', 'B')).toBe('a\nB\r\nc\nB\r\n');
  });

  it('keeps a multi-line replacement on one ending style', () => {
    // The old string is matched against the normalized text, so it is spelled
    // with LF here even though the file is CRLF.
    expect(splice('one\r\ntwo\r\nthree\r\n', 'two\nthree', 'TWO')).toBe(
      'one\r\nTWO\r\n',
    );
  });

  it('handles a file with no trailing newline', () => {
    expect(splice('one\r\ntwo', 'two', 'TWO\nAGAIN')).toBe(
      'one\r\nTWO\r\nAGAIN',
    );
  });

  it('keeps the CRLF intact when the match starts on a newline', () => {
    // Normalization drops the `\r` of every CRLF, so a normalized `\n` maps to
    // the raw index of the `\n` and never of the `\r` in front of it. When the
    // match *starts* on such a newline, that `\r` belongs to the match: leaving
    // it in the untouched prefix orphans it, and the inserted text then
    // contributes a break of its own.
    expect(
      splice(
        'const a = 1;\r\nconst b = 2;\r\n',
        '\nconst b = 2;',
        '\nconst B = 2;',
      ),
    ).toBe('const a = 1;\r\nconst B = 2;\r\n');
  });

  it('keeps the CRLF intact when the match starts on a newline in a mixed file', () => {
    expect(
      splice(
        'const a = 1;\nconst b = 2;\r\nconst c = 3;\n',
        '\nconst b = 2;',
        '\nconst B = 2;',
      ),
    ).toBe('const a = 1;\nconst B = 2;\r\nconst c = 3;\n');
  });

  it('replaces every newline-only match, each keeping its own kind', () => {
    // replace_all over a bare newline: the same span shape at every position,
    // so each one has to resolve its own ending rather than inherit the first
    // match's. A matched break is replaced by a break of the same kind, so
    // swapping newlines for newlines leaves the file alone.
    expect(splice('a\r\nb\nc\r\n', '\n', '\n')).toBe('a\r\nb\nc\r\n');
    expect(splice('a\r\nb\r\nc\r\n', '\n', '\n')).toBe('a\r\nb\r\nc\r\n');
    expect(splice('a\nb\rc\n', '\n', '\n')).toBe('a\nb\rc\n');

    // A break the edit adds is new, so it takes the ending of the region it
    // lands in: the matched one keeps its own kind, the added one follows it.
    expect(splice('a\r\nb\nc\r\n', '\n', '\n\n')).toBe(
      'a\r\n\r\nb\n\nc\r\n\r\n',
    );
  });

  it('keeps the CRLF intact when the match ends on a newline', () => {
    // The mirror image: a match that ends on a newline must not leave the
    // `\r` of that pair behind either.
    expect(
      splice(
        'const a = 1;\r\nconst b = 2;\r\n',
        'const a = 1;\n',
        'const A = 1;\n',
      ),
    ).toBe('const A = 1;\r\nconst b = 2;\r\n');
  });

  it('matches the previous write path byte for byte on uniform files', () => {
    // The promise this change makes is that a file which is already uniformly LF
    // or uniformly CRLF comes out exactly as it did before: `main` replaced on
    // the normalized text and then let `prepareTextFileContent` re-expand it to
    // the file's single style. Reproduce that here and compare, rather than
    // trusting a couple of hand-picked cases.
    const uniform = [
      'const a = 1;\nconst b = 2;\nconst c = 3;\n',
      'one\n\nthree\nfour\n',
      'x = 1\n',
      'a\nb\nc\nd\ne\n',
    ];
    const uniformCrlf = [
      'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n',
      'one\r\n\r\nthree\r\nfour\r\n',
      'x = 1\r\n',
      'a\r\nb\r\nc\r\nd\r\ne\r\n',
    ];
    const edits: Array<[string, string]> = [
      ['const b = 2;', 'const B = 2;'],
      ['const a = 1;\n', 'const A = 1;\n'],
      ['\nconst b = 2;', '\nconst B = 2;'],
      ['const b = 2;\n', ''],
      ['const a = 1;\nconst b = 2;', 'const B = 2;\nconst A = 1;'],
      ['const b = 2;', 'const B = 2;\nconst extra = 3;'],
      ['one', 'ONE\ninserted'],
      // An edit that starts on the first line and stops mid-line, with ordinary
      // text between it and the break that ends that line. Nothing above reaches
      // that shape: the other entries either sit on a later line or run right up
      // to a break, and both of those find an ending without a fallback.
      ['const a', 'const A\nextra = 0;'],
      ['const a = 1;', 'const A = 1;\nconst b = 0;'],
    ];

    const previous = (raw: string, oldString: string, newString: string) => {
      const replaced = safeLiteralReplace(
        raw.replace(/\r\n/g, '\n'),
        oldString,
        newString,
      );
      return detectLineEnding(raw) === 'crlf'
        ? ensureCrlfLineEndings(replaced)
        : replaced;
    };

    for (const file of [...uniform, ...uniformCrlf]) {
      for (const [oldString, newString] of edits) {
        if (!normalized(file).includes(oldString)) {
          continue;
        }
        expect(
          applyReplacementPreservingLineEndings(
            file,
            normalized(file),
            oldString,
            newString,
          ),
        ).toBe(previous(file, oldString, newString));
      }
    }
  });

  it('returns the file unchanged when the old string is absent', () => {
    expect(splice('one\ntwo\n', 'three', 'THREE')).toBe('one\ntwo\n');
  });

  it('returns the file unchanged for an empty old string', () => {
    expect(splice('one\ntwo\n', '', 'inserted')).toBe('one\ntwo\n');
  });

  it('deletes a line without gluing it to the next one', () => {
    expect(splice('one\r\ntwo\r\nthree\r\n', 'two\n', '')).toBe(
      'one\r\nthree\r\n',
    );
  });

  it('gives an edit on the first line the ending of the file', () => {
    // The span starts at offset 0, so there is no break in front of it, and it
    // stops mid-line, so there is no break right after it either. The only
    // remaining source of an ending is the file itself, and this one is CRLF
    // throughout -- so the breaks the edit introduces have to be CRLF too. An LF
    // here would leave the file with mixed endings and nothing downstream would
    // correct it.
    expect(
      splice('const a = 1;\r\nconst b = 2;\r\n', 'const a', 'CONST\nA'),
    ).toBe('CONST\r\nA = 1;\r\nconst b = 2;\r\n');
  });

  it('gives an edit on the first line the ending of a mixed file', () => {
    // Same shape, but the file's first break is LF and a later one is CRLF. The
    // first ending is the closest thing to a verdict this position has.
    expect(splice('one\r\ntwo\r\nthree\nfour\n', 'one', 'ONE\nAGAIN')).toBe(
      'ONE\r\nAGAIN\r\ntwo\r\nthree\nfour\n',
    );
  });

  it('stays linear when replacing every match on one long line', () => {
    // `replace_all` over a file that is essentially a single line used to rescan
    // backwards to the previous break for every match, which made the whole
    // operation quadratic in the file size -- a 256 KB input took about 8.5 s
    // and 512 KB about 42 s, with the loop synchronous throughout, so the event
    // loop was blocked for the duration. Carrying the preceding break forward
    // makes it linear: the same 256 KB now takes about 0.16 s and 512 KB about
    // 0.6 s.
    //
    // 256 KB is the size used rather than the reviewer's 1 MB because the point is
    // a threshold this test can assert, not the largest input that fits: 8.5 s
    // before the change is comfortably over the 2.5 s budget and 0.16 s after it
    // is comfortably under, so the assertion is not sensitive to a slow machine.
    const raw = 'var x=1;'.repeat(29_136) + '\r\n';
    const started = performance.now();
    const out = applyReplacementPreservingLineEndings(
      raw,
      normalized(raw),
      'var',
      'let',
    );
    const elapsed = performance.now() - started;

    // Correctness first: every match replaced, and no ending invented.
    expect(out.startsWith('let x=1;')).toBe(true);
    expect(out).not.toContain('var');
    expect(out.match(/(?<!\r)\n/g)).toBeNull();
    expect(elapsed).toBeLessThan(2500);
  });
});
