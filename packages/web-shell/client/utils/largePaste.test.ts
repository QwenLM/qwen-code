/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { MAX_FILE_ATTACHMENT_DATA_BYTES } from './imageIngestion';
import {
  countTextLines,
  createPastedTextFile,
  PASTE_FOLD_MIN_CHARS,
  PASTE_FOLD_MIN_LINES,
  PASTE_TITLE_MAX_CHARS,
  pastedTextTitle,
  shouldFoldPastedText,
} from './largePaste';

describe('countTextLines', () => {
  it('counts a single unterminated line as one', () => {
    expect(countTextLines('a')).toBe(1);
    expect(countTextLines('')).toBe(1);
  });

  it('counts a trailing newline as opening a new line', () => {
    expect(countTextLines('a\n')).toBe(2);
    expect(countTextLines('a\nb')).toBe(2);
  });
});

describe('shouldFoldPastedText', () => {
  it('keeps content under both thresholds inline', () => {
    expect(
      shouldFoldPastedText('line\n'.repeat(PASTE_FOLD_MIN_LINES - 2) + 'line'),
    ).toBe(false);
    expect(shouldFoldPastedText('x'.repeat(PASTE_FOLD_MIN_CHARS - 1))).toBe(
      false,
    );
  });

  it('folds exactly at the line threshold', () => {
    const text = `${'line\n'.repeat(PASTE_FOLD_MIN_LINES - 1)}line`;
    expect(countTextLines(text)).toBe(PASTE_FOLD_MIN_LINES);
    expect(shouldFoldPastedText(text)).toBe(true);
  });

  it('folds a single long line at the character threshold', () => {
    expect(shouldFoldPastedText('x'.repeat(PASTE_FOLD_MIN_CHARS))).toBe(true);
  });

  it('folds one minified line that carries megabytes', () => {
    expect(shouldFoldPastedText('x'.repeat(5_000_000))).toBe(true);
  });

  it('keeps a paste above the attachment limit inline', () => {
    const text = 'x'.repeat(MAX_FILE_ATTACHMENT_DATA_BYTES + 1);
    expect(shouldFoldPastedText(text)).toBe(false);
  });

  it('measures the attachment limit in bytes, not characters', () => {
    // Three bytes per character, so this is over the limit while its character
    // count is not.
    const text = '中'.repeat(Math.ceil(MAX_FILE_ATTACHMENT_DATA_BYTES / 3));
    expect(text.length).toBeLessThan(MAX_FILE_ATTACHMENT_DATA_BYTES);
    expect(shouldFoldPastedText(text)).toBe(false);
  });

  it('folds a paste exactly at the attachment limit', () => {
    expect(
      shouldFoldPastedText('x'.repeat(MAX_FILE_ATTACHMENT_DATA_BYTES)),
    ).toBe(true);
  });

  it('folds a paste that ends with a newline at the line threshold', () => {
    expect(
      shouldFoldPastedText('line\n'.repeat(PASTE_FOLD_MIN_LINES - 1)),
    ).toBe(true);
  });

  it('does not fold empty or whitespace-only input', () => {
    expect(shouldFoldPastedText('')).toBe(false);
    expect(shouldFoldPastedText('   \n  ')).toBe(false);
  });
});

describe('createPastedTextFile', () => {
  it('builds a text card with the byte size of its content', () => {
    const file = createPastedTextFile('hello\nworld', new Set());
    expect(file).toEqual({
      name: 'hello world.txt',
      media_type: 'text/plain',
      text: 'hello\nworld',
      size: 11,
    });
  });

  it('sizes multibyte content in bytes, not characters', () => {
    expect(createPastedTextFile('中文', new Set()).size).toBe(6);
  });

  it('deduplicates a repeated name against the cards already present', () => {
    const taken = new Set(['x.txt']);
    expect(createPastedTextFile('x', taken).name).toBe('x (1).txt');
  });

  it('keeps the .txt extension so the daemon resolves the content as text', () => {
    expect(createPastedTextFile('x', new Set()).name).toMatch(/\.txt$/);
  });

  it('falls back to the constant stem when there is no content to name it', () => {
    expect(createPastedTextFile('   \n'.repeat(200), new Set()).name).toBe(
      'pasted-text.txt',
    );
  });
});

describe('pastedTextTitle', () => {
  it('uses the beginning of the content', () => {
    expect(pastedTextTitle('ERROR refused\nstack\nmore', 'pasted.txt')).toBe(
      'ERROR refused stack more',
    );
  });

  it('continues past a one-word first line', () => {
    const title = pastedTextTitle(
      'import\n  spawn from child_process\n',
      'pasted.txt',
    );
    // The one-word first line is not the whole title: it runs into the next.
    expect(title).toContain('import spawn');
    expect(title).not.toContain('\n');
  });

  it('collapses runs of whitespace', () => {
    expect(pastedTextTitle('  spaced   \t\n\n  out  ', 'pasted.txt')).toBe(
      'spaced out',
    );
  });

  it('reaches past a gap narrower than the scan window', () => {
    expect(pastedTextTitle('Summary\n\n\npayload', 'pasted.txt')).toBe(
      'Summary payload',
    );
  });

  it('marks a title the scan window cut short', () => {
    // The gap is far wider than the window (and wider than any plausible
    // retuning of it), so the content that resumes after it is out of reach:
    // the title has to say it is not the whole beginning.
    expect(
      pastedTextTitle(`Summary${' '.repeat(2_000)}payload`, 'pasted.txt'),
    ).toBe('Summary…');
  });

  it('falls back to the name when there is no content to show', () => {
    expect(pastedTextTitle('\n\n   \n', 'pasted.txt')).toBe('pasted.txt');
    expect(pastedTextTitle('', 'pasted.txt')).toBe('pasted.txt');
  });

  it('clips a long content run to the character budget', () => {
    const title = pastedTextTitle('x'.repeat(500), 'pasted.txt');
    expect(title).toBe(`${'x'.repeat(PASTE_TITLE_MAX_CHARS)}…`);
  });

  it('keeps content at the budget unclipped', () => {
    const line = 'y'.repeat(PASTE_TITLE_MAX_CHARS);
    expect(pastedTextTitle(line, 'pasted.txt')).toBe(line);
  });

  it('clips once the collapsed content passes the budget', () => {
    const line = 'y'.repeat(PASTE_TITLE_MAX_CHARS);
    expect(pastedTextTitle(`${line}\nmore`, 'pasted.txt')).toBe(`${line}…`);
  });

  it('does not split a surrogate pair when clipping', () => {
    const title = pastedTextTitle('😀'.repeat(100), 'pasted.txt');
    expect(title).toBe(`${'😀'.repeat(PASTE_TITLE_MAX_CHARS / 2)}…`);
    // A clip that lands between the halves drops the stray half.
    expect(pastedTextTitle(`a${'😀'.repeat(100)}`, 'pasted.txt')).toBe(
      `a${'😀'.repeat(PASTE_TITLE_MAX_CHARS / 2 - 1)}…`,
    );
  });

  it('leaves only characters the attachment sanitizer keeps', () => {
    // The title is the card's attachment name, so a slash has to survive the
    // sanitizer's leading-path rule and the rest its invalid-character rule.
    expect(pastedTextTitle('src/utils/largePaste.ts', 'pasted.txt')).toBe(
      'src utils largePaste.ts',
    );
    expect(pastedTextTitle('https://example.com/x', 'pasted.txt')).toBe(
      'https example.com x',
    );
  });

  it('drops a lone surrogate the scan window cut in half', () => {
    // The window is measured in code units, so it can end between the halves of
    // one astral character — and a lone half survives neither a file name nor
    // the URI the attachment token is built from.
    const title = pastedTextTitle(`a${' '.repeat(94)}😀b`, 'pasted.txt');
    expect(title).toBe('a…');
    expect(/[\uD800-\uDFFF]/u.test(title)).toBe(false);
  });
});
