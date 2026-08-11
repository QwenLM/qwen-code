/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  MediaPolicyToolDescriptor,
  ToolInvocation,
  ToolResult,
} from '../../../tools/tools.js';
import { Kind } from '../../../tools/tools.js';
import { ToolNames } from '../../../tools/tool-names.js';
import { probeMediaMetadata, runFfmpeg } from '../../ffmpeg.js';
import {
  assertMediaPolicyIo,
  BaseMediaPolicyTool,
  ffmpegFailureMessage,
  BaseMediaPolicyToolInvocation,
  MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
  mediaPolicyToolError,
  mediaPolicyToolFailure,
  mediaPolicyToolSuccess,
  resolvePolicyToolTimeoutMs,
  type MediaPolicyIoParams,
  type MediaPolicyToolConfigView,
} from './media-policy-tool.js';

export const OMNI_CLIP_VIDEO_TOOL_NAME = ToolNames.OMNI_CLIP_VIDEO;

/** Fixed-call default encode parameters (mapping doc §6.1): clip is a
 * time-axis cut, NOT a degradation — crf 23 preserves quality; lowering
 * resolution/bit rate is omni_downscale_video's job. */
export const CLIP_VIDEO_DEFAULTS = {
  crf: 23,
  preset: 'veryfast',
  audioBitrateKbps: 128,
} as const;

const OUTPUT_FILE_NAME = 'clip.mp4';

export interface ClipVideoParams extends MediaPolicyIoParams {
  /** Clip start in seconds (default 0). */
  startSec?: number;
  /** Clip duration in seconds (default: to the end of the video). */
  durationSec?: number;
}

const TUNABLE_SCHEMA_PROPERTIES = {
  startSec: {
    type: 'number',
    description: 'Clip start position in seconds. Default 0.',
    minimum: 0,
  },
  durationSec: {
    type: 'number',
    description: 'Clip duration in seconds. Default: from startSec to the end.',
    exclusiveMinimum: 0,
  },
} as const;

const DESCRIPTOR: MediaPolicyToolDescriptor = {
  kind: 'media_policy',
  version: '1',
  inputMediaTypes: ['video'],
  outputs: [
    {
      kind: 'media',
      mimeTypes: ['video/mp4'],
      required: true,
      lossy: true,
    },
    { kind: 'text', role: 'disclosure', required: true },
  ],
  settingsSchema: {
    type: 'object',
    properties: TUNABLE_SCHEMA_PROPERTIES,
    additionalProperties: false,
  },
};

/** "12s" / "12.4s" — seconds with at most one decimal. */
function formatSeconds(seconds: number): string {
  return `${Math.round(seconds * 10) / 10}s`;
}

class ClipVideoInvocation extends BaseMediaPolicyToolInvocation<ClipVideoParams> {
  constructor(
    params: ClipVideoParams,
    private readonly timeoutMs: number,
  ) {
    super(params);
  }

  getDescription(): string {
    const start = this.params.startSec ?? 0;
    const span =
      this.params.durationSec !== undefined
        ? `${formatSeconds(start)}–${formatSeconds(start + this.params.durationSec)}`
        : `${formatSeconds(start)}–end`;
    return `Clip ${path.basename(this.params.inputPath)} to [${span}]`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const startSec = this.params.startSec ?? 0;
    const durationSec = this.params.durationSec;
    try {
      await assertMediaPolicyIo(this.params);
      const probe = await probeMediaMetadata(
        this.params.inputPath,
        'video',
        signal,
      );
      const totalSeconds =
        probe.durationMs !== undefined ? probe.durationMs / 1000 : undefined;
      if (totalSeconds !== undefined && startSec >= totalSeconds) {
        return mediaPolicyToolError(
          `startSec (${formatSeconds(startSec)}) is at or beyond the end of the video (${formatSeconds(totalSeconds)})`,
        );
      }
      // Detectable full-span no-op: the effective window covers the whole
      // video, so "clipping" would only run a lossy re-encode and the
      // disclosure would falsely claim content outside the span was
      // discarded. This is a time-axis cut, NOT a degradation tool.
      if (
        totalSeconds !== undefined &&
        startSec === 0 &&
        durationSec !== undefined &&
        durationSec >= totalSeconds
      ) {
        return mediaPolicyToolError(
          `the requested span [0–${formatSeconds(durationSec)}] covers the ` +
            `entire video (${formatSeconds(totalSeconds)}) — a no-op clip ` +
            `that would only re-encode (and damage) the input`,
        );
      }

      const outputPath = path.join(this.params.outputDir, OUTPUT_FILE_NAME);
      // Input-side -ss/-t plus a full re-encode: frame-accurate cuts
      // regardless of keyframe placement (`-c copy` snaps to keyframes).
      // The scale filter only forces even dimensions (libx264 hard
      // requirement); resolution is otherwise preserved.
      const run = await runFfmpeg(
        [
          '-y',
          '-ss',
          String(startSec),
          ...(durationSec !== undefined ? ['-t', String(durationSec)] : []),
          '-i',
          this.params.inputPath,
          '-vf',
          'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          '-c:v',
          'libx264',
          '-crf',
          String(CLIP_VIDEO_DEFAULTS.crf),
          '-preset',
          CLIP_VIDEO_DEFAULTS.preset,
          '-c:a',
          'aac',
          '-b:a',
          `${CLIP_VIDEO_DEFAULTS.audioBitrateKbps}k`,
          '-movflags',
          '+faststart',
          outputPath,
        ],
        { signal, timeoutMs: this.timeoutMs },
      );
      if (signal.aborted) {
        return mediaPolicyToolError('video clipping aborted');
      }
      if (run.code !== 0) {
        return mediaPolicyToolError(
          ffmpegFailureMessage(run, 'clipping', this.params.inputPath),
        );
      }

      const outputSizeBytes = (await fs.stat(outputPath)).size;
      const endSec =
        durationSec !== undefined
          ? totalSeconds !== undefined
            ? Math.min(startSec + durationSec, totalSeconds)
            : startSec + durationSec
          : totalSeconds;
      const original =
        totalSeconds !== undefined ? formatSeconds(totalSeconds) : '未知时长';
      const endText = endSec !== undefined ? formatSeconds(endSec) : '结尾';
      const spanText =
        endSec !== undefined ? ` ${formatSeconds(endSec - startSec)}` : '';
      const disclosure = `原 ${original} → 片段 [${formatSeconds(startSec)}–${endText}]${spanText}，片段外内容全部丢弃`;

      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName: OUTPUT_FILE_NAME,
        artifactKind: 'video',
        title: 'Clipped video',
        mimeType: 'video/mp4',
        sizeBytes: outputSizeBytes,
        disclosure,
        // Marks the artifact as a temporal excerpt for downstream role
        // consumers (output routing selectors, memory coverage).
        role: 'clip',
      });
    } catch (error) {
      return mediaPolicyToolFailure(error);
    }
  }
}

/**
 * `omni_clip_video` — time-axis cut (ffmpeg): input-side seek plus a
 * frame-accurate re-encode of the selected span (mapping doc §6.1).
 * Everything outside the span is discarded — lossy by definition, with
 * the span disclosed.
 */
export class OmniClipVideoTool extends BaseMediaPolicyTool<ClipVideoParams> {
  constructor(config: MediaPolicyToolConfigView) {
    super(
      OMNI_CLIP_VIDEO_TOOL_NAME,
      'ClipVideo',
      'Cuts a time span out of a video (frame-accurate re-encode), discarding everything outside the span, with a disclosure of the cut.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          ...MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
          ...TUNABLE_SCHEMA_PROPERTIES,
        },
        required: ['inputPath', 'outputDir'],
        additionalProperties: false,
      },
      config,
    );
  }

  override get mediaPolicyDescriptor(): MediaPolicyToolDescriptor {
    return DESCRIPTOR;
  }

  protected override validateToolParamValues(
    params: ClipVideoParams,
  ): string | null {
    const ioError = super.validateToolParamValues(params);
    if (ioError) return ioError;
    // A no-op invocation (full-length "clip") must be rejected at the
    // parameter layer instead of burning a full lossy re-encode on it:
    // both absent, or an explicit startSec of 0 with no duration bound.
    if (params.startSec === undefined && params.durationSec === undefined) {
      return 'at least one of startSec / durationSec must be provided';
    }
    if (params.startSec === 0 && params.durationSec === undefined) {
      return (
        'startSec: 0 without durationSec selects the whole video — a no-op ' +
        'clip that would only re-encode (and damage) the input'
      );
    }
    return null;
  }

  protected createInvocation(
    params: ClipVideoParams,
  ): ToolInvocation<ClipVideoParams, ToolResult> {
    return new ClipVideoInvocation(
      params,
      resolvePolicyToolTimeoutMs(this.configView, this.name),
    );
  }
}
