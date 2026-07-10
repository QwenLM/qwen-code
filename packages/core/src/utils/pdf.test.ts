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
  shouldRequirePDFPageRange,
  estimatePDFTextOutputTokens,
  buildLargePDFGuidance,
  buildPDFTextTooLargeGuidance,
  renderPDFPagesToImages,
  resetPdftoppmCache,
  PDF_RENDER_UNAVAILABLE_MESSAGE,
} from './pdf.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, tmpdir: vi.fn(() => '/tmp') };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdtemp: vi.fn(async () => '/tmp/pdf-render-test'),
    readdir: vi.fn(),
    readFile: vi.fn(),
    rm: vi.fn(async () => undefined),
  };
});

import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
const mockExecFile = vi.mocked(execFile);
const mockReaddir = vi.mocked(readdir);
const mockReadFile = vi.mocked(readFile);

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

/**
 * Helper: simulate Node's maxBuffer overrun — child is killed, partial
 * stdout is delivered, error.code is 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'.
 */
function mockMaxBufferExceeded(partialStdout: string) {
  mockExecFile.mockImplementationOnce(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      const callback = cb as (
        err: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      const err = new Error('stdout maxBuffer length exceeded') as Error & {
        code: string;
      };
      err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      callback(err, partialStdout, '');
      return {} as ReturnType<typeof execFile>;
    },
  );
}

describe('pdf utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPdftotextCache();
    resetPdftoppmCache();
  });

  describe('PDF budget policy helpers', () => {
    it('requires pages when pdfinfo reports more than the full-text page limit', () => {
      expect(shouldRequirePDFPageRange(11, 64 * 1024)).toEqual({
        required: true,
        effectivePageCount: 11,
        hadPdfInfo: true,
      });
    });

    it('does not require pages for small PDFs', () => {
      expect(shouldRequirePDFPageRange(10, 2 * 1024 * 1024)).toEqual({
        required: false,
        effectivePageCount: 10,
        hadPdfInfo: true,
      });
    });

    it('falls back to a size heuristic when pdfinfo is unavailable', () => {
      expect(shouldRequirePDFPageRange(null, 2 * 1024 * 1024)).toEqual({
        required: true,
        effectivePageCount: 21,
        hadPdfInfo: false,
      });
    });

    it('estimates dense ASCII PDF text output tokens with wrapper allowance', () => {
      expect(estimatePDFTextOutputTokens('x'.repeat(64_000))).toBe(16_016);
    });

    it('estimates dense non-ASCII PDF text conservatively', () => {
      expect(estimatePDFTextOutputTokens('\u4e00'.repeat(45_000))).toBe(49_517);
    });

    it('builds exact page-range guidance for pdfinfo-backed and heuristic counts', () => {
      expect(
        buildLargePDFGuidance('paper.pdf', {
          required: true,
          effectivePageCount: 42,
          hadPdfInfo: true,
        }),
      ).toBe(
        "PDF \"paper.pdf\" has 42 pages, which is too many to read at once. Use the 'pages' parameter to read a specific page range such as '1-5'. Maximum 20 pages per request.",
      );
      expect(
        buildLargePDFGuidance('scan.pdf', {
          required: true,
          effectivePageCount: 21,
          hadPdfInfo: false,
        }),
      ).toBe(
        "PDF \"scan.pdf\" appears to have about 21 pages, which is too many to read at once. Use the 'pages' parameter to read a specific page range such as '1-5'. Maximum 20 pages per request.",
      );
    });

    it('builds exact dense-text guidance for range and single-page reads', () => {
      const defaultRangeGuidance =
        "PDF text extracted from \"paper.pdf\" is too large to return safely (12345 estimated tokens; limit 12000). Use the 'pages' parameter with a narrower range, for example '1-2' or a single page.";
      const fivePageRangeGuidance =
        "PDF text extracted from \"paper.pdf\" is too large to return safely (12345 estimated tokens; limit 12000). Use the 'pages' parameter with fewer pages, for example '1-3' or a single page.";
      const twoPageRangeGuidance =
        "PDF text extracted from \"paper.pdf\" is too large to return safely (12345 estimated tokens; limit 12000). Use the 'pages' parameter with a single page, for example '1'.";
      const singlePageGuidance =
        'PDF text extracted from "paper.pdf" is too large to return safely (12345 estimated tokens; limit 12000). The selected page exceeds the output limit. Use a native PDF-capable model, split the page content externally, or extract a smaller section with another tool.';

      expect(buildPDFTextTooLargeGuidance('paper.pdf', 12_345)).toBe(
        defaultRangeGuidance,
      );
      expect(buildPDFTextTooLargeGuidance('paper.pdf', 12_345, '1-5')).toBe(
        fivePageRangeGuidance,
      );
      expect(buildPDFTextTooLargeGuidance('paper.pdf', 12_345, '1-2')).toBe(
        twoPageRangeGuidance,
      );
      expect(buildPDFTextTooLargeGuidance('paper.pdf', 12_345, '1')).toBe(
        singlePageGuidance,
      );
      expect(buildPDFTextTooLargeGuidance('paper.pdf', 12_345, '1-1')).toBe(
        singlePageGuidance,
      );
      expect(buildPDFTextTooLargeGuidance('paper.pdf', 12_345, '1 - 1')).toBe(
        singlePageGuidance,
      );
    });
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
      expect(parsePDFPageRange('+5')).toBeNull();
    });

    it('should tolerate whitespace around the range hyphen', () => {
      // Preserves compatibility with the old parseInt-based parser, which
      // skipped leading whitespace on each side of the hyphen.
      expect(parsePDFPageRange('1 - 5')).toEqual({ firstPage: 1, lastPage: 5 });
      expect(parsePDFPageRange('1-  5')).toEqual({ firstPage: 1, lastPage: 5 });
      expect(parsePDFPageRange('  2 -  7  ')).toEqual({
        firstPage: 2,
        lastPage: 7,
      });
      expect(parsePDFPageRange('3 -')).toEqual({
        firstPage: 3,
        lastPage: Infinity,
      });
    });

    it('should reject page numbers past the safe precision limit', () => {
      // Number('999999999999999998') === Number('999999999999999999') due
      // to IEEE-754 precision loss. Without a hard ceiling, that made
      // "999999999999999998-999999999999999999" look like a 1-page range
      // and sneak past the 20-page validator in read-file.ts.
      expect(parsePDFPageRange('999999999999999999')).toBeNull();
      expect(
        parsePDFPageRange('999999999999999998-999999999999999999'),
      ).toBeNull();
      // Just past the documented cap (1_000_000) also rejected.
      expect(parsePDFPageRange('1000001')).toBeNull();
      expect(parsePDFPageRange('1-1000001')).toBeNull();
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

    it('should return true when exit code is 0 even without stderr (sandboxed)', async () => {
      // Exit code is the reliable signal. Earlier implementation relied on
      // stderr having bytes, which flaked to false when stderr was
      // suppressed by a container / CI wrapper.
      mockExecResult({ stdout: '', stderr: '', code: 0 });
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

    it('should dedupe concurrent callers to a single subprocess spawn', async () => {
      // Returning a delayed result lets us start multiple callers before
      // the first resolves — without in-flight promise caching each one
      // would have spawned its own pdftotext -v probe.
      mockExecFile.mockImplementation(
        (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
          const callback = cb as (
            err: Error | null,
            stdout: string,
            stderr: string,
          ) => void;
          setTimeout(() => callback(null, '', 'pdftotext version 24.02.0'), 10);
          return {} as ReturnType<typeof execFile>;
        },
      );

      const [a, b, c] = await Promise.all([
        isPdftotextAvailable(),
        isPdftotextAvailable(),
        isPdftotextAvailable(),
      ]);

      expect(a).toBe(true);
      expect(b).toBe(true);
      expect(c).toBe(true);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it('resetPdftotextCache should allow re-probing after a failed first attempt', async () => {
      // The in-flight slot is cleared in a `.finally` so a transient probe
      // failure can't leave the cache stuck on a rejected promise. After
      // `resetPdftotextCache()`, the second call must reach the subprocess
      // again and observe the new (now-installed) state.
      mockExecError();
      const first = await isPdftotextAvailable();
      expect(first).toBe(false);

      resetPdftotextCache();
      mockExecResult({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      const second = await isPdftotextAvailable();
      expect(second).toBe(true);
      expect(mockExecFile).toHaveBeenCalledTimes(2);
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

    it('should quote the filename with -- so hyphen-prefixed paths are not parsed as options', async () => {
      // Without `--`, a filename like `-opw=X.pdf` is treated by poppler
      // as the `-opw` (owner password) option, since execFile passes each
      // element as a separate argv entry but poppler itself parses argv.
      mockExecResult({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      mockExecResult({ stdout: 'dummy content', stderr: '', code: 0 });

      await extractPDFText('/tmp/-opw=X.pdf');
      const extractionArgs = mockExecFile.mock.calls[1]![1] as string[];
      const dashDashIndex = extractionArgs.indexOf('--');
      const fileIndex = extractionArgs.indexOf('/tmp/-opw=X.pdf');
      expect(dashDashIndex).toBeGreaterThanOrEqual(0);
      expect(fileIndex).toBeGreaterThan(dashDashIndex);
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
        expect(result.text).toContain('text truncated at 100000 characters');
        expect(result.text).toContain("'pages' parameter");
      }
    });

    it('should treat maxBuffer overrun as truncation, not a generic failure', async () => {
      // Availability check
      mockExecResult({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      // Simulate a text-dense PDF whose output exceeded the execFile
      // maxBuffer. Node kills the child and delivers partial stdout plus
      // err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'. We should recover
      // the partial output and return success with the truncation note,
      // not fail with "pdftotext failed:" or "pdftotext execution failed:".
      const partial = 'y'.repeat(200000);
      mockMaxBufferExceeded(partial);

      const result = await extractPDFText('/test.pdf');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.text.length).toBeLessThan(110000);
        expect(result.text).toContain('text truncated');
        expect(result.text).toContain("'pages' parameter");
      }
    });

    it('should recover maxBuffer overrun when UTF-8 bytes exceed the threshold', async () => {
      mockExecResult({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      mockMaxBufferExceeded('\u4e00'.repeat(70_000));

      const result = await extractPDFText('/test.pdf');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.text).toContain('text truncated');
        expect(result.text).toContain('PDF text buffer limit');
        expect(result.text).not.toContain('100000 characters');
        expect(result.text).toContain("'pages' parameter");
      }
    });

    it('should NOT treat maxBuffer overrun as success when stdout is tiny', async () => {
      // If pdftotext spilled into maxBuffer-exceeded with very little
      // stdout, the overrun was probably caused by stderr warnings —
      // pretending we got a valid extraction would feed garbage to the
      // model. Re-run the password/corrupt detectors on the stderr we
      // did capture, then fall back to a generic failure.
      mockExecResult({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      mockExecFile.mockImplementationOnce(
        (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
          const callback = cb as (
            err: Error | null,
            stdout: string,
            stderr: string,
          ) => void;
          const err = new Error('maxBuffer') as Error & { code: string };
          err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          // Tiny stdout, password-related stderr spam.
          callback(err, 'x', 'Incorrect password '.repeat(20000));
          return {} as ReturnType<typeof execFile>;
        },
      );

      const result = await extractPDFText('/test.pdf');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('password-protected');
      }
    });

    it('should surface a dedicated error on timeout', async () => {
      mockExecResult({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      mockExecFile.mockImplementationOnce(
        (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
          const callback = cb as (
            err: Error | null,
            stdout: string,
            stderr: string,
          ) => void;
          // Node's execFile timeout: SIGTERM + killed=true, no numeric code.
          const err = new Error('Command failed: pdftotext') as Error & {
            code?: string;
            killed?: boolean;
            signal?: string;
          };
          err.killed = true;
          err.signal = 'SIGTERM';
          callback(err, '', '');
          return {} as ReturnType<typeof execFile>;
        },
      );

      const result = await extractPDFText('/test.pdf');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/timed out/i);
      }
    });

    it('should surface a dedicated error on Windows-style timeout (signal=null)', async () => {
      // On Windows Node terminates via TerminateProcess and `signal` is
      // typically null rather than 'SIGTERM'. Should still be classified
      // as a timeout, not as a generic execution failure.
      mockExecResult({
        stdout: '',
        stderr: 'pdftotext version 24.02.0',
        code: 0,
      });
      mockExecFile.mockImplementationOnce(
        (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
          const callback = cb as (
            err: Error | null,
            stdout: string,
            stderr: string,
          ) => void;
          const err = new Error('Command failed: pdftotext') as Error & {
            code?: string;
            killed?: boolean;
            signal?: string | null;
          };
          err.killed = true;
          err.signal = null;
          callback(err, '', '');
          return {} as ReturnType<typeof execFile>;
        },
      );

      const result = await extractPDFText('/test.pdf');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/timed out/i);
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

  describe('renderPDFPagesToImages', () => {
    // Queue the `pdftoppm -v` availability probe as successful. It runs once
    // per render call because resetPdftoppmCache clears the cache each test.
    const mockAvailable = () =>
      mockExecResult({
        stdout: '',
        stderr: 'pdftoppm version 24.02.0',
        code: 0,
      });
    const asEntries = (names: string[]) => names as never;

    it('renders pages to base64 JPEG images, numerically sorted', async () => {
      mockAvailable();
      mockExecResult({ stdout: '', stderr: '', code: 0 });
      // Returned out of order to prove numeric (not lexical) sorting.
      mockReaddir.mockResolvedValue(asEntries(['page-2.jpg', 'page-1.jpg']));
      mockReadFile
        .mockResolvedValueOnce(Buffer.from('page-one-bytes'))
        .mockResolvedValueOnce(Buffer.from('page-two-bytes'));

      const result = await renderPDFPagesToImages('/test.pdf');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.images).toEqual([
          {
            data: Buffer.from('page-one-bytes').toString('base64'),
            mimeType: 'image/jpeg',
          },
          {
            data: Buffer.from('page-two-bytes').toString('base64'),
            mimeType: 'image/jpeg',
          },
        ]);
        expect(result.bytesTruncated).toBe(false);
      }
      const renderCall = mockExecFile.mock.calls[1]!;
      expect(renderCall[0]).toBe('pdftoppm');
      expect(renderCall[1]).toEqual(
        expect.arrayContaining(['-jpeg', '-scale-to']),
      );
    });

    it('forwards an explicit page range to pdftoppm', async () => {
      mockAvailable();
      mockExecResult({ stdout: '', stderr: '', code: 0 });
      mockReaddir.mockResolvedValue(asEntries(['page-3.jpg']));
      mockReadFile.mockResolvedValue(Buffer.from('x'));

      await renderPDFPagesToImages('/test.pdf', { firstPage: 3, lastPage: 5 });

      const args = mockExecFile.mock.calls[1]![1] as string[];
      expect(args[args.indexOf('-f') + 1]).toBe('3');
      expect(args[args.indexOf('-l') + 1]).toBe('5');
    });

    it('omits -l for an open-ended (Infinity) last page', async () => {
      mockAvailable();
      mockExecResult({ stdout: '', stderr: '', code: 0 });
      mockReaddir.mockResolvedValue(asEntries(['page-1.jpg']));
      mockReadFile.mockResolvedValue(Buffer.from('x'));

      await renderPDFPagesToImages('/test.pdf', {
        firstPage: 1,
        lastPage: Infinity,
      });

      const args = mockExecFile.mock.calls[1]![1] as string[];
      expect(args).toContain('-f');
      expect(args).not.toContain('-l');
    });

    it('returns an install hint when pdftoppm is unavailable', async () => {
      mockExecError(); // `-v` probe fails with ENOENT
      const result = await renderPDFPagesToImages('/test.pdf');
      expect(result).toEqual({
        success: false,
        error: PDF_RENDER_UNAVAILABLE_MESSAGE,
      });
      // Only the availability probe ran; no render invocation followed.
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it('maps password-protected PDFs to a clear error', async () => {
      mockAvailable();
      mockExecResult({
        stdout: '',
        stderr: 'Command Line Error: Incorrect password',
        code: 1,
      });
      const result = await renderPDFPagesToImages('/test.pdf');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('password-protected');
      }
    });

    it('maps corrupt PDFs to a clear error', async () => {
      mockAvailable();
      mockExecResult({
        stdout: '',
        stderr: 'Syntax Error: Document is damaged',
        code: 1,
      });
      const result = await renderPDFPagesToImages('/test.pdf');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('corrupted');
      }
    });

    it('errors when pdftoppm produces no images', async () => {
      mockAvailable();
      mockExecResult({ stdout: '', stderr: '', code: 0 });
      mockReaddir.mockResolvedValue(asEntries([]));
      const result = await renderPDFPagesToImages('/test.pdf');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('no image output');
      }
    });

    it('caps total payload size and flags truncation instead of dropping silently', async () => {
      mockAvailable();
      mockExecResult({ stdout: '', stderr: '', code: 0 });
      mockReaddir.mockResolvedValue(asEntries(['page-1.jpg', 'page-2.jpg']));
      // The first page alone (~27MB base64) already exceeds the 25MB cap, so
      // the second page is dropped and the result is flagged.
      mockReadFile
        .mockResolvedValueOnce(Buffer.alloc(20 * 1024 * 1024))
        .mockResolvedValueOnce(Buffer.from('second-page'));

      const result = await renderPDFPagesToImages('/test.pdf');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.images).toHaveLength(1);
        expect(result.bytesTruncated).toBe(true);
      }
    });
  });
});
