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
import { deriveMediaArtifact } from '../../utils/media/media-derive.js';
import { getMediaReadPermission } from '../../utils/media/media-security.js';
import type { MediaReadParams } from '../../utils/media/reader-registry.js';
import type { MediaEffort } from '../../utils/media/types.js';

export type ExtractMode = 'transcript' | 'keyframes' | 'audio_track' | 'clip';

export interface MediaExtractParams {
  file_path: string;
  mode: ExtractMode;
  range?: [number, number];
  effort?: MediaEffort;
}

/**
 * P4 · `media_extract` — explicit derivation (transcript / keyframes / audio
 * track / clip). Keyframes/audio_track/clip run locally via ffmpeg and are
 * written to the content-addressed derived store (each artifact becomes a
 * first-class media file linked back to the source, searchable via media_grep).
 * `transcript` needs understanding (ASR), so it routes to the delegated read
 * backend and fails closed with a remedy when none is configured.
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
    if (this.params.mode === 'transcript') {
      const params: MediaReadParams = { intent: 'transcript' };
      if (this.params.range) params.range = this.params.range;
      if (this.params.effort) params.effort = this.params.effort;
      return readMedia({
        filePath: this.params.file_path,
        params,
        config: this.config,
        signal,
        requireDelegated: true,
      });
    }
    return deriveMediaArtifact({
      filePath: this.params.file_path,
      mode: this.params.mode,
      ...(this.params.range ? { range: this.params.range } : {}),
      ...(this.params.effort ? { effort: this.params.effort } : {}),
      config: this.config,
      signal,
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
      'Extract a derived artifact from a media file. keyframes/audio_track/clip run locally via ffmpeg and cache the artifact as a first-class media file (searchable via media_grep); transcript uses a configured understanding/ASR backend. Every result states scope and precision.',
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
            description:
              'What to extract. clip requires a range; keyframes needs a video.',
          },
          range: {
            type: 'array',
            items: { type: 'number' },
            minItems: 2,
            maxItems: 2,
            description: 'Optional time range [startSeconds, endSeconds].',
          },
          effort: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'xhigh', 'max'],
            description:
              'Optional detail/cost tradeoff (more keyframes / higher resolution).',
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
