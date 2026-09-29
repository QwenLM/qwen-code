/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { TaskOutputSanitizer } from './task-output-sanitizer.js';

describe('TaskOutputSanitizer', () => {
  it.each([
    ['A\x1b\x1b]0;t\x07D', 'AD'],
    ['A\x1b\x1b[31mD', 'AD'],
    ['A\x1b\u0085D', 'AD'],
    ['A\x1b[31\u0085Deploying\n', 'ADeploying\n'],
    ['A\x1b\x1bPpayload\x1b\\M', 'AM'],
    ['A\x1b\x1b]0;t\x07[ERROR] boom', 'A[ERROR] boom'],
    ['\x1b[31\x0bmred', 'red'],
    ['\x1b[3\x00mred', 'red'],
    ['\x1b[\u00ff mred', 'red'],
    ['a\x1b[31\x18b', 'ab'],
    ['a\x1b[31\x1ab', 'ab'],
    ['a\x1b[31\x7fmb', 'ab'],
    ['a\x1b\\b', 'ab'],
    ['\x1bPtmux;\x1b\x1b[31mRED\x1b\x1b\\', 'RED'],
    ['a\u009d0;title\u009cb', 'ab'],
    ['a\u0090payload\u009cb', 'ab'],
    ['a\u009b31mb', 'ab'],
    ['a\x1b]title\x18b', 'ab'],
    ['a\x1b]title\nreal line', 'a\nreal line'],
    ['plain\t中文\nline\r\n', 'plain\t中文\nline\r\n'],
  ])('sanitizes %j consistently at every chunk boundary', (input, expected) => {
    expect(new TaskOutputSanitizer().write(input)).toBe(expected);
    for (let split = 0; split <= input.length; split++) {
      const sanitizer = new TaskOutputSanitizer();
      expect(
        sanitizer.write(input.slice(0, split)) +
          sanitizer.write(input.slice(split)),
      ).toBe(expected);
    }
  });

  it.each(['', '\x1b', '\x1b[31', '\x1b(', '\x1b]title'])(
    'treats C1 single controls equally in both encodings after %j',
    (prefix) => {
      for (let code = 0x40; code <= 0x5f; code++) {
        if ('PX[\\]^_'.includes(String.fromCharCode(code))) continue;
        for (const control of [
          `\x1b${String.fromCharCode(code)}`,
          String.fromCharCode(code + 0x40),
        ]) {
          expect(new TaskOutputSanitizer().write(`a${prefix}${control}b`)).toBe(
            'ab',
          );
        }
      }
    },
  );

  it.each(['\x07', '\x1b\\', '\u009c', '\x18', '\x1a'])(
    'ends an oversized string on %j',
    (terminator) => {
      const sanitizer = new TaskOutputSanitizer();
      expect(sanitizer.write('before\x1b]52;')).toBe('before');
      for (let i = 0; i < 20; i++)
        expect(sanitizer.write('x'.repeat(4096))).toBe('');
      expect(sanitizer.write(terminator + 'after')).toBe('after');
      expect(sanitizer.hasPendingSequence).toBe(false);
    },
  );
});
