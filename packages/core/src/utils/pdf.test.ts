/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parsePDFPageRange,
  isPdftotextAvailable,
  getPDFPageCount,
  extractPDFText,
  resetPdftotextCache,
} from './pdf.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
const mockExecFile = vi.mocked(execFile);

/**
 * Helper: make mockExecFile resolve with given stdout/stderr/code.
 */
function mockExecResult(result: {
  stdout: string;
  stderr: string;
  code: number;
}) {
  mockExecFile.mockImplementationOnce(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      const callback = cb as (
        err: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      if (result.code !== 0) {
        const err = new Error('command failed') as Error & { code: number };
        err.code = result.code;
        callback(err, result.stdout, result.stderr);
      } else {
        callback(null, result.stdout, result.stderr);
      }
      return {} as ReturnType<typeof execFile>;
    },
  );
}

/**
 * Helper: make mockExecFile reject (e.g., ENOENT).
 */
function mockExecError() {
  mockExecFile.mockImplementationOnce(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      const callback = cb as (
        err: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      const err = new Error('ENOENT') as Error & { code: string };
      err.code = 'ENOENT';
      callback(err, '', '');
      return {} as ReturnType<typeof execFile>;
    },
  );
}

describe('pdf utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPdftotextCache();
  });

  describe('parsePDFPageRange', () => {
    it('should parse a single page', () => {
      expect(parsePDFPageRange('5')).toEqual({ firstPage: 5, lastPage: 5 });
    });

    it('should parse a page range', () => {
      expect(parsePDFPageRange('1-10')).toEqual({
        firstPage: 1,
        lastPage: 10,
      });
    });

    it('should parse an open-ended range', () => {
      expect(parsePDFPageRange('3-')).toEqual({
        firstPage: 3,
        lastPage: Infinity,
      });
    });

    it('should handle whitespace', () => {
      expect(parsePDFPageRange('  5  ')).toEqual({
        firstPage: 5,
        lastPage: 5,
      });
    });

    it('should return null for empty string', () => {
      expect(parsePDFPageRange('')).toBeNull();
      expect(parsePDFPageRange('  ')).toBeNull();
    });

    it('should return null for zero page', () => {
      expect(parsePDFPageRange('0')).toBeNull();
    });

    it('should return null for negative page', () => {
      expect(parsePDFPageRange('-1')).toBeNull();
    });

    it('should return null for inverted range', () => {
      expect(parsePDFPageRange('10-5')).toBeNull();
    });

    it('should return null for non-numeric input', () => {
      expect(parsePDFPageRange('abc')).toBeNull();
      expect(parsePDFPageRange('1-abc')).toBeNull();
    });

    it('should reject malformed tokens that parseInt would silently truncate', () => {
      // Whole-string validation — parseInt() would accept each of these.
      expect(parsePDFPageRange('5abc')).toBeNull();
      expect(parsePDFPageRange('1-2-3')).toBeNull();
      expect(parsePDFPageRange('1-2x')).toBeNull();
      expect(parsePDFPageRange('1x-2')).toBeNull();
      expect(parsePDFPageRange('1.5')).toBeNull();
      expect(parsePDFPageRange('1 - 5')).toBeNull();
      expect(parsePDFPageRange('+5')).toBeNull();
    });
  });

  describe('isPdftotextAvailable', () => {
    it('should return true when pdftotext is available', async () => {
      mockExecResult({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      expect(await isPdftotextAvailable()).toBe(true);
    });

    it('should return false when pdftotext is not installed', async () => {
      mockExecError();
      expect(await isPdftotextAvailable()).toBe(false);
    });

    it('should cache the result', async () => {
      mockExecResult({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      await isPdftotextAvailable();
      await isPdftotextAvailable();
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('getPDFPageCount', () => {
    it('should return page count from pdfinfo output', async () => {
      mockExecResult({
        stdout:
          'Title:          Test\nPages:          42\nPage size:      612 x 792 pts',
        stderr: '',
        code: 0,
      });
      expect(await getPDFPageCount('/test.pdf')).toBe(42);
    });

    it('should return null when pdfinfo fails', async () => {
      mockExecResult({
        stdout: '',
        stderr: 'error',
        code: 1,
      });
      expect(await getPDFPageCount('/test.pdf')).toBeNull();
    });

    it('should return null when pdfinfo is not installed', async () => {
      mockExecError();
      expect(await getPDFPageCount('/test.pdf')).toBeNull();
    });
  });

  describe('extractPDFText', () => {
    it('should extract text from a PDF', async () => {
      // First call: isPdftotextAvailable check
      mockExecResult({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      // Second call: actual extraction
      mockExecResult({
        stdout: 'Hello World\nThis is a PDF.',
        stderr: '',
        code: 0,
      });

      const result = await extractPDFText('/test.pdf');
      expect(result).toEqual({
        success: true,
        text: 'Hello World\nThis is a PDF.',
      });
    });

    it('should pass page range options to pdftotext', async () => {
      mockExecResult({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      mockExecResult({
        stdout: 'Page 2 content',
        stderr: '',
        code: 0,
      });

      await extractPDFText('/test.pdf', { firstPage: 2, lastPage: 5 });
      // Second call to execFile should have the page range args
      const secondCall = mockExecFile.mock.calls[1]!;
      const args = secondCall[1] as string[];
      expect(args).toContain('-f');
      expect(args).toContain('2');
      expect(args).toContain('-l');
      expect(args).toContain('5');
    });

    it('should not pass lastPage for Infinity', async () => {
      mockExecResult({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      mockExecResult({
        stdout: 'Page content',
        stderr: '',
        code: 0,
      });

      await extractPDFText('/test.pdf', { firstPage: 3, lastPage: Infinity });
      const secondCall = mockExecFile.mock.calls[1]!;
      const args = secondCall[1] as string[];
      expect(args).toContain('-f');
      expect(args).toContain('3');
      expect(args).not.toContain('-l');
    });

    it('should return error when pdftotext is not installed', async () => {
      mockExecError();
      const result = await extractPDFText('/test.pdf');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('pdftotext is not installed');
      }
    });

    it('should detect password-protected PDFs', async () => {
      mockExecResult({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      mockExecResult({
        stdout: '',
        stderr: 'Incorrect password',
        code: 1,
      });

      const result = await extractPDFText('/test.pdf');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('password-protected');
      }
    });

    it('should detect corrupted PDFs', async () => {
      mockExecResult({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      mockExecResult({
        stdout: '',
        stderr: 'PDF file is damaged',
        code: 1,
      });

      const result = await extractPDFText('/test.pdf');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('corrupted or invalid');
      }
    });

    it('should truncate very large text output', async () => {
      mockExecResult({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      const largeText = 'x'.repeat(200000);
      mockExecResult({
        stdout: largeText,
        stderr: '',
        code: 0,
      });

      const result = await extractPDFText('/test.pdf');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.text.length).toBeLessThan(110000);
        expect(result.text).toContain('text truncated');
        expect(result.text).toContain("'pages' parameter");
      }
    });

    it('should report empty output', async () => {
      mockExecResult({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      mockExecResult({
        stdout: '   ',
        stderr: '',
        code: 0,
      });

      const result = await extractPDFText('/test.pdf');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('no text output');
      }
    });
  });
});
