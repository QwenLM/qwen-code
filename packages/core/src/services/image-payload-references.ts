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
// Anchor the match to the full output of `imageReferenceText` so only the
// markers eviction actually wrote resolve against the store. A bare
// `Image #<id>` echo (a model reply quoting the id, or a post-compaction
// summary that retained marker text) must not resurrect the stored payload.
const IMAGE_REFERENCE_PATTERN = new RegExp(
  `\\[Image #([a-f0-9]{${IMAGE_ID_LENGTH}}): [^\\]]+\\]`,
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

  clear(): void {
    this.images.clear();
  }

  copyTo(target: InMemoryImagePayloadStore): void {
    for (const [id, image] of this.images) {
      target.images.set(id, image);
    }
  }

  /**
   * Drop payloads no longer referenced by `contents` and absorb any raw
   * payloads still inline in them. Call after any operation that replaces
   * history wholesale (compaction, truncation, thought stripping) so evicted
   * references do not pin their bytes for the rest of the session.
   */
  reconcile(contents: Content[]): void {
    const referencedIds = collectReferencedImageIds(contents);
    for (const id of this.images.keys()) {
      if (!referencedIds.has(id)) this.images.delete(id);
    }
    rememberImagePayloads(contents, this);
  }
}

export function countAllInlineImages(contents: Content[]): number {
  let count = 0;
  for (const _part of inlineImageParts(contents)) count++;
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
  for (const part of inlineImageParts(contents, skipContent)) {
    const stored = store.put(part);
    replaced.push(stored);
    part.text = imageReferenceText(stored);
    delete part.inlineData;
  }
  return replaced;
}

/**
 * Build reattach parts from images replaced in the current pass and stored
 * payloads referenced by markers in `referencedContents`, even when the
 * current pass replaced nothing.
 */
export function buildReattachParts(
  replaced: StoredImagePayload[],
  maxRecentImages: number,
  referencedContents: Content[] = [],
  store?: ImagePayloadStore,
): Part[] {
  const referencedIds = collectReferencedImageIds(referencedContents);
  if (replaced.length === 0 && (!store || referencedIds.size === 0)) return [];
  const inlineIds = collectInlineImageIds(referencedContents);
  const last = referencedContents.at(-1);
  const lastReferencedIds = collectReferencedImageIds(
    last?.role === 'user' ? [last] : [],
  );
  const candidates: CollectedImage[] = replaced
    .filter(
      (image) => !inlineIds.has(image.id) && !lastReferencedIds.has(image.id),
    )
    .map((stored) => ({ stored }));

  if (store) {
    for (const id of referencedIds) {
      if (inlineIds.has(id) || lastReferencedIds.has(id)) continue;
      const stored = store.get(id);
      if (stored) candidates.push({ stored });
    }
  }
  const recent = recentUniqueImages(candidates, maxRecentImages).map(
    ({ stored }) => stored,
  );
  const reattachLimit = Math.max(maxRecentImages, 1);
  if (store) {
    for (const id of lastReferencedIds) {
      if (inlineIds.has(id) || recent.some((image) => image.id === id)) {
        continue;
      }
      const stored = store.get(id);
      if (stored) {
        if (recent.length >= reattachLimit) recent.shift();
        recent.push(stored);
      }
    }
  }
  if (recent.length === 0) return [];
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
  const referencedIds = collectReferencedImageIds(
    contents.at(-1) ? [contents.at(-1)!] : [],
  );
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

function collectInlineImageIds(contents: Content[]): Set<string> {
  const ids = new Set<string>();
  for (const part of inlineImageParts(contents)) {
    ids.add(imagePartToStoredPayload(part).id);
  }
  return ids;
}

function* inlineImageParts(
  contents: Content[],
  skipContent?: Content,
): Generator<Part> {
  for (const content of contents) {
    if (content === skipContent) continue;
    for (const part of content.parts ?? []) {
      if (
        part.inlineData?.mimeType?.startsWith('image/') &&
        part.inlineData.data
      ) {
        yield part;
      }
      for (const inner of getFunctionResponseParts(part) ?? []) {
        if (
          inner.inlineData?.mimeType?.startsWith('image/') &&
          inner.inlineData.data
        ) {
          yield inner;
        }
      }
    }
  }
}

export function collectReferencedImageIds(contents: Content[]): Set<string> {
  const ids = new Set<string>();
  const collect = (parts: Part[] | undefined): void => {
    for (const part of parts ?? []) {
      for (const match of part.text?.matchAll(IMAGE_REFERENCE_PATTERN) ?? []) {
        const id = match[1];
        if (id) ids.add(id.toLowerCase());
      }
      collect(getFunctionResponseParts(part));
    }
  };
  for (const content of contents) {
    collect(content.parts);
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

/**
 * Absorb every raw image payload in `contents` into `store` without rewriting
 * the contents. Used on resume, where history is rebuilt from the original
 * JSONL and the store must be repopulated before references are resolved.
 */
export function rememberImagePayloads(
  contents: Content[],
  store: ImagePayloadStore,
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
