/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isSupportedImageMediaType,
  normalizeImageMediaType,
  unsupportedImagePlaceholder,
  type ModelInputContentBlock,
} from '@qwen-code/core';
import type { Part } from '@google/genai';

export function partsToContentBlocks(parts: Part[]): ModelInputContentBlock[] {
  const contentBlocks: ModelInputContentBlock[] = [];

  for (const part of parts) {
    if ('text' in part && typeof part.text === 'string') {
      contentBlocks.push({ type: 'text', text: part.text });
      continue;
    }

    if (
      'inlineData' in part &&
      part.inlineData &&
      typeof part.inlineData.data === 'string'
    ) {
      const mimeType = part.inlineData.mimeType ?? 'application/octet-stream';
      if (isSupportedImageMediaType(mimeType)) {
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            mediaType: normalizeImageMediaType(mimeType),
            data: part.inlineData.data,
          },
        });
      } else if (mimeType.startsWith('image/')) {
        contentBlocks.push({
          type: 'text',
          text: unsupportedImagePlaceholder(mimeType),
        });
      } else {
        contentBlocks.push({
          type: 'text',
          text: `[Warning: binary content with MIME type \`${mimeType}\` could not be represented as a supported model input block.]`,
        });
      }
    }
  }

  return contentBlocks;
}
