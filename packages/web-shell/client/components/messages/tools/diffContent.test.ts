import { describe, expect, it } from 'vitest';
import {
  DIFF_INVISIBLE_CHARACTERS,
  DIFF_MERGE_INVISIBLE_CHARACTERS,
  escapeDiffContent,
  escapeInvisibleForMerge,
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
