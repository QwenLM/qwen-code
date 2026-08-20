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
import {
  probeMediaMetadata,
  runFfmpeg,
  type FfmpegRunResult,
} from '../../ffmpeg.js';
import {
  assertMediaPolicyIo,
  BaseMediaPolicyTool,
  ffmpegFailureMessage,
  BaseMediaPolicyToolInvocation,
  formatBytesShort,
  MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
  mediaPolicyToolError,
  mediaPolicyToolFailure,
  policyOutputFileName,
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

/** Matcher for the frames of ONE source, derived from the name template
 * so the lister can never pick up a sibling video's frames out of a
 * shared outputDir. */
function frameFileMatcher(nameTemplate: string): RegExp {
  const escaped = nameTemplate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace('%04d', '(\\d{4})')}$`);
}

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
  // '2': outputs now carry `metadata.omniRole: 'keyframe'`, which memory
  // maps to `sampled` coverage. Pre-'2' cache entries and recorded
  // executions hold role-less outputs whose coverage was derived as
  // `complete`; sharing a version would let them converge onto the same
  // fingerprint and keep reporting sampled frames as complete visual
  // coverage — the model would answer about footage it never saw.
  version: '2',
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
async function listFrameFiles(
  outputDir: string,
  nameTemplate: string,
): Promise<string[]> {
  const matcher = frameFileMatcher(nameTemplate);
  const entries = await fs.readdir(outputDir);
  return entries.filter((name) => matcher.test(name)).sort();
}

/**
 * Per-bucket scene search window cap in seconds. Bounding the search
 * keeps the worst case (no scene changes anywhere — every window decoded
 * to its end) at `maxFrames × window` seconds of decoded video instead
 * of the full duration.
 */
const SCENE_SEARCH_WINDOW_SECONDS = 30;

/** One extracted frame with its absolute position on the timeline. */
interface ExtractedFrame {
  fileName: string;
  /** Absolute timestamp in seconds (undefined only on the legacy path
   * when showinfo produced no usable pts). */
  timeSeconds?: number;
}

/** Seconds formatted for ffmpeg `-ss`/`-t` args: fixed-point, never
 * scientific notation, millisecond precision. */
function formatSeconds(seconds: number): string {
  return seconds.toFixed(3);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Shared knobs threaded through one extraction run. */
interface ExtractionContext {
  maxFrames: number;
  sceneThreshold: number;
  maxDimension: number;
  remainingTimeoutMs: () => number;
  signal: AbortSignal;
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
      const durationSeconds =
        probe.durationMs !== undefined && probe.durationMs > 0
          ? probe.durationMs / 1000
          : undefined;

      // ALL ffmpeg passes share ONE wall-clock budget, keeping the
      // invocation within the configured timeout no matter how many
      // per-bucket runs it takes.
      const remainingTimeoutMs = createPolicyToolTimeoutBudget(this.timeoutMs);
      const context: ExtractionContext = {
        maxFrames,
        sceneThreshold,
        maxDimension,
        remainingTimeoutMs,
        signal,
      };

      // Bucketed extraction is the primary path: it spreads the frames
      // across the FULL duration instead of stopping at the first
      // maxFrames scene changes (which front-loads every frame into the
      // opening minutes of a long video). The single-pass path remains
      // for unknown duration (no way to place buckets) and single-frame
      // requests (one bucket ≡ one pass).
      const bucketed = durationSeconds !== undefined && maxFrames > 1;
      const extraction = bucketed
        ? await this.extractBucketed(context, durationSeconds)
        : await this.extractSinglePass(context);
      if (!Array.isArray(extraction)) {
        return extraction;
      }
      const frames = extraction;

      const originalDuration =
        durationSeconds !== undefined
          ? `${Math.round(durationSeconds)}s`
          : formatBytesShort(inputSizeBytes);
      const originalResolution =
        probe.width !== undefined && probe.height !== undefined
          ? `/${probe.width}×${probe.height}`
          : '';
      // D8: full-duration coverage may only be claimed when every bucket
      // actually yielded a frame — an early budget stop or a failed
      // bucket leaves unsampled spans, and the model must be told so it
      // does not answer questions about footage it never saw.
      const samplingNote = bucketed
        ? frames.length < maxFrames
          ? `静态抽帧（全片分桶采样，仅覆盖 ${frames.length}/${maxFrames} 个分桶，其余时段未采样）`
          : '静态抽帧（全片分桶采样）'
        : '静态抽帧';

      const artifacts: ToolArtifact[] = [];
      for (const [index, frame] of frames.entries()) {
        const sizeBytes = (
          await fs.stat(path.join(this.params.outputDir, frame.fileName))
        ).size;
        const t = frame.timeSeconds;
        const atTime =
          t !== undefined && Number.isFinite(t)
            ? ` @ ${Math.round(t * 10) / 10}s`
            : '';
        artifacts.push({
          kind: 'image',
          storage: 'workspace',
          title: `Keyframe ${index + 1}/${frames.length}`,
          workspacePath: frame.fileName,
          mimeType: 'image/jpeg',
          sizeBytes,
          metadata: {
            omniDisclosure: `原视频 ${originalDuration}${originalResolution} → 关键帧 ${index + 1}/${frames.length}${atTime}，${samplingNote}，时间连续性丢失`,
            // Marks the artifact as a sampled excerpt for downstream role
            // consumers (output routing selectors, memory coverage).
            omniRole: 'keyframe',
          },
        });
      }

      const summary = `Extracted ${frames.length} keyframe(s) from ${path.basename(this.params.inputPath)} (${originalDuration}${originalResolution})`;
      const outputPaths = frames
        .map((frame) => path.join(this.params.outputDir, frame.fileName))
        .join('\n');
      // Not mediaPolicyToolSuccess: that helper encodes the common
      // one-artifact contract, while this is the multi-artifact tool —
      // every frame is its own artifact with its own disclosure.
      return {
        llmContent:
          `${summary}\nOutput files:\n${outputPaths}\n` +
          'Use read_file with these absolute paths to inspect the results.',
        returnDisplay: summary,
        artifacts,
      };
    } catch (error) {
      return mediaPolicyToolFailure(error);
    }
  }

  /**
   * Full-duration coverage: split the timeline into `maxFrames` equal
   * buckets and extract one frame per bucket — a scene change from the
   * bucket's opening window when one exists, the bucket midpoint
   * otherwise. Input seeking (`-ss` before `-i`) jumps straight to each
   * bucket without decoding the preceding footage; it also resets
   * pts to ~0, so the absolute timestamp is bucketStart + showinfo
   * pts_time. Individual bucket failures are tolerated (the last one is
   * kept for the zero-frames diagnostic); the loop stops early when the
   * shared budget is exhausted.
   */
  private async extractBucketed(
    context: ExtractionContext,
    durationSeconds: number,
  ): Promise<ToolResult | ExtractedFrame[]> {
    const {
      maxFrames,
      sceneThreshold,
      maxDimension,
      remainingTimeoutMs,
      signal,
    } = context;
    const bucket = durationSeconds / maxFrames;
    const window = Math.min(bucket, SCENE_SEARCH_WINDOW_SECONDS);
    const frames: ExtractedFrame[] = [];
    let lastFailure: FfmpegRunResult | undefined;

    for (let i = 0; i < maxFrames; i++) {
      if (remainingTimeoutMs() <= 1) {
        break;
      }
      const bucketStart = i * bucket;
      // Frame index is the natural variant; the source stem keeps two
      // videos' frames from colliding in one persistent outputDir.
      const fileName = policyOutputFileName({
        inputPath: this.params.inputPath,
        operation: 'keyframe',
        variant: String(i + 1).padStart(4, '0'),
        extension: '.jpg',
      });
      const outputPath = path.join(this.params.outputDir, fileName);

      // Scene attempt: first scene change within the bucket's opening
      // window. `-update 1` lets ffmpeg write a literal (non-pattern)
      // image filename; `-frames:v 1` stops the decode at the first hit.
      const sceneRun = await runFfmpeg(
        [
          '-y',
          '-ss',
          formatSeconds(bucketStart),
          '-t',
          formatSeconds(window),
          '-i',
          this.params.inputPath,
          '-vf',
          `select='gt(scene,${sceneThreshold})',${scaleFilter(maxDimension)},showinfo`,
          '-vsync',
          'vfr',
          '-frames:v',
          '1',
          '-q:v',
          '4',
          '-update',
          '1',
          outputPath,
        ],
        { signal, timeoutMs: remainingTimeoutMs() },
      );
      if (signal.aborted) {
        return mediaPolicyToolError('keyframe extraction aborted');
      }
      if (sceneRun.code === 0 && (await fileExists(outputPath))) {
        const pts = parseShowinfoTimestamps(sceneRun.stderr)[0];
        frames.push({
          fileName,
          timeSeconds:
            bucketStart +
            (pts !== undefined && Number.isFinite(pts) ? pts : window / 2),
        });
        continue;
      }
      if (sceneRun.code !== 0) {
        lastFailure = sceneRun;
      }

      // Midpoint fallback: no scene change in the window (static or
      // slow footage) — take the bucket's midpoint frame instead so the
      // bucket still contributes coverage.
      const midpoint = bucketStart + bucket / 2;
      const midpointRun = await runFfmpeg(
        [
          '-y',
          '-ss',
          formatSeconds(midpoint),
          '-i',
          this.params.inputPath,
          '-vf',
          scaleFilter(maxDimension),
          '-frames:v',
          '1',
          '-q:v',
          '4',
          '-update',
          '1',
          outputPath,
        ],
        { signal, timeoutMs: remainingTimeoutMs() },
      );
      if (signal.aborted) {
        return mediaPolicyToolError('keyframe extraction aborted');
      }
      if (midpointRun.code === 0 && (await fileExists(outputPath))) {
        frames.push({ fileName, timeSeconds: midpoint });
      } else if (midpointRun.code !== 0) {
        lastFailure = midpointRun;
      }
    }

    if (frames.length === 0) {
      return mediaPolicyToolError(
        lastFailure !== undefined
          ? ffmpegFailureMessage(
              lastFailure,
              'extracting keyframes from',
              this.params.inputPath,
            )
          : `no keyframes could be extracted from ${path.basename(this.params.inputPath)}`,
      );
    }
    return frames;
  }

  /**
   * Single-pass scene detection (legacy path): frame 0 always selected,
   * then every frame whose scene score exceeds the threshold, capped at
   * maxFrames. Only used when the duration is unknown (buckets cannot
   * be placed) or a single frame was requested. showinfo (after select)
   * logs one stderr line per KEPT frame with its pts_time — the
   * timestamps feed the per-frame disclosures.
   */
  private async extractSinglePass(
    context: ExtractionContext,
  ): Promise<ToolResult | ExtractedFrame[]> {
    const {
      maxFrames,
      sceneThreshold,
      maxDimension,
      remainingTimeoutMs,
      signal,
    } = context;
    // Same self-describing scheme as the bucketed path, expressed as an
    // ffmpeg output pattern. `%04d` is ffmpeg's own frame counter.
    const frameNameTemplate = policyOutputFileName({
      inputPath: this.params.inputPath,
      operation: 'keyframe',
      variant: '%04d',
      extension: '.jpg',
    });
    const outputPattern = path.join(this.params.outputDir, frameNameTemplate);
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

    const frameFiles = await listFrameFiles(
      this.params.outputDir,
      frameNameTemplate,
    );
    if (frameFiles.length === 0) {
      return mediaPolicyToolError(
        `no keyframes could be extracted from ${path.basename(this.params.inputPath)}`,
      );
    }
    const timestamps = parseShowinfoTimestamps(scenePass.stderr);
    return frameFiles.map((fileName, index) => {
      const t = timestamps[index];
      return {
        fileName,
        timeSeconds: t !== undefined && Number.isFinite(t) ? t : undefined,
      };
    });
  }
}

/**
 * `omni_extract_keyframes` — still frames covering the FULL video
 * duration (ffmpeg): the timeline is split into `maxFrames` equal
 * buckets and each bucket contributes one frame — a scene change from
 * its opening window when one exists, its midpoint otherwise — scaled to
 * fit `maxDimension`, as JPEG artifacts with per-frame timestamps in the
 * disclosure (mapping doc §6.1). Single-pass scene detection remains for
 * unknown duration or single-frame requests. This is the multi-artifact
 * policy tool — every frame is promoted in one atomic invocation
 * transaction.
 */
export class OmniExtractKeyframesTool extends BaseMediaPolicyTool<ExtractKeyframesParams> {
  constructor(config: MediaPolicyToolConfigView) {
    super(
      OMNI_EXTRACT_KEYFRAMES_TOOL_NAME,
      'ExtractKeyframes',
      'Extracts representative still frames spread across the full video duration (per-segment scene detection with midpoint fallback), producing JPEG keyframes with per-frame timestamps and a disclosure of the temporal loss.',
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
    params: ExtractKeyframesParams,
  ): ToolInvocation<ExtractKeyframesParams, ToolResult> {
    return new ExtractKeyframesInvocation(
      params,
      resolvePolicyToolTimeoutMs(this.configView, this.name),
    );
  }
}
