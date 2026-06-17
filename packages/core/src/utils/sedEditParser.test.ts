/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { applySedSubstitution, parseSedEditCommand } from './sedEditParser.js';

describe('sedEditParser', () => {
  it('parses a simple in-place substitution', () => {
    expect(parseSedEditCommand("sed -i 's/foo/bar/g' src/a.ts")).toEqual({
      filePath: 'src/a.ts',
      pattern: 'foo',
      replacement: 'bar',
      flags: 'g',
      extendedRegex: false,
    });
  });

  it('keeps regex end anchors supported', () => {
    expect(parseSedEditCommand("sed -i 's/foo$/bar/' src/a.ts")).toEqual({
      filePath: 'src/a.ts',
      pattern: 'foo$',
      replacement: 'bar',
      flags: '',
      extendedRegex: false,
    });
  });

  it('parses macOS empty suffix and extended regex flags', () => {
    expect(
      parseSedEditCommand("sed -i '' -E 's/foo|bar/baz/g' src/a.ts"),
    ).toEqual({
      filePath: 'src/a.ts',
      pattern: 'foo|bar',
      replacement: 'baz',
      flags: 'g',
      extendedRegex: true,
    });
  });

  it('parses safe combined in-place and extended regex flags', () => {
    expect(parseSedEditCommand("sed -Ei 's/foo|bar/baz/g' src/a.ts")).toEqual({
      filePath: 'src/a.ts',
      pattern: 'foo|bar',
      replacement: 'baz',
      flags: 'g',
      extendedRegex: true,
    });
    expect(parseSedEditCommand("sed -ri 's/foo|bar/baz/g' src/a.ts")).toEqual({
      filePath: 'src/a.ts',
      pattern: 'foo|bar',
      replacement: 'baz',
      flags: 'g',
      extendedRegex: true,
    });
    expect(
      parseSedEditCommand("sed -iE 's/foo|bar/baz/g' src/a.ts"),
    ).toBeNull();
  });

  it('parses expression flag forms', () => {
    expect(parseSedEditCommand("sed -i -e 's/foo/bar/' file.txt")).toEqual({
      filePath: 'file.txt',
      pattern: 'foo',
      replacement: 'bar',
      flags: '',
      extendedRegex: false,
    });
    expect(
      parseSedEditCommand("sed -i --expression 's/foo/bar/' file.txt"),
    ).toEqual({
      filePath: 'file.txt',
      pattern: 'foo',
      replacement: 'bar',
      flags: '',
      extendedRegex: false,
    });
    expect(
      parseSedEditCommand("sed -i --expression='s/foo/bar/' file.txt"),
    ).toEqual({
      filePath: 'file.txt',
      pattern: 'foo',
      replacement: 'bar',
      flags: '',
      extendedRegex: false,
    });
    expect(parseSedEditCommand('sed -i -e')).toBeNull();
  });

  it('rejects command chains, globs, multiple files, and unsafe flags', () => {
    expect(
      parseSedEditCommand("sed -i 's/foo/bar/' a.ts && echo done"),
    ).toBeNull();
    expect(parseSedEditCommand("sed -i 's/foo/bar/' *.ts")).toBeNull();
    expect(parseSedEditCommand("sed -i 's/foo/bar/' a.ts b.ts")).toBeNull();
    expect(parseSedEditCommand("sed -n -i 's/foo/bar/' a.ts")).toBeNull();
    expect(parseSedEditCommand("sed -i.bak 's/foo/bar/' a.ts")).toBeNull();
    expect(parseSedEditCommand("sed -i 's/foo/bar/e' a.ts")).toBeNull();
    expect(parseSedEditCommand("sed -i 's/foo/bar/p' a.ts")).toBeNull();
    expect(parseSedEditCommand("sed -i 's/foo/bar/I' a.ts")).toBeNull();
    expect(parseSedEditCommand("sed -i 's/foo/bar/1g2' a.ts")).toBeNull();
    expect(parseSedEditCommand("sed -i 's/foo/bar/' $FILE")).toBeNull();
    expect(parseSedEditCommand('sed -i "s/$FOO/bar/" a.ts')).toBeNull();
    expect(parseSedEditCommand('sed -i "s/$1/bar/" a.ts')).toBeNull();
    expect(parseSedEditCommand('sed -i "s/$(whoami)/root/" a.ts')).toBeNull();
    expect(parseSedEditCommand("sed -i 's/`whoami`/root/' a.ts")).toBeNull();
    expect(parseSedEditCommand("sed -i 's/[//g' a.ts")).toBeNull();
    expect(parseSedEditCommand("sed -i 's//bar/' a.ts")).toBeNull();
    expect(parseSedEditCommand("sed -i 's/foo/\\n/' a.ts")).toBeNull();
  });

  it('applies supported sed substitutions', () => {
    const sedInfo = parseSedEditCommand("sed -i 's/a\\+/X/g' file.txt");

    expect(sedInfo).not.toBeNull();
    expect(applySedSubstitution('aa aaa b', sedInfo!)).toBe('X X b');
  });

  it('supports replacement ampersands', () => {
    const sedInfo = parseSedEditCommand("sed -i 's/foo/[&]/g' file.txt");

    expect(sedInfo).not.toBeNull();
    expect(applySedSubstitution('foo foo', sedInfo!)).toBe('[foo] [foo]');
  });

  it('supports escaped replacement ampersands', () => {
    const sedInfo = parseSedEditCommand("sed -i 's/foo/\\&/g' file.txt");

    expect(sedInfo).not.toBeNull();
    expect(applySedSubstitution('foo foo', sedInfo!)).toBe('& &');
  });

  it('supports escaped replacement delimiters', () => {
    const slashSedInfo = parseSedEditCommand("sed -i 's/foo/\\//g' file.txt");

    expect(slashSedInfo).not.toBeNull();
    expect(applySedSubstitution('foo foo', slashSedInfo!)).toBe('/ /');
  });

  it('supports literal backslashes in replacements', () => {
    const sedInfo = parseSedEditCommand("sed -i 's/foo/\\\\bar/g' file.txt");

    expect(sedInfo).not.toBeNull();
    expect(applySedSubstitution('foo foo', sedInfo!)).toBe('\\bar \\bar');
  });

  it('keeps literal backslashes before replacement ampersands', () => {
    const sedInfo = parseSedEditCommand("sed -i 's/foo/\\\\&/g' file.txt");

    expect(sedInfo).not.toBeNull();
    expect(applySedSubstitution('foo foo', sedInfo!)).toBe('\\foo \\foo');
  });

  it('keeps unescaped BRE braces literal', () => {
    const sedInfo = parseSedEditCommand("sed -i 's/a{2}/X/g' file.txt");

    expect(sedInfo).not.toBeNull();
    expect(applySedSubstitution('aa a{2} aaa', sedInfo!)).toBe('aa X aaa');
  });

  it('converts escaped BRE braces to intervals', () => {
    const sedInfo = parseSedEditCommand("sed -i 's/a\\{2\\}/X/g' file.txt");

    expect(sedInfo).not.toBeNull();
    expect(applySedSubstitution('aa a{2} aaa', sedInfo!)).toBe('X a{2} Xa');
  });

  it('applies non-global substitutions once per line', () => {
    const sedInfo = parseSedEditCommand("sed -i 's/foo/bar/' file.txt");

    expect(sedInfo).not.toBeNull();
    expect(applySedSubstitution('foo foo\nfoo foo', sedInfo!)).toBe(
      'bar foo\nbar foo',
    );
  });

  it('supports numeric occurrences and capture replacements', () => {
    const sedInfo = parseSedEditCommand("sed -E -i 's/(foo)/[\\1]/2' file.txt");

    expect(sedInfo).not.toBeNull();
    expect(applySedSubstitution('foo foo foo', sedInfo!)).toBe('foo [foo] foo');
  });

  it('rejects nested quantifier patterns before simulated edits', () => {
    expect(parseSedEditCommand("sed -E -i 's/(a*)*b/X/g' file.txt")).toBeNull();
  });

  it('rejects quantified alternation groups before simulated edits', () => {
    expect(
      parseSedEditCommand("sed -E -i 's/(a|aa)*b/X/g' file.txt"),
    ).toBeNull();
  });

  it('rejects POSIX bracket expressions before simulated edits', () => {
    expect(
      parseSedEditCommand("sed -i 's/[[:space:]]*$//' file.txt"),
    ).toBeNull();
    expect(
      parseSedEditCommand("sed -i 's/[[:digit:]]/X/g' file.txt"),
    ).toBeNull();
  });

  it('rejects sed escapes that diverge in JavaScript regexes', () => {
    expect(parseSedEditCommand("sed -i 's/\\d/X/g' file.txt")).toBeNull();
    expect(parseSedEditCommand("sed -i 's/\\</X/g' file.txt")).toBeNull();
    expect(parseSedEditCommand("sed -i 's/\\>/X/g' file.txt")).toBeNull();
  });

  it('preserves carriage returns in sed pattern space', () => {
    const anchoredSedInfo = parseSedEditCommand(
      "sed -i 's/foo$/bar/' file.txt",
    );
    const crSedInfo = parseSedEditCommand("sed -i 's/\\r$//g' file.txt");

    expect(anchoredSedInfo).not.toBeNull();
    expect(crSedInfo).not.toBeNull();
    expect(applySedSubstitution('foo\r\n', anchoredSedInfo!)).toBe('foo\r\n');
    expect(applySedSubstitution('foo\r\n', crSedInfo!)).toBe('foo\n');
  });

  it('applies substitutions to empty lines', () => {
    const sedInfo = parseSedEditCommand("sed -i 's/^$/X/g' file.txt");

    expect(sedInfo).not.toBeNull();
    expect(applySedSubstitution('line1\n\nline3', sedInfo!)).toBe(
      'line1\nX\nline3',
    );
  });

  it('does not process a phantom line after a trailing newline', () => {
    const sedInfo = parseSedEditCommand("sed -i 's/$/!/g' file.txt");

    expect(sedInfo).not.toBeNull();
    expect(applySedSubstitution('', sedInfo!)).toBe('');
    expect(applySedSubstitution('hello\n', sedInfo!)).toBe('hello!\n');
    expect(applySedSubstitution('\n', sedInfo!)).toBe('!\n');
  });

  it('supports multi-digit numeric occurrences', () => {
    const sedInfo = parseSedEditCommand("sed -i 's/x/y/10' file.txt");

    expect(sedInfo).not.toBeNull();
    expect(applySedSubstitution('x x x x x x x x x x x', sedInfo!)).toBe(
      'x x x x x x x x x y x',
    );
  });

  it('supports global substitutions from a numeric occurrence', () => {
    const sedInfo = parseSedEditCommand("sed -i 's/foo/bar/2g' file.txt");

    expect(sedInfo).not.toBeNull();
    expect(applySedSubstitution('foo foo foo foo', sedInfo!)).toBe(
      'foo bar bar bar',
    );
  });

  it('suppresses trailing zero-width global matches like sed', () => {
    const starSedInfo = parseSedEditCommand("sed -i 's/a*/X/g' file.txt");
    const lineSedInfo = parseSedEditCommand("sed -i 's/.*/X/g' file.txt");

    expect(starSedInfo).not.toBeNull();
    expect(lineSedInfo).not.toBeNull();
    expect(applySedSubstitution('aaa', starSedInfo!)).toBe('X');
    expect(applySedSubstitution('aaa', lineSedInfo!)).toBe('X');
  });

  it('throws when direct sed simulation cannot compile the pattern', () => {
    expect(() =>
      applySedSubstitution('foo', {
        filePath: 'file.txt',
        pattern: '[',
        replacement: 'bar',
        flags: '',
        extendedRegex: true,
      }),
    ).toThrow(/sed pattern simulation failed/);
  });
});
