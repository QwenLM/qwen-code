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

const IMAGE_ID_LENGTH = 12;
const IMAGE_REFERENCE_PATTERN = new RegExp(
  `Image #([a-f0-9]{${IMAGE_ID_LENGTH}})`,
  'gi',
);

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

export function countAllInlineImages(contents: Content[]): number {
  let count = 0;
  for (const content of contents) {
    for (const part of content.parts ?? []) {
      if (part.inlineData?.mimeType?.startsWith('image/')) count++;
      const nested = getFunctionResponseParts(part);
      if (!nested) continue;
      for (const inner of nested) {
        if (inner.inlineData?.mimeType?.startsWith('image/')) count++;
      }
    }
  }
  return count;
}

/**
 * Replace image payloads in-place with text references, storing the
 * originals in the provided store. This mutates the history so that
 * subsequent `countAllInlineImages` returns a lower count.
 *
 * Returns the stored payloads in order of appearance for downstream
 * reattach decisions.
 */
export function replaceImagePayloadsInPlace(
  contents: Content[],
  store: ImagePayloadStore,
  skipContent?: Content,
): StoredImagePayload[] {
  const replaced: StoredImagePayload[] = [];
  for (const content of contents) {
    if (content === skipContent) continue;
    if (!content.parts) continue;
    for (let i = 0; i < content.parts.length; i++) {
      const part = content.parts[i]!;
      if (
        part.inlineData?.mimeType?.startsWith('image/') &&
        part.inlineData.data
      ) {
        const stored = store.put(part);
        replaced.push(stored);
        content.parts[i] = { text: imageReferenceText(stored) };
        continue;
      }
      const nested = getFunctionResponseParts(part);
      if (!nested) continue;
      for (let j = 0; j < nested.length; j++) {
        const inner = nested[j]!;
        if (
          inner.inlineData?.mimeType?.startsWith('image/') &&
          inner.inlineData.data
        ) {
          const stored = store.put(inner);
          replaced.push(stored);
          nested[j] = { text: imageReferenceText(stored) };
        }
      }
    }
  }
  return replaced;
}

/**
 * Build the reattach parts for the most recent unique images from a
 * replacement pass. Used after `replaceImagePayloadsInPlace` to append
 * recent image bytes to the outgoing request.
 */
export function buildReattachParts(
  replaced: StoredImagePayload[],
  maxRecentImages: number,
): Part[] {
  if (maxRecentImages <= 0 || replaced.length === 0) return [];
  const recent: StoredImagePayload[] = [];
  const seen = new Set<string>();
  for (let i = replaced.length - 1; i >= 0; i--) {
    const img = replaced[i]!;
    if (seen.has(img.id)) continue;
    seen.add(img.id);
    recent.push(img);
    if (recent.length === maxRecentImages) break;
  }
  recent.reverse();
  return [
    {
      text:
        'Recent images reattached for visual context: ' +
        recent.map((img) => `Image #${img.id}`).join(', '),
    },
    ...recent.map(storedImageToPart),
  ];
}

export function prepareImagePayloadsForRequest(
  contents: Content[],
  options: {
    maxRecentImages: number;
    preserveImagePartsForContentIndex?: number;
    preserveLastUserImagePartCount?: number;
    store: ImagePayloadStore;
  },
): Content[] {
  const referencedIds = collectReferencedImageIds(contents.at(-1));
  const collected: CollectedImage[] = [];
  const transformed = contents.map((content, index) => {
    if (index === options.preserveImagePartsForContentIndex) {
      return content;
    }
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
  const recent = recentUniqueImages(collected, options.maxRecentImages);
  for (const image of recent) {
    reattachById.set(image.stored.id, image.stored);
  }
  for (const image of collected) {
    if (referencedIds.has(image.stored.id)) {
      reattachById.set(image.stored.id, image.stored);
    }
  }
  for (const id of referencedIds) {
    const stored = options.store.get(id);
    if (stored) {
      reattachById.set(stored.id, stored);
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
    for (const match of text.matchAll(IMAGE_REFERENCE_PATTERN)) {
      const id = match[1];
      if (id) ids.add(id.toLowerCase());
    }
  }
  return ids;
}

function recentUniqueImages(
  collected: CollectedImage[],
  maxRecentImages: number,
): CollectedImage[] {
  if (maxRecentImages <= 0) {
    return [];
  }
  const recent: CollectedImage[] = [];
  const seen = new Set<string>();
  for (let index = collected.length - 1; index >= 0; index--) {
    const image = collected[index];
    if (!image || seen.has(image.stored.id)) continue;
    seen.add(image.stored.id);
    recent.push(image);
    if (recent.length === maxRecentImages) break;
  }
  return recent.reverse();
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
    id: hash.slice(0, IMAGE_ID_LENGTH),
    mimeType,
    data,
    bytes: approxBase64Bytes(data),
    displayName: part.inlineData?.displayName,
  };
}

function imageReferenceText(stored: StoredImagePayload): string {
  return `[Image #${stored.id}: ${safeImageMimeType(stored.mimeType)}, ${stored.bytes} bytes]`;
}

function safeImageMimeType(mimeType: string): string {
  return /^image\/[a-z0-9.+-]{1,64}$/i.test(mimeType)
    ? mimeType.toLowerCase()
    : 'image/unknown';
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
