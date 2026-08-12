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
  policyOutputFileName,
  resolvePolicyToolTimeoutMs,
  sharpTimeoutSeconds,
  type MediaPolicyIoParams,
  type MediaPolicyToolConfigView,
} from './media-policy-tool.js';
import { loadSharp, type SharpModule } from './sharp-module.js';

export const OMNI_DOWNSAMPLE_IMAGE_TOOL_NAME = ToolNames.OMNI_DOWNSAMPLE_IMAGE;

/** Fixed-call default parameters (mapping doc §6). */
export const DOWNSAMPLE_IMAGE_DEFAULTS = {
  maxDimension: 1568,
  quality: 75,
} as const;

export interface DownsampleImageParams extends MediaPolicyIoParams {
  /** Longest-edge ceiling in pixels; aspect ratio is preserved. */
  maxDimension?: number;
  /** JPEG quality factor of the re-encode (1-100). */
  quality?: number;
}

const TUNABLE_SCHEMA_PROPERTIES = {
  maxDimension: {
    type: 'number',
    description:
      'Longest-edge ceiling in pixels (aspect ratio preserved). Default 1568.',
    minimum: 1,
  },
  quality: {
    type: 'number',
    description: 'JPEG quality factor of the re-encode (1-100). Default 75.',
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

class DownsampleImageInvocation extends BaseMediaPolicyToolInvocation<DownsampleImageParams> {
  constructor(
    params: DownsampleImageParams,
    private readonly timeoutMs: number,
  ) {
    super(params);
  }

  getDescription(): string {
    const maxDimension =
      this.params.maxDimension ?? DOWNSAMPLE_IMAGE_DEFAULTS.maxDimension;
    return `Downsample ${path.basename(this.params.inputPath)} to fit ${maxDimension}px`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const maxDimension =
      this.params.maxDimension ?? DOWNSAMPLE_IMAGE_DEFAULTS.maxDimension;
    const quality = this.params.quality ?? DOWNSAMPLE_IMAGE_DEFAULTS.quality;
    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);

      // Probe BEFORE decoding: the original dimensions feed the disclosure,
      // and animated inputs must be refused outright — sharp would silently
      // re-encode only the first frame, destroying the animation without
      // any disclosure of that loss (decision D9: animated images are
      // excluded from the image policy; the guard handles them).
      const probe = await probeMediaMetadata(
        this.params.inputPath,
        'image',
        signal,
      );
      if ((probe.frameCount ?? 1) > 1) {
        return mediaPolicyToolError(
          `animated image (${probe.frameCount} frames) is not supported by ${OMNI_DOWNSAMPLE_IMAGE_TOOL_NAME}`,
        );
      }

      let sharp: SharpModule;
      try {
        sharp = await loadSharp();
      } catch {
        return mediaPolicyToolError(
          'the "sharp" image module could not be loaded; image downsampling is unavailable',
        );
      }
      if (signal.aborted) {
        return mediaPolicyToolError('image downsampling aborted');
      }

      // Second, independent animated-input gate: ffprobe cannot always
      // report a frame count (and the counting fallback is best-effort),
      // while sharp's own metadata decodes the page count directly. Both
      // must agree the input is single-frame before the first-frame-only
      // re-encode below is lossless-in-frames.
      const pages = (await sharp(this.params.inputPath).metadata()).pages;
      if (pages !== undefined && pages > 1) {
        return mediaPolicyToolError(
          `animated image (${pages} frames) is not supported by ${OMNI_DOWNSAMPLE_IMAGE_TOOL_NAME}`,
        );
      }

      const outputPath = path.join(
        this.params.outputDir,
        policyOutputFileName({
          inputPath: this.params.inputPath,
          operation: 'downsampled',
          extension: '.jpg',
        }),
      );
      // `rotate()` bakes in the EXIF orientation so the resized pixels
      // match what the user saw; `fit: 'inside'` preserves aspect ratio;
      // `withoutEnlargement` keeps already-small originals at native size.
      // PNG and other lossless inputs are re-encoded to JPEG too — the
      // whole point of the policy is a smaller transport payload.
      const info = await sharp(this.params.inputPath, {
        failOn: 'error',
        limitInputPixels: true,
      })
        .timeout({ seconds: sharpTimeoutSeconds(this.timeoutMs) })
        .rotate()
        .resize({
          width: maxDimension,
          height: maxDimension,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality })
        .toFile(outputPath);
      if (signal.aborted) {
        return mediaPolicyToolError('image downsampling aborted');
      }

      // Disclosure (decision D8): dimensions/bytes plus the OUTPUT quality
      // parameter only — the original's JPEG quality factor is not stored
      // in the bitstream, so no claim is made about it.
      const original =
        probe.width !== undefined && probe.height !== undefined
          ? `${probe.width}×${probe.height}/${formatBytesShort(inputSizeBytes)}`
          : formatBytesShort(inputSizeBytes);
      const disclosure = `原 ${original} → ${info.width}×${info.height}/${formatBytesShort(info.size)}，质量 ${quality}，细节与文字锐度受损`;

      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName: policyOutputFileName({
          inputPath: this.params.inputPath,
          operation: 'downsampled',
          extension: '.jpg',
        }),
        artifactKind: 'image',
        title: 'Downsampled image',
        mimeType: 'image/jpeg',
        sizeBytes: info.size,
        disclosure,
      });
    } catch (error) {
      return mediaPolicyToolFailure(error);
    }
  }
}

/**
 * `omni_downsample_image` — lossy image degradation (sharp): scale to fit
 * `maxDimension` and re-encode as JPEG at `quality` (mapping doc §6).
 * Registered as a media-policy tool: fixed-policy-only unless modelAccess
 * opens it up.
 */
export class OmniDownsampleImageTool extends BaseMediaPolicyTool<DownsampleImageParams> {
  constructor(config: MediaPolicyToolConfigView = {}) {
    super(
      OMNI_DOWNSAMPLE_IMAGE_TOOL_NAME,
      'DownsampleImage',
      'Downsamples an image to fit a maximum dimension and re-encodes it as JPEG, producing a smaller lossy derivative with a disclosure of the degradation.',
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
    params: DownsampleImageParams,
  ): ToolInvocation<DownsampleImageParams, ToolResult> {
    return new DownsampleImageInvocation(
      params,
      resolvePolicyToolTimeoutMs(this.configView, this.name),
    );
  }
}
