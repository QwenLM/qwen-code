/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, type ExecFileOptions } from 'node:child_process';

const MAX_PDF_TEXT_OUTPUT_CHARS = 100000;

/**
 * Lightweight wrapper around execFile that returns { stdout, stderr, code }.
 * Avoids importing shell-utils.ts (which pulls in tool-utils → barrel index →
 * circular dependency in vitest mock environments).
 */
function execCommand(
  command: string,
  args: string[],
  options: ExecFileOptions = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', ...options },
      (error, stdout, stderr) => {
        if (error) {
          // ENOENT (command not found) — code is a string, not a number
          resolve({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            code: typeof error.code === 'number' ? error.code : 1,
          });
          return;
        }
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code: 0,
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
  const openEnded = /^(\d+)-$/.exec(trimmed);
  if (openEnded) {
    const first = Number(openEnded[1]);
    if (first < 1) return null;
    return { firstPage: first, lastPage: Infinity };
  }

  const range = /^(\d+)-(\d+)$/.exec(trimmed);
  if (range) {
    const first = Number(range[1]);
    const last = Number(range[2]);
    if (first < 1 || last < 1 || last < first) return null;
    return { firstPage: first, lastPage: last };
  }

  const single = /^(\d+)$/.exec(trimmed);
  if (single) {
    const page = Number(single[1]);
    if (page < 1) return null;
    return { firstPage: page, lastPage: page };
  }

  return null;
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
