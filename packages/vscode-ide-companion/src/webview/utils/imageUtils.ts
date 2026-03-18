/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ImageAttachment } from '../../types/imageAttachment.js';
import {
  MAX_IMAGE_SIZE,
  MAX_TOTAL_IMAGE_SIZE,
} from '../../utils/imageAttachmentLimits.js';
import {
  getImageExtensionForMimeType,
  isSupportedPastedImageMimeType,
} from '../../utils/imageFormats.js';

export type { ImageAttachment };
export { MAX_IMAGE_SIZE, MAX_TOTAL_IMAGE_SIZE };

export async function fileToBase64(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function isSupportedImage(file: File): boolean {
  return isSupportedPastedImageMimeType(file.type);
}

export function isWithinSizeLimit(file: File): boolean {
  return file.size <= MAX_IMAGE_SIZE;
}

export function generateImageId(): string {
  return `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) {
    return '0 B';
  }
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export async function createImageAttachment(
  file: File,
): Promise<ImageAttachment | null> {
  if (!isSupportedImage(file)) {
    console.warn('Unsupported image type:', file.type);
    return null;
  }

  if (!isWithinSizeLimit(file)) {
    console.warn('Image file too large:', formatFileSize(file.size));
    return null;
  }

  try {
    const base64Data = await fileToBase64(file);
    return {
      id: generateImageId(),
      name: file.name || `image_${Date.now()}`,
      type: file.type,
      size: file.size,
      data: base64Data,
      timestamp: Date.now(),
    };
  } catch (error) {
    console.error('Failed to create image attachment:', error);
    return null;
  }
}

export function generatePastedImageName(mimeType: string): string {
  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2, '0')}${now
    .getMinutes()
    .toString()
    .padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}`;
  const ext = getImageExtensionForMimeType(mimeType);
  return `pasted_image_${timeStr}${ext}`;
}
