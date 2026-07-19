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

export class InMemoryImagePayloadStore {
  private readonly images = new Map<string, StoredImagePayload>();

  put(part: Part): StoredImagePayload {
    const stored = imagePartToStoredPayload(part);
    this.images.set(stored.id, stored);
    return stored;
  }

  get(id: string): StoredImagePayload | undefined {
    return this.images.get(id);
  }

  clear(): void {
    this.images.clear();
  }

  copyTo(target: InMemoryImagePayloadStore): void {
    for (const [id, image] of this.images) {
      target.images.set(id, image);
    }
  }

  reconcile(contents: Content[]): void {
    const referencedIds = new Set<string>();
    for (const content of contents) {
      for (const id of collectReferencedImageIds(content)) {
        referencedIds.add(id);
      }
    }
    for (const id of this.images.keys()) {
      if (!referencedIds.has(id)) this.images.delete(id);
    }
    rememberImagePayloads(contents, this);
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

export function prepareImagePayloadsForRequest(
  contents: Content[],
  options: {
    maxRecentImages: number;
    preserveImagePartsForContentIndex?: number;
    store: InMemoryImagePayloadStore;
  },
): Content[] {
  const referencedIds = collectReferencedImageIds(contents.at(-1));
  const collected: StoredImagePayload[] = [];
  const transformed = contents.map((content, index) => {
    if (index === options.preserveImagePartsForContentIndex) {
      return {
        ...content,
        parts: content.parts ? [...content.parts] : content.parts,
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
    reattachById.set(image.id, image);
  }
  for (const image of collected) {
    if (referencedIds.has(image.id)) {
      reattachById.set(image.id, image);
    }
  }
  for (const id of referencedIds) {
    const stored = options.store.get(id);
    if (stored) {
      reattachById.set(stored.id, stored);
    }
  }
  for (const id of collectInlineImageIds(transformed.at(-1))) {
    reattachById.delete(id);
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
  store: InMemoryImagePayloadStore,
  collected: StoredImagePayload[],
): Part {
  if (part.inlineData?.mimeType?.startsWith('image/') && part.inlineData.data) {
    const stored = store.put(part);
    collected.push(stored);
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

export function collectReferencedImageIds(
  content: Content | undefined,
): Set<string> {
  const ids = new Set<string>();
  collectReferencedImageIdsFromParts(content?.parts ?? [], ids);
  return ids;
}

function collectReferencedImageIdsFromParts(
  parts: Part[],
  ids: Set<string>,
): void {
  for (const part of parts) {
    const text = part.text;
    if (text) {
      for (const match of text.matchAll(IMAGE_REFERENCE_PATTERN)) {
        const id = match[1];
        if (id) ids.add(id.toLowerCase());
      }
    }
    collectReferencedImageIdsFromParts(
      getFunctionResponseParts(part) ?? [],
      ids,
    );
  }
}

function recentUniqueImages(
  collected: StoredImagePayload[],
  maxRecentImages: number,
): StoredImagePayload[] {
  if (maxRecentImages <= 0) {
    return [];
  }
  const recent: StoredImagePayload[] = [];
  const seen = new Set<string>();
  for (let index = collected.length - 1; index >= 0; index--) {
    const image = collected[index];
    if (!image || seen.has(image.id)) continue;
    seen.add(image.id);
    recent.push(image);
    if (recent.length === maxRecentImages) break;
  }
  return recent.reverse();
}

export function imagePartToStoredPayload(part: Part): StoredImagePayload {
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

export function rememberImagePayloads(
  contents: Content[],
  store: InMemoryImagePayloadStore,
): void {
  for (const content of contents) {
    for (const part of content.parts ?? []) {
      if (
        part.inlineData?.mimeType?.startsWith('image/') &&
        part.inlineData.data
      ) {
        store.put(part);
      }
      for (const nested of getFunctionResponseParts(part) ?? []) {
        if (
          nested.inlineData?.mimeType?.startsWith('image/') &&
          nested.inlineData.data
        ) {
          store.put(nested);
        }
      }
    }
  }
}

function collectInlineImageIds(content: Content | undefined): Set<string> {
  const ids = new Set<string>();
  for (const part of content?.parts ?? []) {
    if (
      part.inlineData?.mimeType?.startsWith('image/') &&
      part.inlineData.data
    ) {
      ids.add(imagePartToStoredPayload(part).id);
    }
    for (const nested of getFunctionResponseParts(part) ?? []) {
      if (
        nested.inlineData?.mimeType?.startsWith('image/') &&
        nested.inlineData.data
      ) {
        ids.add(imagePartToStoredPayload(nested).id);
      }
    }
  }
  return ids;
}
