import { describe, expect, it } from 'vitest';
import {
  DIFF_INVISIBLE_CHARACTERS,
  DIFF_MERGE_INVISIBLE_CHARACTERS,
  escapeDiffContent,
  escapeInvisibleForMerge,
  escapePairForMerge,
} from './diffContent';

describe('escapeInvisibleForMerge', () => {
  it('keeps every line terminator verbatim', () => {
    // This text is handed to CodeMirror as a document, so CR and LF are
    // structure, not content. Escaping CR turned every row of a CRLF file into
    // `alpha\r` in the narrow merge layout while the wide layout rendered the
    // same file clean — terminator noise on 100% of rows, and a resize across
    // the 720px breakpoint flipped it.
    const crlf = 'alpha\r\nbeta\r\ngamma\r\n';
    expect(escapeInvisibleForMerge(crlf)).toBe(crlf);
    expect(escapeInvisibleForMerge('a\nb\n')).toBe('a\nb\n');
    // A tab is rendered as text by the view layer; escaping it would change
    // the column layout the diff is compared over.
    expect(escapeInvisibleForMerge('\ta\t')).toBe('\ta\t');
  });

  it('still neutralises the characters that can hide content inside a line', () => {
    expect(escapeInvisibleForMerge('a\u200bb')).toBe('a\\u200bb');
    expect(escapeInvisibleForMerge('a\u202eb')).toBe('a\\u202eb');
    expect(escapeInvisibleForMerge('a\u0000b')).toBe('a\\u0000b');
    expect(escapeInvisibleForMerge('a\u001bb')).toBe('a\\u001bb');
  });

  it('is injective: a real invisible character never collides with its own escape text', () => {
    // The merge view compares these documents. A non-injective transform made a
    // real U+200B and the literal text `\\u200b` byte-identical, so a file that
    // changed was reported as unchanged context, while the file-list badge -
    // computed from the raw texts - still said +1/-1.
    const pairs: Array<[string, string]> = [
      ['a\u200bb', 'a\\u200bb'],
      ['a\u200db', 'a\\u200db'],
      ['a\u202eb', 'a\\u202eb'],
      ['a\u0000b', 'a\\u0000b'],
    ];
    for (const [real, literal] of pairs) {
      expect(escapeInvisibleForMerge(real)).not.toBe(
        escapeInvisibleForMerge(literal),
      );
    }
    // The real character keeps a single backslash; the literal keeps two.
    expect(escapeInvisibleForMerge('a\u200bb')).toBe('a\\u200bb');
    expect(escapeInvisibleForMerge('a\\u200bb')).toBe('a\\\\u200bb');
  });

  it('differs from the decoration class on exactly the structural set', () => {
    // The two classes differ on CR alone: LF and TAB were never in either, so
    // CR is the one character that reached a document as a literal escape.
    // The decoration layer keeps it (a row is rendered as text anyway); this
    // one must not, because it builds the document.
    const marks = (pattern: RegExp, character: string): boolean => {
      pattern.lastIndex = 0;
      return pattern.test(character);
    };
    expect(marks(DIFF_INVISIBLE_CHARACTERS, '\r')).toBe(true);
    expect(marks(DIFF_MERGE_INVISIBLE_CHARACTERS, '\r')).toBe(false);
    expect(marks(DIFF_INVISIBLE_CHARACTERS, '\n')).toBe(false);
    expect(marks(DIFF_MERGE_INVISIBLE_CHARACTERS, '\n')).toBe(false);
    expect(marks(DIFF_MERGE_INVISIBLE_CHARACTERS, '\u200b')).toBe(true);
    expect(escapeDiffContent('\r')).toBe('\\r');
  });
});

describe('escapePairForMerge', () => {
  it('leaves ordinary text alone rather than rewriting every backslash', () => {
    // Doubling a backslash is the price of injectivity, and it must only be
    // paid by a file that needs neutralising. Charging every file rendered
    // `/\\d+/` for a regex written `/\d+/`, `C:\\tmp` for a path written
    // `C:\tmp` and `"\\n"` for `"\n"` in the narrow artifact pane, while the
    // wide branch fifteen lines away showed the raw bytes — one artifact,
    // two contents, flipped by dragging the split handle past 720px.
    const pair = escapePairForMerge(
      'C:\\tmp\\file.txt',
      'const re = /^\\d+$/;',
    );
    expect(pair.oldText).toBe('C:\\tmp\\file.txt');
    expect(pair.newText).toBe('const re = /^\\d+$/;');
  });

  it('escapes both sides once either side carries an invisible character', () => {
    expect(escapePairForMerge('a\u200bb', 'ab')).toEqual({
      oldText: 'a\\u200bb',
      newText: 'ab',
    });
  });

  it('keeps a real invisible character distinct from its escape literal', () => {
    // The decision is taken over the pair for exactly this shape. Decided per
    // side, the literal `\u200b` on the right would stay raw while the real
    // U+200B on the left escaped to the same characters — the merge view would
    // report "unchanged" for a file that changed, which is the defect the
    // doubling exists to prevent.
    const pair = escapePairForMerge('a\u200bb', 'a\\u200bb');
    expect(pair.oldText).toBe('a\\u200bb');
    expect(pair.newText).toBe('a\\\\u200bb');
    expect(pair.oldText).not.toBe(pair.newText);
  });
});
