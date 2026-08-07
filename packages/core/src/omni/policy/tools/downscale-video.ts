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
import { BaseToolInvocation, Kind } from '../../../tools/tools.js';
import { probeMediaMetadata, runFfmpeg } from '../../ffmpeg.js';
import {
  assertMediaPolicyIo,
  BaseMediaPolicyTool,
  formatBytesShort,
  MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
  mediaPolicyToolError,
  mediaPolicyToolSuccess,
  resolvePolicyToolTimeoutMs,
  validateMediaPolicyIoParams,
  type MediaPolicyIoParams,
  type MediaPolicyToolConfigView,
} from './media-policy-tool.js';

export const OMNI_DOWNSCALE_VIDEO_TOOL_NAME = 'omni_downscale_video';

/** Fixed-call default parameters (mapping doc §6). */
export const DOWNSCALE_VIDEO_DEFAULTS = {
  maxHeight: 480,
  fps: 10,
  crf: 28,
  preset: 'veryfast',
} as const;

const OUTPUT_FILE_NAME = 'downscaled.mp4';

/** x264 presets accepted by the `preset` tunable. */
const X264_PRESETS = [
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
] as const;

export interface DownscaleVideoParams extends MediaPolicyIoParams {
  /** Output height ceiling in pixels (width follows aspect ratio). */
  maxHeight?: number;
  /** Output frame rate. */
  fps?: number;
  /** x264 constant rate factor (higher = smaller/lossier). */
  crf?: number;
  /** x264 encoding preset. */
  preset?: string;
}

const TUNABLE_SCHEMA_PROPERTIES = {
  maxHeight: {
    type: 'number',
    description:
      'Output height ceiling in pixels (width follows aspect ratio). Default 480.',
    minimum: 2,
  },
  fps: {
    type: 'number',
    description: 'Output frame rate. Default 10.',
    minimum: 1,
  },
  crf: {
    type: 'number',
    description:
      'x264 constant rate factor, 0-51 (higher = smaller/lossier). Default 28.',
    minimum: 0,
    maximum: 51,
  },
  preset: {
    type: 'string',
    description: 'x264 encoding preset. Default "veryfast".',
    enum: [...X264_PRESETS],
  },
} as const;

const DESCRIPTOR: MediaPolicyToolDescriptor = {
  kind: 'media_policy',
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

class DownscaleVideoInvocation extends BaseToolInvocation<
  DownscaleVideoParams,
  ToolResult
> {
  constructor(
    params: DownscaleVideoParams,
    private readonly timeoutMs: number,
  ) {
    super(params);
  }

  getDescription(): string {
    const maxHeight =
      this.params.maxHeight ?? DOWNSCALE_VIDEO_DEFAULTS.maxHeight;
    return `Downscale ${path.basename(this.params.inputPath)} to ${maxHeight}p`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const maxHeight =
      this.params.maxHeight ?? DOWNSCALE_VIDEO_DEFAULTS.maxHeight;
    const fps = this.params.fps ?? DOWNSCALE_VIDEO_DEFAULTS.fps;
    const crf = this.params.crf ?? DOWNSCALE_VIDEO_DEFAULTS.crf;
    const preset = this.params.preset ?? DOWNSCALE_VIDEO_DEFAULTS.preset;
    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);
      const probe = await probeMediaMetadata(
        this.params.inputPath,
        'video',
        signal,
      );
      if (probe.height === undefined) {
        return mediaPolicyToolError(
          `could not determine video height of ${path.basename(this.params.inputPath)}`,
        );
      }

      // Target height computed in JS from the probe (not an ffmpeg scale
      // expression — expression commas need filtergraph escaping and are
      // easy to get subtly wrong): never upscale, and round down to even
      // because libx264 requires even dimensions. `scale=-2:h` rounds the
      // width to even automatically.
      const targetHeight = Math.max(
        2,
        Math.floor(Math.min(maxHeight, probe.height) / 2) * 2,
      );
      const outputPath = path.join(this.params.outputDir, OUTPUT_FILE_NAME);
      const argsFor = (audio: string[]): string[] => [
        '-y',
        '-i',
        this.params.inputPath,
        '-vf',
        `scale=-2:${targetHeight},fps=${fps}`,
        '-c:v',
        'libx264',
        '-crf',
        String(crf),
        '-preset',
        preset,
        ...audio,
        outputPath,
      ];

      // Audio: try stream copy first (free); if the source codec cannot be
      // muxed into mp4 (e.g. pcm, vorbis) ffmpeg fails fast, and the
      // fallback re-encodes to AAC 64k (mapping doc §6: copy→aac 兜底).
      let run = await runFfmpeg(argsFor(['-c:a', 'copy']), {
        signal,
        timeoutMs: this.timeoutMs,
      });
      if (signal.aborted) {
        return mediaPolicyToolError('video downscaling aborted');
      }
      if (run.code !== 0) {
        run = await runFfmpeg(argsFor(['-c:a', 'aac', '-b:a', '64k']), {
          signal,
          timeoutMs: this.timeoutMs,
        });
        if (signal.aborted) {
          return mediaPolicyToolError('video downscaling aborted');
        }
        if (run.code !== 0) {
          return mediaPolicyToolError(
            `ffmpeg failed (exit ${run.code}) downscaling ${path.basename(this.params.inputPath)}: ${run.stderr.slice(-500)}`,
          );
        }
      }

      const outputSizeBytes = (await fs.stat(outputPath)).size;
      const originalRate =
        probe.frameRate !== undefined ? Math.round(probe.frameRate) : '?';
      const disclosure = `原 ${probe.height}p${originalRate}/${formatBytesShort(inputSizeBytes)} → ${targetHeight}p${fps}/${formatBytesShort(outputSizeBytes)}，分辨率与帧率下降，细节受损`;

      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName: OUTPUT_FILE_NAME,
        artifactKind: 'video',
        title: 'Downscaled video',
        mimeType: 'video/mp4',
        sizeBytes: outputSizeBytes,
        disclosure,
      });
    } catch (error) {
      return mediaPolicyToolError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

/**
 * `omni_downscale_video` — lossy video degradation (ffmpeg): scale to a
 * height ceiling, drop the frame rate, re-encode with x264 at a fixed CRF;
 * audio is stream-copied with an AAC 64k fallback (mapping doc §6).
 */
export class OmniDownscaleVideoTool extends BaseMediaPolicyTool<DownscaleVideoParams> {
  constructor(private readonly config: MediaPolicyToolConfigView) {
    super(
      OMNI_DOWNSCALE_VIDEO_TOOL_NAME,
      'DownscaleVideo',
      'Downscales a video to a maximum height and frame rate and re-encodes it, producing a smaller lossy derivative with a disclosure of the degradation.',
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
    params: DownscaleVideoParams,
  ): string | null {
    return validateMediaPolicyIoParams(params);
  }

  protected createInvocation(
    params: DownscaleVideoParams,
  ): ToolInvocation<DownscaleVideoParams, ToolResult> {
    return new DownscaleVideoInvocation(
      params,
      resolvePolicyToolTimeoutMs(this.config, this.name),
    );
  }
}
