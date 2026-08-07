/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import type { Metadata } from 'sharp';

const IMAGE_VIEW_MAX_EDGE = 1568;
const IMAGE_VIEW_MAX_PATCHES = 1568;
const IMAGE_PATCH_SIZE = 28;
const IMAGE_MAX_UPSCALE = 8;
const IMAGE_JPEG_QUALITY = 92;
export const IMAGE_MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const IMAGE_MAX_OUTPUT_BYTES = 9 * 1024 * 1024;
const SUPPORTED_IMAGE_FORMATS = new Set(['jpeg', 'png', 'webp']);

export interface NormalizedRegion {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ImageView {
  bytes: Buffer;
  mimeType: 'image/jpeg';
  sourceWidth: number;
  sourceHeight: number;
  selectedWidth: number;
  selectedHeight: number;
  outputWidth: number;
  outputHeight: number;
}

interface ImageSize {
  width: number;
  height: number;
}

interface PreparedImage {
  bytes: Buffer;
  metadata: Metadata;
  sharp: typeof import('sharp');
}

export type ImageViewErrorCode =
  | 'renderer_unavailable'
  | 'file_not_found'
  | 'target_is_directory'
  | 'target_not_regular_file'
  | 'source_too_large'
  | 'unsupported_image'
  | 'animated_image'
  | 'decode_failed'
  | 'output_too_large';

export class ImageViewError extends Error {
  constructor(
    readonly code: ImageViewErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function fitsVisualBudget({ width, height }: ImageSize): boolean {
  return (
    width <= IMAGE_VIEW_MAX_EDGE &&
    height <= IMAGE_VIEW_MAX_EDGE &&
    Math.ceil(width / IMAGE_PATCH_SIZE) *
      Math.ceil(height / IMAGE_PATCH_SIZE) <=
      IMAGE_VIEW_MAX_PATCHES
  );
}

function boundedSize(
  width: number,
  height: number,
  maxUpscale: number,
): ImageSize {
  const widthIsLongEdge = width >= height;
  const maxLongEdge = Math.min(
    IMAGE_VIEW_MAX_EDGE,
    Math.max(width, height) * maxUpscale,
  );
  let low = 1;
  let high = maxLongEdge;
  let best: ImageSize = { width: 1, height: 1 };

  while (low <= high) {
    const longEdge = Math.floor((low + high) / 2);
    const candidate = widthIsLongEdge
      ? {
          width: longEdge,
          height: Math.max(1, Math.round((height / width) * longEdge)),
        }
      : {
          width: Math.max(1, Math.round((width / height) * longEdge)),
          height: longEdge,
        };
    if (fitsVisualBudget(candidate)) {
      best = candidate;
      low = longEdge + 1;
    } else {
      high = longEdge - 1;
    }
  }

  return best;
}

async function prepareImage(
  filePath: string,
  signal: AbortSignal,
): Promise<PreparedImage> {
  signal.throwIfAborted();
  let sharp: typeof import('sharp');
  try {
    // sharp is a CJS `export =` module, so the callable is on `.default`
    // at runtime even though NodeNext types collapse that namespace away.
    sharp = (
      (await import('sharp')) as unknown as {
        default: typeof import('sharp');
      }
    ).default;
  } catch {
    throw new ImageViewError(
      'renderer_unavailable',
      'Image rendering is unavailable because the "sharp" image module could not be loaded.',
    );
  }

  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ImageViewError(
        'file_not_found',
        `Image file not found: ${filePath}`,
      );
    }
    throw error;
  }
  if (stats.isDirectory()) {
    throw new ImageViewError(
      'target_is_directory',
      `Image path is a directory: ${filePath}`,
    );
  }
  if (!stats.isFile()) {
    throw new ImageViewError(
      'target_not_regular_file',
      `Image path is not a regular file: ${filePath}`,
    );
  }
  if (stats.size > IMAGE_MAX_SOURCE_BYTES) {
    throw new ImageViewError(
      'source_too_large',
      `Image file exceeds the 100 MB source limit: ${filePath}`,
    );
  }

  const bytes = await fs.readFile(filePath, { signal });
  if (bytes.length > IMAGE_MAX_SOURCE_BYTES) {
    throw new ImageViewError(
      'source_too_large',
      `Image file exceeds the 100 MB source limit: ${filePath}`,
    );
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(bytes, {
      failOn: 'error',
      limitInputPixels: true,
    }).metadata();
  } catch {
    signal.throwIfAborted();
    throw new ImageViewError(
      'decode_failed',
      `Failed to decode image (file may be corrupt or not a static PNG, JPEG, or WebP): ${filePath}`,
    );
  }
  signal.throwIfAborted();

  if (!SUPPORTED_IMAGE_FORMATS.has(metadata.format)) {
    throw new ImageViewError(
      'unsupported_image',
      `Unsupported image. Expected a static PNG, JPEG, or WebP file: ${filePath}`,
    );
  }
  if ((metadata.pages ?? 1) > 1) {
    throw new ImageViewError(
      'animated_image',
      `Only static images are supported: ${filePath}`,
    );
  }

  return { bytes, metadata, sharp };
}

async function renderImageView(
  filePath: string,
  prepared: PreparedImage,
  selection: { left: number; top: number; width: number; height: number },
  outputSize: ImageSize,
  signal: AbortSignal,
): Promise<ImageView> {
  const { bytes, metadata, sharp } = prepared;
  let output: Buffer;
  try {
    output = await sharp(bytes, {
      autoOrient: true,
      failOn: 'error',
      limitInputPixels: true,
    })
      .extract(selection)
      .resize(outputSize.width, outputSize.height, {
        fit: 'fill',
        kernel: sharp.kernel.lanczos3,
      })
      .flatten({ background: '#ffffff' })
      .jpeg({
        quality: IMAGE_JPEG_QUALITY,
        chromaSubsampling: '4:4:4',
      })
      .toBuffer();
  } catch {
    signal.throwIfAborted();
    throw new ImageViewError(
      'decode_failed',
      `Failed to render image overview: ${filePath}`,
    );
  }
  signal.throwIfAborted();
  if (output.length > IMAGE_MAX_OUTPUT_BYTES) {
    throw new ImageViewError(
      'output_too_large',
      `Rendered image exceeds the 9 MB output limit: ${filePath}`,
    );
  }

  return {
    bytes: output,
    mimeType: 'image/jpeg',
    sourceWidth: metadata.autoOrient.width,
    sourceHeight: metadata.autoOrient.height,
    selectedWidth: selection.width,
    selectedHeight: selection.height,
    outputWidth: outputSize.width,
    outputHeight: outputSize.height,
  };
}

export async function renderImageOverview(
  filePath: string,
  signal: AbortSignal,
): Promise<ImageView> {
  const prepared = await prepareImage(filePath, signal);
  const sourceWidth = prepared.metadata.autoOrient.width;
  const sourceHeight = prepared.metadata.autoOrient.height;
  const outputSize = boundedSize(sourceWidth, sourceHeight, 1);
  return renderImageView(
    filePath,
    prepared,
    { left: 0, top: 0, width: sourceWidth, height: sourceHeight },
    outputSize,
    signal,
  );
}

export async function renderNormalizedImageCrop(
  filePath: string,
  region: NormalizedRegion,
  signal: AbortSignal,
): Promise<ImageView> {
  const prepared = await prepareImage(filePath, signal);
  const sourceWidth = prepared.metadata.autoOrient.width;
  const sourceHeight = prepared.metadata.autoOrient.height;
  const left = Math.min(
    sourceWidth - 1,
    Math.max(0, Math.floor((region.x1 / 1000) * sourceWidth)),
  );
  const top = Math.min(
    sourceHeight - 1,
    Math.max(0, Math.floor((region.y1 / 1000) * sourceHeight)),
  );
  const right = Math.min(
    sourceWidth,
    Math.max(left + 1, Math.ceil((region.x2 / 1000) * sourceWidth)),
  );
  const bottom = Math.min(
    sourceHeight,
    Math.max(top + 1, Math.ceil((region.y2 / 1000) * sourceHeight)),
  );
  const selectedWidth = right - left;
  const selectedHeight = bottom - top;
  const outputSize = boundedSize(
    selectedWidth,
    selectedHeight,
    IMAGE_MAX_UPSCALE,
  );

  return renderImageView(
    filePath,
    prepared,
    { left, top, width: selectedWidth, height: selectedHeight },
    outputSize,
    signal,
  );
}
