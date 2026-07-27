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
import { getMediaReadPermission } from '../../utils/media/media-security.js';
import {
  buildMediaDelivery,
  buildMediaError,
} from '../../utils/media/media-result.js';
import { dispatchMediaSegments } from '../../utils/media/media-dispatch.js';
import { MediaReadError } from '../../utils/media/reader-registry.js';
import { isMediaUrl } from '../../utils/media/media-source.js';

export interface MediaDispatchParams {
  file_path: string;
  segments?: number;
  prompt?: string;
  force?: boolean;
}

class MediaDispatchInvocation extends BaseToolInvocation<
  MediaDispatchParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: MediaDispatchParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const base = path.basename(this.params.file_path);
    return this.params.segments
      ? `${base} (${this.params.segments} segments, parallel)`
      : `${base} (parallel segments)`;
  }

  override async getDefaultPermission(): Promise<PermissionDecision> {
    return getMediaReadPermission(this.params.file_path, this.config);
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    let result;
    try {
      result = await dispatchMediaSegments(this.params.file_path, this.config, {
        signal,
        ...(this.params.segments ? { segments: this.params.segments } : {}),
        ...(this.params.prompt ? { prompt: this.params.prompt } : {}),
        ...(this.params.force ? { force: true } : {}),
      });
    } catch (err) {
      if (err instanceof MediaReadError) {
        return buildMediaError({
          kind: err.kind,
          message: err.message,
          remedy: err.remedy,
        });
      }
      throw err;
    }

    // Cache hit: return the stored cross-session understanding without re-work.
    if (result.fromMemory) {
      return buildMediaDelivery(
        `Recalled prior understanding of ${result.path} from media memory (no re-analysis):\n\n${result.memoryBody ?? ''}`,
        {
          path: result.path,
          hash: result.hash,
          modality: 'video',
          scope: 'recalled from cross-session media memory',
          precision:
            'cached understanding from a previous analysis — pass force=true to re-analyze the video',
          readMore:
            'Call media_dispatch with force=true to re-run the parallel analysis, or media_watch a time range for raw fidelity.',
        },
      );
    }

    const body = result.segments
      .map(
        (s) =>
          `## Segment ${s.index + 1} · t=${s.range[0]}s–${s.range[1]}s (${s.frameCount} frames)\n${s.note}`,
      )
      .join('\n\n');
    const text = `Parallel segment understanding of ${result.path} (${Math.round(result.durationSec)}s, model ${result.model}):\n\n${body}`;

    return buildMediaDelivery(text, {
      path: result.path,
      hash: result.hash,
      modality: 'video',
      scope: `${result.segments.length} time segments understood in parallel by ${result.model}`,
      precision:
        'per-segment keyframe notes (LOSSY: keyframes only, no audio) — recorded in media memory, searchable via media_grep',
      readMore:
        'For a specific segment at full fidelity, call media_watch with a time range.',
    });
  }
}

/**
 * media_dispatch — fan out parallel understanding of a long video's time
 * segments and record the combined result in cross-session media memory. Works
 * whether or not the main model is multimodal.
 */
export class MediaDispatchTool extends BaseDeclarativeTool<
  MediaDispatchParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.MEDIA_DISPATCH;

  constructor(private config: Config) {
    super(
      MediaDispatchTool.Name,
      ToolDisplayNames.MEDIA_DISPATCH,
      'Understand a long video by splitting it into time segments and understanding each in parallel (keyframes per segment), then aggregating the notes into media memory. If the same video was analyzed in a previous session, the stored understanding is returned instantly (pass force=true to re-analyze). Use for videos too long or large to watch in one pass.',
      Kind.Read,
      {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path or http(s) URL of the video file.',
          },
          segments: {
            type: 'integer',
            description:
              'Optional number of time segments to split into (default ~1 per 30s, max 12).',
          },
          prompt: {
            type: 'string',
            description:
              'Optional: what to extract from each segment. Defaults to a general factual description. Set it to target the question you need answered (e.g. "identify any team, brand, studio, logo, or credits shown"). Analyses are cached per (file, prompt) and accumulate in media memory.',
          },
          force: {
            type: 'boolean',
            description:
              'Re-analyze even if a prior understanding for this same prompt exists in media memory (default false).',
          },
        },
        required: ['file_path'],
      },
    );
  }

  protected override validateToolParamValues(
    params: MediaDispatchParams,
  ): string | null {
    if (!params.file_path?.trim()) {
      return "The 'file_path' parameter must be non-empty.";
    }
    if (!path.isAbsolute(params.file_path) && !isMediaUrl(params.file_path)) {
      return `File path must be an absolute path or an http(s) URL, but was: ${params.file_path}.`;
    }
    if (
      params.segments !== undefined &&
      (!Number.isInteger(params.segments) || params.segments < 1)
    ) {
      return 'segments must be a positive integer.';
    }
    return null;
  }

  protected createInvocation(
    params: MediaDispatchParams,
  ): ToolInvocation<MediaDispatchParams, ToolResult> {
    return new MediaDispatchInvocation(this.config, params);
  }
}
