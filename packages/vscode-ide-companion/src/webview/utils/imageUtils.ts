/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Supported image MIME types
// Aligned with Core's SUPPORTED_IMAGE_MIME_TYPES in packages/core/src/utils/request-tokenizer/supportedImageFormats.ts
export const SUPPORTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/tiff',
  'image/heic',
];

// Maximum file size in bytes (10MB)
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
// Maximum total size for all images in a single message (20MB)
export const MAX_TOTAL_IMAGE_SIZE = 20 * 1024 * 1024;

export interface ImageAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  data: string; // base64 encoded
  timestamp: number;
}

/**
 * Convert a File or Blob to base64 string
 */
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

/**
 * Check if a file is a supported image type
 */
export function isSupportedImage(file: File): boolean {
  return SUPPORTED_IMAGE_TYPES.includes(file.type);
}

/**
 * Check if a file size is within limits
 */
export function isWithinSizeLimit(file: File): boolean {
  return file.size <= MAX_IMAGE_SIZE;
}

/**
 * Generate a unique ID for an image attachment
 */
export function generateImageId(): string {
  return `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Get a human-readable file size
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) {
    return '0 B';
  }
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Extract image dimensions from base64 string
 */
export async function getImageDimensions(
  base64: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.width, height: img.height });
    };
    img.onerror = reject;
    img.src = base64;
  });
}

/**
 * Create an ImageAttachment from a File
 */
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

/**
 * Get extension from MIME type
 * Aligned with Core's SUPPORTED_IMAGE_MIME_TYPES
 */
export function getExtensionFromMimeType(mimeType: string): string {
  const mimeMap: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'image/heic': '.heic',
    'image/svg+xml': '.svg',
  };
  return mimeMap[mimeType] || '.png';
}

/**
 * Generate a clean filename for pasted images
 */
export function generatePastedImageName(mimeType: string): string {
  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2, '0')}${now
    .getMinutes()
    .toString()
    .padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}`;
  const ext = getExtensionFromMimeType(mimeType);
  return `pasted_image_${timeStr}${ext}`;
}
