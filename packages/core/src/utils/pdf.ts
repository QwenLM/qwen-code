/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execCommand } from './shell-utils.js';

const MAX_PDF_TEXT_OUTPUT_CHARS = 100000;

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

  // "N-" open-ended range
  if (trimmed.endsWith('-')) {
    const first = parseInt(trimmed.slice(0, -1), 10);
    if (isNaN(first) || first < 1) {
      return null;
    }
    return { firstPage: first, lastPage: Infinity };
  }

  const dashIndex = trimmed.indexOf('-');
  if (dashIndex === -1) {
    // Single page: "5"
    const page = parseInt(trimmed, 10);
    if (isNaN(page) || page < 1) {
      return null;
    }
    return { firstPage: page, lastPage: page };
  }

  // Range: "1-10"
  const first = parseInt(trimmed.slice(0, dashIndex), 10);
  const last = parseInt(trimmed.slice(dashIndex + 1), 10);
  if (isNaN(first) || isNaN(last) || first < 1 || last < 1 || last < first) {
    return null;
  }
  return { firstPage: first, lastPage: last };
}

let pdftotextAvailable: boolean | undefined;

/**
 * Check whether `pdftotext` (from poppler-utils) is available.
 * The result is cached for the lifetime of the process.
 */
export async function isPdftotextAvailable(): Promise<boolean> {
  if (pdftotextAvailable !== undefined) return pdftotextAvailable;
  try {
    const { stderr } = await execCommand('pdftotext', ['-v'], {
      preserveOutputOnError: true,
      timeout: 5000,
    });
    // pdftotext prints version info to stderr
    pdftotextAvailable = stderr.length > 0;
  } catch {
    pdftotextAvailable = false;
  }
  return pdftotextAvailable;
}

/**
 * Reset the pdftotext availability cache. Used by tests only.
 */
export function resetPdftotextCache(): void {
  pdftotextAvailable = undefined;
}

/**
 * Get the number of pages in a PDF using `pdfinfo` (from poppler-utils).
 * Returns null if pdfinfo is not available or page count cannot be determined.
 */
export async function getPDFPageCount(
  filePath: string,
): Promise<number | null> {
  try {
    const { stdout, code } = await execCommand('pdfinfo', [filePath], {
      preserveOutputOnError: true,
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
  args.push(filePath, '-'); // `-` means output to stdout

  try {
    const { stdout, stderr, code } = await execCommand('pdftotext', args, {
      preserveOutputOnError: true,
      timeout: 30000,
      maxBuffer: 5 * 1024 * 1024, // 5MB — default 1MB is too small for dense PDFs
    });

    if (code !== 0) {
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
        error: `pdftotext failed: ${stderr}`,
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
