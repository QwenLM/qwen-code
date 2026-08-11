/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type {
  MediaPolicyToolDescriptor,
  ToolInvocation,
  ToolResult,
} from '../../../tools/tools.js';
import { Kind } from '../../../tools/tools.js';
import { ToolNames } from '../../../tools/tool-names.js';
import { probeMediaMetadata } from '../../ffmpeg.js';
import {
  assertMediaPolicyIo,
  BaseMediaPolicyTool,
  BaseMediaPolicyToolInvocation,
  formatBytesShort,
  MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
  mediaPolicyToolError,
  mediaPolicyToolFailure,
  mediaPolicyToolSuccess,
  resolvePolicyToolTimeoutMs,
  sharpTimeoutSeconds,
  type MediaPolicyIoParams,
  type MediaPolicyToolConfigView,
} from './media-policy-tool.js';
import { loadSharp, type SharpPipeline } from './sharp-module.js';

export const OMNI_CONVERT_IMAGE_TOOL_NAME = ToolNames.OMNI_CONVERT_IMAGE;

/** Fixed-call default parameters (mapping doc §6.1). */
export const CONVERT_IMAGE_DEFAULTS = {
  format: 'jpeg',
  quality: 90,
} as const;

interface OutputFormat {
  fileName: string;
  mimeType: string;
  label: string;
  /** The disclosure's loss clause for this target format, given the
   * probed input codec (undefined when the probe could not tell). */
  lossNote(inputCodec: string | undefined): string;
  encode(pipeline: SharpPipeline, quality: number): SharpPipeline;
}

/** Probed codecs whose format can structurally carry an alpha channel —
 * the only sources for which a JPEG target's disclosure may assert
 * 透明通道丢弃 (a JPEG→JPEG re-encode cannot lose what never existed). */
const ALPHA_CAPABLE_CODECS = new Set(['png', 'webp', 'gif', 'tiff']);

const OUTPUT_FORMATS: Record<string, OutputFormat> = {
  jpeg: {
    fileName: 'converted.jpg',
    mimeType: 'image/jpeg',
    label: 'JPEG',
    lossNote: (codec) =>
      codec === undefined
        ? '透明通道（如有）与元数据丢弃'
        : ALPHA_CAPABLE_CODECS.has(codec)
          ? '透明通道与元数据丢弃'
          : '元数据丢弃',
    encode: (p, quality) => p.jpeg({ quality }),
  },
  png: {
    fileName: 'converted.png',
    mimeType: 'image/png',
    label: 'PNG',
    lossNote: () => '元数据丢弃',
    encode: (p) => p.png(),
  },
  webp: {
    fileName: 'converted.webp',
    mimeType: 'image/webp',
    label: 'WEBP',
    lossNote: () => '元数据丢弃',
    encode: (p, quality) => p.webp({ quality }),
  },
};

/** ffprobe codec → human format label for the disclosure's "原 X" part. */
const CODEC_LABELS: Record<string, string> = {
  mjpeg: 'JPEG',
  jpeg: 'JPEG',
  png: 'PNG',
  webp: 'WEBP',
  gif: 'GIF',
  bmp: 'BMP',
  tiff: 'TIFF',
};

export interface ConvertImageParams extends MediaPolicyIoParams {
  /** Target format. */
  format?: 'jpeg' | 'png' | 'webp';
  /** Quality factor (1-100) for jpeg/webp; ignored for png. */
  quality?: number;
}

const TUNABLE_SCHEMA_PROPERTIES = {
  format: {
    type: 'string',
    enum: ['jpeg', 'png', 'webp'],
    description: "Target image format. Default 'jpeg'.",
  },
  quality: {
    type: 'number',
    description:
      'Quality factor (1-100) for jpeg/webp output (ignored for png). Default 90.',
    minimum: 1,
    maximum: 100,
  },
} as const;

const DESCRIPTOR: MediaPolicyToolDescriptor = {
  kind: 'media_policy',
  version: '1',
  inputMediaTypes: ['image'],
  outputs: [
    {
      kind: 'media',
      mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      required: true,
      // Uniform lossy declaration (mapping doc §6.1): re-encoding strips
      // metadata (and alpha, for JPEG) even when the target codec itself
      // is lossless, so every conversion carries a disclosure.
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

class ConvertImageInvocation extends BaseMediaPolicyToolInvocation<ConvertImageParams> {
  constructor(
    params: ConvertImageParams,
    private readonly timeoutMs: number,
  ) {
    super(params);
  }

  getDescription(): string {
    const format = this.params.format ?? CONVERT_IMAGE_DEFAULTS.format;
    return `Convert ${path.basename(this.params.inputPath)} to ${format.toUpperCase()}`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const format = this.params.format ?? CONVERT_IMAGE_DEFAULTS.format;
    const quality = this.params.quality ?? CONVERT_IMAGE_DEFAULTS.quality;
    const output = OUTPUT_FORMATS[format];
    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);

      // Probe BEFORE decoding: the original format feeds the disclosure,
      // and animated inputs must be refused outright — sharp would
      // silently re-encode only the first frame (decision D9, same guard
      // as omni_downsample_image).
      const probe = await probeMediaMetadata(
        this.params.inputPath,
        'image',
        signal,
      );
      if ((probe.frameCount ?? 1) > 1) {
        return mediaPolicyToolError(
          `animated image (${probe.frameCount} frames) is not supported by ${OMNI_CONVERT_IMAGE_TOOL_NAME}`,
        );
      }

      let sharp;
      try {
        sharp = await loadSharp();
      } catch {
        return mediaPolicyToolError(
          'the "sharp" image module could not be loaded; image conversion is unavailable',
        );
      }
      if (signal.aborted) {
        return mediaPolicyToolError('image conversion aborted');
      }

      // Second, independent animated-input gate (same rationale as
      // omni_downsample_image): ffprobe cannot always report a frame
      // count, while sharp's metadata decodes the page count directly.
      const pages = (await sharp(this.params.inputPath).metadata()).pages;
      if (pages !== undefined && pages > 1) {
        return mediaPolicyToolError(
          `animated image (${pages} frames) is not supported by ${OMNI_CONVERT_IMAGE_TOOL_NAME}`,
        );
      }

      const outputPath = path.join(this.params.outputDir, output.fileName);
      // `rotate()` bakes in the EXIF orientation — the orientation tag is
      // part of the metadata this conversion strips, so the pixels must
      // carry it instead.
      const pipeline = sharp(this.params.inputPath, {
        failOn: 'error',
        limitInputPixels: true,
      })
        .timeout({ seconds: sharpTimeoutSeconds(this.timeoutMs) })
        .rotate();
      const info = await output.encode(pipeline, quality).toFile(outputPath);
      if (signal.aborted) {
        return mediaPolicyToolError('image conversion aborted');
      }

      const originalLabel =
        (probe.codec !== undefined ? CODEC_LABELS[probe.codec] : undefined) ??
        probe.codec?.toUpperCase() ??
        '未知格式';
      const qualityPart = format === 'png' ? '' : ` 质量 ${quality}`;
      const disclosure = `原 ${originalLabel}/${formatBytesShort(inputSizeBytes)} → ${output.label}${qualityPart}/${formatBytesShort(info.size)}，${output.lossNote(probe.codec)}`;

      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName: output.fileName,
        artifactKind: 'image',
        title: 'Converted image',
        mimeType: output.mimeType,
        sizeBytes: info.size,
        disclosure,
      });
    } catch (error) {
      return mediaPolicyToolFailure(error);
    }
  }
}

/**
 * `omni_convert_image` — image format conversion (sharp): re-encode to
 * JPEG/PNG/WEBP with EXIF orientation baked in (mapping doc §6.1). No
 * resizing — that is omni_downsample_image's job.
 */
export class OmniConvertImageTool extends BaseMediaPolicyTool<ConvertImageParams> {
  constructor(config: MediaPolicyToolConfigView = {}) {
    super(
      OMNI_CONVERT_IMAGE_TOOL_NAME,
      'ConvertImage',
      'Converts an image to JPEG, PNG, or WEBP (re-encode, metadata stripped, EXIF orientation baked in), with a disclosure of the change.',
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
    params: ConvertImageParams,
  ): ToolInvocation<ConvertImageParams, ToolResult> {
    return new ConvertImageInvocation(
      params,
      resolvePolicyToolTimeoutMs(this.configView, this.name),
    );
  }
}
