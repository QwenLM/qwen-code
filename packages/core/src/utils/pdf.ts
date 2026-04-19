/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, type ExecFileOptions } from 'node:child_process';

const MAX_PDF_TEXT_OUTPUT_CHARS = 100000;
// Upper bound on a page number we're willing to forward to pdftotext.
// Sits well below Number.MAX_SAFE_INTEGER so arithmetic in validation
// (e.g. lastPage - firstPage + 1) stays exact, and well above any real
// PDF (the current world record is roughly 86,000 pages).
const MAX_PDF_PAGE_NUMBER = 1_000_000;

/**
 * Lightweight wrapper around execFile that returns { stdout, stderr, code,
 * maxBufferExceeded, timedOut }. Avoids importing shell-utils.ts (which
 * pulls in tool-utils → barrel index → circular dependency in vitest mock
 * environments).
 */
function execCommand(
  command: string,
  args: string[],
  options: ExecFileOptions = {},
): Promise<{
  stdout: string;
  stderr: string;
  code: number;
  maxBufferExceeded: boolean;
  timedOut: boolean;
}> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', ...options },
      (error, stdout, stderr) => {
        if (error) {
          // Node sets error.code to the string 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          // when stdout or stderr exceeds the configured maxBuffer — the child
          // is killed and the partial output is delivered. ENOENT (command
          // not found) is also a string code. Numeric codes are real exit codes.
          const errAny = error as {
            code?: unknown;
            killed?: boolean;
            signal?: string;
          };
          const maxBufferExceeded =
            errAny.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          // `timeout` option triggers SIGTERM and sets error.killed with no
          // numeric exit code. Some Node versions also surface 'ETIMEDOUT'.
          const timedOut =
            !maxBufferExceeded &&
            (errAny.code === 'ETIMEDOUT' ||
              (errAny.killed === true && errAny.signal === 'SIGTERM'));
          resolve({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            code: typeof error.code === 'number' ? error.code : 1,
            maxBufferExceeded,
            timedOut,
          });
          return;
        }
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code: 0,
          maxBufferExceeded: false,
          timedOut: false,
        });
      },
    );
  });
}

/**
 * Parse a page range string into firstPage/lastPage numbers.
 * Supported formats:
 * - "5" → { firstPage: 5, lastPage: 5 }
 * - "1-10" → { firstPage: 1, lastPage: 10 }
 * - "3-" → { firstPage: 3, lastPage: Infinity }
 *
 * Returns null on invalid input (non-numeric, zero, inverted range).
 * Pages are 1-indexed.
 */
export function parsePDFPageRange(
  pages: string,
): { firstPage: number; lastPage: number } | null {
  const trimmed = pages.trim();
  if (!trimmed) {
    return null;
  }

  // Whole-string match — parseInt() would silently accept tokens like
  // "5abc", "1-2-3", "1.5", or "1x-2" because of its truncation behaviour.
  // Optional whitespace around the hyphen is allowed so "1 - 5" still parses
  // like the old parseInt-based implementation did. A hard ceiling on the
  // parsed integer prevents precision loss past Number.MAX_SAFE_INTEGER from
  // collapsing e.g. "999999999999999998-999999999999999999" into a range of
  // length 1 that would sneak past the 20-page validator in read-file.ts.
  const inRange = (n: number): boolean =>
    Number.isFinite(n) && n >= 1 && n <= MAX_PDF_PAGE_NUMBER;

  const openEnded = /^(\d+)\s*-$/.exec(trimmed);
  if (openEnded) {
    const first = Number(openEnded[1]);
    if (!inRange(first)) return null;
    return { firstPage: first, lastPage: Infinity };
  }

  const range = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
  if (range) {
    const first = Number(range[1]);
    const last = Number(range[2]);
    if (!inRange(first) || !inRange(last) || last < first) return null;
    return { firstPage: first, lastPage: last };
  }

  const single = /^(\d+)$/.exec(trimmed);
  if (single) {
    const page = Number(single[1]);
    if (!inRange(page)) return null;
    return { firstPage: page, lastPage: page };
  }

  return null;
}

let pdftotextAvailable: boolean | undefined;
let pdftotextAvailablePromise: Promise<boolean> | undefined;

/**
 * Check whether `pdftotext` (from poppler-utils) is available.
 * The result is cached for the lifetime of the process. The in-flight
 * promise is also cached so N concurrent callers (e.g. @-reading a
 * directory of PDFs) don't each spawn their own probe subprocess.
 */
export async function isPdftotextAvailable(): Promise<boolean> {
  if (pdftotextAvailable !== undefined) return pdftotextAvailable;
  if (pdftotextAvailablePromise) return pdftotextAvailablePromise;

  pdftotextAvailablePromise = (async () => {
    try {
      const { code } = await execCommand('pdftotext', ['-v'], {
        timeout: 5000,
      });
      // Exit code is the reliable signal. Sandboxes that suppress stderr
      // would have made the old stderr-length check flake to false.
      return code === 0;
    } catch {
      return false;
    }
  })().then((result) => {
    pdftotextAvailable = result;
    pdftotextAvailablePromise = undefined;
    return result;
  });

  return pdftotextAvailablePromise;
}

/**
 * Reset the pdftotext availability cache. Used by tests only.
 */
export function resetPdftotextCache(): void {
  pdftotextAvailable = undefined;
  pdftotextAvailablePromise = undefined;
}

/**
 * Get the number of pages in a PDF using `pdfinfo` (from poppler-utils).
 * Returns null if pdfinfo is not available or page count cannot be determined.
 */
export async function getPDFPageCount(
  filePath: string,
): Promise<number | null> {
  try {
    // `--` separates options from positional args so a filename starting
    // with `-` (e.g. `-opw=foo.pdf`) can't be mistaken for an option by
    // poppler's option parser.
    const { stdout, code } = await execCommand('pdfinfo', ['--', filePath], {
      timeout: 10000,
    });
    if (code !== 0) {
      return null;
    }
    const match = /^Pages:\s+(\d+)/m.exec(stdout);
    if (!match) {
      return null;
    }
    const count = parseInt(match[1]!, 10);
    return isNaN(count) ? null : count;
  } catch {
    return null;
  }
}

export type PDFTextResult =
  | { success: true; text: string }
  | { success: false; error: string };

/**
 * Extract text from a PDF file using `pdftotext`.
 * Outputs to stdout (`-` argument).
 *
 * @param filePath Path to the PDF file
 * @param options Optional page range (1-indexed, inclusive)
 */
export async function extractPDFText(
  filePath: string,
  options?: { firstPage?: number; lastPage?: number },
): Promise<PDFTextResult> {
  const available = await isPdftotextAvailable();
  if (!available) {
    return {
      success: false,
      error:
        'pdftotext is not installed. Install poppler-utils to enable PDF text extraction (e.g. `apt-get install poppler-utils` or `brew install poppler`).',
    };
  }

  const args: string[] = ['-layout'];
  if (options?.firstPage) {
    args.push('-f', String(options.firstPage));
  }
  if (options?.lastPage && options.lastPage !== Infinity) {
    args.push('-l', String(options.lastPage));
  }
  // `--` separates options from positional args so a filename starting
  // with `-` isn't misread as an option by poppler's parser. `-` means
  // "write extracted text to stdout".
  args.push('--', filePath, '-');

  try {
    const { stdout, stderr, code, maxBufferExceeded, timedOut } =
      await execCommand('pdftotext', args, {
        timeout: 30000,
        // Keep the buffer just above MAX_PDF_TEXT_OUTPUT_CHARS — anything
        // past that is going to be truncated anyway, and capping the child
        // prevents unbounded memory use on pathological text-dense PDFs.
        maxBuffer: MAX_PDF_TEXT_OUTPUT_CHARS * 2,
      });

    if (timedOut) {
      return {
        success: false,
        error: `pdftotext timed out after 30s. The PDF may be unusually large or complex; try the 'pages' parameter to narrow the range.`,
      };
    }

    // pdftotext produced more than maxBuffer — Node killed the child and
    // delivered the partial stdout. Treat this the same as a post-hoc
    // truncation so large PDFs degrade to a usable prefix instead of a
    // generic execution failure. Require enough stdout to be confident
    // the extraction actually made progress (guards against cases where
    // the buffer overrun was driven by pathological stderr rather than
    // real text output) and still give the password/corrupt detectors a
    // chance to kick in on the partial stderr.
    if (maxBufferExceeded && stdout.length >= MAX_PDF_TEXT_OUTPUT_CHARS) {
      return {
        success: true,
        text:
          stdout.substring(0, MAX_PDF_TEXT_OUTPUT_CHARS) +
          `\n\n... [text truncated at ${MAX_PDF_TEXT_OUTPUT_CHARS} characters. Use the 'pages' parameter to read specific page ranges.]`,
      };
    }

    if (code !== 0 || maxBufferExceeded) {
      if (/password/i.test(stderr)) {
        return {
          success: false,
          error:
            'PDF is password-protected. Please provide an unprotected version.',
        };
      }
      if (/damaged|corrupt|invalid/i.test(stderr)) {
        return {
          success: false,
          error: 'PDF file is corrupted or invalid.',
        };
      }
      return {
        success: false,
        error: `pdftotext failed: ${stderr || '(no stderr)'}`,
      };
    }

    if (!stdout.trim()) {
      return {
        success: false,
        error:
          'pdftotext produced no text output. The PDF may contain only images.',
      };
    }

    if (stdout.length > MAX_PDF_TEXT_OUTPUT_CHARS) {
      return {
        success: true,
        text:
          stdout.substring(0, MAX_PDF_TEXT_OUTPUT_CHARS) +
          `\n\n... [text truncated at ${MAX_PDF_TEXT_OUTPUT_CHARS} characters. Use the 'pages' parameter to read specific page ranges.]`,
      };
    }

    return { success: true, text: stdout };
  } catch (e: unknown) {
    return {
      success: false,
      error: `pdftotext execution failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
