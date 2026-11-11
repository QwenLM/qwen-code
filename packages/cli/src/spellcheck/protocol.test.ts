/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildCheckerArgs,
  encodeCheckLine,
  isSendableWord,
  isValidDictionaryName,
  parseBanner,
  parseResponseLine,
} from './protocol.js';

describe('buildCheckerArgs', () => {
  it('asks each engine for pipe mode with UTF-8', () => {
    expect(buildCheckerArgs('aspell')).toEqual([
      '-a',
      '--encoding=utf-8',
      '--sug-mode=ultra',
    ]);
    expect(buildCheckerArgs('hunspell')).toEqual(['-a', '-i', 'utf-8']);
    expect(buildCheckerArgs('ispell')).toEqual(['-a']);
  });

  it('passes a dictionary through each engine own flag', () => {
    expect(buildCheckerArgs('aspell', 'en_GB')).toContain('--lang=en_GB');
    expect(buildCheckerArgs('hunspell', 'en_GB').slice(-2)).toEqual([
      '-d',
      'en_GB',
    ]);
    expect(buildCheckerArgs('ispell', 'en_GB')).toEqual(['-a', '-d', 'en_GB']);
  });
});

describe('parseBanner', () => {
  it('reads the engine out of the greeting', () => {
    expect(
      parseBanner(
        '@(#) International Ispell Version 3.1.20 (but really Aspell 0.60.8)',
      ),
    ).toBe('aspell');
    expect(
      parseBanner(
        '@(#) International Ispell Version 3.2.06 (but really Hunspell 1.7.2)',
      ),
    ).toBe('hunspell');
    expect(parseBanner('@(#) International Ispell Version 3.1.20')).toBe(
      'ispell',
    );
  });

  it('rejects anything that is not a checker greeting', () => {
    expect(parseBanner('bash: aspell: command not found')).toBeNull();
    expect(parseBanner('')).toBeNull();
  });
});

describe('encodeCheckLine', () => {
  it('escapes the line so words cannot be read as commands', () => {
    expect(encodeCheckLine(['helo', 'wrold'])).toBe('^helo wrold\n');
    // Without the `^` this would add "add" to the checker's dictionary.
    expect(encodeCheckLine(['*add'])).toBe('^*add\n');
  });
});

describe('parseResponseLine', () => {
  it('reads a blank line as the end of a batch', () => {
    expect(parseResponseLine('')).toEqual({ type: 'end' });
  });

  it('reads the correct-word markers', () => {
    expect(parseResponseLine('*')).toEqual({ type: 'correct' });
    expect(parseResponseLine('+ derive')).toEqual({ type: 'correct' });
    expect(parseResponseLine('-')).toEqual({ type: 'correct' });
  });

  it('reads a misspelling with suggestions', () => {
    expect(parseResponseLine('& helo 3 0: hello, halo, help')).toEqual({
      type: 'misspelled',
      word: 'helo',
    });
    expect(parseResponseLine('? helo 0 0: hello')).toEqual({
      type: 'misspelled',
      word: 'helo',
    });
  });

  it('reads a misspelling without suggestions', () => {
    expect(parseResponseLine('# wrold 6')).toEqual({
      type: 'misspelled',
      word: 'wrold',
    });
  });

  it('flags anything outside the protocol', () => {
    expect(parseResponseLine('Segmentation fault')).toEqual({
      type: 'unrecognized',
    });
  });
});

describe('isValidDictionaryName', () => {
  it('accepts plain dictionary names', () => {
    expect(isValidDictionaryName('en')).toBe(true);
    expect(isValidDictionaryName('en_GB')).toBe(true);
    expect(isValidDictionaryName('de-1996')).toBe(true);
    // hunspell -d takes a comma-separated list.
    expect(isValidDictionaryName('en_US,de_DE')).toBe(true);
  });

  it('rejects anything that could be an argument or a path', () => {
    expect(isValidDictionaryName('../../etc/passwd')).toBe(false);
    expect(isValidDictionaryName('--lang=x')).toBe(false);
    expect(isValidDictionaryName('en US')).toBe(false);
    expect(isValidDictionaryName('')).toBe(false);
    expect(isValidDictionaryName('a'.repeat(65))).toBe(false);
  });
});

describe('isSendableWord', () => {
  it('rejects words that would break the request line', () => {
    expect(isSendableWord('hello')).toBe(true);
    expect(isSendableWord('two words')).toBe(false);
    expect(isSendableWord('with\ttab')).toBe(false);
    expect(isSendableWord('')).toBe(false);
    expect(isSendableWord('a'.repeat(129))).toBe(false);
  });
});
