/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Image MIME types the image tokenizer can decode for metadata extraction.
 * This is a capability list, not an acceptance contract: the file-read path
 * only forwards a narrower set to model endpoints (see
 * PROVIDER_SAFE_IMAGE_MIME_TYPES in fileUtils.ts and #9291), so some types
 * here are omitted from requests before they ever reach the tokenizer.
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
 * model (not the tokenizer's wider decode capability).
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
