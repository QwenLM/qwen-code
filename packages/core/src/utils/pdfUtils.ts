/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PDF utility functions.
 */

/**
 * Parse a page range string into firstPage/lastPage numbers.
 * Supported formats:
 * - "5" -> { firstPage: 5, lastPage: 5 }
 * - "1-10" -> { firstPage: 1, lastPage: 10 }
 * - "3-" -> { firstPage: 3, lastPage: Infinity }
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

/**
 * Check if PDF reading is supported for the given model.
 *
 * NOTE: Native PDF reading via application/pdf inlineData is currently
 * disabled. model API's functionResponse does not reliably handle PDF
 * document blocks — for non-gen-3 models, inlineData becomes a sibling
 * part detached from the functionResponse, and the model only sees
 * "Binary content provided (1 item(s))." instead of the actual PDF content.
 * All PDFs go through page extraction (pdftoppm → JPEG images) instead.
 *
 * TODO: Re-enable when model API supports PDF in functionResponse.
 * To re-enable: restore the model pattern matching logic
 * (PDF_UNSUPPORTED_MODEL_PATTERNS) and update the read-file.ts PDF section
 * to use the conditional shouldExtractPages pattern.
 *
 * @param _modelId The model identifier string (unused while native PDF is disabled)
 * @returns false — all models currently use page extraction for PDF
 */
export function isPDFSupported(_modelId: string): boolean {
  return false;
}

/**
 * Check if a file extension is a PDF document.
 * @param ext File extension (with or without leading dot)
 */
export function isPDFExtension(ext: string): boolean {
  const normalized = ext.startsWith('.') ? ext.slice(1) : ext;
  return normalized.toLowerCase() === 'pdf';
}
