/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import type { InlineImageData } from '../types.js';

export type InlineContentRun =
  | { kind: 'text'; text: string }
  | { kind: 'image'; image: InlineImageData };

export function getInlineImageData(part: Part): InlineImageData | null {
  const inlineData = part.inlineData;
  if (
    !inlineData?.mimeType?.trim().toLowerCase().startsWith('image/') ||
    typeof inlineData.data !== 'string' ||
    inlineData.data.length === 0
  ) {
    return null;
  }

  return {
    data: inlineData.data,
    mimeType: inlineData.mimeType,
    ...(typeof inlineData.displayName === 'string'
      ? { displayName: inlineData.displayName }
      : {}),
  };
}

export function extractInlineImages(
  parts: Part[] | undefined,
): InlineImageData[] {
  if (!parts) {
    return [];
  }

  const images: InlineImageData[] = [];
  for (const part of parts) {
    const topLevelImage = getInlineImageData(part);
    if (topLevelImage) {
      images.push(topLevelImage);
    }

    for (const nested of part.functionResponse?.parts ?? []) {
      const nestedImage = getInlineImageData(nested as Part);
      if (nestedImage) {
        images.push(nestedImage);
      }
    }
  }
  return images;
}

export function extractInlineContentRuns(
  parts: Part[] | undefined,
  textSeparator = '',
): InlineContentRun[] {
  if (!parts) {
    return [];
  }

  const runs: InlineContentRun[] = [];
  let textParts: string[] = [];
  const flushText = () => {
    if (textParts.length === 0) return;
    runs.push({ kind: 'text', text: textParts.join(textSeparator) });
    textParts = [];
  };

  for (const part of parts) {
    if (part.thought) continue;
    if (part.text) {
      textParts.push(part.text);
    }
    const image = getInlineImageData(part);
    if (image) {
      flushText();
      runs.push({ kind: 'image', image });
    }
  }
  flushText();
  return runs;
}
