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

export const OMNI_DOWNSAMPLE_AUDIO_TOOL_NAME = 'omni_downsample_audio';

/** Fixed-call default parameters (mapping doc §6). */
export const DOWNSAMPLE_AUDIO_DEFAULTS = {
  bitrateKbps: 64,
  sampleRateHz: 16_000,
  channels: 1,
} as const;

const OUTPUT_FILE_NAME = 'downsampled.m4a';

export interface DownsampleAudioParams extends MediaPolicyIoParams {
  /** Output bit rate in kbit/s. */
  bitrateKbps?: number;
  /** Output sample rate in Hz. */
  sampleRateHz?: number;
  /** Output channel count. */
  channels?: number;
}

const TUNABLE_SCHEMA_PROPERTIES = {
  bitrateKbps: {
    type: 'number',
    description: 'Output bit rate in kbit/s. Default 64.',
    minimum: 8,
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
} as const;

const DESCRIPTOR: MediaPolicyToolDescriptor = {
  kind: 'media_policy',
  inputMediaTypes: ['audio'],
  outputs: [
    {
      kind: 'media',
      mimeTypes: ['audio/mp4'],
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

/** "立体声" / "单声道" / "N声道" for the disclosure text. */
function describeChannels(channels: number | undefined): string {
  if (channels === undefined) return '';
  if (channels === 1) return ' 单声道';
  if (channels === 2) return ' 立体声';
  return ` ${channels}声道`;
}

class DownsampleAudioInvocation extends BaseToolInvocation<
  DownsampleAudioParams,
  ToolResult
> {
  constructor(
    params: DownsampleAudioParams,
    private readonly timeoutMs: number,
  ) {
    super(params);
  }

  getDescription(): string {
    const bitrateKbps =
      this.params.bitrateKbps ?? DOWNSAMPLE_AUDIO_DEFAULTS.bitrateKbps;
    return `Downsample ${path.basename(this.params.inputPath)} to ${bitrateKbps}kbps`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const bitrateKbps =
      this.params.bitrateKbps ?? DOWNSAMPLE_AUDIO_DEFAULTS.bitrateKbps;
    const sampleRateHz =
      this.params.sampleRateHz ?? DOWNSAMPLE_AUDIO_DEFAULTS.sampleRateHz;
    const channels = this.params.channels ?? DOWNSAMPLE_AUDIO_DEFAULTS.channels;
    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);
      const probe = await probeMediaMetadata(
        this.params.inputPath,
        'audio',
        signal,
      );

      const outputPath = path.join(this.params.outputDir, OUTPUT_FILE_NAME);
      const run = await runFfmpeg(
        [
          '-y',
          '-i',
          this.params.inputPath,
          // Audio-only output: a cover-art video stream would otherwise be
          // carried along (and can even fail the m4a mux).
          '-vn',
          '-c:a',
          'aac',
          '-b:a',
          `${bitrateKbps}k`,
          '-ar',
          String(sampleRateHz),
          '-ac',
          String(channels),
          outputPath,
        ],
        { signal, timeoutMs: this.timeoutMs },
      );
      if (signal.aborted) {
        return mediaPolicyToolError('audio downsampling aborted');
      }
      if (run.code !== 0) {
        return mediaPolicyToolError(
          `ffmpeg failed (exit ${run.code}) downsampling ${path.basename(this.params.inputPath)}: ${run.stderr.slice(-500)}`,
        );
      }

      const outputSizeBytes = (await fs.stat(outputPath)).size;
      const originalBitrate =
        probe.bitRate !== undefined
          ? `${Math.round(probe.bitRate / 1000)}kbps`
          : formatBytesShort(inputSizeBytes);
      const originalRate =
        probe.sampleRateHz !== undefined
          ? `/${Math.round(probe.sampleRateHz / 1000)}kHz`
          : '';
      const disclosure = `原 ${originalBitrate}${originalRate}${describeChannels(probe.channels)} → ${bitrateKbps}kbps/${Math.round(sampleRateHz / 1000)}kHz${describeChannels(channels)}，高频细节丢失`;

      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName: OUTPUT_FILE_NAME,
        artifactKind: 'audio',
        title: 'Downsampled audio',
        mimeType: 'audio/mp4',
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
 * `omni_downsample_audio` — lossy audio degradation (ffmpeg): re-encode
 * to AAC at a low bit rate, sample rate, and channel count (mapping doc
 * §6).
 */
export class OmniDownsampleAudioTool extends BaseMediaPolicyTool<DownsampleAudioParams> {
  constructor(private readonly config: MediaPolicyToolConfigView) {
    super(
      OMNI_DOWNSAMPLE_AUDIO_TOOL_NAME,
      'DownsampleAudio',
      'Downsamples an audio file to a lower bit rate, sample rate, and channel count, producing a smaller lossy derivative with a disclosure of the degradation.',
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
    params: DownsampleAudioParams,
  ): string | null {
    return validateMediaPolicyIoParams(params);
  }

  protected createInvocation(
    params: DownsampleAudioParams,
  ): ToolInvocation<DownsampleAudioParams, ToolResult> {
    return new DownsampleAudioInvocation(
      params,
      resolvePolicyToolTimeoutMs(this.config, this.name),
    );
  }
}
