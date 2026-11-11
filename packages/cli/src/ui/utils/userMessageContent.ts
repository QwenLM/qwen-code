/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getDisplayablePromptText,
  isSyntheticPromptText,
} from '@qwen-code/core';

export function extractDisplayableUserText(content: unknown): string {
  const text = extractUserTextBlocks(content)
    .map((block) => getDisplayablePromptText(block))
    .filter((block): block is string => block !== undefined)
    .join('\n');
  return text.trim() ? text : '';
}

export interface DisplayableUserContent {
  text: string;
  images: Array<{ media_type: string; data: string; blob_id?: string }>;
}

export function extractDisplayableUserContent(
  content: unknown,
): DisplayableUserContent {
  const text = extractDisplayableUserText(content);
  const images: DisplayableUserContent['images'] = [];

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block == null || typeof block !== 'object') continue;
      if ((block as { type?: unknown }).type !== 'image') continue;
      const source = (block as { source?: unknown }).source;
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
  }

  return { text, images };
}

export function isSyntheticUserPayload(
  payload: Record<string, unknown>,
): boolean {
  if (payload['isSynthetic'] === true) {
    return true;
  }

  const message = payload['message'];
  if (message == null || typeof message !== 'object') {
    return false;
  }

  const content = (message as { content?: unknown }).content;
  return extractUserTextBlocks(content).some((text) =>
    isSyntheticPromptText(text),
  );
}

function extractUserTextBlocks(content: unknown): string[] {
  if (typeof content === 'string') {
    const text = content.trim();
    return text ? [text] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .map((block) => {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        return (block as { text: string }).text.trim();
      }
      return '';
    })
    .filter(Boolean);
}
