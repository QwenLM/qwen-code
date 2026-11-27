/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const SUPPORTED_IMAGE_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

export type SupportedImageMediaType =
  (typeof SUPPORTED_IMAGE_MEDIA_TYPES)[number];

const supportedImageMediaTypeSet = new Set<string>(
  SUPPORTED_IMAGE_MEDIA_TYPES,
);

export function normalizeImageMediaType(mediaType: string): string {
  const normalized = mediaType.trim().toLowerCase();
  const withPrefix = normalized.includes('/')
    ? normalized
    : `image/${normalized}`;
  return withPrefix === 'image/jpg' ? 'image/jpeg' : withPrefix;
}

export function isSupportedImageMediaType(
  mediaType: string,
): boolean {
  return supportedImageMediaTypeSet.has(normalizeImageMediaType(mediaType));
}

export function unsupportedImagePlaceholder(mediaType: string): string {
  const normalized = normalizeImageMediaType(mediaType);
  return `[Unsupported image omitted: ${normalized}. Supported formats are PNG, JPEG, GIF, and WebP.]`;
}
