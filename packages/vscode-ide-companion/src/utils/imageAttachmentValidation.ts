/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ImageAttachment } from '../types/imageAttachment.js';
import { MAX_IMAGE_SIZE } from './imageAttachmentLimits.js';
import { isSupportedPastedImageMimeType } from './imageFormats.js';

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
