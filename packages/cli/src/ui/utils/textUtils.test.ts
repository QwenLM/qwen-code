/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type {
  ToolCallConfirmationDetails,
  ToolEditConfirmationDetails,
} from '@qwen-code/qwen-code-core';
import {
  escapeAnsiCtrlCodes,
  sanitizeFilenameForDisplay,
  sanitizeSensitiveText,
  sliceTextByVisualHeight,
} from './textUtils.js';

describe('textUtils', () => {
  describe('sliceTextByVisualHeight', () => {
    it('returns the original text when maxHeight is undefined', () => {
      const sliced = sliceTextByVisualHeight('a\nb\nc', undefined, 10);
      expect(sliced).toEqual({ text: 'a\nb\nc', hiddenLinesCount: 0 });
    });

    it('keeps the tail when overflowing from the top (default)', () => {
      const sliced = sliceTextByVisualHeight('abcdefghijklmnop', 3, 4, {
        minHeight: 2,
        reservedRows: 1,
        overflowDirection: 'top',
      });

      expect(sliced).toEqual({
        text: 'ijkl\nmnop',
        hiddenLinesCount: 2,
      });
    });

    it('keeps the head when overflowing from the bottom', () => {
      const sliced = sliceTextByVisualHeight('a\nb\nc\nd', 3, 80, {
        overflowDirection: 'bottom',
      });

      expect(sliced).toEqual({
        text: 'a\nb\nc',
        hiddenLinesCount: 1,
      });
    });

    it('counts soft wraps in narrow widths as visual rows', () => {
      const sliced = sliceTextByVisualHeight('aaaa\nbbbbbbbb\ncc', 3, 4, {
        overflowDirection: 'bottom',
      });

      expect(sliced.hiddenLinesCount).toBeGreaterThan(0);
      expect(sliced.text.split('\n').length).toBeLessThanOrEqual(3);
    });

    it('subtracts reservedRows before deciding whether to truncate', () => {
      // With reservedRows=1 and maxHeight=3 the visible content budget is 2.
      // A 3-line input must therefore truncate to 2 rows (not return
      // unchanged just because it fits inside the unreserved 3-row budget).
      const sliced = sliceTextByVisualHeight('a\nb\nc', 3, 80, {
        reservedRows: 1,
        overflowDirection: 'bottom',
      });

      expect(sliced).toEqual({ text: 'a\nb', hiddenLinesCount: 1 });
    });
  });

  describe('escapeAnsiCtrlCodes', () => {
    describe('escapeAnsiCtrlCodes string case study', () => {
      it('should replace ANSI escape codes with a visible representation', () => {
        const text = '\u001b[31mHello\u001b[0m';
        const expected = '\\u001b[31mHello\\u001b[0m';
        expect(escapeAnsiCtrlCodes(text)).toBe(expected);

        const text2 = "sh -e 'good && bad# \u001b[9D\u001b[K && good";
        const expected2 = "sh -e 'good && bad# \\u001b[9D\\u001b[K && good";
        expect(escapeAnsiCtrlCodes(text2)).toBe(expected2);
      });

      it('should not change a string with no ANSI codes', () => {
        const text = 'Hello, world!';
        expect(escapeAnsiCtrlCodes(text)).toBe(text);
      });

      it('should handle an empty string', () => {
        expect(escapeAnsiCtrlCodes('')).toBe('');
      });

      describe('toolConfirmationDetails case study', () => {
        it('should sanitize command and rootCommand for exec type', () => {
          const details: ToolCallConfirmationDetails = {
            title: '\u001b[34mfake-title\u001b[0m',
            type: 'exec',
            command: '\u001b[31mmls -l\u001b[0m',
            rootCommand: '\u001b[32msudo apt-get update\u001b[0m',
            onConfirm: async () => {},
          };

          const sanitized = escapeAnsiCtrlCodes(details);

          if (sanitized.type === 'exec') {
            expect(sanitized.title).toBe('\\u001b[34mfake-title\\u001b[0m');
            expect(sanitized.command).toBe('\\u001b[31mmls -l\\u001b[0m');
            expect(sanitized.rootCommand).toBe(
              '\\u001b[32msudo apt-get update\\u001b[0m',
            );
          }
        });

        it('should sanitize properties for edit type', () => {
          const details: ToolCallConfirmationDetails = {
            type: 'edit',
            title: '\u001b[34mEdit File\u001b[0m',
            fileName: '\u001b[31mfile.txt\u001b[0m',
            filePath: '/path/to/\u001b[32mfile.txt\u001b[0m',
            fileDiff:
              'diff --git a/file.txt b/file.txt\n--- a/\u001b[33mfile.txt\u001b[0m\n+++ b/file.txt',
            onConfirm: async () => {},
          } as unknown as ToolEditConfirmationDetails;

          const sanitized = escapeAnsiCtrlCodes(details);

          if (sanitized.type === 'edit') {
            expect(sanitized.title).toBe('\\u001b[34mEdit File\\u001b[0m');
            expect(sanitized.fileName).toBe('\\u001b[31mfile.txt\\u001b[0m');
            expect(sanitized.filePath).toBe(
              '/path/to/\\u001b[32mfile.txt\\u001b[0m',
            );
            expect(sanitized.fileDiff).toBe(
              'diff --git a/file.txt b/file.txt\n--- a/\\u001b[33mfile.txt\\u001b[0m\n+++ b/file.txt',
            );
          }
        });

        it('should sanitize properties for mcp type', () => {
          const details: ToolCallConfirmationDetails = {
            type: 'mcp',
            title: '\u001b[34mCloud Run\u001b[0m',
            serverName: '\u001b[31mmy-server\u001b[0m',
            toolName: '\u001b[32mdeploy\u001b[0m',
            toolDisplayName: '\u001b[33mDeploy Service\u001b[0m',
            onConfirm: async () => {},
          };

          const sanitized = escapeAnsiCtrlCodes(details);

          if (sanitized.type === 'mcp') {
            expect(sanitized.title).toBe('\\u001b[34mCloud Run\\u001b[0m');
            expect(sanitized.serverName).toBe('\\u001b[31mmy-server\\u001b[0m');
            expect(sanitized.toolName).toBe('\\u001b[32mdeploy\\u001b[0m');
            expect(sanitized.toolDisplayName).toBe(
              '\\u001b[33mDeploy Service\\u001b[0m',
            );
          }
        });

        it('should sanitize properties for info type', () => {
          const details: ToolCallConfirmationDetails = {
            type: 'info',
            title: '\u001b[34mWeb Search\u001b[0m',
            prompt: '\u001b[31mSearch for cats\u001b[0m',
            urls: ['https://\u001b[32mgoogle.com\u001b[0m'],
            onConfirm: async () => {},
          };

          const sanitized = escapeAnsiCtrlCodes(details);

          if (sanitized.type === 'info') {
            expect(sanitized.title).toBe('\\u001b[34mWeb Search\\u001b[0m');
            expect(sanitized.prompt).toBe(
              '\\u001b[31mSearch for cats\\u001b[0m',
            );
            expect(sanitized.urls?.[0]).toBe(
              'https://\\u001b[32mgoogle.com\\u001b[0m',
            );
          }
        });
      });

      it('should not change the object if no sanitization is needed', () => {
        const details: ToolCallConfirmationDetails = {
          type: 'info',
          title: 'Web Search',
          prompt: 'Search for cats',
          urls: ['https://google.com'],
          onConfirm: async () => {},
        };

        const sanitized = escapeAnsiCtrlCodes(details);
        expect(sanitized).toBe(details);
      });

      it('should handle nested objects and arrays', () => {
        const details = {
          a: '\u001b[31mred\u001b[0m',
          b: {
            c: '\u001b[32mgreen\u001b[0m',
            d: ['\u001b[33myellow\u001b[0m', { e: '\u001b[34mblue\u001b[0m' }],
          },
          f: 123,
          g: null,
          h: () => '\u001b[35mpurple\u001b[0m',
        };

        const sanitized = escapeAnsiCtrlCodes(details);

        expect(sanitized.a).toBe('\\u001b[31mred\\u001b[0m');
        if (typeof sanitized.b === 'object' && sanitized.b !== null) {
          const b = sanitized.b as { c: string; d: Array<string | object> };
          expect(b.c).toBe('\\u001b[32mgreen\\u001b[0m');
          expect(b.d[0]).toBe('\\u001b[33myellow\\u001b[0m');
          if (typeof b.d[1] === 'object' && b.d[1] !== null) {
            const e = b.d[1] as { e: string };
            expect(e.e).toBe('\\u001b[34mblue\\u001b[0m');
          }
        }
        expect(sanitized.f).toBe(123);
        expect(sanitized.g).toBe(null);
        expect(sanitized.h()).toBe('\u001b[35mpurple\u001b[0m');
      });
    });
  });

  describe('sanitizeFilenameForDisplay', () => {
    it('passes clean filenames through unchanged', () => {
      expect(sanitizeFilenameForDisplay('src/foo.ts')).toBe('src/foo.ts');
      expect(sanitizeFilenameForDisplay('packages/cli/src/index.ts')).toBe(
        'packages/cli/src/index.ts',
      );
      expect(sanitizeFilenameForDisplay('文件.txt')).toBe('文件.txt');
      expect(sanitizeFilenameForDisplay('')).toBe('');
    });

    it('escapes C0 control bytes that bypass escapeAnsiCtrlCodes', () => {
      // Bare \n / \r / NUL / BEL / BS slip past the ANSI regex but would
      // still inject layout breaks or terminal effects in `<Text>`.
      expect(sanitizeFilenameForDisplay('a\nb')).toBe('a\\nb');
      expect(sanitizeFilenameForDisplay('a\rb')).toBe('a\\rb');
      expect(sanitizeFilenameForDisplay('a\tb')).toBe('a\\tb');
      expect(sanitizeFilenameForDisplay('a\bb')).toBe('a\\bb');
      expect(sanitizeFilenameForDisplay('a\fb')).toBe('a\\fb');
      expect(sanitizeFilenameForDisplay('a\x00b')).toBe('a\\u0000b');
      expect(sanitizeFilenameForDisplay('a\x07b')).toBe('a\\u0007b');
    });

    it('escapes DEL (0x7F) and C1 control bytes (0x80–0x9F)', () => {
      expect(sanitizeFilenameForDisplay('a\x7fb')).toBe('a\\u007fb');
      expect(sanitizeFilenameForDisplay('a\x80b')).toBe('a\\u0080b');
      expect(sanitizeFilenameForDisplay('a\x9fb')).toBe('a\\u009fb');
    });

    it('strips multi-byte ANSI CSI sequences', () => {
      // SGR color/reset and cursor movement should not survive to the
      // terminal — `escapeAnsiCtrlCodes` neutralizes the ESC byte, then
      // the control-char pass cleans up any leftover bare C0/C1 bytes.
      const ansi = '\x1b[31mred\x1b[0m';
      const out = sanitizeFilenameForDisplay(ansi);
      expect(out.includes('\x1b')).toBe(false);
      expect(out).toContain('red');
    });

    it('handles a path crafted with mixed C0 controls + ANSI', () => {
      const crafted = `evil\x1b[2K\npath\x00.txt`;
      const out = sanitizeFilenameForDisplay(crafted);
      // No raw C0 / DEL bytes remain in the output.
      for (let i = 0; i < out.length; i++) {
        const code = out.charCodeAt(i);
        expect(code < 0x20 || code === 0x7f).toBe(false);
      }
      expect(out).toContain('evil');
      expect(out).toContain('path');
      expect(out).toContain('.txt');
    });
  });

  describe('sanitizeSensitiveText', () => {
    it('should return text unchanged if no sensitive patterns', () => {
      const text = 'Hello, this is a normal prompt';
      expect(sanitizeSensitiveText(text)).toBe(text);
    });

    it('should redact OpenAI-style API keys', () => {
      const text = 'Use API key sk-1234567890abcdefghijklmnopqrstuv for access';
      expect(sanitizeSensitiveText(text)).toBe(
        'Use API key sk-***REDACTED*** for access',
      );
    });

    it('should redact api_key assignments', () => {
      const text = 'api_key=supersecretkey123456789012';
      expect(sanitizeSensitiveText(text)).toBe('api_key=***REDACTED***');
    });

    it('should redact Bearer tokens', () => {
      const text = 'Authorization: Bearer abc123token456xyz';
      expect(sanitizeSensitiveText(text)).toBe(
        'Authorization: Bearer ***REDACTED***',
      );
    });

    it('should redact password assignments', () => {
      const text = 'password=mysecretpassword123';
      expect(sanitizeSensitiveText(text)).toBe('password=***REDACTED***');
    });

    it('should redact AWS access keys', () => {
      const text = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
      expect(sanitizeSensitiveText(text)).toBe(
        'AWS_ACCESS_KEY_ID=***REDACTED***',
      );
    });

    it('should truncate long text', () => {
      const text = 'a'.repeat(300);
      const result = sanitizeSensitiveText(text, 200);
      expect(result.length).toBe(200);
      expect(result.endsWith('...')).toBe(true);
    });

    it('should handle custom max length', () => {
      const text =
        'This is a test prompt with sk-1234567890abcdefghijklmnopqrstuv';
      const result = sanitizeSensitiveText(text, 20);
      expect(result.length).toBe(20);
      expect(result).toBe('This is a test pr...');
    });

    it('should handle empty string', () => {
      expect(sanitizeSensitiveText('')).toBe('');
    });

    it('should redact multiple sensitive patterns', () => {
      const text =
        'api_key=secretkey12345678901234 and password=mypass123 and sk-test123456789012345678901';
      const result = sanitizeSensitiveText(text);
      expect(result).toContain('***REDACTED***');
      expect(result).not.toContain('secretkey12345678901234');
      expect(result).not.toContain('mypass123');
      expect(result).not.toContain('sk-test123456789012345678901');
    });
  });
});
