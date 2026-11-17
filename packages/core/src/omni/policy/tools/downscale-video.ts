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
  formatBytesShort,
  MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
  mediaPolicyToolError,
  mediaPolicyToolFailure,
  mediaPolicyToolSuccess,
  policyOutputFileName,
  resolvePolicyToolTimeoutMs,
  createPolicyToolTimeoutBudget,
  type MediaPolicyIoParams,
  type MediaPolicyToolConfigView,
} from './media-policy-tool.js';

export const OMNI_DOWNSCALE_VIDEO_TOOL_NAME = ToolNames.OMNI_DOWNSCALE_VIDEO;

/** Fixed-call default parameters (mapping doc §6). */
export const DOWNSCALE_VIDEO_DEFAULTS = {
  maxHeight: 480,
  fps: 10,
  crf: 28,
  preset: 'veryfast',
} as const;

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
    description:
      'Output frame rate. Fractional rates (e.g. 0.5 = one frame every 2s) are supported. Default 10.',
    // Fractional floor: the server-side billing of omni video is per
    // SAMPLED FRAME, so sub-1fps rates are the effective degradation
    // lever for long clips (reactive server-limit fallback ladder).
    minimum: 0.01,
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

class DownscaleVideoInvocation extends BaseMediaPolicyToolInvocation<DownscaleVideoParams> {
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
      const outputPath = path.join(
        this.params.outputDir,
        policyOutputFileName({
          inputPath: this.params.inputPath,
          operation: 'downscaled',
          extension: '.mp4',
        }),
      );
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
      // Both passes share ONE wall-clock budget: the fallback gets only
      // what the failed copy pass left, keeping the invocation within the
      // configured timeout instead of doubling it.
      const remainingTimeoutMs = createPolicyToolTimeoutBudget(this.timeoutMs);
      let run = await runFfmpeg(argsFor(['-c:a', 'copy']), {
        signal,
        timeoutMs: remainingTimeoutMs(),
      });
      if (signal.aborted) {
        return mediaPolicyToolError('video downscaling aborted');
      }
      if (run.code !== 0) {
        run = await runFfmpeg(argsFor(['-c:a', 'aac', '-b:a', '64k']), {
          signal,
          timeoutMs: remainingTimeoutMs(),
        });
        if (signal.aborted) {
          return mediaPolicyToolError('video downscaling aborted');
        }
        if (run.code !== 0) {
          return mediaPolicyToolError(
            ffmpegFailureMessage(run, 'downscaling', this.params.inputPath),
          );
        }
      }

      const outputSizeBytes = (await fs.stat(outputPath)).size;
      const originalRate =
        probe.frameRate !== undefined ? Math.round(probe.frameRate) : '?';
      // The loss clause must match the numbers shown next to it: a 360p@8
      // input downscaled for size against the 480p/10fps defaults lowers
      // neither dimension — claiming 分辨率与帧率下降 would contradict the
      // user-visible before/after figures (D8).
      const drops = [
        ...(targetHeight < probe.height ? ['分辨率下降'] : []),
        ...(probe.frameRate !== undefined && fps < probe.frameRate
          ? ['帧率下降']
          : []),
      ];
      const lossClause =
        drops.length === 2 ? '分辨率与帧率下降' : (drops[0] ?? '重新编码压缩');
      const disclosure = `原 ${probe.height}p${originalRate}/${formatBytesShort(inputSizeBytes)} → ${targetHeight}p${fps}/${formatBytesShort(outputSizeBytes)}，${lossClause}，细节受损`;

      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName: policyOutputFileName({
          inputPath: this.params.inputPath,
          operation: 'downscaled',
          extension: '.mp4',
        }),
        artifactKind: 'video',
        title: 'Downscaled video',
        mimeType: 'video/mp4',
        sizeBytes: outputSizeBytes,
        disclosure,
      });
    } catch (error) {
      return mediaPolicyToolFailure(error);
    }
  }
}

/**
 * `omni_downscale_video` — lossy video degradation (ffmpeg): scale to a
 * height ceiling, drop the frame rate, re-encode with x264 at a fixed CRF;
 * audio is stream-copied with an AAC 64k fallback (mapping doc §6).
 */
export class OmniDownscaleVideoTool extends BaseMediaPolicyTool<DownscaleVideoParams> {
  constructor(config: MediaPolicyToolConfigView) {
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
        required: ['outputDir'],
        additionalProperties: false,
      },
      config,
    );
  }

  override get mediaPolicyDescriptor(): MediaPolicyToolDescriptor {
    return DESCRIPTOR;
  }

  protected createInvocation(
    params: DownscaleVideoParams,
  ): ToolInvocation<DownscaleVideoParams, ToolResult> {
    return new DownscaleVideoInvocation(
      params,
      resolvePolicyToolTimeoutMs(this.configView, this.name),
    );
  }
}
