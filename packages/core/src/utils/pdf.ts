/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, type ExecFileOptions } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateTextTokens } from './request-tokenizer/textTokenizer.js';

const MAX_PDF_TEXT_OUTPUT_CHARS = 100000;
const PDF_FULL_TEXT_PAGE_LIMIT = 10;
export const PDF_MAX_PAGES_PER_READ = 20;
const PDF_PAGE_COUNT_SIZE_HEURISTIC_BYTES = 100 * 1024;
export const PDF_TEXT_RESULT_MAX_TOKENS = 12_000;
const PDF_TEXT_RESULT_WRAPPER_TOKEN_CHARS = 64;
const PDF_TEXT_RESULT_CHARS_PER_TOKEN = 4;
export const PDF_TEXT_EXTRACTION_UNAVAILABLE_MESSAGE =
  'pdftotext is not installed. Install poppler-utils to enable PDF text extraction (e.g. `apt-get install poppler-utils` or `brew install poppler`).';
export const PDF_RENDER_UNAVAILABLE_MESSAGE =
  'pdftoppm is not installed. Install poppler-utils to enable PDF page rendering (e.g. `apt-get install poppler-utils` or `brew install poppler`).';
/**
 * Longest-edge pixel cap passed to `pdftoppm -scale-to`. Bounds each rendered
 * page's JPEG size — and thus its base64 payload and vision-token cost —
 * independently of the PDF's physical page dimensions. Mirrors claude-code's
 * page-as-image rendering. NOTE: `-scale-to` overrides `-r`, so the two must
 * never be combined.
 */
export const PDF_RENDER_SCALE_TO_PX = 1600;
/**
 * Upper bound on the summed base64 size of all pages returned from one render
 * call. Rendering up to PDF_MAX_PAGES_PER_READ pages at ~1-2 MB each could
 * otherwise produce a tool result tens of MB large; once this is reached the
 * remaining pages are dropped and the caller is told (never silently). Sized
 * well above any single 1600px JPEG so the first page always survives.
 */
const PDF_RENDER_MAX_TOTAL_BASE64_BYTES = 25 * 1024 * 1024;
/** Timeout for a single pdftoppm render invocation. */
const PDF_RENDER_TIMEOUT_MS = 120_000;
// Upper bound on a page number we're willing to forward to pdftotext.
// Sits well below Number.MAX_SAFE_INTEGER so arithmetic in validation
// (e.g. lastPage - firstPage + 1) stays exact, and well above any real
// PDF (the current world record is roughly 86,000 pages).
const MAX_PDF_PAGE_NUMBER = 1_000_000;

export interface PDFPageRangeRequirement {
  required: boolean;
  effectivePageCount: number;
  hadPdfInfo: boolean;
}

export function shouldRequirePDFPageRange(
  pageCount: number | null,
  sizeBytes: number,
): PDFPageRangeRequirement {
  const hadPdfInfo = pageCount !== null;
  const effectivePageCount =
    pageCount ?? Math.ceil(sizeBytes / PDF_PAGE_COUNT_SIZE_HEURISTIC_BYTES);
  return {
    required: effectivePageCount > PDF_FULL_TEXT_PAGE_LIMIT,
    effectivePageCount,
    hadPdfInfo,
  };
}

export function estimatePDFTextOutputTokens(text: string): number {
  return Math.ceil(
    estimateTextTokens(text) +
      PDF_TEXT_RESULT_WRAPPER_TOKEN_CHARS / PDF_TEXT_RESULT_CHARS_PER_TOKEN,
  );
}

export function buildLargePDFGuidance(
  displayName: string,
  requirement: PDFPageRangeRequirement,
): string {
  const source = requirement.hadPdfInfo ? 'has' : 'appears to have about';
  return `PDF "${displayName}" ${source} ${requirement.effectivePageCount} pages, which is too many to read at once. Use the 'pages' parameter to read a specific page range such as '1-5'. Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`;
}

export function buildPDFTextTooLargeGuidance(
  displayName: string,
  estimatedTokens: number,
  pagesUsed?: string,
): string {
  const pageRange = pagesUsed ? parsePDFPageRange(pagesUsed) : null;
  const prefix = `PDF text extracted from "${displayName}" is too large to return safely (${estimatedTokens} estimated tokens; limit ${PDF_TEXT_RESULT_MAX_TOKENS}).`;
  if (pageRange && pageRange.firstPage === pageRange.lastPage) {
    return `${prefix} The selected page exceeds the output limit. Use a native PDF-capable model, split the page content externally, or extract a smaller section with another tool.`;
  }
  if (pageRange) {
    const suggestedEnd = Math.floor(
      (pageRange.firstPage + pageRange.lastPage) / 2,
    );
    if (suggestedEnd === pageRange.firstPage) {
      return `${prefix} Use the 'pages' parameter with a single page, for example '${pageRange.firstPage}'.`;
    }
    return `${prefix} Use the 'pages' parameter with fewer pages, for example '${pageRange.firstPage}-${suggestedEnd}' or a single page.`;
  }
  return `${prefix} Use the 'pages' parameter with a narrower range, for example '1-2' or a single page.`;
}

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
          // `timeout` option triggers process termination with `killed=true`
          // and no numeric exit code. On POSIX the signal is SIGTERM; on
          // Windows Node uses TerminateProcess and `signal` is typically
          // null. Some Node versions also surface `code='ETIMEDOUT'`. Cover
          // all three so timeouts always get a dedicated message.
          const timedOut =
            !maxBufferExceeded &&
            (errAny.code === 'ETIMEDOUT' ||
              (errAny.killed === true &&
                (errAny.signal === 'SIGTERM' ||
                  errAny.signal === undefined ||
                  errAny.signal === null)));
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
  })()
    .then((result) => {
      pdftotextAvailable = result;
      return result;
    })
    .finally(() => {
      // Always clear the in-flight slot so a transient probe failure
      // (e.g. an unexpected throw) doesn't leave the cache permanently
      // pointing at a rejected promise.
      pdftotextAvailablePromise = undefined;
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
  options?: { firstPage?: number; lastPage?: number; signal?: AbortSignal },
): Promise<PDFTextResult> {
  const available = await isPdftotextAvailable();
  if (!available) {
    return {
      success: false,
      error: PDF_TEXT_EXTRACTION_UNAVAILABLE_MESSAGE,
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
        // Caller cancellation kills the subprocess instead of blocking the
        // tool invocation for up to the 30s timeout.
        signal: options?.signal,
      });

    // execCommand reports a signal-killed child as timedOut (killed +
    // SIGTERM); check the caller's abort first so a user cancel is not
    // misreported as a 30s timeout.
    if (options?.signal?.aborted) {
      return { success: false, error: 'PDF text extraction was cancelled.' };
    }

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
    if (
      maxBufferExceeded &&
      Buffer.byteLength(stdout, 'utf8') >= MAX_PDF_TEXT_OUTPUT_CHARS
    ) {
      const wasCharTruncated = stdout.length > MAX_PDF_TEXT_OUTPUT_CHARS;
      const text = wasCharTruncated
        ? stdout.substring(0, MAX_PDF_TEXT_OUTPUT_CHARS)
        : stdout;
      const truncationReason = wasCharTruncated
        ? `at ${MAX_PDF_TEXT_OUTPUT_CHARS} characters`
        : 'after reaching the PDF text buffer limit';
      return {
        success: true,
        text:
          text +
          `\n\n... [text truncated ${truncationReason}. Use the 'pages' parameter to read specific page ranges.]`,
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

let pdftoppmAvailable: boolean | undefined;
let pdftoppmAvailablePromise: Promise<boolean> | undefined;

/**
 * Check whether `pdftoppm` (from poppler-utils) is available. Mirrors
 * {@link isPdftotextAvailable}: the result and the in-flight probe promise are
 * cached for the process lifetime so concurrent render callers share one probe.
 */
export async function isPdftoppmAvailable(): Promise<boolean> {
  if (pdftoppmAvailable !== undefined) return pdftoppmAvailable;
  if (pdftoppmAvailablePromise) return pdftoppmAvailablePromise;

  pdftoppmAvailablePromise = (async () => {
    try {
      const { code } = await execCommand('pdftoppm', ['-v'], {
        timeout: 5000,
      });
      return code === 0;
    } catch {
      return false;
    }
  })()
    .then((result) => {
      pdftoppmAvailable = result;
      return result;
    })
    .finally(() => {
      pdftoppmAvailablePromise = undefined;
    });

  return pdftoppmAvailablePromise;
}

/**
 * Reset the pdftoppm availability cache. Used by tests only.
 */
export function resetPdftoppmCache(): void {
  pdftoppmAvailable = undefined;
  pdftoppmAvailablePromise = undefined;
}

export interface PDFRenderedImage {
  /** base64-encoded JPEG data (no `data:` URI prefix). */
  data: string;
  mimeType: string;
}

export type PDFRenderResult =
  | { success: true; images: PDFRenderedImage[]; bytesTruncated: boolean }
  | { success: false; error: string };

/**
 * Compare two pdftoppm output filenames (e.g. "page-1.jpg", "page-10.jpg") by
 * their trailing page number, so page 10 sorts after page 2 regardless of the
 * zero-padding width pdftoppm chooses (which depends on the page count).
 */
function comparePdfPageFilenames(a: string, b: string): number {
  const pageNumber = (name: string): number => {
    const match = /(\d+)\.jpg$/i.exec(name);
    return match ? parseInt(match[1]!, 10) : 0;
  };
  return pageNumber(a) - pageNumber(b);
}

/**
 * Render PDF pages to JPEG images using `pdftoppm` (from poppler-utils). Each
 * page becomes one base64 JPEG whose longest edge is capped at
 * {@link PDF_RENDER_SCALE_TO_PX}, giving a bounded token cost per page
 * regardless of text density — the fallback path when text extraction
 * overflows or fails on a vision-capable model.
 *
 * @param filePath Path to the PDF file.
 * @param options Optional 1-indexed inclusive page range. Omit `firstPage` to
 *   render from the start; an `Infinity` `lastPage` renders through the end.
 */
export async function renderPDFPagesToImages(
  filePath: string,
  options?: { firstPage?: number; lastPage?: number },
): Promise<PDFRenderResult> {
  const available = await isPdftoppmAvailable();
  if (!available) {
    return { success: false, error: PDF_RENDER_UNAVAILABLE_MESSAGE };
  }

  let tempDir: string | undefined;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'pdf-render-'));
    const outputPrefix = join(tempDir, 'page');

    const args: string[] = [
      '-jpeg',
      '-scale-to',
      String(PDF_RENDER_SCALE_TO_PX),
    ];
    if (options?.firstPage) {
      args.push('-f', String(options.firstPage));
    }
    if (options?.lastPage && options.lastPage !== Infinity) {
      args.push('-l', String(options.lastPage));
    }
    // `--` separates options from positional args so a filename starting with
    // `-` isn't misread as an option by poppler's parser.
    args.push('--', filePath, outputPrefix);

    const { stderr, code, timedOut } = await execCommand('pdftoppm', args, {
      timeout: PDF_RENDER_TIMEOUT_MS,
    });

    if (timedOut) {
      return {
        success: false,
        error: `pdftoppm timed out after ${Math.round(
          PDF_RENDER_TIMEOUT_MS / 1000,
        )}s. The PDF may be unusually large or complex; try the 'pages' parameter to narrow the range.`,
      };
    }

    if (code !== 0) {
      if (/password/i.test(stderr)) {
        return {
          success: false,
          error:
            'PDF is password-protected. Please provide an unprotected version.',
        };
      }
      if (/damaged|corrupt|invalid/i.test(stderr)) {
        return { success: false, error: 'PDF file is corrupted or invalid.' };
      }
      return {
        success: false,
        error: `pdftoppm failed: ${stderr || '(no stderr)'}`,
      };
    }

    // The temp dir is fresh and holds only this call's output, so reading and
    // numerically sorting whatever pdftoppm produced is robust to its
    // zero-padding width.
    const entries = (await readdir(tempDir))
      .filter((name) => name.toLowerCase().endsWith('.jpg'))
      .sort(comparePdfPageFilenames);

    if (entries.length === 0) {
      return {
        success: false,
        error:
          'pdftoppm produced no image output. The PDF may be empty or the page range may be out of bounds.',
      };
    }

    const images: PDFRenderedImage[] = [];
    let totalBytes = 0;
    let bytesTruncated = false;
    for (const name of entries) {
      const buffer = await readFile(join(tempDir, name));
      const data = buffer.toString('base64');
      // Always keep the first page; afterwards stop before exceeding the cap so
      // one tool result can't balloon to tens of MB.
      if (
        images.length > 0 &&
        totalBytes + data.length > PDF_RENDER_MAX_TOTAL_BASE64_BYTES
      ) {
        bytesTruncated = true;
        break;
      }
      totalBytes += data.length;
      images.push({ data, mimeType: 'image/jpeg' });
    }

    return { success: true, images, bytesTruncated };
  } catch (e: unknown) {
    return {
      success: false,
      error: `pdftoppm execution failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  } finally {
    if (tempDir) {
      // Best-effort cleanup; never let a cleanup failure mask the result.
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
