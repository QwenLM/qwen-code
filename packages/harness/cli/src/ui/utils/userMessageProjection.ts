/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HistoryItemWithoutId } from '../types.js';

export interface UserMessageDisplayContent {
  text: string;
  images: Array<{ media_type: string; data: string; blob_id?: string }>;
}

export function appendUserMessageToHistory(
  content: UserMessageDisplayContent,
  addHistoryItem: (item: HistoryItemWithoutId) => void,
): void {
  const historyItem = {
    type: 'user' as const,
    text: content.text,
    ...(content.images.length > 0 ? { images: content.images } : {}),
  };
  addHistoryItem(historyItem);
}

export function extractUserMessageImages(
  blocks: Array<{ type: string; [key: string]: unknown }>,
): Array<{ media_type: string; data: string; blob_id?: string }> {
  const images: Array<{ media_type: string; data: string; blob_id?: string }> =
    [];
  for (const block of blocks) {
    if (block.type !== 'image') continue;
    const source = block['source'];
    if (source == null || typeof source !== 'object') continue;
    const sourceRecord = source as Record<string, unknown>;
    const mediaType = sourceRecord['media_type'];
    const data = sourceRecord['data'];
    const blobId = sourceRecord['blob_id'];
    if (
      sourceRecord['type'] === 'base64' &&
      typeof mediaType === 'string' &&
      typeof data === 'string'
    ) {
      images.push({
        media_type: mediaType,
        data,
      });
    } else if (
      sourceRecord['type'] === 'blob_ref' &&
      typeof blobId === 'string'
    ) {
      images.push({
        media_type: typeof mediaType === 'string' ? mediaType : 'image/png',
        data: '',
        blob_id: blobId,
      });
    }
  }
  return images;
}
