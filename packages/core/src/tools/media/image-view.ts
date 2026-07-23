/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { ToolInvocation, ToolResult } from '../tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from '../tools.js';
import { ToolNames, ToolDisplayNames } from '../tool-names.js';
import type { Config } from '../../config/config.js';
import type { PermissionDecision } from '../../permissions/types.js';
import { readMedia } from '../../utils/media/media-orchestrator.js';
import { getMediaReadPermission } from '../../utils/media/media-security.js';
import { resolveMediaConfig } from '../../utils/media/media-config.js';
import { isModelOwned } from '../../utils/media/decision-policy.js';
import type { MediaReadParams } from '../../utils/media/reader-registry.js';

export interface ImageViewParams {
  file_path: string;
  region?: [number, number, number, number];
  scale?: number;
}

class ImageViewInvocation extends BaseToolInvocation<
  ImageViewParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: ImageViewParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return path.basename(this.params.file_path);
  }

  override async getDefaultPermission(): Promise<PermissionDecision> {
    return getMediaReadPermission(this.params.file_path, this.config);
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const policy = resolveMediaConfig(this.config).decisionPolicy;
    const params: MediaReadParams = {};
    if (isModelOwned('region', policy) && this.params.region) {
      params.region = this.params.region;
    }
    if (isModelOwned('scale', policy) && this.params.scale !== undefined) {
      params.scale = this.params.scale;
    }
    return readMedia({
      filePath: this.params.file_path,
      params,
      config: this.config,
      signal,
    });
  }
}

/**
 * P1 · `image_view` — the unified "look at an image" entry point. Delegates to
 * the Seam A read trunk; native passthrough is the built-in reader. Which
 * refinement knobs (region/scale) are exposed is driven by the decision policy.
 */
export class ImageViewTool extends BaseDeclarativeTool<
  ImageViewParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.IMAGE_VIEW;

  constructor(private config: Config) {
    const policy = resolveMediaConfig(config).decisionPolicy;
    const properties: Record<string, unknown> = {
      file_path: {
        type: 'string',
        description: 'Absolute path to the image file to view.',
      },
    };
    if (isModelOwned('region', policy)) {
      properties['region'] = {
        type: 'array',
        items: { type: 'integer' },
        minItems: 4,
        maxItems: 4,
        description:
          'Optional crop region [x, y, width, height] in pixels for a closer look.',
      };
    }
    if (isModelOwned('scale', policy)) {
      properties['scale'] = {
        type: 'number',
        description: 'Optional downscale factor in (0, 1].',
      };
    }
    super(
      ImageViewTool.Name,
      ToolDisplayNames.IMAGE_VIEW,
      'View an image. Returns the image to the model (natively when supported) with a self-describing note stating scope, precision, and how to look closer.',
      Kind.Read,
      { type: 'object', properties, required: ['file_path'] },
    );
  }

  protected override validateToolParamValues(
    params: ImageViewParams,
  ): string | null {
    if (!params.file_path?.trim()) {
      return "The 'file_path' parameter must be non-empty.";
    }
    if (!path.isAbsolute(params.file_path)) {
      return `File path must be absolute, but was relative: ${params.file_path}.`;
    }
    return null;
  }

  protected createInvocation(
    params: ImageViewParams,
  ): ToolInvocation<ImageViewParams, ToolResult> {
    return new ImageViewInvocation(this.config, params);
  }
}
