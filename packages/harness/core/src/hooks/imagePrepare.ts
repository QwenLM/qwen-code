/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { Model } from '../provider/model/model.js';
import type {
  ModelInputContentBlock,
  ModelImageBlock,
} from '../provider/modelStreamRequest.js';

/** Only ownership is exposed: a full Model may contain BYOK credentials. */
export interface ImagePrepareInput {
  images: readonly ModelImageBlock[];
  imageModel: Pick<Model, 'source' | 'key'>;
  /** Queued input degrades a failed image to text instead of persisting it. */
  failureMode?: 'keep' | 'throw';
}

/** Host request; model metadata is resolved before dispatching the event. */
export interface ImagePrepareRequest extends Omit<ImagePrepareInput, 'imageModel'> {
  modelKey?: string;
}

export interface ImagePreparationContext {
  config?: Config;
  modelKey?: string;
  signal?: AbortSignal;
  failureMode?: 'keep' | 'throw';
}

/** Called at the old upload boundaries, before messages are persisted. */
export async function prepareImageBlocks<T extends ModelInputContentBlock>(
  blocks: readonly T[],
  context: ImagePreparationContext = {},
): Promise<T[]> {
  context.signal?.throwIfAborted();
  const images = blocks.filter(
    (block): block is T & ModelImageBlock => block.type === 'image',
  );
  if (!images.length) return [...blocks];
  const hooks = context.config?.getHookSystem();
  if (!hooks) return [...blocks];
  const prepared = await hooks.fireImagePrepareEvent(
    { images, modelKey: context.modelKey, failureMode: context.failureMode },
    context.signal,
  );
  context.signal?.throwIfAborted();
  if (prepared === images) return [...blocks];
  let index = 0;
  return blocks.map((block) =>
    block.type === 'image' ? (prepared[index++] as T) : block,
  );
}

export function validatePreparedImages(
  value: unknown,
  original: readonly ModelImageBlock[],
): ModelImageBlock[] {
  if (!Array.isArray(value) || value.length !== original.length) {
    throw new Error('ImagePrepare must preserve image count and order');
  }
  for (let index = 0; index < value.length; index++) {
    const block = value[index];
    const source = block?.source;
    const previous = original[index].source;
    const unchanged =
      (previous.type === 'url' &&
        source?.type === 'url' &&
        source.url === previous.url) ||
      (previous.type === 'base64' &&
        source?.type === 'base64' &&
        source.data === previous.data &&
        source.mediaType === previous.mediaType);
    let uploaded = false;
    if (
      previous.type === 'base64' &&
      source?.type === 'url' &&
      typeof source.url === 'string'
    ) {
      try {
        uploaded = ['https:', 'http:'].includes(new URL(source.url).protocol);
      } catch {
        /* invalid output */
      }
    }
    if (block?.type !== 'image' || (!unchanged && !uploaded)) {
      throw new Error('ImagePrepare returned an invalid image replacement');
    }
  }
  return value;
}
