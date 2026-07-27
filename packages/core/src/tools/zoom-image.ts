/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import type { Part } from '@google/genai';
import type { Metadata } from 'sharp';
import type { Config } from '../config/config.js';
import type { PermissionDecision } from '../permissions/types.js';
import { makeRelative, shortenPath, unescapePath } from '../utils/paths.js';
import { getFileReadDefaultPermission } from './file-read-permission.js';
import { ToolErrorType } from './tool-error.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import type { ToolInvocation, ToolLocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';

const IMAGE_VIEW_MAX_EDGE = 1568;
const IMAGE_VIEW_MAX_PATCHES = 1568;
const IMAGE_PATCH_SIZE = 28;
const IMAGE_MAX_UPSCALE = 8;
const IMAGE_JPEG_QUALITY = 92;
const IMAGE_MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const IMAGE_MAX_OUTPUT_BYTES = 9 * 1024 * 1024;
const SUPPORTED_IMAGE_FORMATS = new Set(['jpeg', 'png', 'webp']);

export interface ZoomImageParams {
  file_path: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface ImageSize {
  width: number;
  height: number;
}

function failureResult(message: string, type: ToolErrorType): ToolResult {
  return {
    llmContent: message,
    returnDisplay: message,
    error: { message, type },
  };
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

function magnifiedSize(width: number, height: number): ImageSize {
  const widthIsLongEdge = width >= height;
  const maxLongEdge = Math.min(
    IMAGE_VIEW_MAX_EDGE,
    Math.max(width, height) * IMAGE_MAX_UPSCALE,
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

class ZoomImageInvocation extends BaseToolInvocation<
  ZoomImageParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: ZoomImageParams,
  ) {
    super(params);
  }

  override getDescription(): string {
    const relativePath = makeRelative(
      this.params.file_path,
      this.config.getTargetDir(),
    );
    return `${shortenPath(relativePath)} (${this.params.x1},${this.params.y1})-(${this.params.x2},${this.params.y2})`;
  }

  override toolLocations(): ToolLocation[] {
    return [{ path: this.params.file_path }];
  }

  override getDefaultPermission(): Promise<PermissionDecision> {
    return Promise.resolve(
      getFileReadDefaultPermission(this.config, this.params.file_path),
    );
  }

  override async execute(signal: AbortSignal): Promise<ToolResult> {
    signal.throwIfAborted();
    if (this.config.getEffectiveInputModalities().image !== true) {
      return failureResult(
        'zoom_image requires a model that accepts image inputs, but the current model does not. Switch to an image-capable model to zoom images.',
        ToolErrorType.READ_CONTENT_FAILURE,
      );
    }
    let sharp: typeof import('sharp');
    try {
      // sharp is a CJS `export =` module: at runtime the dynamic-import
      // namespace carries the callable on `.default`, which the NodeNext types
      // collapse away, so unwrap it explicitly (cf. utils/iconvHelper.ts).
      sharp = (
        (await import('sharp')) as unknown as {
          default: typeof import('sharp');
        }
      ).default;
    } catch {
      return failureResult(
        'zoom_image is unavailable because the "sharp" image module could not be loaded.',
        ToolErrorType.READ_CONTENT_FAILURE,
      );
    }
    let stats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stats = await fs.stat(this.params.file_path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return failureResult(
          `Image file not found: ${this.params.file_path}`,
          ToolErrorType.FILE_NOT_FOUND,
        );
      }
      throw error;
    }
    if (stats.isDirectory()) {
      return failureResult(
        `Image path is a directory: ${this.params.file_path}`,
        ToolErrorType.TARGET_IS_DIRECTORY,
      );
    }
    if (!stats.isFile()) {
      return failureResult(
        `Image path is not a regular file: ${this.params.file_path}`,
        ToolErrorType.TARGET_NOT_REGULAR_FILE,
      );
    }
    if (stats.size > IMAGE_MAX_SOURCE_BYTES) {
      return failureResult(
        `Image file exceeds the 100 MB source limit: ${this.params.file_path}`,
        ToolErrorType.FILE_TOO_LARGE,
      );
    }
    let metadata: Metadata;
    try {
      metadata = await sharp(this.params.file_path, {
        failOn: 'error',
        limitInputPixels: true,
      }).metadata();
    } catch {
      return failureResult(
        `Unsupported image. zoom_image accepts static PNG, JPEG, or WebP files: ${this.params.file_path}`,
        ToolErrorType.READ_CONTENT_FAILURE,
      );
    }
    signal.throwIfAborted();
    if (!SUPPORTED_IMAGE_FORMATS.has(metadata.format)) {
      return failureResult(
        `Unsupported image. zoom_image accepts static PNG, JPEG, or WebP files: ${this.params.file_path}`,
        ToolErrorType.READ_CONTENT_FAILURE,
      );
    }
    if ((metadata.pages ?? 1) > 1) {
      return failureResult(
        `zoom_image accepts static images only: ${this.params.file_path}`,
        ToolErrorType.READ_CONTENT_FAILURE,
      );
    }

    const sourceWidth = metadata.autoOrient.width;
    const sourceHeight = metadata.autoOrient.height;
    const left = Math.min(
      sourceWidth - 1,
      Math.max(0, Math.floor((this.params.x1 / 1000) * sourceWidth)),
    );
    const top = Math.min(
      sourceHeight - 1,
      Math.max(0, Math.floor((this.params.y1 / 1000) * sourceHeight)),
    );
    const right = Math.min(
      sourceWidth,
      Math.max(left + 1, Math.ceil((this.params.x2 / 1000) * sourceWidth)),
    );
    const bottom = Math.min(
      sourceHeight,
      Math.max(top + 1, Math.ceil((this.params.y2 / 1000) * sourceHeight)),
    );
    const cropWidth = right - left;
    const cropHeight = bottom - top;
    const outputSize = magnifiedSize(cropWidth, cropHeight);

    let output: Buffer;
    try {
      output = await sharp(this.params.file_path, {
        autoOrient: true,
        failOn: 'error',
        limitInputPixels: true,
      })
        .extract({ left, top, width: cropWidth, height: cropHeight })
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
      return failureResult(
        `Failed to decode image: ${this.params.file_path}`,
        ToolErrorType.READ_CONTENT_FAILURE,
      );
    }
    signal.throwIfAborted();
    if (output.length > IMAGE_MAX_OUTPUT_BYTES) {
      return failureResult(
        `Zoomed image exceeds the 9 MB output limit: ${this.params.file_path}`,
        ToolErrorType.FILE_TOO_LARGE,
      );
    }

    const text =
      `Zoomed normalized region (${this.params.x1},${this.params.y1})-` +
      `(${this.params.x2},${this.params.y2}) from ${this.params.file_path}. ` +
      `Oriented source: ${sourceWidth}x${sourceHeight}; source crop: ` +
      `${cropWidth}x${cropHeight}; returned view: ` +
      `${outputSize.width}x${outputSize.height}.`;
    const llmContent: Part[] = [
      { text },
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: output.toString('base64'),
        },
      },
    ];

    return {
      llmContent,
      returnDisplay: `Zoomed image: ${shortenPath(
        makeRelative(this.params.file_path, this.config.getTargetDir()),
      )}`,
    };
  }
}

export class ZoomImageTool extends BaseDeclarativeTool<
  ZoomImageParams,
  ToolResult
> {
  static readonly Name = ToolNames.ZOOM_IMAGE;

  constructor(private readonly config: Config) {
    super(
      ZoomImageTool.Name,
      ToolDisplayNames.ZOOM_IMAGE,
      'Crops a region from a full-resolution static image and returns a magnified view. Coordinates are integers normalized from 0 to 1000 against the displayed image, with (0,0) at top-left and (1000,1000) at bottom-right. Use this when text, numbers, lines, or other details are too small to inspect confidently. You may call it repeatedly; coordinates always refer to the original full-resolution image, never to a previously returned view.',
      Kind.Read,
      {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to a static PNG, JPEG, or WebP image.',
          },
          x1: {
            type: 'integer',
            minimum: 0,
            maximum: 1000,
            description: 'Left edge in normalized image coordinates.',
          },
          y1: {
            type: 'integer',
            minimum: 0,
            maximum: 1000,
            description: 'Top edge in normalized image coordinates.',
          },
          x2: {
            type: 'integer',
            minimum: 0,
            maximum: 1000,
            description: 'Right edge in normalized image coordinates.',
          },
          y2: {
            type: 'integer',
            minimum: 0,
            maximum: 1000,
            description: 'Bottom edge in normalized image coordinates.',
          },
        },
        required: ['file_path', 'x1', 'y1', 'x2', 'y2'],
      },
      true,
      false,
      true,
      false,
      'zoom crop magnify image picture screenshot chart diagram small text detail',
    );
  }

  protected override validateToolParamValues(
    params: ZoomImageParams,
  ): string | null {
    params.file_path = unescapePath(params.file_path.trim());
    if (!params.file_path) {
      return "The 'file_path' parameter must be non-empty.";
    }
    if (!path.isAbsolute(params.file_path)) {
      return `File path must be absolute, but was relative: ${params.file_path}.`;
    }
    if (params.x1 >= params.x2) {
      return 'x1 must be less than x2.';
    }
    if (params.y1 >= params.y2) {
      return 'y1 must be less than y2.';
    }
    const fileService = this.config.getFileService();
    if (fileService.shouldQwenIgnoreFile(params.file_path)) {
      return `File path '${params.file_path}' is ignored by ${fileService.getQwenIgnoreFileDisplayForPath(params.file_path)} pattern(s).`;
    }
    return null;
  }

  protected override createInvocation(
    params: ZoomImageParams,
  ): ToolInvocation<ZoomImageParams, ToolResult> {
    return new ZoomImageInvocation(this.config, params);
  }
}
