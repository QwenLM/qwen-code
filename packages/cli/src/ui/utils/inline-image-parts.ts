/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import { MAX_TERMINAL_IMAGE_BYTES } from '@qwen-code/qwen-code-core';
import type { InlineImageData } from '../types.js';

export const MAX_INLINE_IMAGES_PER_ITEM = 4;
export const MAX_INLINE_IMAGE_ENCODED_LENGTH =
  Math.ceil((MAX_TERMINAL_IMAGE_BYTES * 4) / 3) + 4;

export type InlineContentRun =
  | { kind: 'text'; text: string }
  | { kind: 'image'; image: InlineImageData }
  | { kind: 'omitted_images'; count: number };

export interface InlineImageCollection {
  images: InlineImageData[];
  omittedImageCount: number;
}

export function formatInlineImageOverflow(count: number): string {
  return `[+${count} more ${count === 1 ? 'image' : 'images'}]`;
}

export function getInlineImageData(part: Part): InlineImageData | null {
  const inlineData = part.inlineData;
  if (
    !inlineData?.mimeType?.trim().toLowerCase().startsWith('image/') ||
    typeof inlineData.data !== 'string' ||
    inlineData.data.length === 0 ||
    inlineData.data.length > MAX_INLINE_IMAGE_ENCODED_LENGTH
  ) {
    return null;
  }

  return {
    data: inlineData.data,
    mimeType: inlineData.mimeType,
  };
}

export function collectInlineImages(
  parts: Part[] | undefined,
): InlineImageCollection {
  if (!parts) {
    return { images: [], omittedImageCount: 0 };
  }

  const images: InlineImageData[] = [];
  let omittedImageCount = 0;
  const collectImage = (part: Part) => {
    const image = getInlineImageData(part);
    if (!image) {
      return;
    }
    if (images.length < MAX_INLINE_IMAGES_PER_ITEM) {
      images.push(image);
    } else {
      omittedImageCount++;
    }
  };

  for (const part of parts) {
    collectImage(part);

    for (const nested of part.functionResponse?.parts ?? []) {
      collectImage(nested as Part);
    }
  }
  return { images, omittedImageCount };
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
  let displayedImageCount = 0;
  let overflowRun: Extract<
    InlineContentRun,
    { kind: 'omitted_images' }
  > | null = null;
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
      if (displayedImageCount < MAX_INLINE_IMAGES_PER_ITEM) {
        runs.push({ kind: 'image', image });
        displayedImageCount++;
      } else if (overflowRun) {
        overflowRun.count++;
      } else {
        overflowRun = { kind: 'omitted_images', count: 1 };
        runs.push(overflowRun);
      }
    }
  }
  flushText();
  return runs;
}
