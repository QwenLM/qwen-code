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
import { probeMediaMetadata, runFfmpeg } from '../../ffmpeg.js';
import {
  assertMediaPolicyIo,
  BaseMediaPolicyTool,
  BaseMediaPolicyToolInvocation,
  describeChannels,
  formatBytesShort,
  MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
  mediaPolicyToolError,
  mediaPolicyToolSuccess,
  resolvePolicyToolTimeoutMs,
  validateMediaPolicyIoParams,
  type MediaPolicyIoParams,
  type MediaPolicyToolConfigView,
} from './media-policy-tool.js';

export const OMNI_EXTRACT_AUDIO_TOOL_NAME = 'omni_extract_audio';

/** Fixed-call default parameters (mapping doc §6.1): 16 kHz mono WAV is
 * the ASR-recommended input shape, chaining into omni_transcribe_audio. */
export const EXTRACT_AUDIO_DEFAULTS = {
  format: 'wav',
  sampleRateHz: 16_000,
  channels: 1,
  bitrateKbps: 64,
} as const;

interface OutputFormat {
  fileName: string;
  mimeType: string;
  label: string;
  /** Codec args; lossy formats consume the bit rate. */
  codecArgs(bitrateKbps: number): string[];
}

const OUTPUT_FORMATS: Record<string, OutputFormat> = {
  wav: {
    fileName: 'extracted.wav',
    mimeType: 'audio/wav',
    label: 'WAV',
    codecArgs: () => ['-c:a', 'pcm_s16le'],
  },
  mp3: {
    fileName: 'extracted.mp3',
    mimeType: 'audio/mpeg',
    label: 'MP3',
    codecArgs: (kbps) => ['-c:a', 'libmp3lame', '-b:a', `${kbps}k`],
  },
  m4a: {
    fileName: 'extracted.m4a',
    mimeType: 'audio/mp4',
    label: 'M4A',
    codecArgs: (kbps) => ['-c:a', 'aac', '-b:a', `${kbps}k`],
  },
};

export interface ExtractAudioParams extends MediaPolicyIoParams {
  /** Output container/codec: wav (PCM), mp3, or m4a (AAC). */
  format?: 'wav' | 'mp3' | 'm4a';
  /** Output sample rate in Hz. */
  sampleRateHz?: number;
  /** Output channel count. */
  channels?: number;
  /** Output bit rate in kbit/s (mp3/m4a only; wav is PCM). */
  bitrateKbps?: number;
}

const TUNABLE_SCHEMA_PROPERTIES = {
  format: {
    type: 'string',
    enum: ['wav', 'mp3', 'm4a'],
    description:
      "Output format: 'wav' (16-bit PCM), 'mp3', or 'm4a' (AAC). Default 'wav'.",
  },
  sampleRateHz: {
    type: 'number',
    description: 'Output sample rate in Hz. Default 16000.',
    minimum: 8000,
  },
  channels: {
    type: 'number',
    description: 'Output channel count. Default 1 (mono).',
    minimum: 1,
    maximum: 2,
  },
  bitrateKbps: {
    type: 'number',
    description:
      'Output bit rate in kbit/s for mp3/m4a (ignored for wav). Default 64.',
    minimum: 8,
  },
} as const;

const DESCRIPTOR: MediaPolicyToolDescriptor = {
  kind: 'media_policy',
  version: '1',
  inputMediaTypes: ['video'],
  outputs: [
    {
      kind: 'media',
      // One spec, three possible containers: the orchestrator matches the
      // recognized mime against this list (mapping doc §6.1).
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

class ExtractAudioInvocation extends BaseMediaPolicyToolInvocation<ExtractAudioParams> {
  constructor(
    params: ExtractAudioParams,
    private readonly timeoutMs: number,
  ) {
    super(params);
  }

  getDescription(): string {
    const format = this.params.format ?? EXTRACT_AUDIO_DEFAULTS.format;
    return `Extract ${format.toUpperCase()} audio track from ${path.basename(this.params.inputPath)}`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const format = this.params.format ?? EXTRACT_AUDIO_DEFAULTS.format;
    const sampleRateHz =
      this.params.sampleRateHz ?? EXTRACT_AUDIO_DEFAULTS.sampleRateHz;
    const channels = this.params.channels ?? EXTRACT_AUDIO_DEFAULTS.channels;
    const bitrateKbps =
      this.params.bitrateKbps ?? EXTRACT_AUDIO_DEFAULTS.bitrateKbps;
    const output = OUTPUT_FORMATS[format];
    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);
      const probe = await probeMediaMetadata(
        this.params.inputPath,
        'video',
        signal,
      );

      const outputPath = path.join(this.params.outputDir, output.fileName);
      const run = await runFfmpeg(
        [
          '-y',
          '-i',
          this.params.inputPath,
          // Drop the video stream entirely — the audio track is the output.
          '-vn',
          ...output.codecArgs(bitrateKbps),
          '-ar',
          String(sampleRateHz),
          '-ac',
          String(channels),
          outputPath,
        ],
        { signal, timeoutMs: this.timeoutMs },
      );
      if (signal.aborted) {
        return mediaPolicyToolError('audio extraction aborted');
      }
      if (run.code !== 0) {
        return mediaPolicyToolError(
          `ffmpeg failed (exit ${run.code}) extracting audio from ${path.basename(this.params.inputPath)}: ${run.stderr.slice(-500)}`,
        );
      }

      const outputSizeBytes = (await fs.stat(outputPath)).size;
      const originalDuration =
        probe.durationMs !== undefined
          ? `${Math.round(probe.durationMs / 1000)}s/`
          : '';
      const disclosure = `原视频 ${originalDuration}${formatBytesShort(inputSizeBytes)} → 音轨 ${output.label}/${Math.round(sampleRateHz / 1000)}kHz${describeChannels(channels)}，视觉信息全部丢弃`;

      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName: output.fileName,
        artifactKind: 'audio',
        title: 'Extracted audio track',
        mimeType: output.mimeType,
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
 * `omni_extract_audio` — audio-track extraction from video (ffmpeg):
 * drop the video stream and re-encode the audio as WAV/MP3/M4A (mapping
 * doc §6.1). The representation change — the visual channel is discarded
 * — makes this lossy by definition, so the disclosure obligation applies
 * even to the technically-lossless WAV output.
 */
export class OmniExtractAudioTool extends BaseMediaPolicyTool<ExtractAudioParams> {
  constructor(private readonly config: MediaPolicyToolConfigView) {
    super(
      OMNI_EXTRACT_AUDIO_TOOL_NAME,
      'ExtractAudio',
      'Extracts the audio track from a video into WAV/MP3/M4A, discarding the visual stream, with a disclosure of the loss.',
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
    params: ExtractAudioParams,
  ): string | null {
    return validateMediaPolicyIoParams(params);
  }

  protected createInvocation(
    params: ExtractAudioParams,
  ): ToolInvocation<ExtractAudioParams, ToolResult> {
    return new ExtractAudioInvocation(
      params,
      resolvePolicyToolTimeoutMs(this.config, this.name),
    );
  }
}
