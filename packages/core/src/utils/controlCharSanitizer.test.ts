/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeTerminalOutput,
  sanitizeAnsiOutput,
} from './controlCharSanitizer.js';

describe('sanitizeTerminalOutput', () => {
  it('should handle empty strings', () => {
    expect(sanitizeTerminalOutput('')).toBe('');
    expect(sanitizeTerminalOutput(null as unknown as string)).toBeNull();
  });

  it('should normalize Windows line endings', () => {
    expect(sanitizeTerminalOutput('line1\r\nline2\r\nline3')).toBe(
      'line1\nline2\nline3',
    );
  });

  it('should handle standalone carriage returns', () => {
    expect(sanitizeTerminalOutput('progress:\rupdating...')).toBe(
      'progress:\nupdating...',
    );
  });

  it('should preserve tabs and newlines', () => {
    expect(sanitizeTerminalOutput('col1\tcol2\nrow2')).toBe('col1\tcol2\nrow2');
  });

  it('should remove NULL characters', () => {
    expect(sanitizeTerminalOutput('text\x00more')).toBe('textmore');
  });

  it('should remove backspace characters', () => {
    expect(sanitizeTerminalOutput('text\x08more')).toBe('textmore');
  });

  it('should remove vertical tab and form feed', () => {
    expect(sanitizeTerminalOutput('text\x0B\x0Cmore')).toBe('textmore');
  });

  it('should remove escape sequences', () => {
    expect(sanitizeTerminalOutput('text\x0E\x1Fmore')).toBe('textmore');
  });

  it('should handle mixed control characters', () => {
    expect(
      sanitizeTerminalOutput('line1\r\n\x00line2\rupdating\x08fixed'),
    ).toBe('line1\nline2\nupdatingfixed');
  });

  it('should handle real-world command output', () => {
    const windowsOutput =
      'C:\\Users>dir\r\n Volume in drive C has no label.\r\n\r\n Directory of C:\\Users';
    expect(sanitizeTerminalOutput(windowsOutput)).toBe(
      'C:\\Users>dir\n Volume in drive C has no label.\n\n Directory of C:\\Users',
    );
  });
});

describe('sanitizeAnsiOutput', () => {
  it('should handle empty AnsiOutput', () => {
    expect(sanitizeAnsiOutput([])).toEqual([]);
  });

  it('should sanitize text tokens', () => {
    const input = [
      [
        {
          text: 'line1\r\nline2',
          bold: false,
          italic: false,
          underline: false,
          dim: false,
          inverse: false,
          fg: '',
          bg: '',
        },
        {
          text: '\ttabbed',
          bold: false,
          italic: false,
          underline: false,
          dim: false,
          inverse: false,
          fg: '',
          bg: '',
        },
      ],
    ];
    const expected = [
      [
        {
          text: 'line1\nline2',
          bold: false,
          italic: false,
          underline: false,
          dim: false,
          inverse: false,
          fg: '',
          bg: '',
        },
        {
          text: '\ttabbed',
          bold: false,
          italic: false,
          underline: false,
          dim: false,
          inverse: false,
          fg: '',
          bg: '',
        },
      ],
    ];
    expect(sanitizeAnsiOutput(input)).toEqual(expected);
  });
});
