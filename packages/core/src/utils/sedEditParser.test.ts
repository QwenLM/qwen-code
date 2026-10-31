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

  // GNU sed anchors ^ right after \( or \|, and $ right before \) or \|
  // (escaped or raw). Measured against GNU sed 4.9: s/\(^foo\)/Z/ on
  // "xxfoo\nfoo\n" writes "xxfoo\nZ\n", and s/\(foo$\)/Z/ writes
  // "xxZ\nZ\nfoobar\n". A live anchor that shares an alternation is declined
  // below: JavaScript's leftmost-first choice is not POSIX leftmost-longest.
  it('anchors BRE ^ and $ at group boundaries', () => {
    expect(applySed("sed -i 's/\\(^foo\\)/Z/' f.txt", 'xxfoo\nfoo\n')).toBe(
      'xxfoo\nZ\n',
    );
    expect(
      applySed("sed -i 's/\\(foo$\\)/Z/' f.txt", 'xxfoo\nfoo\nfoobar\n'),
    ).toBe('xxZ\nZ\nfoobar\n');
    expect(
      applySed("sed -i 's/\\(^foo$\\)/Z/' f.txt", 'foo\nfoobar\nxfoo\n'),
    ).toBe('Z\nfoobar\nxfoo\n');
    // ^ that is not the first character of the group stays a literal.
    expect(applySed("sed -i 's/\\(a^b\\)/X/' f.txt", 'a^b\n')).toBe('X\n');
    // An even run of backslashes is a literal \, so "(^" is not a group.
    expect(applySed("sed -i 's/\\\\(^/X/' f.txt", 'a\\(^b\n(^b\n')).toBe(
      'aXb\n(^b\n',
    );
    // The same even run before | keeps "^" literal (pattern a\\|^b).
    expect(applySed("sed -i 's/a\\\\|^b/X/' f.txt", 'a\\|^b\n')).toBe('X\n');
    // Same-length branches still agree with sed when ^ sits outside them.
    expect(
      applySed("sed -i 's/^foo\\(a\\|b\\)/Z/' f.txt", 'fooa\nfoob\nxfooa\n'),
    ).toBe('Z\nZ\nxfooa\n');
  });

  it('declines a live anchor inside an alternation', () => {
    expect(
      parseSedEditCommand("sed -i 's/\\(foo$\\|^bar\\)/Z/' f.txt"),
    ).toBeNull();
    expect(parseSedEditCommand("sed -i 's/foo\\|^bar/Z/' f.txt")).toBeNull();
    expect(parseSedEditCommand("sed -i 's/foo$\\|bar/Z/' f.txt")).toBeNull();
    expect(
      parseSedEditCommand("sed -i 's/\\(^\\|TODO\\)/DONE/g' f.txt"),
    ).toBeNull();
    expect(parseSedEditCommand("sed -i 's/\\(^a\\|ab\\)/X/' f.txt")).toBeNull();
    expect(
      parseSedEditCommand("sed -i 's/\\(^ab\\|abc\\)/X/' f.txt"),
    ).toBeNull();
    // The anchor sits in a nested group that is itself a branch.
    expect(
      parseSedEditCommand("sed -i 's/\\(\\(^a\\)\\|ab\\)/X/' f.txt"),
    ).toBeNull();
    // ERE: ^a matches one character and ab matches two, so "ab" diverges.
    expect(parseSedEditCommand("sed -E -i 's/^a|ab/X/' f.txt")).toBeNull();
  });

  // Prefix-overlapping branches disagree even when the anchor is outside
  // the group, and even with no anchor at all. Equal-length branches do not.
  it('declines overlapping alternation branches', () => {
    expect(
      parseSedEditCommand("sed -i 's/\\(^a\\(b\\|bc\\)\\)/X/' f.txt"),
    ).toBeNull();
    expect(
      parseSedEditCommand("sed -i 's/\\(^foo\\(b\\|bar\\)\\)/X/' f.txt"),
    ).toBeNull();
    expect(
      parseSedEditCommand("sed -i 's/^foo\\(a\\|ab\\)/Z/' f.txt"),
    ).toBeNull();
    expect(
      parseSedEditCommand("sed -i 's/foo\\(a\\|ab\\)/Z/' f.txt"),
    ).toBeNull();
    expect(parseSedEditCommand("sed -E -i 's/(^a(b|bc))/X/' f.txt")).toBeNull();
  });

  it('simulates equal-length alternation branches', () => {
    expect(
      parseSedEditCommand("sed -i 's/\\(^a\\(b\\|c\\)\\)/X/' f.txt"),
    ).not.toBeNull();
    expect(applySed("sed -i 's/\\(^a\\(b\\|c\\)\\)/X/' f.txt", 'abc\n')).toBe(
      'Xc\n',
    );
    expect(
      parseSedEditCommand("sed -E -i 's/^foo(a|b)/Z/' f.txt"),
    ).not.toBeNull();
    expect(
      applySed("sed -E -i 's/^foo(a|b)/Z/' f.txt", 'fooa\nfoob\nxfooa\n'),
    ).toBe('Z\nZ\nxfooa\n');
  });

  // GNU sed 4.9 leaves "aa" unchanged for \{1,2\}, \{1,\}, \{0,2\}, and \+,
  // and rewrites both * and \{0,\} as Xa on "aa" (XaX with /g). A nested
  // group keeps the anchor: \(\(^a\)\)\{1,2\} stays "aa", while * rewrites Xa.
  it('declines an anchored group closed by an unsafe quantifier', () => {
    expect(
      parseSedEditCommand("sed -i 's/\\(^#\\)\\{1,2\\} */# /' a.ts"),
    ).toBeNull();
    expect(
      parseSedEditCommand("sed -i 's/\\(^a\\)\\{1,2\\}/X/' a.ts"),
    ).toBeNull();
    expect(parseSedEditCommand("sed -i 's/\\(^a\\)\\+/X/' a.ts")).toBeNull();
    expect(parseSedEditCommand("sed -i 's/\\(^a\\)*/X/' a.ts")).not.toBeNull();
    expect(applySed("sed -i 's/\\(^a\\)*/X/' a.ts", 'aa\n')).toBe('Xa\n');
    expect(applySed("sed -i 's/\\(^a\\)*/X/' a.ts", '\n')).toBe('X\n');
    expect(applySed("sed -i 's/\\(^a\\)*/X/' a.ts", 'ba\n')).toBe('Xba\n');
    expect(
      parseSedEditCommand("sed -i 's/\\(^a\\)\\{0,\\}/X/' a.ts"),
    ).not.toBeNull();
    expect(applySed("sed -i 's/\\(^a\\)\\{0,\\}/X/' a.ts", 'aa\n')).toBe(
      'Xa\n',
    );
    expect(
      parseSedEditCommand("sed -i 's/\\(^a\\)\\{1,\\}/X/' a.ts"),
    ).toBeNull();
    expect(
      parseSedEditCommand("sed -i 's/\\(^a\\)\\{0,2\\}/X/' a.ts"),
    ).toBeNull();
    expect(
      parseSedEditCommand("sed -i 's/\\(\\(^a\\)\\)\\{1,2\\}/X/' a.ts"),
    ).toBeNull();
    expect(
      parseSedEditCommand("sed -i 's/\\(\\(^a\\)\\)*/X/' a.ts"),
    ).not.toBeNull();
    expect(applySed("sed -i 's/\\(\\(^a\\)\\)*/X/' a.ts", 'aa\n')).toBe('Xa\n');
    // No quantifier after the group: GNU sed 4.9 rewrites "ab" to "X".
    expect(applySed("sed -i 's/\\(^a\\)*b/X/' a.ts", 'ab\n')).toBe('X\n');
  });

  // A zero-capable quantifier on an anchored group, followed by another
  // quantifier, is leftmost-longest in GNU sed 4.9. JavaScript keeps a
  // shorter match, so these are handed to real sed.
  it('declines an anchored group with a zero quantifier before later quantified text', () => {
    expect(
      parseSedEditCommand("sed -i 's/\\(^a\\)*\\(ab\\)*/X/' f.txt"),
    ).toBeNull();
    expect(
      parseSedEditCommand("sed -i 's/\\(^a\\)*\\(ab\\)\\?/X/' f.txt"),
    ).toBeNull();
    expect(
      parseSedEditCommand("sed -i 's/\\(^a\\)\\{0,1\\}\\(ab\\)*/X/' f.txt"),
    ).toBeNull();
    expect(
      parseSedEditCommand("sed -i 's/\\(^a\\)\\{0,\\}\\(ab\\)*/X/' f.txt"),
    ).toBeNull();
  });

  // GNU sed 4.9 anchors $ before a raw ) or | only when that marker is not
  // the last character of the pattern. A final ) or | leaves $ literal.
  it('anchors $ before a raw ) or |', () => {
    expect(applySed("sed -i 's/\\(^foo$|bar\\)/Z/' f.txt", 'foo$|bar\n')).toBe(
      'foo$|bar\n',
    );
    expect(applySed("sed -i 's/x$)y/Z/' f.txt", 'x$)y\n')).toBe('x$)y\n');
    expect(applySed("sed -i 's/x$|y/Z/' f.txt", 'x$|y\n')).toBe('x$|y\n');
    expect(applySed("sed -i 's/x$))/Z/' f.txt", 'x$))\n')).toBe('x$))\n');
    expect(applySed("sed -i 's/x$)/Z/' f.txt", 'ax$)b\n')).toBe('aZb\n');
    expect(applySed("sed -i 's/x$|/Z/' f.txt", 'ax$|b\n')).toBe('aZb\n');
    expect(applySed("sed -i 's/x$)/Z/g' f.txt", 'ax$)b\n')).toBe('aZb\n');
    expect(applySed("sed -i 's/x$|/Z/g' f.txt", 'ax$|b\n')).toBe('aZb\n');
    expect(applySed("sed -i 's/(x$)/Z/g' f.txt", 'a(x$)b\n')).toBe('aZb\n');
    expect(applySed("sed -i 's/x$)/Z/g' f.txt", 'x$)\nx$)\n')).toBe('Z\nZ\n');
  });

  // $ followed by \ and a char other than ) or | stays literal. GNU sed 4.9
  // writes X for s/a$\\b/X/ on the bytes a, $, \, b. A helper that treats
  // every $ before \ as an anchor leaves the line unchanged.
  it('keeps $ literal before a backslash that does not escape ) or |', () => {
    expect(applySed("sed -i 's/a$\\\\b/X/' f.txt", 'a$\\b\n')).toBe('X\n');
    // `$` before `\\)` or `\\|` is literal: the byte after `\` is `\`, not
    // `)` or `|`. The `|` here is a literal pipe, not an alternation.
    expect(applySed("sed -i 's/x$\\\\)y/Z/' f.txt", 'x$\\)y\n')).toBe('Z\n');
    expect(applySed("sed -i 's/x$\\\\|y/Z/' f.txt", 'x$\\|y\n')).toBe('Z\n');
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
    // -E goes through the same bracket translation, so the same check
    // declines these.
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

  // A backslash inside a bracket expression is a literal member under -E
  // too; JS read it as an escape. Expected values measured with GNU sed 4.9.
  it('keeps backslashes literal inside bracket expressions under -E', () => {
    // [\[\]] is the class {\, [} followed by a literal ]; sed leaves this
    // input alone, the simulation deleted both brackets.
    expect(applySed("sed -E -i 's/[\\[\\]]//g' f.txt", 'a[b]c')).toBe('a[b]c');
    expect(applySed("sed -E -i 's/[\\+]/X/g' f.txt", 'a + \\ b')).toBe(
      'a X X b',
    );
    expect(applySed("sed -E -i 's/[\\.]/X/g' f.txt", 'a.b\\c')).toBe('aXbXc');
    expect(applySed("sed -E -i 's/[\\]]/X/g' f.txt", 'a\\]b]')).toBe('aXb]');
    // \-c is a range from backslash to c, so it covers b as well.
    expect(applySed("sed -E -i 's/[a\\-c]/X/g' f.txt", 'a-b\\c')).toBe('X-XXX');
  });

  // GNU sed expands \t, \n and friends inside a bracket expression, so
  // [ \t] is a space or a TAB there; the BRE translation read it as a space,
  // backslash or t. Other seds disagree with GNU, so these go to real sed.
  it('declines character escapes inside bracket expressions', () => {
    // On 'bat', sed writes 'bat'; the simulation wrote 'ba'.
    expect(parseSedEditCommand("sed -i 's/[ \\t]*$//' f.txt")).toBeNull();
  });

  it.each(['n', 't', 'r', 'f', 'v', 'a', 'd065', 'o101', 'x41', 'cA'])(
    'declines [\\%s] under BRE and -E',
    (escape) => {
      expect(
        parseSedEditCommand(`sed -i 's/[\\${escape}]/X/g' f.txt`),
      ).toBeNull();
      expect(
        parseSedEditCommand(`sed -E -i 's/[\\${escape}]/X/g' f.txt`),
      ).toBeNull();
    },
  );

  it('still simulates escapes outside brackets and escaped backslashes', () => {
    // Guards over-correcting. GNU sed reads \t outside a bracket as a TAB,
    // as the simulation does; the ] in [a]\t closes the bracket, so that \t
    // is simulated (GNU sed 4.9 writes 'at Xb'); a \\ inside a bracket
    // leaves the t after it literal; and under -E an escaped [ does not
    // open a bracket expression.
    expect(applySed("sed -i 's/a\\tb/X/g' f.txt", 'a\tb')).toBe('X');
    expect(applySed("sed -i 's/[a]\\t/X/' f.txt", 'at a\tb')).toBe('at Xb');
    expect(applySed("sed -E -i 's/[a]\\t/X/' f.txt", 'at a\tb')).toBe('at Xb');
    expect(applySed("sed -i 's/[\\\\t]/X/g' f.txt", 'a\tb\\t')).toBe('a\tbXX');
    expect(applySed("sed -E -i 's/[\\\\t]/X/g' f.txt", 'a\tb\\t')).toBe(
      'a\tbXX',
    );
    expect(applySed("sed -E -i 's/a\\.b/X/g' f.txt", 'a.b axb')).toBe('X axb');
    expect(applySed("sed -E -i 's/\\[a\\]/X/g' f.txt", '[a] a\\]')).toBe(
      'X a\\]',
    );
  });
});
