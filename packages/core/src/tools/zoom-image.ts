/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { Part } from '@google/genai';
import type { Config } from '../config/config.js';
import type { PermissionDecision } from '../permissions/types.js';
import { logFileOperation } from '../telemetry/loggers.js';
import { FileOperation } from '../telemetry/metrics.js';
import { FileOperationEvent } from '../telemetry/types.js';
import { getSpecificMimeType } from '../utils/fileUtils.js';
import {
  ImageViewError,
  renderNormalizedImageCrop,
} from '../utils/image-view.js';
import { makeRelative, shortenPath, unescapePath } from '../utils/paths.js';
import { getFileReadDefaultPermission } from './file-read-permission.js';
import { ToolErrorType } from './tool-error.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import type { ToolInvocation, ToolLocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';

export interface ZoomImageParams {
  file_path: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function failureResult(message: string, type: ToolErrorType): ToolResult {
  return {
    llmContent: message,
    returnDisplay: message,
    error: { message, type },
  };
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
    let view: Awaited<ReturnType<typeof renderNormalizedImageCrop>>;
    try {
      view = await renderNormalizedImageCrop(
        this.params.file_path,
        this.params,
        signal,
      );
    } catch (error) {
      signal.throwIfAborted();
      const message =
        error instanceof Error ? error.message : 'Failed to decode image.';
      let errorType = ToolErrorType.READ_CONTENT_FAILURE;
      if (error instanceof ImageViewError) {
        if (error.code === 'file_not_found') {
          errorType = ToolErrorType.FILE_NOT_FOUND;
        } else if (error.code === 'target_is_directory') {
          errorType = ToolErrorType.TARGET_IS_DIRECTORY;
        } else if (error.code === 'target_not_regular_file') {
          errorType = ToolErrorType.TARGET_NOT_REGULAR_FILE;
        } else if (
          error.code === 'source_too_large' ||
          error.code === 'output_too_large'
        ) {
          errorType = ToolErrorType.FILE_TOO_LARGE;
        }
      }
      return failureResult(message, errorType);
    }

    const text =
      `Zoomed normalized region (${this.params.x1},${this.params.y1})-` +
      `(${this.params.x2},${this.params.y2}) from ${this.params.file_path}. ` +
      `Oriented source: ${view.sourceWidth}x${view.sourceHeight}; source crop: ` +
      `${view.selectedWidth}x${view.selectedHeight}; returned view: ` +
      `${view.outputWidth}x${view.outputHeight}.`;
    const llmContent: Part[] = [
      { text },
      {
        inlineData: {
          mimeType: view.mimeType,
          data: view.bytes.toString('base64'),
        },
      },
    ];

    logFileOperation(
      this.config,
      new FileOperationEvent(
        ZoomImageTool.Name,
        FileOperation.READ,
        undefined,
        getSpecificMimeType(this.params.file_path),
        path.extname(this.params.file_path),
      ),
    );

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
