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

export const OMNI_CLIP_IMAGE_TOOL_NAME = ToolNames.OMNI_CLIP_IMAGE;

export interface ClipImageParams extends MediaPolicyIoParams {
  /** Left edge of the crop rectangle, in pixels. */
  x: number;
  /** Top edge of the crop rectangle, in pixels. */
  y: number;
  /** Crop rectangle width in pixels. */
  width: number;
  /** Crop rectangle height in pixels. */
  height: number;
}

const TUNABLE_SCHEMA_PROPERTIES = {
  x: {
    type: 'number',
    description: 'Left edge of the crop rectangle, in pixels (≥ 0).',
    minimum: 0,
  },
  y: {
    type: 'number',
    description: 'Top edge of the crop rectangle, in pixels (≥ 0).',
    minimum: 0,
  },
  width: {
    type: 'number',
    description: 'Crop rectangle width in pixels (≥ 1).',
    minimum: 1,
  },
  height: {
    type: 'number',
    description: 'Crop rectangle height in pixels (≥ 1).',
    minimum: 1,
  },
} as const;

const DESCRIPTOR: MediaPolicyToolDescriptor = {
  kind: 'media_policy',
  version: '1',
  inputMediaTypes: ['image'],
  outputs: [
    {
      kind: 'media',
      // PNG output: the crop itself is the loss (everything outside the
      // rectangle is discarded); the surviving pixels are NOT additionally
      // damaged by a lossy re-encode.
      mimeTypes: ['image/png'],
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

class ClipImageInvocation extends BaseMediaPolicyToolInvocation<ClipImageParams> {
  constructor(
    params: ClipImageParams,
    private readonly timeoutMs: number,
  ) {
    super(params);
  }

  getDescription(): string {
    const { x, y, width, height } = this.params;
    return `Clip ${path.basename(this.params.inputPath)} to ${width}×${height} @ (${x},${y})`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const { x, y, width, height } = this.params;
    try {
      const { inputSizeBytes } = await assertMediaPolicyIo(this.params);

      // Probe BEFORE decoding (same stance as the other image tools):
      // original dimensions validate the rectangle and feed the
      // disclosure; animated inputs are refused outright — cropping the
      // first frame would silently destroy the rest of the animation.
      const probe = await probeMediaMetadata(
        this.params.inputPath,
        'image',
        signal,
      );
      if ((probe.frameCount ?? 1) > 1) {
        return mediaPolicyToolError(
          `animated image (${probe.frameCount} frames) is not supported by ${OMNI_CLIP_IMAGE_TOOL_NAME}`,
        );
      }
      if (probe.width !== undefined && probe.height !== undefined) {
        if (x + width > probe.width || y + height > probe.height) {
          return mediaPolicyToolError(
            `crop rectangle (${x},${y} ${width}×${height}) exceeds the image bounds (${probe.width}×${probe.height})`,
          );
        }
        // Detectable full-image no-op: "cropping" to the whole image
        // would only re-encode it while the disclosure falsely claims
        // content outside the rectangle was discarded.
        if (
          x === 0 &&
          y === 0 &&
          width === probe.width &&
          height === probe.height
        ) {
          return mediaPolicyToolError(
            'the requested rectangle covers the entire image — a no-op ' +
              'clip that would only re-encode (and damage) the input',
          );
        }
      }

      let sharp: SharpModule;
      try {
        sharp = await loadSharp();
      } catch {
        return mediaPolicyToolError(
          'the "sharp" image module could not be loaded; image clipping is unavailable',
        );
      }
      if (signal.aborted) {
        return mediaPolicyToolError('image clipping aborted');
      }

      // Second, independent animated-input gate (same rationale as
      // omni_downsample_image / omni_convert_image).
      const pages = (await sharp(this.params.inputPath).metadata()).pages;
      if (pages !== undefined && pages > 1) {
        return mediaPolicyToolError(
          `animated image (${pages} frames) is not supported by ${OMNI_CLIP_IMAGE_TOOL_NAME}`,
        );
      }

      const outputFileName = policyOutputFileName({
        inputPath: this.params.inputPath,
        operation: 'clip',
        variant: `${x}x${y}+${width}x${height}`,
        extension: '.png',
      });
      const outputPath = path.join(this.params.outputDir, outputFileName);
      // `rotate()` bakes in the EXIF orientation FIRST so the pixel
      // coordinates match what the user saw when picking the rectangle;
      // metadata is then stripped by the re-encode.
      const info = await sharp(this.params.inputPath, {
        failOn: 'error',
        limitInputPixels: true,
      })
        .timeout({ seconds: sharpTimeoutSeconds(this.timeoutMs) })
        .rotate()
        .extract({
          left: Math.round(x),
          top: Math.round(y),
          width: Math.round(width),
          height: Math.round(height),
        })
        .png()
        .toFile(outputPath);
      if (signal.aborted) {
        return mediaPolicyToolError('image clipping aborted');
      }

      const original =
        probe.width !== undefined && probe.height !== undefined
          ? `${probe.width}×${probe.height}/${formatBytesShort(inputSizeBytes)}`
          : formatBytesShort(inputSizeBytes);
      const disclosure = `原 ${original} → 裁剪区域 (${x},${y}) ${width}×${height}/${formatBytesShort(info.size)}，区域外内容全部丢弃`;

      return mediaPolicyToolSuccess({
        outputDir: this.params.outputDir,
        outputFileName,
        artifactKind: 'image',
        title: 'Clipped image',
        mimeType: 'image/png',
        sizeBytes: info.size,
        disclosure,
        // Marks the artifact as a spatial excerpt for downstream role
        // consumers (output routing selectors, memory coverage — 'clip'
        // maps to partial coverage).
        role: 'clip',
      });
    } catch (error) {
      return mediaPolicyToolFailure(error);
    }
  }
}

/**
 * `omni_clip_image` — rectangle crop (design doc §3.1, sharp): extract
 * the `x`/`y`/`width`/`height` pixel rectangle (EXIF orientation baked
 * in first, so coordinates match what the user saw) into a new PNG
 * image. Everything outside the rectangle is discarded — lossy by
 * definition, with the rectangle disclosed. Unlike the model-facing
 * `zoom_image` (normalized 0–1000 coordinates, no policy lineage), this
 * is the POLICY form: resourceId-addressable, orchestrable by
 * fixedPolicies, products committed to memory.
 */
export class OmniClipImageTool extends BaseMediaPolicyTool<ClipImageParams> {
  constructor(config: MediaPolicyToolConfigView = {}) {
    super(
      OMNI_CLIP_IMAGE_TOOL_NAME,
      'ClipImage',
      'Crops a pixel rectangle (x, y, width, height) out of an image into a new PNG, discarding everything outside the rectangle, with a disclosure of the cut.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          ...MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
          ...TUNABLE_SCHEMA_PROPERTIES,
        },
        required: ['outputDir', 'x', 'y', 'width', 'height'],
        additionalProperties: false,
      },
      config,
    );
  }

  override get mediaPolicyDescriptor(): MediaPolicyToolDescriptor {
    return DESCRIPTOR;
  }

  protected override validateToolParamValues(
    params: ClipImageParams,
  ): string | null {
    const ioError = super.validateToolParamValues(params);
    if (ioError) return ioError;
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      if (!Number.isInteger(params[key]) || params[key] < 0) {
        return `${key} must be a non-negative integer (got ${params[key]})`;
      }
    }
    if (params.width < 1 || params.height < 1) {
      return 'width and height must be at least 1 pixel';
    }
    return null;
  }

  protected createInvocation(
    params: ClipImageParams,
  ): ToolInvocation<ClipImageParams, ToolResult> {
    return new ClipImageInvocation(
      params,
      resolvePolicyToolTimeoutMs(this.configView, this.name),
    );
  }
}
