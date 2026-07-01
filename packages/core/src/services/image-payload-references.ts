/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { Part } from '@google/genai';
import { createHash } from 'node:crypto';
import { approxBase64Bytes } from '../core/inlineMediaLimit.js';
import { getFunctionResponseParts } from './compactionInputSlimming.js';

export interface StoredImagePayload {
  id: string;
  mimeType: string;
  data: string;
  bytes: number;
  displayName?: string;
}

export interface ImagePayloadStore {
  put(part: Part): StoredImagePayload;
  get(id: string): StoredImagePayload | undefined;
}

interface CollectedImage {
  stored: StoredImagePayload;
}

export class InMemoryImagePayloadStore implements ImagePayloadStore {
  private readonly images = new Map<string, StoredImagePayload>();

  put(part: Part): StoredImagePayload {
    const stored = imagePartToStoredPayload(part);
    this.images.set(stored.id, stored);
    return stored;
  }

  get(id: string): StoredImagePayload | undefined {
    return this.images.get(id);
  }
}

export function prepareImagePayloadsForRequest(
  contents: Content[],
  options: {
    maxRecentImages: number;
    preserveLastUserImagePartCount?: number;
    store: ImagePayloadStore;
  },
): Content[] {
  const referencedIds = collectReferencedImageIds(contents.at(-1));
  const collected: CollectedImage[] = [];
  const transformed = contents.map((content, index) => {
    if (index === contents.length - 1 && content.role === 'user') {
      const preserveCount = options.preserveLastUserImagePartCount ?? 0;
      const preserveFrom = Math.max(
        0,
        (content.parts?.length ?? 0) - preserveCount,
      );
      return {
        ...content,
        parts: content.parts?.map((part, partIndex) =>
          partIndex >= preserveFrom
            ? part
            : transformPart(part, options.store, collected),
        ),
      };
    }
    return {
      ...content,
      parts: content.parts?.map((part) =>
        transformPart(part, options.store, collected),
      ),
    };
  });

  const reattachById = new Map<string, StoredImagePayload>();
  const recent =
    options.maxRecentImages > 0
      ? collected.slice(-options.maxRecentImages)
      : [];
  for (const image of recent) {
    reattachById.set(image.stored.id, image.stored);
  }
  for (const image of collected) {
    if (referencedIds.has(image.stored.id)) {
      reattachById.set(image.stored.id, image.stored);
    }
  }

  if (reattachById.size === 0) {
    return transformed;
  }

  const reattachParts: Part[] = [
    {
      text:
        'Recent images reattached for visual context: ' +
        [...reattachById.keys()].map((id) => `Image #${id}`).join(', '),
    },
    ...[...reattachById.values()].map(storedImageToPart),
  ];

  const last = transformed.at(-1);
  if (last?.role === 'user') {
    last.parts = [...(last.parts ?? []), ...reattachParts];
    return transformed;
  }

  return [...transformed, { role: 'user', parts: reattachParts }];
}

function transformPart(
  part: Part,
  store: ImagePayloadStore,
  collected: CollectedImage[],
): Part {
  if (part.inlineData?.mimeType?.startsWith('image/') && part.inlineData.data) {
    const stored = store.put(part);
    collected.push({ stored });
    return { text: imageReferenceText(stored) };
  }

  if (part.functionResponse) {
    const nestedParts = getFunctionResponseParts(part);
    if (!nestedParts) return part;
    return {
      ...part,
      functionResponse: {
        ...part.functionResponse,
        parts: nestedParts.map((nested) =>
          transformPart(nested, store, collected),
        ),
      },
    };
  }

  return part;
}

function collectReferencedImageIds(content: Content | undefined): Set<string> {
  const ids = new Set<string>();
  for (const part of content?.parts ?? []) {
    const text = part.text;
    if (!text) continue;
    for (const match of text.matchAll(/Image #([a-f0-9]{12})/gi)) {
      const id = match[1];
      if (id) ids.add(id.toLowerCase());
    }
  }
  return ids;
}

function imagePartToStoredPayload(part: Part): StoredImagePayload {
  const data = part.inlineData?.data ?? '';
  const mimeType = part.inlineData?.mimeType ?? 'application/octet-stream';
  const hash = createHash('sha256')
    .update(mimeType)
    .update('\0')
    .update(data)
    .digest('hex');
  return {
    id: hash.slice(0, 12),
    mimeType,
    data,
    bytes: approxBase64Bytes(data),
    displayName: part.inlineData?.displayName,
  };
}

function imageReferenceText(stored: StoredImagePayload): string {
  const displayName = stored.displayName ? `, ${stored.displayName}` : '';
  return `[Image #${stored.id}: ${stored.mimeType}, ${stored.bytes} bytes${displayName}]`;
}

function storedImageToPart(stored: StoredImagePayload): Part {
  return {
    inlineData: {
      mimeType: stored.mimeType,
      data: stored.data,
      displayName: stored.displayName,
    },
  };
}
