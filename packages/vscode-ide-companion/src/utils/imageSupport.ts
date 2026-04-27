/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// ---------- Types ----------

export interface ImageAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  data: string;
  timestamp: number;
}

export interface SavedImageAttachment {
  path: string;
  name: string;
  mimeType: string;
}

// ---------- Constants ----------

export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_SIZE = 20 * 1024 * 1024;

// ---------- Path escaping ----------

export const SHELL_SPECIAL_CHARS = /[ \t()[\]{};|*?$`'"#&<>!~]/;

export function escapePath(filePath: string): string {
  let result = '';
  for (let i = 0; i < filePath.length; i += 1) {
    const char = filePath[i];

    let backslashCount = 0;
    for (let j = i - 1; j >= 0 && filePath[j] === '\\'; j -= 1) {
      backslashCount += 1;
    }

    const isAlreadyEscaped = backslashCount % 2 === 1;

    if (!isAlreadyEscaped && SHELL_SPECIAL_CHARS.test(char)) {
      result += `\\${char}`;
    } else {
      result += char;
    }
  }

  return result;
}

export function unescapePath(filePath: string): string {
  return filePath.replace(
    new RegExp(`\\\\([${SHELL_SPECIAL_CHARS.source.slice(1, -1)}])`, 'g'),
    '$1',
  );
}

// ---------- Image format detection ----------

const PASTED_IMAGE_MIME_TO_EXTENSION: Record<string, string> = {
  'image/bmp': '.bmp',
  'image/heic': '.heic',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/tiff': '.tiff',
  'image/webp': '.webp',
};

// Keep this list aligned with packages/core/src/utils/request-tokenizer/supportedImageFormats.ts.
export const SUPPORTED_PASTED_IMAGE_MIME_TYPES = new Set(
  Object.keys(PASTED_IMAGE_MIME_TO_EXTENSION),
);

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
  return SUPPORTED_PASTED_IMAGE_MIME_TYPES.has(mimeType);
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

// ---------- Attachment validation ----------

function extractBase64Payload(data: string): string | null {
  const dataUrlMatch = data.match(/^data:[^;]+;base64,(.+)$/);
  const payload = dataUrlMatch ? dataUrlMatch[1] : data;
  const normalized = payload.trim();

  if (!normalized || /[^A-Za-z0-9+/=]/.test(normalized)) {
    return null;
  }

  return normalized;
}

function getDecodedByteSize(base64Payload: string): number {
  const padding = base64Payload.endsWith('==')
    ? 2
    : base64Payload.endsWith('=')
      ? 1
      : 0;
  return Math.floor((base64Payload.length * 3) / 4) - padding;
}

export function normalizeImageAttachment(
  attachment: ImageAttachment,
  options?: {
    maxBytes?: number;
  },
): ImageAttachment | null {
  if (!isSupportedPastedImageMimeType(attachment.type)) {
    return null;
  }

  const payload = extractBase64Payload(attachment.data);
  if (!payload) {
    return null;
  }

  const byteSize = getDecodedByteSize(payload);
  const maxBytes = options?.maxBytes ?? MAX_IMAGE_SIZE;
  if (byteSize <= 0 || byteSize > maxBytes) {
    return null;
  }

  return {
    ...attachment,
    size: byteSize,
    data: payload,
  };
}
