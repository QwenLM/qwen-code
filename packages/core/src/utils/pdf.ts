/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PDF reading and page extraction utilities.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PDF_MAX_EXTRACT_SIZE } from './constants.js';
import { formatFileSize } from './fileUtils.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PDFError = {
  reason:
    | 'empty'
    | 'too_large'
    | 'password_protected'
    | 'corrupted'
    | 'unknown'
    | 'unavailable';
  message: string;
};

export type PDFResult<T> =
  | { success: true; data: T }
  | { success: false; error: PDFError };

export type PDFExtractPagesResult = {
  type: 'parts';
  file: {
    filePath: string;
    originalSize: number;
    count: number;
    outputDir: string;
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run an external command and never throw — return { code, stdout, stderr }.
 */
async function execFileNoThrow(
  cmd: string,
  args: string[],
  options: { timeout: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(cmd, args, {
      timeout: options.timeout,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (e: unknown) {
    const err = e as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    const code =
      typeof err.code === 'number'
        ? err.code
        : typeof err.code === 'string' && err.code === 'ENOENT'
          ? 127
          : 1;
    return {
      code,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the number of pages in a PDF file using `pdfinfo` (from poppler-utils).
 * Returns `null` if pdfinfo is not available or if the page count cannot be determined.
 */
export async function getPDFPageCount(
  filePath: string,
): Promise<number | null> {
  const { code, stdout } = await execFileNoThrow('pdfinfo', [filePath], {
    timeout: 10_000,
  });
  if (code !== 0) {
    return null;
  }
  const match = /^Pages:\s+(\d+)/m.exec(stdout);
  if (!match) {
    return null;
  }
  const count = parseInt(match[1], 10);
  return isNaN(count) ? null : count;
}

let pdftoppmAvailable: boolean | undefined;

/**
 * Reset the pdftoppm availability cache. Used by tests only.
 */
export function resetPdftoppmCache(): void {
  pdftoppmAvailable = undefined;
}

/**
 * Check whether the `pdftoppm` binary (from poppler-utils) is available.
 * The result is cached for the lifetime of the process.
 */
export async function isPdftoppmAvailable(): Promise<boolean> {
  if (pdftoppmAvailable !== undefined) return pdftoppmAvailable;
  const { code, stderr } = await execFileNoThrow('pdftoppm', ['-v'], {
    timeout: 5000,
  });
  // pdftoppm prints version info to stderr and exits 0 (or sometimes 99 on older versions)
  pdftoppmAvailable = code === 0 || stderr.length > 0;
  return pdftoppmAvailable;
}

/**
 * Extract PDF pages as JPEG images using pdftoppm.
 * Produces page-01.jpg, page-02.jpg, etc. in an output directory.
 *
 * @param filePath Path to the PDF file
 * @param options Optional page range (1-indexed, inclusive)
 * @param outputBaseDir Base directory for output (defaults to OS tmpdir)
 */
export async function extractPDFPages(
  filePath: string,
  options?: { firstPage?: number; lastPage?: number },
  outputBaseDir?: string,
): Promise<PDFResult<PDFExtractPagesResult>> {
  try {
    const stats = await fs.promises.stat(filePath);
    const originalSize = stats.size;

    if (originalSize === 0) {
      return {
        success: false,
        error: { reason: 'empty', message: `PDF file is empty: ${filePath}` },
      };
    }

    if (originalSize > PDF_MAX_EXTRACT_SIZE) {
      return {
        success: false,
        error: {
          reason: 'too_large',
          message: `PDF file exceeds maximum allowed size for text extraction (${formatFileSize(PDF_MAX_EXTRACT_SIZE)}).`,
        },
      };
    }

    const available = await isPdftoppmAvailable();
    if (!available) {
      return {
        success: false,
        error: {
          reason: 'unavailable',
          message:
            'pdftoppm is not installed. Install poppler-utils (e.g. `brew install poppler` or `apt-get install poppler-utils`) to enable PDF page rendering.',
        },
      };
    }

    const uuid = randomUUID();
    const baseDir =
      outputBaseDir ??
      (await fs.promises.realpath(
        await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pdf-')),
      ));
    const outputDir = outputBaseDir
      ? path.join(outputBaseDir, `pdf-${uuid}`)
      : baseDir;

    if (outputBaseDir) {
      await fs.promises.mkdir(outputDir, { recursive: true });
    }

    // pdftoppm produces files like <prefix>-01.jpg, <prefix>-02.jpg, etc.
    const prefix = path.join(outputDir, 'page');
    const args = ['-jpeg', '-r', '100'];
    if (options?.firstPage) {
      args.push('-f', String(options.firstPage));
    }
    if (options?.lastPage && options.lastPage !== Infinity) {
      args.push('-l', String(options.lastPage));
    }
    args.push(filePath, prefix);
    const { code, stderr } = await execFileNoThrow('pdftoppm', args, {
      timeout: 120_000,
    });

    if (code !== 0) {
      if (/password/i.test(stderr)) {
        return {
          success: false,
          error: {
            reason: 'password_protected',
            message:
              'PDF is password-protected. Please provide an unprotected version.',
          },
        };
      }
      if (/damaged|corrupt|invalid/i.test(stderr)) {
        return {
          success: false,
          error: {
            reason: 'corrupted',
            message: 'PDF file is corrupted or invalid.',
          },
        };
      }
      return {
        success: false,
        error: { reason: 'unknown', message: `pdftoppm failed: ${stderr}` },
      };
    }

    // Read generated image files and sort naturally
    const entries = await fs.promises.readdir(outputDir);
    const imageFiles = entries.filter((f) => f.endsWith('.jpg')).sort();
    const pageCount = imageFiles.length;

    if (pageCount === 0) {
      return {
        success: false,
        error: {
          reason: 'corrupted',
          message: 'pdftoppm produced no output pages. The PDF may be invalid.',
        },
      };
    }

    return {
      success: true,
      data: {
        type: 'parts',
        file: {
          filePath,
          originalSize,
          outputDir,
          count: imageFiles.length,
        },
      },
    };
  } catch (e: unknown) {
    return {
      success: false,
      error: {
        reason: 'unknown',
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }
}
