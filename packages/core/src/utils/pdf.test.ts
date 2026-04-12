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

vi.mock('./shell-utils.js', () => ({
  execCommand: vi.fn(),
}));

import { execCommand } from './shell-utils.js';
const mockExecCommand = vi.mocked(execCommand);

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
  });

  describe('isPdftotextAvailable', () => {
    it('should return true when pdftotext is available', async () => {
      mockExecCommand.mockResolvedValue({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      expect(await isPdftotextAvailable()).toBe(true);
    });

    it('should return false when pdftotext is not installed', async () => {
      mockExecCommand.mockRejectedValue(new Error('ENOENT'));
      expect(await isPdftotextAvailable()).toBe(false);
    });

    it('should cache the result', async () => {
      mockExecCommand.mockResolvedValue({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      await isPdftotextAvailable();
      await isPdftotextAvailable();
      expect(mockExecCommand).toHaveBeenCalledTimes(1);
    });
  });

  describe('getPDFPageCount', () => {
    it('should return page count from pdfinfo output', async () => {
      mockExecCommand.mockResolvedValue({
        stdout:
          'Title:          Test\nPages:          42\nPage size:      612 x 792 pts',
        stderr: '',
        code: 0,
      });
      expect(await getPDFPageCount('/test.pdf')).toBe(42);
    });

    it('should return null when pdfinfo fails', async () => {
      mockExecCommand.mockResolvedValue({
        stdout: '',
        stderr: 'error',
        code: 1,
      });
      expect(await getPDFPageCount('/test.pdf')).toBeNull();
    });

    it('should return null when pdfinfo is not installed', async () => {
      mockExecCommand.mockRejectedValue(new Error('ENOENT'));
      expect(await getPDFPageCount('/test.pdf')).toBeNull();
    });
  });

  describe('extractPDFText', () => {
    it('should extract text from a PDF', async () => {
      // First call: isPdftotextAvailable check
      mockExecCommand.mockResolvedValueOnce({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      // Second call: actual extraction
      mockExecCommand.mockResolvedValueOnce({
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
      mockExecCommand.mockResolvedValueOnce({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      mockExecCommand.mockResolvedValueOnce({
        stdout: 'Page 2 content',
        stderr: '',
        code: 0,
      });

      await extractPDFText('/test.pdf', { firstPage: 2, lastPage: 5 });
      expect(mockExecCommand).toHaveBeenLastCalledWith(
        'pdftotext',
        ['-layout', '-f', '2', '-l', '5', '/test.pdf', '-'],
        expect.any(Object),
      );
    });

    it('should not pass lastPage for Infinity', async () => {
      mockExecCommand.mockResolvedValueOnce({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      mockExecCommand.mockResolvedValueOnce({
        stdout: 'Page content',
        stderr: '',
        code: 0,
      });

      await extractPDFText('/test.pdf', { firstPage: 3, lastPage: Infinity });
      expect(mockExecCommand).toHaveBeenLastCalledWith(
        'pdftotext',
        ['-layout', '-f', '3', '/test.pdf', '-'],
        expect.any(Object),
      );
    });

    it('should return error when pdftotext is not installed', async () => {
      mockExecCommand.mockRejectedValue(new Error('ENOENT'));
      const result = await extractPDFText('/test.pdf');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('pdftotext is not installed');
      }
    });

    it('should detect password-protected PDFs', async () => {
      mockExecCommand.mockResolvedValueOnce({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      mockExecCommand.mockResolvedValueOnce({
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
      mockExecCommand.mockResolvedValueOnce({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      mockExecCommand.mockResolvedValueOnce({
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
      mockExecCommand.mockResolvedValueOnce({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      const largeText = 'x'.repeat(200000);
      mockExecCommand.mockResolvedValueOnce({
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
      mockExecCommand.mockResolvedValueOnce({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      mockExecCommand.mockResolvedValueOnce({
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
