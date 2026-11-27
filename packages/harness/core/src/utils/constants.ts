/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const REFERENCE_CONTENT_START = '--- Content from referenced files ---';
export const REFERENCE_CONTENT_END = '--- End of content ---';

export const DEFAULT_MAX_LINES_TEXT_FILE = 2000;
export const MAX_LINE_LENGTH_TEXT_FILE = 2000;


/** Maximum output size in bytes for text file reads (256KB). */
export const MAX_OUTPUT_SIZE = 256 * 1024;
/** Maximum output token count for file reads. */
export const MAX_READ_TOKENS = 25000;


// ---------------------------------------------------------------------------
// PDF limits
// ---------------------------------------------------------------------------

/**
 * Maximum PDF file size for the page extraction path. PDFs larger than
 * this are rejected to avoid processing extremely large files.
 */
export const PDF_MAX_EXTRACT_SIZE = 100 * 1024 * 1024;

/**
 * Max pages the Read tool will extract in a single call with the pages parameter.
 */
export const PDF_MAX_PAGES_PER_READ = 20;



/**
 * PDFs with more pages than this trigger a "use pages parameter" error
 * when read without the pages param.
 */
export const PDF_AT_MENTION_INLINE_THRESHOLD = 10;

// ---------------------------------------------------------------------------
// Image limits
// ---------------------------------------------------------------------------

/**
 * API hard limit for image base64 size (5 MB).
 * Images encoded as base64 must not exceed this size.
 */
export const API_IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024;

/**
 * Target raw image size before base64 encoding (3.75 MB).
 * Derived from API base64 limit: 5MB × 3/4 = 3.75MB.
 */
export const IMAGE_TARGET_RAW_SIZE = (API_IMAGE_MAX_BASE64_SIZE * 3) / 4;

/** Maximum image width accepted by the API (px). */
export const IMAGE_MAX_WIDTH = 2000;

/** Maximum image height accepted by the API (px). */
export const IMAGE_MAX_HEIGHT = 2000;

/** Minimum image width accepted by the API (px). */
export const IMAGE_MIN_WIDTH = 11;

/** Minimum image height accepted by the API (px). */
export const IMAGE_MIN_HEIGHT = 11;

/** Maximum number of images allowed per API request. */
export const API_MAX_MEDIA_PER_REQUEST = 100;
