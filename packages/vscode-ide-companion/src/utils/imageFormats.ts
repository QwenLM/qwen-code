/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isSupportedImageMimeType } from '@qwen-code/qwen-code-core';

const PASTED_IMAGE_MIME_TO_EXTENSION: Record<string, string> = {
  'image/bmp': '.bmp',
  'image/heic': '.heic',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/tiff': '.tiff',
  'image/webp': '.webp',
};

const DISPLAYABLE_IMAGE_EXTENSION_TO_MIME: Record<string, string> = {
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
};

export function isSupportedPastedImageMimeType(mimeType: string): boolean {
  return isSupportedImageMimeType(mimeType);
}

export function getImageExtensionForMimeType(mimeType: string): string {
  return PASTED_IMAGE_MIME_TO_EXTENSION[mimeType] ?? '.png';
}

export function getDisplayableImageMimeType(
  filePath: string,
): string | undefined {
  const lowerPath = filePath.toLowerCase();
  const extensionIndex = lowerPath.lastIndexOf('.');
  if (extensionIndex === -1) {
    return undefined;
  }

  return DISPLAYABLE_IMAGE_EXTENSION_TO_MIME[lowerPath.slice(extensionIndex)];
}

export function isDisplayableImagePath(filePath: string): boolean {
  return getDisplayableImageMimeType(filePath) !== undefined;
}
