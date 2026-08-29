/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Image MIME types accepted for vision input (attachment/thumbnail paths).
 * This is an acceptance list for inputs, not a decode-capability list:
 * token accounting uses the flat DEFAULT_IMAGE_TOKEN_ESTIMATE in
 * compactionInputSlimming.ts — the former request-tokenizer estimator
 * cluster, including ImageTokenizer and its dimension parsing, was removed
 * as orphaned in PR #9676. The file-read path forwards only the narrower
 * PIPELINE_IMAGE_MIME_TYPES subset to model endpoints (see
 * PROVIDER_SAFE_IMAGE_MIME_TYPES in fileUtils.ts and #9291); anything else
 * is omitted from requests with an in-band notice.
 */
export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/jpg', // Alternative MIME type for JPEG
  'image/png',
  'image/tiff',
  'image/webp',
  'image/heic',
] as const;

/**
 * Image MIME types the pipeline forwards to model endpoints end-to-end.
 * Mirrors the read-path omission gate in fileUtils.ts (#9291): anything
 * outside this set is omitted from requests with an in-band notice instead
 * of being forwarded, because provider request-validation 400s on unknown
 * media abort the whole session.
 */
export const PIPELINE_IMAGE_MIME_TYPES = [
  'image/gif',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
] as const;

/**
 * Type for supported image MIME types
 */
export type SupportedImageMimeType =
  (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

/**
 * Check if a MIME type is supported for vision processing
 * @param mimeType The MIME type to check
 * @returns True if the MIME type is supported
 */
export function isSupportedImageMimeType(
  mimeType: string,
): mimeType is SupportedImageMimeType {
  return SUPPORTED_IMAGE_MIME_TYPES.includes(
    mimeType as SupportedImageMimeType,
  );
}

/**
 * Get a human-readable list of image formats the pipeline forwards to the
 * model (the narrower pipeline subset, not the full acceptance list above).
 * @returns Comma-separated string of forwarded formats
 */
export function getSupportedImageFormatsString(): string {
  return PIPELINE_IMAGE_MIME_TYPES.map((type) =>
    type.replace('image/', '').toUpperCase(),
  ).join(', ');
}

/**
 * Get warning message for unsupported image formats
 * @returns Warning message string
 */
export function getUnsupportedImageFormatWarning(): string {
  return `Only the following image formats are supported: ${getSupportedImageFormatsString()}. Other formats may not work as expected.`;
}
