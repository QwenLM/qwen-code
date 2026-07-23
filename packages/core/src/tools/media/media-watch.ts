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

export interface MediaWatchParams {
  file_path: string;
  range?: [number, number];
  fps?: number;
}

class MediaWatchInvocation extends BaseToolInvocation<
  MediaWatchParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: MediaWatchParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const base = path.basename(this.params.file_path);
    if (this.params.range) {
      return `${base} (${this.params.range[0]}s–${this.params.range[1]}s)`;
    }
    return base;
  }

  override async getDefaultPermission(): Promise<PermissionDecision> {
    return getMediaReadPermission(this.params.file_path, this.config);
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const policy = resolveMediaConfig(this.config).decisionPolicy;
    const params: MediaReadParams = {};
    if (isModelOwned('range', policy) && this.params.range) {
      params.range = this.params.range;
    }
    if (isModelOwned('fps', policy) && this.params.fps !== undefined) {
      params.fps = this.params.fps;
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
 * P1 · `media_watch` — the unified "watch/listen" entry point for audio and
 * video. Delegates to the Seam A read trunk. Slicing/parallel strategies are
 * orchestrated above this tool (via existing Explore/Workflow primitives), not
 * baked in here (U4).
 */
export class MediaWatchTool extends BaseDeclarativeTool<
  MediaWatchParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.MEDIA_WATCH;

  constructor(private config: Config) {
    const policy = resolveMediaConfig(config).decisionPolicy;
    const properties: Record<string, unknown> = {
      file_path: {
        type: 'string',
        description: 'Absolute path to the audio or video file.',
      },
    };
    if (isModelOwned('range', policy)) {
      properties['range'] = {
        type: 'array',
        items: { type: 'number' },
        minItems: 2,
        maxItems: 2,
        description: 'Optional time range [startSeconds, endSeconds].',
      };
    }
    if (isModelOwned('fps', policy)) {
      properties['fps'] = {
        type: 'number',
        description: 'Optional frames-per-second to sample (video only).',
      };
    }
    super(
      MediaWatchTool.Name,
      ToolDisplayNames.MEDIA_WATCH,
      'Watch a video or listen to an audio file. Returns the media to the model (natively when supported) with a self-describing note stating scope, precision, and how to read more.',
      Kind.Read,
      { type: 'object', properties, required: ['file_path'] },
    );
  }

  protected override validateToolParamValues(
    params: MediaWatchParams,
  ): string | null {
    if (!params.file_path?.trim()) {
      return "The 'file_path' parameter must be non-empty.";
    }
    if (!path.isAbsolute(params.file_path)) {
      return `File path must be absolute, but was relative: ${params.file_path}.`;
    }
    if (
      params.range &&
      (params.range.length !== 2 || params.range[0] > params.range[1])
    ) {
      return 'range must be [startSeconds, endSeconds] with start ≤ end.';
    }
    return null;
  }

  protected createInvocation(
    params: MediaWatchParams,
  ): ToolInvocation<MediaWatchParams, ToolResult> {
    return new MediaWatchInvocation(this.config, params);
  }
}
