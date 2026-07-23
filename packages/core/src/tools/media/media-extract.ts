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
import type { MediaReadParams } from '../../utils/media/reader-registry.js';

export type ExtractMode = 'transcript' | 'keyframes' | 'audio_track' | 'clip';

export interface MediaExtractParams {
  file_path: string;
  mode: ExtractMode;
  range?: [number, number];
}

/**
 * P4 · `media_extract` — explicit derivation (transcript / keyframes / audio
 * track / clip) via a delegated backend. Conditional-trigger: it only does
 * something when a delegated reader is configured, and fails closed with a
 * remedy otherwise (信念二: build the entry, wire the heavy machinery on proof).
 * Derived understandings land in media memory and are recalled by media_grep.
 */
class MediaExtractInvocation extends BaseToolInvocation<
  MediaExtractParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: MediaExtractParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `${this.params.mode} of ${path.basename(this.params.file_path)}`;
  }

  override async getDefaultPermission(): Promise<PermissionDecision> {
    return getMediaReadPermission(this.params.file_path, this.config);
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const params: MediaReadParams = { intent: this.params.mode };
    if (this.params.range) params.range = this.params.range;
    return readMedia({
      filePath: this.params.file_path,
      params,
      config: this.config,
      signal,
      requireDelegated: true,
    });
  }
}

export class MediaExtractTool extends BaseDeclarativeTool<
  MediaExtractParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.MEDIA_EXTRACT;

  constructor(private config: Config) {
    super(
      MediaExtractTool.Name,
      ToolDisplayNames.MEDIA_EXTRACT,
      'Extract a derived artifact from a media file (transcript, keyframes, audio track, or clip) via a configured delegated backend. Results are cached in media memory and searchable via media_grep.',
      Kind.Read,
      {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to the media file.',
          },
          mode: {
            type: 'string',
            enum: ['transcript', 'keyframes', 'audio_track', 'clip'],
            description: 'What to extract.',
          },
          range: {
            type: 'array',
            items: { type: 'number' },
            minItems: 2,
            maxItems: 2,
            description: 'Optional time range [startSeconds, endSeconds].',
          },
        },
        required: ['file_path', 'mode'],
      },
    );
  }

  protected override validateToolParamValues(
    params: MediaExtractParams,
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
    params: MediaExtractParams,
  ): ToolInvocation<MediaExtractParams, ToolResult> {
    return new MediaExtractInvocation(this.config, params);
  }
}
