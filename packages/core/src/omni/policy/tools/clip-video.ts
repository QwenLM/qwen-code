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
  policyOutputFileName,
  policyOutputStem,
  resolvePolicyToolTimeoutMs,
  type MediaPolicyIoParams,
  type MediaPolicyToolConfigView,
} from './media-policy-tool.js';

export const OMNI_CLIP_VIDEO_TOOL_NAME = ToolNames.OMNI_CLIP_VIDEO;

/**
 * Soft budget on model-initiated clips of ONE source before the tool starts
 * nudging the caller to stop. Measured on Video-MME-v2: items where the model
 * clipped 1–3 times scored +11.8pt over not clipping, but items that clipped
 * 4+ times scored identically to not clipping (zero accuracy gain) while
 * spending 10–50× the tokens — an unbounded "clip → didn't find it → clip
 * again → sweep the whole film" loop. Past this count the tool appends a brake
 * to its result: answer from what you have, or densify-locate first. Soft, not
 * a hard block — a legitimate Nth clip still runs; overridable via
 * `policyTools.omni_clip_video.settings.softClipBudget`.
 */
export const DEFAULT_CLIP_SOFT_BUDGET = 3;

/** Fixed-call default encode parameters (mapping doc §6.1): clip is a
 * time-axis cut, NOT a degradation — crf 23 preserves quality; lowering
 * resolution/bit rate is omni_downscale_video's job. */
export const CLIP_VIDEO_DEFAULTS = {
  crf: 23,
  preset: 'veryfast',
} as const;

export interface ClipVideoParams extends MediaPolicyIoParams {
  /** Clip start in seconds (default 0). */
  startSec?: number;
  /** Clip duration in seconds (default: to the end of the video). */
  durationSec?: number;
  /** Number of clips before the model receives a soft stop reminder. */
  softClipBudget?: number;
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
  softClipBudget: {
    type: 'number',
    description:
      'Positive integer clip count that triggers the soft stop reminder. Default 3.',
    minimum: 1,
    multipleOf: 1,
  },
} as const;

const DESCRIPTOR: MediaPolicyToolDescriptor = {
  kind: 'media_policy',
  // '3': clips retain their source audio. Pre-'3' cached clips are
  // video-only and cannot be reused under the new media contract.
  version: '3',
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
  operatorOnlyParams: ['softClipBudget'],
};

/** "12s" / "12.4s" — seconds with at most one decimal. */
function formatSeconds(seconds: number): string {
  return `${Math.round(seconds * 10) / 10}s`;
}

class ClipVideoInvocation extends BaseMediaPolicyToolInvocation<ClipVideoParams> {
  constructor(
    params: ClipVideoParams,
    private readonly timeoutMs: number,
    private readonly softBudget: number,
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

      // Self-describing name: two different spans of one source coexist
      // instead of the later clip destroying the earlier one.
      const outputFileName = policyOutputFileName({
        inputPath: this.params.inputPath,
        operation: 'clip',
        variant:
          durationSec !== undefined
            ? `${Math.round(startSec)}s+${Math.round(durationSec)}s`
            : `${Math.round(startSec)}s-end`,
        extension: '.mp4',
      });
      const outputPath = path.join(this.params.outputDir, outputFileName);
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
          '128k',
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
      const disclosure = `原 ${original} → 片段 [${formatSeconds(startSec)}–${endText}]${spanText}，保留画面与原有音轨，片段外内容全部丢弃`;

      const success = mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName,
        artifactKind: 'video',
        title: 'Clipped video',
        mimeType: 'video/mp4',
        sizeBytes: outputSizeBytes,
        disclosure,
        // Marks the artifact as a temporal excerpt for downstream role
        // consumers (output routing selectors, memory coverage).
        role: 'clip',
      });
      // The clip is not delivered inline; give the model the path to open it.
      // Whether that read yields native video or gets re-downscaled to
      // keyframes is decided downstream by the ingest policies (e.g.
      // movie-keyframes' own duration gate), NOT by this tool — so the hint
      // stays threshold-agnostic and does not promise "native video". The
      // length rule and the re-downscale outcome are surfaced where they are
      // owned: the fixed policy's description, and the keyframe disclosure the
      // re-ingest emits. Kept out of `disclosure` (the D8 media-adjacent
      // text) — model-facing only.
      // Soft clip budget: count clips of THIS source already on disk (they
      // share the self-describing `<stem>-clip-` prefix, incl. the one just
      // written). Past the budget, append a brake — unbounded trial-clipping
      // adds no accuracy over not clipping and burns 10–50× the tokens. Not a
      // hard block: the clip already ran; this only steers the next turn.
      let clipBrake = '';
      try {
        const prefix = `${policyOutputStem(this.params.inputPath)}-clip-`;
        const clipCount = (await fs.readdir(this.params.outputDir)).filter(
          (f) => f.startsWith(prefix) && f.endsWith('.mp4'),
        ).length;
        if (clipCount >= this.softBudget) {
          clipBrake =
            `。已对该视频切了 ${clipCount} 段：继续逐段盲扫通常不再提升判断、` +
            `只增开销。请基于已看片段作答；若仍需定位某个画面，先用 ` +
            `omni_extract_keyframes（strategy='uniform'、startSec、endSec）` +
            `在疑似区间加密抽帧锁定，再精准切 1 段，不要继续试切`;
        }
      } catch {
        // outputDir unreadable → skip the brake, never fail the clip on it.
      }
      return {
        ...success,
        llmContent: `${success.llmContent}。用 read_file 打开 ${outputPath} 查看该片段${clipBrake}`,
      };
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
          // outputDir is optional for clip: when omitted it defaults to the
          // source video's own directory (see validateToolParamValues). The
          // model was otherwise guessing a path — a wrong guess like
          // `<dir>/clips` failed the call with "output directory not found"
          // and burned a turn.
          outputDir: {
            type: 'string',
            description:
              'Optional absolute directory to write the clip into. ' +
              "Defaults to the source video's own directory when omitted.",
          },
          ...TUNABLE_SCHEMA_PROPERTIES,
        },
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
    // Default a missing outputDir to the source's own directory so the model
    // never has to invent a path (a wrong guess like `<dir>/clips` used to
    // fail with "output directory not found" and waste a turn). inputPath is
    // already resolved — from resourceId if the model passed one — by the
    // time validation runs, and build() threads this same params object into
    // createInvocation, so the default reaches execute().
    if (
      (params.outputDir as string | undefined) === undefined &&
      typeof params.inputPath === 'string' &&
      params.inputPath.length > 0
    ) {
      params.outputDir = path.dirname(params.inputPath);
    }
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
      params.softClipBudget ?? this.resolveSoftBudget(),
    );
  }

  /** `policyTools.omni_clip_video.settings.softClipBudget` (positive int),
   * else {@link DEFAULT_CLIP_SOFT_BUDGET}. */
  private resolveSoftBudget(): number {
    const entry = this.configView.getOmniPolicyToolsSettings?.()?.[this.name];
    const settings =
      entry && typeof entry === 'object'
        ? (entry as Record<string, unknown>)['settings']
        : undefined;
    const raw =
      settings && typeof settings === 'object'
        ? (settings as Record<string, unknown>)['softClipBudget']
        : undefined;
    return typeof raw === 'number' && Number.isInteger(raw) && raw > 0
      ? raw
      : DEFAULT_CLIP_SOFT_BUDGET;
  }
}
