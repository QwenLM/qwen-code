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

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

const errorWith = (message: string, fields: Record<string, unknown>) =>
  Object.assign(new Error(message), fields);

/** Queues one execFile outcome: its callback receives (err, stdout, stderr). */
function queueExec(err: Error | null, stdout = '', stderr = '') {
  mockExecFile.mockImplementationOnce(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as ExecCallback)(err, stdout, stderr);
      return {} as ReturnType<typeof execFile>;
    },
  );
}

/** A non-zero `code` fails the call with that numeric exit code. */
function mockExecResult({ stdout = '', stderr = '', code = 0 } = {}) {
  const err = code !== 0 ? errorWith('command failed', { code }) : null;
  queueExec(err, stdout, stderr);
}

/** The command is missing (ENOENT). */
const mockExecError = () => queueExec(errorWith('ENOENT', { code: 'ENOENT' }));

/**
 * Node's maxBuffer overrun: the child is killed, partial stdout is
 * delivered, error.code is 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'.
 */
const maxBufferError = (message: string) =>
  errorWith(message, { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
const mockMaxBufferExceeded = (partialStdout: string) =>
  queueExec(maxBufferError('stdout maxBuffer length exceeded'), partialStdout);

const mockPdftotextAvailable = () =>
  mockExecResult({ stderr: 'pdftotext version 24.02.0' });

const execArgs = (call: number) =>
  mockExecFile.mock.calls[call]![1] as string[];

/** Asserts a failed result whose error matches `text`. */
function expectError(
  result: { success: true } | { success: false; error: string },
  text: string | RegExp,
) {
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error).toMatch(text);
}

/** Asserts a successful extraction and returns its text. */
function expectText(result: Awaited<ReturnType<typeof extractPDFText>>) {
  expect(result.success).toBe(true);
  return result.success ? result.text : '';
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
      expect(estimatePDFTextOutputTokens('一'.repeat(45_000))).toBe(49_517);
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
    it.each([
      ['should parse a single page', '5', 5, 5],
      ['should parse a page range', '1-10', 1, 10],
      ['should parse an open-ended range', '3-', 3, Infinity],
      ['should handle whitespace', '  5  ', 5, 5],
    ])('%s', (_title, input, firstPage, lastPage) => {
      expect(parsePDFPageRange(input)).toEqual({ firstPage, lastPage });
    });

    it.each([
      ['should return null for empty string', ['', '  ']],
      ['should return null for zero page', ['0']],
      ['should return null for negative page', ['-1']],
      ['should return null for inverted range', ['10-5']],
      ['should return null for non-numeric input', ['abc', '1-abc']],
      // Whole-string validation: parseInt() would accept each of these.
      [
        'should reject malformed tokens that parseInt would silently truncate',
        ['5abc', '1-2-3', '1-2x', '1x-2', '1.5', '+5'],
      ],
    ])('%s', (_title, inputs) => {
      for (const input of inputs) expect(parsePDFPageRange(input)).toBeNull();
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
      mockPdftotextAvailable();
      expect(await isPdftotextAvailable()).toBe(true);
    });

    it('should return true when exit code is 0 even without stderr (sandboxed)', async () => {
      // Exit code is the reliable signal. Earlier implementation relied on
      // stderr having bytes, which flaked to false when stderr was
      // suppressed by a container / CI wrapper.
      mockExecResult();
      expect(await isPdftotextAvailable()).toBe(true);
    });

    it('should return false when pdftotext is not installed', async () => {
      mockExecError();
      expect(await isPdftotextAvailable()).toBe(false);
    });

    it('should cache the result', async () => {
      mockPdftotextAvailable();
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
          const callback = cb as ExecCallback;
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
      expect(await isPdftotextAvailable()).toBe(false);

      resetPdftotextCache();
      mockPdftotextAvailable();
      expect(await isPdftotextAvailable()).toBe(true);
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('getPDFPageCount', () => {
    it('should return page count from pdfinfo output', async () => {
      mockExecResult({
        stdout:
          'Title:          Test\nPages:          42\nPage size:      612 x 792 pts',
      });
      expect(await getPDFPageCount('/test.pdf')).toBe(42);
    });

    it('should return null when pdfinfo fails', async () => {
      mockExecResult({ stderr: 'error', code: 1 });
      expect(await getPDFPageCount('/test.pdf')).toBeNull();
    });

    it('should return null when pdfinfo is not installed', async () => {
      mockExecError();
      expect(await getPDFPageCount('/test.pdf')).toBeNull();
    });
  });

  // Each extraction first queues the pdftotext availability probe, then the
  // extraction call itself (execFile call 1).
  describe('extractPDFText', () => {
    it('should extract text from a PDF', async () => {
      mockPdftotextAvailable();
      mockExecResult({ stdout: 'Hello World\nThis is a PDF.' });

      expect(await extractPDFText('/test.pdf')).toEqual({
        success: true,
        text: 'Hello World\nThis is a PDF.',
      });
    });

    it('should pass page range options to pdftotext', async () => {
      mockPdftotextAvailable();
      mockExecResult({ stdout: 'Page 2 content' });

      await extractPDFText('/test.pdf', { firstPage: 2, lastPage: 5 });
      const args = execArgs(1);
      expect(args).toContain('-f');
      expect(args).toContain('2');
      expect(args).toContain('-l');
      expect(args).toContain('5');
    });

    it('should quote the filename with -- so hyphen-prefixed paths are not parsed as options', async () => {
      // Without `--`, a filename like `-opw=X.pdf` is treated by poppler
      // as the `-opw` (owner password) option, since execFile passes each
      // element as a separate argv entry but poppler itself parses argv.
      mockPdftotextAvailable();
      mockExecResult({ stdout: 'dummy content' });

      await extractPDFText('/tmp/-opw=X.pdf');
      const args = execArgs(1);
      const dashDashIndex = args.indexOf('--');
      const fileIndex = args.indexOf('/tmp/-opw=X.pdf');
      expect(dashDashIndex).toBeGreaterThanOrEqual(0);
      expect(fileIndex).toBeGreaterThan(dashDashIndex);
    });

    it('should not pass lastPage for Infinity', async () => {
      mockPdftotextAvailable();
      mockExecResult({ stdout: 'Page content' });

      await extractPDFText('/test.pdf', { firstPage: 3, lastPage: Infinity });
      const args = execArgs(1);
      expect(args).toContain('-f');
      expect(args).toContain('3');
      expect(args).not.toContain('-l');
    });

    it('should return error when pdftotext is not installed', async () => {
      mockExecError();
      expectError(
        await extractPDFText('/test.pdf'),
        'pdftotext is not installed',
      );
    });

    it('should detect password-protected PDFs', async () => {
      mockPdftotextAvailable();
      mockExecResult({ stderr: 'Incorrect password', code: 1 });
      expectError(await extractPDFText('/test.pdf'), 'password-protected');
    });

    it('should detect corrupted PDFs', async () => {
      mockPdftotextAvailable();
      mockExecResult({ stderr: 'PDF file is damaged', code: 1 });
      expectError(await extractPDFText('/test.pdf'), 'corrupted or invalid');
    });

    it('should truncate very large text output', async () => {
      mockPdftotextAvailable();
      mockExecResult({ stdout: 'x'.repeat(200000) });

      const text = expectText(await extractPDFText('/test.pdf'));
      expect(text.length).toBeLessThan(110000);
      expect(text).toContain('text truncated at 100000 characters');
      expect(text).toContain("'pages' parameter");
    });

    it('should treat maxBuffer overrun as truncation, not a generic failure', async () => {
      // A text-dense PDF whose output exceeded the execFile maxBuffer: we
      // should recover the partial output and return success with the
      // truncation note, not fail with "pdftotext failed:" or "pdftotext
      // execution failed:".
      mockPdftotextAvailable();
      mockMaxBufferExceeded('y'.repeat(200000));

      const text = expectText(await extractPDFText('/test.pdf'));
      expect(text.length).toBeLessThan(110000);
      expect(text).toContain('text truncated');
      expect(text).toContain("'pages' parameter");
    });

    it('should recover maxBuffer overrun when UTF-8 bytes exceed the threshold', async () => {
      mockPdftotextAvailable();
      mockMaxBufferExceeded('一'.repeat(70_000));

      const text = expectText(await extractPDFText('/test.pdf'));
      expect(text).toContain('text truncated');
      expect(text).toContain('PDF text buffer limit');
      expect(text).not.toContain('100000 characters');
      expect(text).toContain("'pages' parameter");
    });

    it('should NOT treat maxBuffer overrun as success when stdout is tiny', async () => {
      // If pdftotext spilled into maxBuffer-exceeded with very little
      // stdout, the overrun was probably caused by stderr warnings —
      // pretending we got a valid extraction would feed garbage to the
      // model. Re-run the password/corrupt detectors on the stderr we
      // did capture, then fall back to a generic failure.
      mockPdftotextAvailable();
      // Tiny stdout, password-related stderr spam.
      queueExec(
        maxBufferError('maxBuffer'),
        'x',
        'Incorrect password '.repeat(20000),
      );
      expectError(await extractPDFText('/test.pdf'), 'password-protected');
    });

    // Node's execFile timeout: killed=true, no numeric code. The signal is
    // SIGTERM on POSIX; on Windows Node terminates via TerminateProcess and
    // `signal` is typically null. Both must classify as a timeout, not as a
    // generic execution failure.
    const timeoutError = (signal: string | null) =>
      errorWith('Command failed: pdftotext', { killed: true, signal });

    it('should surface a dedicated error on timeout', async () => {
      mockPdftotextAvailable();
      queueExec(timeoutError('SIGTERM'));
      expectError(await extractPDFText('/test.pdf'), /timed out/i);
    });

    it('should surface a dedicated error on Windows-style timeout (signal=null)', async () => {
      mockPdftotextAvailable();
      queueExec(timeoutError(null));
      expectError(await extractPDFText('/test.pdf'), /timed out/i);
    });

    it('should report empty output', async () => {
      mockPdftotextAvailable();
      mockExecResult({ stdout: '   ' });
      expectError(await extractPDFText('/test.pdf'), 'no text output');
    });
  });

  describe('renderPDFPagesToImages', () => {
    // Queue the `pdftoppm -v` availability probe as successful. It runs once
    // per render call because resetPdftoppmCache clears the cache each test.
    const mockAvailable = () =>
      mockExecResult({ stderr: 'pdftoppm version 24.02.0' });
    // Probe and render succeed; the temp dir then lists `files`.
    const mockRendered = (files: string[]) => {
      mockAvailable();
      mockExecResult();
      mockReaddir.mockResolvedValue(files as never);
    };

    it('renders pages to base64 JPEG images, numerically sorted', async () => {
      // Returned out of order to prove numeric (not lexical) sorting.
      mockRendered(['page-2.jpg', 'page-1.jpg']);
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
      mockRendered(['page-3.jpg']);
      mockReadFile.mockResolvedValue(Buffer.from('x'));

      await renderPDFPagesToImages('/test.pdf', { firstPage: 3, lastPage: 5 });

      const args = execArgs(1);
      expect(args[args.indexOf('-f') + 1]).toBe('3');
      expect(args[args.indexOf('-l') + 1]).toBe('5');
    });

    it('omits -l for an open-ended (Infinity) last page', async () => {
      mockRendered(['page-1.jpg']);
      mockReadFile.mockResolvedValue(Buffer.from('x'));

      await renderPDFPagesToImages('/test.pdf', {
        firstPage: 1,
        lastPage: Infinity,
      });

      expect(execArgs(1)).toContain('-f');
      expect(execArgs(1)).not.toContain('-l');
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
        stderr: 'Command Line Error: Incorrect password',
        code: 1,
      });
      expectError(
        await renderPDFPagesToImages('/test.pdf'),
        'password-protected',
      );
    });

    it('maps corrupt PDFs to a clear error', async () => {
      mockAvailable();
      mockExecResult({ stderr: 'Syntax Error: Document is damaged', code: 1 });
      expectError(await renderPDFPagesToImages('/test.pdf'), 'corrupted');
    });

    it('errors when pdftoppm produces no images', async () => {
      mockRendered([]);
      expectError(await renderPDFPagesToImages('/test.pdf'), 'no image output');
    });

    it('caps total payload size and flags truncation instead of dropping silently', async () => {
      mockRendered(['page-1.jpg', 'page-2.jpg']);
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
