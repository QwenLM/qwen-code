/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { insertSessionAnswerSeparator } from './session-answer-argv.js';

describe('insertSessionAnswerSeparator', () => {
  it('inserts -- between the session id and a free-text payload', () => {
    expect(
      insertSessionAnswerSeparator([
        'sessions',
        'answer',
        '0f8e1c42',
        'yes, go ahead',
      ]),
    ).toEqual(['sessions', 'answer', '0f8e1c42', '--', 'yes, go ahead']);
  });

  it('fences a payload that quotes help/version tokens', () => {
    // The three shapes from issue #11193's reproduction table.
    expect(
      insertSessionAnswerSeparator([
        'sessions',
        'answer',
        '0f8e1c42',
        'please',
        '--help',
        'me',
      ]),
    ).toEqual([
      'sessions',
      'answer',
      '0f8e1c42',
      '--',
      'please',
      '--help',
      'me',
    ]);
    expect(
      insertSessionAnswerSeparator([
        'sessions',
        'answer',
        '0f8e1c42',
        'yes',
        'please',
        'help',
      ]),
    ).toEqual([
      'sessions',
      'answer',
      '0f8e1c42',
      '--',
      'yes',
      'please',
      'help',
    ]);
    expect(
      insertSessionAnswerSeparator([
        'sessions',
        'answer',
        '0f8e1c42',
        'please',
        '--version',
        'now',
      ]),
    ).toEqual([
      'sessions',
      'answer',
      '0f8e1c42',
      '--',
      'please',
      '--version',
      'now',
    ]);
  });

  it('does not touch other commands or unprefixed argv', () => {
    const untouched: string[][] = [
      ['--help'],
      ['--version'],
      ['sessions', 'list'],
      ['sessions', 'ps', '--json'],
      ['mcp', 'remove', 'victim', '-v', 'help'],
      ['peek', '0f8e1c42'],
      ['answer', '0f8e1c42', 'yes'],
    ];
    for (const argv of untouched) {
      expect(insertSessionAnswerSeparator(argv)).toEqual(argv);
    }
  });

  it('keeps a missing or flag-like session id for the parser to reject', () => {
    expect(insertSessionAnswerSeparator(['sessions', 'answer'])).toEqual([
      'sessions',
      'answer',
    ]);
    // `qwen sessions answer --help` (no id) still routes to the command's
    // help; the demandOption error for a missing id is yargs' to raise.
    expect(
      insertSessionAnswerSeparator(['sessions', 'answer', '--help']),
    ).toEqual(['sessions', 'answer', '--help']);
    expect(insertSessionAnswerSeparator(['sessions', 'answer', '-v'])).toEqual([
      'sessions',
      'answer',
      '-v',
    ]);
  });

  it('keeps a bare --help payload showing help (the documented carve-out)', () => {
    expect(
      insertSessionAnswerSeparator([
        'sessions',
        'answer',
        '0f8e1c42',
        '--help',
      ]),
    ).toEqual(['sessions', 'answer', '0f8e1c42', '--help']);
    expect(
      insertSessionAnswerSeparator(['sessions', 'answer', '0f8e1c42', '-h']),
    ).toEqual(['sessions', 'answer', '0f8e1c42', '-h']);
    // Only the bare form: `--help` with a sibling token is answer text.
    expect(
      insertSessionAnswerSeparator([
        'sessions',
        'answer',
        '0f8e1c42',
        '--help',
        'me',
      ]),
    ).toEqual(['sessions', 'answer', '0f8e1c42', '--', '--help', 'me']);
  });

  it('does not double a user-supplied separator', () => {
    expect(
      insertSessionAnswerSeparator([
        'sessions',
        'answer',
        '0f8e1c42',
        '--',
        '--force',
      ]),
    ).toEqual(['sessions', 'answer', '0f8e1c42', '--', '--force']);
  });

  it('leaves an id with no payload alone', () => {
    expect(
      insertSessionAnswerSeparator(['sessions', 'answer', '0f8e1c42']),
    ).toEqual(['sessions', 'answer', '0f8e1c42']);
  });

  it('returns a new array only when it inserts', () => {
    const untouched = ['sessions', 'answer', '0f8e1c42'];
    expect(insertSessionAnswerSeparator(untouched)).toBe(untouched);
    const fenced = insertSessionAnswerSeparator([...untouched, 'yes']);
    expect(fenced).not.toBe(untouched);
    expect(untouched).toEqual(['sessions', 'answer', '0f8e1c42']);
  });
});
