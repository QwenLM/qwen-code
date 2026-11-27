/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Image processing pipeline for pasted/dragged clipboard images.
 *
 * Handles four operations that must happen before the image reaches the API:
 *   1. `materializePastedContents()` — prepare deferred local paths on submit
 *   2. `storeImages()` — persist base64 data to disk (fire-and-forget)
 *   3. `resizePastedImage()` — normalize legacy, unprepared base64 images
 *   4. `processPastedImages()` — orchestrate the stages and build API blocks
 *
 * Invalid image data fails before it can enter provider context. A pasted *path*
 * with no readable image behind it is instead reported as degraded so the caller
 * can submit it as plain text.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { runLogger } from '../utils/runLogger.js';
import {
  ImageResizeError,
  maybeResizeAndDownsampleImageBuffer,
  readImageWithMediaLimits,
  createImageMetadataText,
  type ImageDimensions,
} from '../utils/imageReader.js';
import type { ModelImageBlock } from '../provider/modelStreamRequest.js';
import type { PastedContent, ProcessInputResult } from './types.js';
import { createUserMessage } from '../protocol/transcript/conversions.js';
import { API_MAX_MEDIA_PER_REQUEST } from '../utils/constants.js';
import { prepareImageBlocks, type ImagePreparationContext } from '../hooks/imagePrepare.js';
import { mapWithConcurrency } from '../utils/generators.js';

const IMAGE_PROCESSING_CONCURRENCY = 3;
// Keep a completed task briefly while React publishes the prepared buffer
// state. An Enter key arriving in that handoff window must reuse the result.
const IMAGE_PREPARATION_RESULT_GRACE_MS = 1000;

/**
 * Keep speculative paste-time work bounded even when several paste events
 * arrive before React publishes their updated buffer state.
 */
function createImagePreparationLimiter(
  maxConcurrency: number,
): <T>(operation: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquire = () =>
    new Promise<void>((resolve) => {
      if (active < maxConcurrency) {
        active++;
        resolve();
        return;
      }
      waiters.push(() => {
        active++;
        resolve();
      });
    });

  return async <T>(operation: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await operation();
    } finally {
      active--;
      waiters.shift()?.();
    }
  };
}

const limitImagePreparation = createImagePreparationLimiter(
  IMAGE_PROCESSING_CONCURRENCY,
);

interface ImagePreparationTask {
  promise: Promise<PastedImageContent>;
  controller: AbortController;
}

const inFlightImagePreparations = new Map<string, ImagePreparationTask>();

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface ResizedImage {
  /** The final API-ready image block. */
  block: ModelImageBlock;
  /** Dimensions for metadata text (may be undefined if resize failed). */
  dimensions?: ImageDimensions;
  /** File path where the image was persisted (for metadata text). */
  sourcePath?: string;
}

/**
 * A pasted path that could not be read as an image.
 *
 * The paste placeholder for such an entry has no image bytes behind it, so the
 * caller replaces `[Image #id]` with `sourcePath` and submits the turn as plain
 * text instead of rejecting the whole user message.
 */
export interface DegradedPastedImage {
  /** Paste ID whose `[Image #N]` placeholder must fall back to plain text. */
  id: number;
  /** The originally pasted path, used as the replacement text. */
  sourcePath: string;
  /** Why the deferred read failed (diagnostics and the user-facing notice). */
  reason: string;
}

export interface ImagePipelineResult {
  /** Image blocks to append to the user message content. */
  imageContentBlocks: ModelImageBlock[];
  /** Human-readable metadata strings for the isMeta annotation message. */
  imageMetadataTexts: string[];
  /** Ordered list of image IDs (matches content block order). */
  imagePasteIds: number[];
  /** Map from pasteId → stored disk path (populated asynchronously). */
  storedImagePaths: Map<number, string>;
  /** Pasted paths that were dropped and must degrade to plain text. */
  degradedImages: DegradedPastedImage[];
}

type PastedImageContent = PastedContent & { type: 'image' };

// ---------------------------------------------------------------------------
// Deferred local-image preparation
// ---------------------------------------------------------------------------

async function readDeferredPastedImage(
  image: PastedImageContent,
  signal?: AbortSignal,
): Promise<PastedImageContent> {
  let prepared: Awaited<ReturnType<typeof readImageWithMediaLimits>>;
  try {
    signal?.throwIfAborted();
    prepared = await readImageWithMediaLimits(
      image.sourcePath!,
      undefined,
      signal,
    );
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (error instanceof ImageResizeError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new ImageResizeError(
      `Unable to read pasted image ${image.sourcePath}: ${detail}`,
    );
  }

  return {
    ...image,
    content: prepared.base64,
    mediaType: prepared.mediaType,
    dimensions: prepared.dimensions,
    isImageContentPrepared: true,
  };
}

function waitForImagePreparation(
  task: ImagePreparationTask,
  signal?: AbortSignal,
): Promise<PastedImageContent> {
  if (!signal) return task.promise;
  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener('abort', handleAbort);
    };
    const handleAbort = () => {
      cleanup();
      task.controller.abort(signal.reason);
      reject(signal.reason);
    };

    signal.addEventListener('abort', handleAbort, { once: true });
    void task.promise.then(
      (prepared) => {
        cleanup();
        resolve(prepared);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Prepare one deferred local image.
 *
 * Paste-time prewarming and submit-time materialization share the same promise
 * through `preparationId`, so an immediate submit waits for the work already in
 * progress instead of starting a second decode/resize pass.
 */
export async function preparePastedImage(
  image: PastedImageContent,
  signal?: AbortSignal,
): Promise<PastedImageContent> {
  if (image.content.length > 0 || typeof image.sourcePath !== 'string') {
    return image;
  }

  signal?.throwIfAborted();
  const preparationId = image.preparationId;
  let task = preparationId
    ? inFlightImagePreparations.get(preparationId)
    : undefined;

  if (!task) {
    const controller = new AbortController();
    task = {
      controller,
      promise: limitImagePreparation(() =>
        readDeferredPastedImage(image, controller.signal),
      ),
    };
    if (preparationId) {
      inFlightImagePreparations.set(preparationId, task);
      const clearTask = () => {
        if (inFlightImagePreparations.get(preparationId) === task) {
          inFlightImagePreparations.delete(preparationId);
        }
      };
      void task.promise.then(() => {
        const timer = setTimeout(
          clearTask,
          IMAGE_PREPARATION_RESULT_GRACE_MS,
        );
        timer.unref?.();
      }, clearTask);
    }
  }

  return waitForImagePreparation(task, signal);
}

// ---------------------------------------------------------------------------
// materializePastedContents — resolve local paths at the submission boundary
// ---------------------------------------------------------------------------

/**
 * Deferred entries are image pastes that registered only a `sourcePath`; their
 * bytes are read at the submission boundary.
 */
type DeferredPastedImage = PastedImageContent & { sourcePath: string };

function collectDeferredImageEntries(
  pastedContents: Record<number, PastedContent>,
): Array<[number, DeferredPastedImage]> {
  const deferred: Array<[number, DeferredPastedImage]> = [];
  for (const [key, content] of Object.entries(pastedContents)) {
    if (
      content.type === 'image' &&
      content.content.length === 0 &&
      typeof content.sourcePath === 'string'
    ) {
      deferred.push([Number(key), content as DeferredPastedImage]);
    }
  }
  return deferred;
}

/**
 * Resolve deferred local-image paths into API-limited base64 content.
 *
 * Paste handlers deliberately register only `sourcePath` so the input
 * placeholder appears without waiting for a full decode/resize. Background
 * prewarming may already have started that work; this submission-boundary
 * function reuses it or starts the authoritative fallback. Existing non-empty
 * content is preserved for compatibility and remains subject to validation in
 * `resizePastedImage()`.
 */
export async function materializePastedContents(
  pastedContents: Record<number, PastedContent>,
  signal?: AbortSignal,
): Promise<Record<number, PastedContent>> {
  const deferredEntries = collectDeferredImageEntries(pastedContents);

  if (deferredEntries.length === 0) {
    return pastedContents;
  }

  const materialized = await mapWithConcurrency(
    deferredEntries,
    IMAGE_PROCESSING_CONCURRENCY,
    async ([id, image]) => {
      const prepared = await preparePastedImage(image, signal);
      return [id, prepared] as const;
    },
  );

  return {
    ...pastedContents,
    ...Object.fromEntries(materialized),
  };
}

type DeferredMaterialization =
  | { key: number; prepared: PastedImageContent; degraded?: undefined }
  | { key: number; prepared?: undefined; degraded: DegradedPastedImage };

/**
 * Same submission-boundary materialization as `materializePastedContents()`, but
 * a pasted *path* that cannot be read degrades instead of failing the turn.
 *
 * A path paste has a faithful plain-text representation, so a broken path (typo,
 * unreachable UNC share, deleted file) is dropped from the registry and returned
 * in `degraded` for the caller to re-insert as text. Cancellations still
 * propagate, and pastes that already carry bytes keep their existing validation
 * in `resizePastedImage()`.
 */
async function materializeWithTextFallback(
  pastedContents: Record<number, PastedContent>,
  signal?: AbortSignal,
): Promise<{
  contents: Record<number, PastedContent>;
  degraded: DegradedPastedImage[];
}> {
  const deferredEntries = collectDeferredImageEntries(pastedContents);
  if (deferredEntries.length === 0) {
    return { contents: pastedContents, degraded: [] };
  }

  const outcomes = await mapWithConcurrency(
    deferredEntries,
    IMAGE_PROCESSING_CONCURRENCY,
    async ([key, image]): Promise<DeferredMaterialization> => {
      try {
        return { key, prepared: await preparePastedImage(image, signal) };
      } catch (error) {
        if (signal?.aborted) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        runLogger.warn(
          '[image-pipeline] pasted path is not a readable image, ' +
            `falling back to plain text: ${image.sourcePath}`,
          error,
        );
        return {
          key,
          degraded: { id: image.id, sourcePath: image.sourcePath, reason },
        };
      }
    },
  );

  const contents = { ...pastedContents };
  const degraded: DegradedPastedImage[] = [];
  for (const outcome of outcomes) {
    if (outcome.degraded) {
      delete contents[outcome.key];
      degraded.push(outcome.degraded);
    } else {
      contents[outcome.key] = outcome.prepared;
    }
  }

  return { contents, degraded };
}

// ---------------------------------------------------------------------------
// storeImages — write base64 images to disk (fire-and-forget)
// ---------------------------------------------------------------------------

/**
 * Persist all image `PastedContent` entries to disk under the session images
 * directory: `<projectTempDir>/images/<sessionId>/<id>-<filename>`, where the
 * filename's original extension is replaced by the detected media-type
 * extension (no double extension).
 *
 * Returns a `Map<id, diskPath>` so the resize step can attach `sourcePath`
 * metadata. Errors are caught and logged; a failed write returns no entry.
 *
 * This function is intentionally **not** awaited by callers — disk I/O
 * happens concurrently with resize. The returned Map is populated by the
 * time resize completes because both are driven by `Promise.all`.
 */
export async function storeImages(
  pastedContents: Record<number, PastedContent>,
  sessionImagesDir: string,
): Promise<Map<number, string>> {
  const imageEntries = Object.values(pastedContents).filter(
    (c): c is PastedContent & { type: 'image' } => c.type === 'image',
  );

  if (imageEntries.length === 0) return new Map();

  await fs.mkdir(sessionImagesDir, { recursive: true });

  const results = await Promise.allSettled(
    imageEntries.map(async (img) => {
      // The pasted filename usually already carries its original extension
      // (e.g. "clipboard-<ts>.png"). Strip it so appending the detected
      // media-type extension does not yield "clipboard-<ts>.png.png".
      const safeName = (img.filename ?? 'image')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(0, 64);
      const ext = img.mediaType?.split('/')[1] ?? 'png';
      const baseName = safeName.replace(/\.[a-zA-Z0-9]{1,10}$/, '');
      const filename = `${img.id}-${baseName || safeName}.${ext}`;
      const outPath = path.join(sessionImagesDir, filename);

      // Persist the media-limited (chat-vision) bytes, identical to the chat
      // block: current video tiers max at 1080P (long edge 1920 < the 2000px
      // vision cap), so this copy suffices downstream, keeps the upload cache
      // hot (single upload) and the temp dir smallest.
      const buffer = Buffer.from(img.content, 'base64');
      await fs.writeFile(outPath, buffer);
      return { id: img.id, path: outPath };
    }),
  );

  const map = new Map<number, string>();
  for (const result of results) {
    if (result.status === 'fulfilled') {
      map.set(result.value.id, result.value.path);
    } else {
      runLogger.log('[image-pipeline:storeImages] write failed', result.reason);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// resizePastedImage — resize a single PastedContent image
// ---------------------------------------------------------------------------

/**
 * Apply `maybeResizeAndDownsampleImageBuffer` to a single paste entry.
 *
 * Rejects image data that cannot be decoded completely.
 */
export async function resizePastedImage(
  img: PastedImageContent,
  storedPath?: string,
  signal?: AbortSignal,
  preparation: ImagePreparationContext = {},
): Promise<ResizedImage> {
  const buffer = Buffer.from(img.content, 'base64');
  if (buffer.length === 0) {
    throw new ImageResizeError(
      img.sourcePath
        ? `Deferred image was not materialized: ${img.sourcePath}`
        : 'Pasted image data is empty',
    );
  }
  const ext = img.mediaType?.split('/')?.[1] ?? 'png';

  const resized = img.isImageContentPrepared
    ? {
        buffer,
        mediaType: ext,
        dimensions: img.dimensions,
      }
    : await maybeResizeAndDownsampleImageBuffer(
        buffer,
        buffer.length,
        ext,
      );

  const block: ModelImageBlock = {
    type: 'image',
    source: {
      type: 'base64',
      mediaType: `image/${resized.mediaType}`,
      data: resized.buffer.toString('base64'),
    },
  };

  return {
    block: (await prepareImageBlocks([block], { ...preparation, signal }))[0],
    dimensions: resized.dimensions,
    sourcePath: storedPath ?? img.sourcePath,
  };
}

// ---------------------------------------------------------------------------
// processPastedImages — main orchestrator
// ---------------------------------------------------------------------------

/**
 * Process all image `PastedContent` entries into API-ready blocks.
 *
 * Steps:
 *   1. Materialize deferred local paths and apply media limits once.
 *   2. Start disk-write (`storeImages`) concurrently with legacy validation.
 *   3. Validate/resize unprepared legacy content with bounded concurrency.
 *   4. Collect `imageContentBlocks`, `imageMetadataTexts`, `imagePasteIds`.
 *
 * @param pastedContents Full paste registry from the TUI buffer.
 * @param sessionImagesDir Directory to store images in.
 * @param orderedIds Ordered image IDs (from `parseImagePlaceholderIds()`).
 *   When provided, images are emitted in placeholder order; extras appended.
 */
export async function processPastedImages(
  pastedContents: Record<number, PastedContent>,
  sessionImagesDir: string,
  orderedIds?: number[],
  signal?: AbortSignal,
  preparation: ImagePreparationContext = {},
): Promise<ImagePipelineResult> {
  let imageEntries = Object.values(pastedContents).filter(
    (c): c is PastedImageContent => c.type === 'image',
  );

  // Enforce per-request image count limit (sorted by id, take first N).
  if (imageEntries.length > API_MAX_MEDIA_PER_REQUEST) {
    runLogger.warn(
      `[image-pipeline] Too many images (${imageEntries.length}), ` +
        `truncating to ${API_MAX_MEDIA_PER_REQUEST}`,
    );
    imageEntries = imageEntries.slice(0, API_MAX_MEDIA_PER_REQUEST);
  }

  if (imageEntries.length === 0) {
    return {
      imageContentBlocks: [],
      imageMetadataTexts: [],
      imagePasteIds: [],
      storedImagePaths: new Map(),
      degradedImages: [],
    };
  }

  const selectedContents = Object.fromEntries(
    imageEntries.map((image) => [image.id, image]),
  );
  const { contents: materializedContents, degraded: degradedImages } =
    await materializeWithTextFallback(selectedContents, signal);
  imageEntries = Object.values(materializedContents).filter(
    (content): content is PastedImageContent => content.type === 'image',
  );

  // 1. Start disk-write concurrently (fire-and-forget style — awaited below)
  const storePromise = storeImages(materializedContents, sessionImagesDir);

  // 2. Resize images with bounded concurrency (don't wait for disk write)
  const resizeResults = await mapWithConcurrency(
    imageEntries,
    IMAGE_PROCESSING_CONCURRENCY,
    (img) => resizePastedImage(img, undefined, signal, preparation),
  );

  // 3. Await disk paths (should be done or nearly done by now)
  const storedImagePaths = await storePromise;

  // Patch in storedPaths and re-generate metadata
  const patchedResults = resizeResults.map((r, i) => {
    const img = imageEntries[i];
    const storedPath = storedImagePaths.get(img.id) ?? img.sourcePath;
    return { ...r, sourcePath: storedPath };
  });

  // 4. Sort by orderedIds if provided
  const idToEntry = new Map(
    imageEntries.map((img, i) => [img.id, { img, result: patchedResults[i] }]),
  );
  const sortedIds = orderedIds
    ? [
        ...orderedIds.filter((id) => idToEntry.has(id)),
        ...imageEntries
          .filter((e) => !orderedIds.includes(e.id))
          .map((e) => e.id),
      ]
    : imageEntries.map((e) => e.id);

  // 5. Build output arrays
  const imageContentBlocks: ModelImageBlock[] = [];
  const imageMetadataTexts: string[] = [];
  const imagePasteIds: number[] = [];

  for (const id of sortedIds) {
    const entry = idToEntry.get(id);
    if (!entry) continue;

    const { result } = entry;
    imageContentBlocks.push(result.block);
    imagePasteIds.push(id);

    if (result.dimensions) {
      const meta = createImageMetadataText(
        result.dimensions,
        result.sourcePath,
      );
      if (meta) imageMetadataTexts.push(meta);
    } else if (result.sourcePath) {
      imageMetadataTexts.push(`[Image source: ${result.sourcePath}]`);
    }
  }

  return {
    imageContentBlocks,
    imageMetadataTexts,
    imagePasteIds,
    storedImagePaths,
    degradedImages,
  };
}

// ---------------------------------------------------------------------------
// addImageMetadataMessage — inject isMeta annotation
// ---------------------------------------------------------------------------

/**
 * Append a `isMeta: true` `UserMessage` containing image metadata to the result.
 *
 * The metadata message is model-visible but not shown to the user in the TUI.
 * It contains strings like `[Image: source: /path, original 1920x1080, displayed at 1000x562...]`.
 *
 * @returns The same result object, mutated in place (for chaining convenience).
 */
export function addImageMetadataMessage(
  result: ProcessInputResult,
  imageMetadataTexts: string[],
): ProcessInputResult {
  if (imageMetadataTexts.length === 0) return result;

  const metaMsg = createUserMessage(
    imageMetadataTexts.map((text) => ({ type: 'text' as const, text })),
    { isMeta: true },
  );

  result.messages.push(metaMsg);
  return result;
}
