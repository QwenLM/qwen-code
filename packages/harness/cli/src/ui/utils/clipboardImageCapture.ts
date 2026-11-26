/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { PastedContent } from '@qwen-code/core';
import {
  cleanupOldClipboardImages,
  saveClipboardImage,
} from './clipboardUtils.js';

const CAPTURE_RESULT_GRACE_MS = 1000;

type PendingClipboardImage = PastedContent & {
  type: 'image';
  preparationId: string;
};

const clipboardImageCaptures = new Map<
  string,
  Promise<PendingClipboardImage>
>();

export class ClipboardImageCaptureError extends Error {
  constructor(message = 'Failed to read clipboard image.') {
    super(message);
    this.name = 'ClipboardImageCaptureError';
  }
}

/**
 * Capture clipboard bytes to disk without blocking placeholder insertion.
 * The task is keyed by preparationId so submit can await the exact work that
 * the paste handler already started.
 */
export function startClipboardImageCapture(
  image: PendingClipboardImage,
  targetDir: string,
): Promise<PendingClipboardImage> {
  const existing = clipboardImageCaptures.get(image.preparationId);
  if (existing) {
    return existing;
  }

  const task = (async () => {
    const imagePath = await saveClipboardImage(targetDir);
    if (!imagePath) {
      throw new ClipboardImageCaptureError();
    }

    void cleanupOldClipboardImages(targetDir).catch(() => {});
    return {
      ...image,
      filename: path.basename(imagePath),
      sourcePath: imagePath,
    };
  })();

  clipboardImageCaptures.set(image.preparationId, task);
  const clearTask = () => {
    if (clipboardImageCaptures.get(image.preparationId) === task) {
      clipboardImageCaptures.delete(image.preparationId);
    }
  };
  void task.then(() => {
    const timer = setTimeout(clearTask, CAPTURE_RESULT_GRACE_MS);
    timer.unref?.();
  }, clearTask);

  return task;
}

/**
 * Resolve clipboard images that were submitted while their native capture was
 * still running. Images that already have sourcePath/content pass through.
 */
function isPendingClipboardImage(
  image: PastedContent,
): image is PendingClipboardImage {
  return (
    image.type === 'image' &&
    image.content.length === 0 &&
    typeof image.sourcePath !== 'string' &&
    typeof image.preparationId === 'string'
  );
}

/** True while any pasted clipboard image is still being written to disk. */
export function hasPendingClipboardImages(
  pastedContents: Record<number, PastedContent>,
): boolean {
  return Object.values(pastedContents).some(isPendingClipboardImage);
}

export async function materializePendingClipboardImages(
  pastedContents: Record<number, PastedContent>,
): Promise<Record<number, PastedContent>> {
  const pending = Object.entries(pastedContents).filter(
    (entry): entry is [string, PendingClipboardImage] =>
      isPendingClipboardImage(entry[1]),
  );

  if (pending.length === 0) {
    return pastedContents;
  }

  const captured = await Promise.all(
    pending.map(async ([id, image]) => {
      const task = clipboardImageCaptures.get(image.preparationId);
      if (!task) {
        throw new ClipboardImageCaptureError(
          'Clipboard image capture did not complete. Paste the image again.',
        );
      }
      return [id, await task] as const;
    }),
  );

  return {
    ...pastedContents,
    ...Object.fromEntries(captured),
  };
}
