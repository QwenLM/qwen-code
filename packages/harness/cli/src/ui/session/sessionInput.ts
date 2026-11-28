/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PartListUnion } from '@google/genai';
import {
  filterOrphanedImages,
  parseImagePlaceholderIds,
  type PastedContent,
} from '@qwen-code/core';
import { extractContentBlocks } from '../../session/messageInput.js';

export function partToContentBlocks(
  content: PartListUnion,
  pastedContents?: Record<number, PastedContent>,
): Array<{ type: string; [key: string]: unknown }> {
  let blocks: Array<{ type: string; [key: string]: unknown }>;
  if (content == null) {
    blocks = [];
  } else if (typeof content === 'string') {
    blocks = extractContentBlocks(content.trim() ? content : '');
  } else {
    const parts = Array.isArray(content) ? content : [content];
    blocks = extractContentBlocks(parts.map(partToContentBlock));
  }
  if (!pastedContents) {
    return blocks;
  }
  return [
    ...blocks,
    ...pastedContentsToContentBlocks(
      pastedContents,
      extractTextFromBlocks(blocks),
    ),
  ];
}

function partToContentBlock(
  part: unknown,
): { type: string; [key: string]: unknown } | null {
  if (typeof part === 'string') {
    return { type: 'text', text: part };
  }
  if (part == null || typeof part !== 'object') {
    return null;
  }
  if ('text' in part && typeof (part as { text?: unknown }).text === 'string') {
    return { type: 'text', text: (part as { text: string }).text };
  }
  if ((part as { type?: unknown }).type === 'image' && 'source' in part) {
    const source = (part as { source?: unknown }).source;
    if (source != null && typeof source === 'object') {
      return { type: 'image', source };
    }
  }
  if ('inlineData' in part) {
    const inline = (part as { inlineData?: unknown }).inlineData;
    if (inline != null && typeof inline === 'object') {
      const inlineRecord = inline as { mimeType?: unknown; data?: unknown };
      if (typeof inlineRecord.data === 'string') {
        return {
          type: 'image',
          source: {
            type: 'base64',
            media_type:
              typeof inlineRecord.mimeType === 'string'
                ? inlineRecord.mimeType
                : 'image/png',
            data: inlineRecord.data,
          },
        };
      }
    }
  }
  return null;
}

export function extractTextFromBlocks(
  blocks: Array<{ type: string; [key: string]: unknown }>,
): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => {
      const text = block['text'];
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

function pastedContentsToContentBlocks(
  pastedContents: Record<number, PastedContent>,
  promptText: string,
): Array<{ type: string; [key: string]: unknown }> {
  const filtered = filterOrphanedImages(pastedContents, promptText);
  const placeholderIds = parseImagePlaceholderIds(promptText);
  const ids = [
    ...placeholderIds.filter(
      (id) => filtered[id]?.type === 'image' && filtered[id].content.length > 0,
    ),
    ...Object.keys(filtered)
      .map((id) => Number(id))
      .filter(
        (id) =>
          filtered[id]?.type === 'image' &&
          filtered[id].content.length > 0 &&
          !placeholderIds.includes(id),
      )
      .sort((a, b) => a - b),
  ];
  return ids.map((id) => {
    const image = filtered[id];
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mediaType ?? 'image/png',
        data: image.content,
      },
    };
  });
}
