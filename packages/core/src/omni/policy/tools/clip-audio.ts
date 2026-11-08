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
  resolvePolicyToolTimeoutMs,
  type MediaPolicyIoParams,
  type MediaPolicyToolConfigView,
} from './media-policy-tool.js';

export const OMNI_CLIP_AUDIO_TOOL_NAME = ToolNames.OMNI_CLIP_AUDIO;

/** Fixed-call default encode parameters: clip is a time-axis cut, NOT a
 * degradation — the bit rate preserves quality; lowering it is
 * omni_downsample_audio's job. */
export const CLIP_AUDIO_DEFAULTS = {
  bitrateKbps: 128,
} as const;

interface OutputFormat {
  /** Output extension, with the leading dot. */
  extension: string;
  mimeType: string;
  label: string;
  codecArgs(bitrateKbps: number): string[];
}

/** Same container/codec mapping as omni_extract_audio. */
const OUTPUT_FORMATS: Record<string, OutputFormat> = {
  wav: {
    extension: '.wav',
    mimeType: 'audio/wav',
    label: 'WAV',
    codecArgs: () => ['-c:a', 'pcm_s16le'],
  },
  mp3: {
    extension: '.mp3',
    mimeType: 'audio/mpeg',
    label: 'MP3',
    codecArgs: (kbps) => ['-c:a', 'libmp3lame', '-b:a', `${kbps}k`],
  },
  m4a: {
    extension: '.m4a',
    mimeType: 'audio/mp4',
    label: 'M4A',
    codecArgs: (kbps) => ['-c:a', 'aac', '-b:a', `${kbps}k`],
  },
};

/** Minimum clip duration in milliseconds (design doc §3.2: `durationMs`
 * ≥ 1000 — a sub-second clip is almost always a mistake and costs a full
 * re-encode to produce). */
const MIN_DURATION_MS = 1000;

export interface ClipAudioParams extends MediaPolicyIoParams {
  /** Clip start position in milliseconds (default 0). */
  startMs?: number;
  /** Clip duration in milliseconds (default: to the end of the audio). */
  durationMs?: number;
  /** Output container/codec: wav (PCM), mp3, or m4a (AAC). */
  format?: 'wav' | 'mp3' | 'm4a';
  /** Output bit rate in kbit/s (mp3/m4a only; wav is PCM). */
  bitrateKbps?: number;
}

const TUNABLE_SCHEMA_PROPERTIES = {
  startMs: {
    type: 'number',
    description: 'Clip start position in milliseconds. Default 0.',
    minimum: 0,
  },
  durationMs: {
    type: 'number',
    description:
      'Clip duration in milliseconds (minimum 1000). Default: from startMs to the end.',
    exclusiveMinimum: 0,
  },
  format: {
    type: 'string',
    enum: ['wav', 'mp3', 'm4a'],
    description:
      "Output format: 'wav' (16-bit PCM), 'mp3', or 'm4a' (AAC). Default 'm4a'.",
  },
  bitrateKbps: {
    type: 'number',
    description:
      'Output bit rate in kbit/s for mp3/m4a (ignored for wav). Default 128.',
    minimum: 8,
  },
} as const;

const DESCRIPTOR: MediaPolicyToolDescriptor = {
  kind: 'media_policy',
  // Same versioning rationale as omni_clip_video '2': outputs carry
  // `metadata.omniRole: 'clip'` → memory maps them to `partial` coverage.
  version: '1',
  inputMediaTypes: ['audio'],
  outputs: [
    {
      kind: 'media',
      mimeTypes: ['audio/wav', 'audio/mpeg', 'audio/mp4'],
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

/** "12s" / "12.4s" — milliseconds rendered as seconds with at most one
 * decimal. */
function formatMs(ms: number): string {
  return `${Math.round(ms / 100) / 10}s`;
}

class ClipAudioInvocation extends BaseMediaPolicyToolInvocation<ClipAudioParams> {
  constructor(
    params: ClipAudioParams,
    private readonly timeoutMs: number,
  ) {
    super(params);
  }

  getDescription(): string {
    const start = this.params.startMs ?? 0;
    const span =
      this.params.durationMs !== undefined
        ? `${formatMs(start)}–${formatMs(start + this.params.durationMs)}`
        : `${formatMs(start)}–end`;
    return `Clip ${path.basename(this.params.inputPath)} to [${span}]`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const startMs = this.params.startMs ?? 0;
    const durationMs = this.params.durationMs;
    const format = this.params.format ?? 'm4a';
    const bitrateKbps =
      this.params.bitrateKbps ?? CLIP_AUDIO_DEFAULTS.bitrateKbps;
    const output = OUTPUT_FORMATS[format];
    try {
      await assertMediaPolicyIo(this.params);
      const probe = await probeMediaMetadata(
        this.params.inputPath,
        'audio',
        signal,
      );
      const totalMs = probe.durationMs;
      if (totalMs !== undefined && startMs >= totalMs) {
        return mediaPolicyToolError(
          `startMs (${formatMs(startMs)}) is at or beyond the end of the audio (${formatMs(totalMs)})`,
        );
      }
      // Detectable full-span no-op (same rationale as omni_clip_video):
      // "clipping" the whole audio would only run a lossy re-encode while
      // the disclosure falsely claims content outside the span was
      // discarded.
      if (
        totalMs !== undefined &&
        startMs === 0 &&
        durationMs !== undefined &&
        durationMs >= totalMs
      ) {
        return mediaPolicyToolError(
          `the requested span [0–${formatMs(durationMs)}] covers the ` +
            `entire audio (${formatMs(totalMs)}) — a no-op clip that ` +
            `would only re-encode (and damage) the input`,
        );
      }

      // Self-describing name: two different spans of one source coexist
      // instead of the later clip destroying the earlier one.
      const outputFileName = policyOutputFileName({
        inputPath: this.params.inputPath,
        operation: 'clip',
        variant:
          durationMs !== undefined
            ? `${Math.round(startMs)}ms+${Math.round(durationMs)}ms`
            : `${Math.round(startMs)}ms-end`,
        extension: output.extension,
      });
      const outputPath = path.join(this.params.outputDir, outputFileName);
      // Input-side -ss/-t plus a full re-encode: sample-accurate cuts
      // regardless of packet boundaries (`-c copy` snaps to packets).
      // Sample rate and channels are preserved — this is a cut, not a
      // degradation.
      const run = await runFfmpeg(
        [
          '-y',
          '-ss',
          (startMs / 1000).toFixed(3),
          ...(durationMs !== undefined
            ? ['-t', (durationMs / 1000).toFixed(3)]
            : []),
          '-i',
          this.params.inputPath,
          '-vn',
          ...output.codecArgs(bitrateKbps),
          outputPath,
        ],
        { signal, timeoutMs: this.timeoutMs },
      );
      if (signal.aborted) {
        return mediaPolicyToolError('audio clipping aborted');
      }
      if (run.code !== 0) {
        return mediaPolicyToolError(
          ffmpegFailureMessage(run, 'clipping', this.params.inputPath),
        );
      }

      const outputSizeBytes = (await fs.stat(outputPath)).size;
      const endMs =
        durationMs !== undefined
          ? totalMs !== undefined
            ? Math.min(startMs + durationMs, totalMs)
            : startMs + durationMs
          : totalMs;
      const original = totalMs !== undefined ? formatMs(totalMs) : '未知时长';
      const endText = endMs !== undefined ? formatMs(endMs) : '结尾';
      const spanText =
        endMs !== undefined ? ` ${formatMs(endMs - startMs)}` : '';
      const disclosure = `原 ${original} → 片段 [${formatMs(startMs)}–${endText}]${spanText} ${output.label}，片段外内容全部丢弃`;

      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName,
        artifactKind: 'audio',
        title: 'Clipped audio',
        mimeType: output.mimeType,
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
 * `omni_clip_audio` — time-axis cut of an audio file (design doc §3.2):
 * input-side seek plus a sample-accurate re-encode of the selected span
 * (`startMs` ≥ 0, `durationMs` ≥ 1000). Everything outside the span is
 * discarded — lossy by definition, with the span disclosed.
 */
export class OmniClipAudioTool extends BaseMediaPolicyTool<ClipAudioParams> {
  constructor(config: MediaPolicyToolConfigView) {
    super(
      OMNI_CLIP_AUDIO_TOOL_NAME,
      'ClipAudio',
      'Cuts a time span out of an audio file (sample-accurate re-encode), discarding everything outside the span, with a disclosure of the cut.',
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

  protected override validateToolParamValues(
    params: ClipAudioParams,
  ): string | null {
    const ioError = super.validateToolParamValues(params);
    if (ioError) return ioError;
    // A no-op invocation (full-length "clip") must be rejected at the
    // parameter layer instead of burning a full lossy re-encode on it
    // (same stance as omni_clip_video).
    if (params.startMs === undefined && params.durationMs === undefined) {
      return 'at least one of startMs / durationMs must be provided';
    }
    if (params.startMs === 0 && params.durationMs === undefined) {
      return (
        'startMs: 0 without durationMs selects the whole audio — a no-op ' +
        'clip that would only re-encode (and damage) the input'
      );
    }
    if (
      params.durationMs !== undefined &&
      params.durationMs < MIN_DURATION_MS
    ) {
      return `durationMs must be at least ${MIN_DURATION_MS} (got ${params.durationMs})`;
    }
    return null;
  }

  protected createInvocation(
    params: ClipAudioParams,
  ): ToolInvocation<ClipAudioParams, ToolResult> {
    return new ClipAudioInvocation(
      params,
      resolvePolicyToolTimeoutMs(this.configView, this.name),
    );
  }
}
