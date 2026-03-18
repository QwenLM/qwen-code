/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { SavedImageAttachment } from '../../types/imageAttachment.js';

export function buildPromptBlocks(
  text: string,
  images: SavedImageAttachment[] = [],
): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (text || images.length === 0) {
    blocks.push({ type: 'text', text });
  }

  for (const image of images) {
    blocks.push({
      type: 'resource_link',
      name: image.name,
      mimeType: image.mimeType,
      uri: `file://${image.path}`,
    });
  }

  return blocks;
}
