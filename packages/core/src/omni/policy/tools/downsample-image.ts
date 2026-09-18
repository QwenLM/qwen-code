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
  resolvePolicyToolSettings,
  resolvePolicyToolTimeoutMs,
  sharpTimeoutSeconds,
  type MediaPolicyIoParams,
  type MediaPolicyToolConfigView,
} from './media-policy-tool.js';
import { loadSharp, type SharpModule } from './sharp-module.js';
import {
  imageDimensionsForTokenBudget,
  type TokenBudgetTier,
} from '../../smart-resize.js';

export const OMNI_DOWNSAMPLE_IMAGE_TOOL_NAME = ToolNames.OMNI_DOWNSAMPLE_IMAGE;

/** Lenient settings read: only a real tier name counts, anything else
 * resolves to "no budget default". */
function readTokenBudget(
  settings: Record<string, unknown>,
): TokenBudgetTier | undefined {
  const value = settings['tokenBudget'];
  return value === 'small' || value === 'normal' || value === 'large'
    ? value
    : undefined;
}

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
  /** Token-budget tier: resize onto the model patch grid with the
   * tier's pixel budget (256/1024/2048 tokens). Overrides maxDimension. */
  tokenBudget?: TokenBudgetTier;
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
  tokenBudget: {
    type: 'string',
    enum: ['small', 'normal', 'large'],
    description:
      "Token-budget tier ('small'/'normal'/'large' = 256/1024/2048 visual tokens): the image is resized onto the model patch grid (28px cells) inside the tier's pixel budget, tiny images upsampled onto the grid. Overrides maxDimension when set.",
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
    private readonly settingsDefaults: Record<string, unknown>,
    private readonly timeoutMs: number,
  ) {
    super(params);
  }

  getDescription(): string {
    const tokenBudget =
      this.params.tokenBudget ??
      readTokenBudget(this.settingsDefaults) ??
      undefined;
    if (tokenBudget) {
      return `Downsample ${path.basename(this.params.inputPath)} to the ${tokenBudget} token budget`;
    }
    const maxDimension =
      this.params.maxDimension ?? DOWNSAMPLE_IMAGE_DEFAULTS.maxDimension;
    return `Downsample ${path.basename(this.params.inputPath)} to fit ${maxDimension}px`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const maxDimension =
      this.params.maxDimension ?? DOWNSAMPLE_IMAGE_DEFAULTS.maxDimension;
    const quality = this.params.quality ?? DOWNSAMPLE_IMAGE_DEFAULTS.quality;
    const tokenBudget =
      this.params.tokenBudget ?? readTokenBudget(this.settingsDefaults);
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
      const inputMetadata = await sharp(this.params.inputPath).metadata();
      const pages = inputMetadata.pages;
      if (pages !== undefined && pages > 1) {
        return mediaPolicyToolError(
          `animated image (${pages} frames) is not supported by ${OMNI_DOWNSAMPLE_IMAGE_TOOL_NAME}`,
        );
      }

      // Token-budget sizing: compute the grid-snapped target from the
      // DISPLAYED dimensions (EXIF orientation ≥ 5 swaps the axes), then
      // resize to exactly those cells — the metered unit is the token
      // grid, so the output must land on it, not merely inside a box.
      let resize: { width: number; height: number } | undefined;
      if (tokenBudget) {
        const displayed =
          inputMetadata.orientation !== undefined &&
          inputMetadata.orientation >= 5
            ? {
                width: inputMetadata.height ?? 0,
                height: inputMetadata.width ?? 0,
              }
            : {
                width: inputMetadata.width ?? 0,
                height: inputMetadata.height ?? 0,
              };
        if (displayed.width > 0 && displayed.height > 0) {
          resize = imageDimensionsForTokenBudget(
            displayed.width,
            displayed.height,
            tokenBudget,
          );
        }
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
      // match what the user saw. Box mode (`maxDimension`): `fit:
      // 'inside'` preserves aspect ratio and `withoutEnlargement` keeps
      // already-small originals at native size. Budget mode
      // (`tokenBudget`): exact grid-snapped dimensions, upsampling
      // included — the pixel budget, not the box, is the contract.
      // PNG and other lossless inputs are re-encoded to JPEG too — the
      // whole point of the policy is a smaller transport payload.
      let pipeline = sharp(this.params.inputPath, {
        failOn: 'error',
        limitInputPixels: true,
      })
        .timeout({ seconds: sharpTimeoutSeconds(this.timeoutMs) })
        .rotate();
      pipeline = resize
        ? pipeline.resize({
            width: resize.width,
            height: resize.height,
            fit: 'fill',
          })
        : pipeline.resize({
            width: maxDimension,
            height: maxDimension,
            fit: 'inside',
            withoutEnlargement: true,
          });
      const info = await pipeline.jpeg({ quality }).toFile(outputPath);
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
      const budgetPart = tokenBudget ? `，token 档位 ${tokenBudget}` : '';
      const disclosure = `原 ${original} → ${info.width}×${info.height}/${formatBytesShort(info.size)}，质量 ${quality}${budgetPart}，细节与文字锐度受损`;

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
      resolvePolicyToolSettings(this.configView, this.name),
      resolvePolicyToolTimeoutMs(this.configView, this.name),
    );
  }
}
