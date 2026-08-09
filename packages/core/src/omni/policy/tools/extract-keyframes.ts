/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  MediaPolicyToolDescriptor,
  ToolArtifact,
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
  resolvePolicyToolTimeoutMs,
  createPolicyToolTimeoutBudget,
  type MediaPolicyIoParams,
  type MediaPolicyToolConfigView,
} from './media-policy-tool.js';

export const OMNI_EXTRACT_KEYFRAMES_TOOL_NAME =
  ToolNames.OMNI_EXTRACT_KEYFRAMES;

/** Fixed-call default parameters (mapping doc §6.1). */
export const EXTRACT_KEYFRAMES_DEFAULTS = {
  maxFrames: 8,
  sceneThreshold: 0.2,
  maxDimension: 768,
} as const;

const FRAME_FILE_PATTERN = /^keyframe_(\d{4})\.jpg$/;

export interface ExtractKeyframesParams extends MediaPolicyIoParams {
  /** Maximum number of frames to extract. */
  maxFrames?: number;
  /** Scene-change threshold (0-1) for the scene-detection engine. */
  sceneThreshold?: number;
  /** Longest-edge ceiling in pixels for the extracted frames. */
  maxDimension?: number;
}

const TUNABLE_SCHEMA_PROPERTIES = {
  maxFrames: {
    type: 'number',
    description: 'Maximum number of frames to extract. Default 8.',
    minimum: 1,
    maximum: 64,
  },
  sceneThreshold: {
    type: 'number',
    description:
      'Scene-change threshold (0-1) for keyframe selection. Default 0.2.',
    minimum: 0,
    maximum: 1,
  },
  maxDimension: {
    type: 'number',
    description:
      'Longest-edge ceiling in pixels for the extracted frames ' +
      '(aspect ratio preserved, never enlarged). Default 768.',
    minimum: 16,
  },
} as const;

const DESCRIPTOR: MediaPolicyToolDescriptor = {
  kind: 'media_policy',
  version: '1',
  inputMediaTypes: ['video'],
  outputs: [
    {
      kind: 'media',
      mimeTypes: ['image/jpeg'],
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

/**
 * Fit-inside scale expression: longest edge capped at `maxDimension`,
 * aspect ratio preserved, small inputs never enlarged (the min() box is
 * the input's own size when it is already within the ceiling).
 */
function scaleFilter(maxDimension: number): string {
  return (
    `scale='min(${maxDimension},iw)':'min(${maxDimension},ih)'` +
    `:force_original_aspect_ratio=decrease`
  );
}

/**
 * Parse per-frame presentation timestamps from ffmpeg's showinfo stderr
 * lines (`[Parsed_showinfo…] n: 3 … pts_time:12.4 …`), in output order.
 */
export function parseShowinfoTimestamps(stderr: string): number[] {
  const timestamps: number[] = [];
  const pattern = /\bn:\s*\d+.*?\bpts_time:(-?[\d.]+)/g;
  for (const match of stderr.matchAll(pattern)) {
    const t = Number(match[1]);
    timestamps.push(Number.isFinite(t) && t >= 0 ? t : NaN);
  }
  return timestamps;
}

/** List produced keyframe files in frame order. */
async function listFrameFiles(outputDir: string): Promise<string[]> {
  const entries = await fs.readdir(outputDir);
  return entries.filter((name) => FRAME_FILE_PATTERN.test(name)).sort();
}

class ExtractKeyframesInvocation extends BaseMediaPolicyToolInvocation<ExtractKeyframesParams> {
  constructor(
    params: ExtractKeyframesParams,
    private readonly timeoutMs: number,
  ) {
    super(params);
  }

  getDescription(): string {
    const maxFrames =
      this.params.maxFrames ?? EXTRACT_KEYFRAMES_DEFAULTS.maxFrames;
    return `Extract up to ${maxFrames} keyframes from ${path.basename(this.params.inputPath)}`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const maxFrames = Math.floor(
      this.params.maxFrames ?? EXTRACT_KEYFRAMES_DEFAULTS.maxFrames,
    );
    const sceneThreshold =
      this.params.sceneThreshold ?? EXTRACT_KEYFRAMES_DEFAULTS.sceneThreshold;
    const maxDimension =
      this.params.maxDimension ?? EXTRACT_KEYFRAMES_DEFAULTS.maxDimension;
    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);
      const probe = await probeMediaMetadata(
        this.params.inputPath,
        'video',
        signal,
      );
      const outputPattern = path.join(
        this.params.outputDir,
        'keyframe_%04d.jpg',
      );

      // Scene-detection pass: frame 0 always selected, then every frame
      // whose scene score exceeds the threshold, capped at maxFrames.
      // showinfo (after select) logs one stderr line per KEPT frame with
      // its pts_time — the timestamps feed the per-frame disclosures.
      // Both passes share ONE wall-clock budget: the uniform-sampling
      // fallback gets only what the scene pass left, keeping the
      // invocation within the configured timeout instead of doubling it.
      const remainingTimeoutMs = createPolicyToolTimeoutBudget(this.timeoutMs);
      const scenePass = await runFfmpeg(
        [
          '-y',
          '-i',
          this.params.inputPath,
          '-vf',
          `select='eq(n,0)+gt(scene,${sceneThreshold})',${scaleFilter(maxDimension)},showinfo`,
          '-vsync',
          'vfr',
          '-frames:v',
          String(maxFrames),
          '-q:v',
          '4',
          outputPattern,
        ],
        { signal, timeoutMs: remainingTimeoutMs() },
      );
      if (signal.aborted) {
        return mediaPolicyToolError('keyframe extraction aborted');
      }
      if (scenePass.code !== 0) {
        return mediaPolicyToolError(
          ffmpegFailureMessage(
            scenePass,
            'extracting keyframes from',
            this.params.inputPath,
          ),
        );
      }

      let frameFiles = await listFrameFiles(this.params.outputDir);
      let timestamps = parseShowinfoTimestamps(scenePass.stderr);

      // Uniform-sampling fallback: a static or single-shot video defeats
      // scene detection (only frame 0 survives). When the caller asked
      // for more than one frame and the duration is known, resample the
      // timeline evenly instead.
      const durationSeconds =
        probe.durationMs !== undefined && probe.durationMs > 0
          ? probe.durationMs / 1000
          : undefined;
      if (
        frameFiles.length < Math.min(2, maxFrames) &&
        maxFrames > 1 &&
        durationSeconds !== undefined
      ) {
        await Promise.all(
          frameFiles.map((name) =>
            fs.rm(path.join(this.params.outputDir, name), { force: true }),
          ),
        );
        const fps = maxFrames / durationSeconds;
        const uniformPass = await runFfmpeg(
          [
            '-y',
            '-i',
            this.params.inputPath,
            '-vf',
            `fps=${fps},${scaleFilter(maxDimension)},showinfo`,
            '-frames:v',
            String(maxFrames),
            '-q:v',
            '4',
            outputPattern,
          ],
          { signal, timeoutMs: remainingTimeoutMs() },
        );
        if (signal.aborted) {
          return mediaPolicyToolError('keyframe extraction aborted');
        }
        if (uniformPass.code !== 0) {
          return mediaPolicyToolError(
            ffmpegFailureMessage(
              uniformPass,
              'uniformly sampling',
              this.params.inputPath,
            ),
          );
        }
        frameFiles = await listFrameFiles(this.params.outputDir);
        timestamps = parseShowinfoTimestamps(uniformPass.stderr);
      }

      if (frameFiles.length === 0) {
        return mediaPolicyToolError(
          `no keyframes could be extracted from ${path.basename(this.params.inputPath)}`,
        );
      }

      const originalDuration =
        durationSeconds !== undefined
          ? `${Math.round(durationSeconds)}s`
          : formatBytesShort(inputSizeBytes);
      const originalResolution =
        probe.width !== undefined && probe.height !== undefined
          ? `/${probe.width}×${probe.height}`
          : '';

      const artifacts: ToolArtifact[] = [];
      for (const [index, fileName] of frameFiles.entries()) {
        const sizeBytes = (
          await fs.stat(path.join(this.params.outputDir, fileName))
        ).size;
        const t = timestamps[index];
        const atTime =
          t !== undefined && Number.isFinite(t)
            ? ` @ ${Math.round(t * 10) / 10}s`
            : '';
        artifacts.push({
          kind: 'image',
          storage: 'workspace',
          title: `Keyframe ${index + 1}/${frameFiles.length}`,
          workspacePath: fileName,
          mimeType: 'image/jpeg',
          sizeBytes,
          metadata: {
            omniDisclosure: `原视频 ${originalDuration}${originalResolution} → 关键帧 ${index + 1}/${frameFiles.length}${atTime}，静态抽帧，时间连续性丢失`,
          },
        });
      }

      const summary = `Extracted ${frameFiles.length} keyframe(s) from ${path.basename(this.params.inputPath)} (${originalDuration}${originalResolution})`;
      // Not mediaPolicyToolSuccess: that helper encodes the common
      // one-artifact contract, while this is the multi-artifact tool —
      // every frame is its own artifact with its own disclosure.
      return {
        llmContent: summary,
        returnDisplay: summary,
        artifacts,
      };
    } catch (error) {
      return mediaPolicyToolFailure(error);
    }
  }
}

/**
 * `omni_extract_keyframes` — scene-detected still frames (ffmpeg): select
 * frame 0 plus scene changes above the threshold, scaled to fit
 * `maxDimension`, as JPEG artifacts with per-frame timestamps in the
 * disclosure; uniform sampling is the fallback for static footage
 * (mapping doc §6.1). This is the multi-artifact policy tool — every
 * frame is promoted in one atomic invocation transaction.
 */
export class OmniExtractKeyframesTool extends BaseMediaPolicyTool<ExtractKeyframesParams> {
  constructor(config: MediaPolicyToolConfigView) {
    super(
      OMNI_EXTRACT_KEYFRAMES_TOOL_NAME,
      'ExtractKeyframes',
      'Extracts representative still frames from a video via scene detection (uniform sampling as fallback), producing JPEG keyframes with per-frame timestamps and a disclosure of the temporal loss.',
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

  protected createInvocation(
    params: ExtractKeyframesParams,
  ): ToolInvocation<ExtractKeyframesParams, ToolResult> {
    return new ExtractKeyframesInvocation(
      params,
      resolvePolicyToolTimeoutMs(this.configView, this.name),
    );
  }
}
