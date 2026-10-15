/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { applySedSubstitution, parseSedEditCommand } from './sedEditParser.js';

describe('sedEditParser', () => {
  // Parses `command`, asserting the simulation accepts it.
  const parseOk = (command: string) => {
    const sedInfo = parseSedEditCommand(command);
    expect(sedInfo).not.toBeNull();
    return sedInfo!;
  };
  const applySed = (command: string, input: string) =>
    applySedSubstitution(input, parseOk(command));

  it('parses a simple in-place substitution', () => {
    expect(parseSedEditCommand("sed -i 's/foo/bar/g' src/a.ts")).toEqual({
      filePath: 'src/a.ts',
      pattern: 'foo',
      replacement: 'bar',
      flags: 'g',
      extendedRegex: false,
    });
  });

  it('parses long in-place flag without consuming the expression', () => {
    expect(parseSedEditCommand("sed --in-place 's/foo/bar/' file.txt")).toEqual(
      {
        filePath: 'file.txt',
        pattern: 'foo',
        replacement: 'bar',
        flags: '',
        extendedRegex: false,
      },
    );
  });

  it('rejects macOS empty suffix after the long in-place flag', () => {
    expect(
      parseSedEditCommand("sed --in-place '' 's/foo/bar/' file.txt"),
    ).toBeNull();
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
    const expected = {
      filePath: 'src/a.ts',
      pattern: 'foo|bar',
      replacement: 'baz',
      flags: 'g',
      extendedRegex: true,
    };
    expect(parseSedEditCommand("sed -Ei 's/foo|bar/baz/g' src/a.ts")).toEqual(
      expected,
    );
    expect(parseSedEditCommand("sed -ri 's/foo|bar/baz/g' src/a.ts")).toEqual(
      expected,
    );
    expect(parseSedEditCommand("sed -Eri 's/foo|bar/baz/g' src/a.ts")).toEqual(
      expected,
    );
    expect(
      parseSedEditCommand("sed -iE 's/foo|bar/baz/g' src/a.ts"),
    ).toBeNull();
  });

  // Everything after -i is the backup suffix: -Eir is `-E` plus in-place with
  // an `r` suffix, so real sed writes src/a.tsr. The simulation makes no
  // backup, so these fall through to real sed (as `-i.bak` does below).
  it('rejects combined flags where in-place is not last', () => {
    expect(
      parseSedEditCommand("sed -Eir 's/foo|bar/baz/g' src/a.ts"),
    ).toBeNull();
    expect(
      parseSedEditCommand("sed -riE 's/foo|bar/baz/g' src/a.ts"),
    ).toBeNull();
    expect(parseSedEditCommand("sed -iri 's/foo/bar/' src/a.ts")).toBeNull();
  });

  it('parses expression flag forms', () => {
    const expected = {
      filePath: 'file.txt',
      pattern: 'foo',
      replacement: 'bar',
      flags: '',
      extendedRegex: false,
    };
    expect(parseSedEditCommand("sed -i -e 's/foo/bar/' file.txt")).toEqual(
      expected,
    );
    expect(
      parseSedEditCommand("sed -i --expression 's/foo/bar/' file.txt"),
    ).toEqual(expected);
    expect(
      parseSedEditCommand("sed -i --expression='s/foo/bar/' file.txt"),
    ).toEqual(expected);
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
    expect(applySed("sed -i 's/a\\+/X/g' file.txt", 'aa aaa b')).toBe('X X b');
  });

  it('supports replacement ampersands', () => {
    expect(applySed("sed -i 's/foo/[&]/g' file.txt", 'foo foo')).toBe(
      '[foo] [foo]',
    );
  });

  it('supports escaped replacement ampersands', () => {
    expect(applySed("sed -i 's/foo/\\&/g' file.txt", 'foo foo')).toBe('& &');
  });

  it('supports escaped replacement delimiters', () => {
    expect(applySed("sed -i 's/foo/\\//g' file.txt", 'foo foo')).toBe('/ /');
  });

  it('supports literal backslashes in replacements', () => {
    expect(applySed("sed -i 's/foo/\\\\bar/g' file.txt", 'foo foo')).toBe(
      '\\bar \\bar',
    );
  });

  it('keeps literal backslashes before replacement ampersands', () => {
    expect(applySed("sed -i 's/foo/\\\\&/g' file.txt", 'foo foo')).toBe(
      '\\foo \\foo',
    );
  });

  it('keeps unescaped BRE braces literal', () => {
    expect(applySed("sed -i 's/a{2}/X/g' file.txt", 'aa a{2} aaa')).toBe(
      'aa X aaa',
    );
  });

  it('converts escaped BRE braces to intervals', () => {
    expect(applySed("sed -i 's/a\\{2\\}/X/g' file.txt", 'aa a{2} aaa')).toBe(
      'X a{2} Xa',
    );
  });

  it('keeps BRE operators literal inside bracket expressions', () => {
    expect(applySed("sed -i 's/[\\+]/X/g' file.txt", 'a + \\ b')).toBe(
      'a X X b',
    );
  });

  it('keeps non-position BRE anchors literal', () => {
    expect(applySed("sed -i 's/a^/X/g' file.txt", 'a^ a')).toBe('X a');
    expect(applySed("sed -i 's/a$-/X/g' file.txt", 'a$- a')).toBe('X a');
  });

  it('applies non-global substitutions once per line', () => {
    expect(applySed("sed -i 's/foo/bar/' file.txt", 'foo foo\nfoo foo')).toBe(
      'bar foo\nbar foo',
    );
  });

  it('supports numeric occurrences and capture replacements', () => {
    expect(
      applySed("sed -E -i 's/(foo)/[\\1]/2' file.txt", 'foo foo foo'),
    ).toBe('foo [foo] foo');
  });

  it('rejects replacement backrefs without matching capture groups', () => {
    expect(parseSedEditCommand("sed -i 's/foo/\\1/' file.txt")).toBeNull();
    expect(parseSedEditCommand("sed -E -i 's/(a)b/\\2/g' file.txt")).toBeNull();
    expect(
      parseSedEditCommand("sed -E -i 's/(a)(b)/\\1\\3/g' file.txt"),
    ).toBeNull();
    expect(
      parseSedEditCommand("sed -E -i 's/(a)(b)/\\2\\1/g' file.txt"),
    ).not.toBeNull();
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
    expect(applySed("sed -i 's/foo$/bar/' file.txt", 'foo\r\n')).toBe(
      'foo\r\n',
    );
    expect(applySed("sed -i 's/\\r$//g' file.txt", 'foo\r\n')).toBe('foo\n');
  });

  it('applies substitutions to empty lines', () => {
    expect(applySed("sed -i 's/^$/X/g' file.txt", 'line1\n\nline3')).toBe(
      'line1\nX\nline3',
    );
  });

  it('does not process a phantom line after a trailing newline', () => {
    const sedInfo = parseOk("sed -i 's/$/!/g' file.txt");
    expect(applySedSubstitution('', sedInfo)).toBe('');
    expect(applySedSubstitution('hello\n', sedInfo)).toBe('hello!\n');
    expect(applySedSubstitution('\n', sedInfo)).toBe('!\n');
  });

  it('supports multi-digit numeric occurrences', () => {
    expect(
      applySed("sed -i 's/x/y/10' file.txt", 'x x x x x x x x x x x'),
    ).toBe('x x x x x x x x x y x');
  });

  it('supports global substitutions from a numeric occurrence', () => {
    expect(applySed("sed -i 's/foo/bar/2g' file.txt", 'foo foo foo foo')).toBe(
      'foo bar bar bar',
    );
  });

  it('suppresses trailing zero-width global matches like sed', () => {
    expect(applySed("sed -i 's/a*/X/g' file.txt", 'aaa')).toBe('X');
    expect(applySed("sed -i 's/.*/X/g' file.txt", 'aaa')).toBe('X');
  });

  it('suppresses zero-width global matches after non-empty matches like sed', () => {
    expect(applySed("sed -i 's/ */_/g' file.txt", 'a  b c')).toBe('_a_b_c_');
    expect(applySed("sed -i 's/[0-9]*/N/g' file.txt", 'x12y3z')).toBe(
      'NxNyNzN',
    );
    expect(applySed("sed -i 's/a*/X/g' file.txt", 'aabaaa')).toBe('XbX');
  });

  it('applies trailing zero-width matches after prior zero-width matches', () => {
    expect(applySed("sed -i 's/a*/foo/g' file.txt", 'bbb')).toBe(
      'foobfoobfoobfoo',
    );
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

  // In POSIX BRE/ERE a `]` right after `[` or `[^` is a literal member; JS
  // reads `[]` as an empty class and `[^]` as "any character", so simulating
  // would rewrite the file differently. Null hands the command back to real
  // sed. Real-sed behaviour below was measured, not assumed.
  it('declines a bracket expression whose first member is a literal ]', () => {
    // On `a]b`, sed writes `XXb`; the simulation matched nothing at all.
    expect(parseSedEditCommand("sed -i 's/[]a]/X/g' f.txt")).toBeNull();
    // On `a]b`, sed writes `X]X`; the simulation wrote `Xb`, losing a byte,
    // because JS reads `[^]` as "any character" and leaves `]` a literal.
    expect(parseSedEditCommand("sed -i 's/[^]]/X/g' f.txt")).toBeNull();
  });

  it('declines the same bracket expressions under -E', () => {
    // The -E path hands the pattern to RegExp untouched, so it diverges the
    // same way and has to be declined separately.
    expect(parseSedEditCommand("sed -E -i 's/[]a]/X/g' f.txt")).toBeNull();
    expect(parseSedEditCommand("sed -E -i 's/[^]]/X/g' f.txt")).toBeNull();
  });

  it('still simulates ordinary bracket expressions', () => {
    // Guards over-correcting (declining everything would pass the tests
    // above): a non-first `]` and an escaped `[` translate exactly and must
    // keep their fast path.
    expect(applySed("sed -i 's/[abc]/X/g' f.txt", 'a]b')).toBe('X]X');
    expect(applySed("sed -i 's/[^abc]/X/g' f.txt", 'a]b')).toBe('aXb');
    expect(applySed("sed -i 's/a\\[b/X/g' f.txt", 'a[b]c')).toBe('X]c');
  });
});
