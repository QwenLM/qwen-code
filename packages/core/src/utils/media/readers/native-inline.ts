/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Part } from '@google/genai';
import {
  determineUploader,
  UploadNotConfiguredError,
} from '../../../core/media/uploader.js';
import { decideTransport } from '../../../core/media/transport-decider.js';
import {
  estimateModalityTokens,
  getMediaProfile,
} from '../../../core/media/provider-media-profiles.js';
import { extractKeyframes } from '../keyframe-extractor.js';
import type {
  MediaReadContext,
  MediaReader,
  MediaReadParams,
  MediaReadResult,
} from '../reader-registry.js';
import { MediaReadError } from '../reader-registry.js';
import type { CostEstimate, MediaProbe, Modality } from '../types.js';

/**
 * P1 · Native passthrough reader (the one built-in reader).
 *
 * When the primary model can natively ingest the modality, this reader puts the
 * bytes straight into the model's view via the existing tool-result media path
 * (small files inline, large files uploaded → `fileData`). This is the
 * delegated readers' fallback baseline. It is deliberately provider-agnostic:
 * transport and profile choices live in `core/media`.
 */

const MODALITY_TO_INPUT_KEY: Record<Modality, 'image' | 'audio' | 'video'> = {
  image: 'image',
  audio: 'audio',
  video: 'video',
};

function costFor(
  probe: MediaProbe,
  config: MediaReadContext['config'],
): CostEstimate {
  const profile = getMediaProfile(config);
  const units = probe.durationSec ?? 1;
  const tokens = estimateModalityTokens(profile, probe.modality, units);
  return { tokens, note: `≈${tokens} tokens (native ${probe.modality})` };
}

class NativeInlineReader implements MediaReader {
  readonly id = 'native-inline';
  readonly kind = 'native' as const;
  readonly modalities: Modality[] = ['image', 'audio', 'video'];

  isAvailable(probe: MediaProbe, ctx: MediaReadContext): boolean {
    const modalities = ctx.config.getEffectiveInputModalities();
    return modalities[MODALITY_TO_INPUT_KEY[probe.modality]] === true;
  }

  estimateCost(probe: MediaProbe): CostEstimate {
    // Cost is provider-profile driven; config is read at read() time. Estimate
    // here uses the size-derived unit only.
    const units = probe.durationSec ?? 1;
    return {
      tokens: Math.ceil(units),
      note: `≈${Math.ceil(units)} unit(s) (native ${probe.modality})`,
    };
  }

  async read(
    probe: MediaProbe,
    params: MediaReadParams,
    ctx: MediaReadContext,
  ): Promise<MediaReadResult> {
    const cost = costFor(probe, ctx.config);
    const transport = decideTransport(probe, ctx.config);

    if (transport.mode === 'inline') {
      const bytes = await fs.readFile(probe.path);
      const part: Part = {
        inlineData: {
          data: bytes.toString('base64'),
          mimeType: probe.mimeType,
          displayName: path.basename(probe.path),
        },
      };
      return {
        content: part,
        scope: `full ${probe.modality} (native inline)`,
        precision: 'original fidelity',
        cost,
        readMore:
          'Full file delivered natively at original fidelity — nothing was omitted.',
      };
    }

    // Too large to inline: prefer uploading so the provider can fetch a
    // fileUri. If no upload backend is configured, fall back to a lossy local
    // representation rather than failing outright.
    const uploader = determineUploader(ctx.config);
    try {
      const uploaded = await uploader.upload(probe);
      const part: Part = {
        fileData: {
          fileUri: uploaded.fileUri,
          mimeType: uploaded.mimeType,
        },
      };
      return {
        content: part,
        scope: `full ${probe.modality} (native, uploaded)`,
        precision: 'original fidelity',
        cost,
        readMore: 'Delivered by reference to the uploaded file.',
      };
    } catch (err) {
      if (!(err instanceof UploadNotConfiguredError)) throw err;
      return this.oversizedFallback(probe, params, ctx, err);
    }
  }

  /**
   * No upload backend, file too large to inline. For video we can still show
   * the model the content via downsampled keyframes (lossy, no audio). Anything
   * else fails closed with the upload remedy.
   */
  private async oversizedFallback(
    probe: MediaProbe,
    params: MediaReadParams,
    ctx: MediaReadContext,
    uploadErr: UploadNotConfiguredError,
  ): Promise<MediaReadResult> {
    if (probe.modality !== 'video') {
      throw new MediaReadError(
        'over-budget',
        uploadErr.message,
        uploadErr.remedy,
      );
    }
    let frames;
    try {
      frames = await extractKeyframes(probe, {
        ...(params.range ? { range: params.range } : {}),
        signal: ctx.signal,
      });
    } catch (kfErr) {
      throw new MediaReadError(
        'over-budget',
        `${probe.path} is too large to inline and no upload backend is configured; keyframe fallback also failed: ${kfErr instanceof Error ? kfErr.message : String(kfErr)}`,
        uploadErr.remedy,
      );
    }
    const durationNote = probe.durationSec
      ? ` from a ${Math.round(probe.durationSec)}s video`
      : '';
    const everyNote = frames.intervalSec
      ? ` (~1 frame every ${frames.intervalSec.toFixed(1)}s)`
      : '';
    return {
      content: frames.parts,
      scope: `${frames.frameCount} downsampled keyframes${durationNote}${everyNote}`,
      precision: `LOSSY: keyframes only (no audio, no motion), downscaled to ${frames.longEdge}px — the full video was not sent because it exceeds the inline limit and no upload backend is configured`,
      cost: {
        tokens: frames.frameCount * getMediaProfile(ctx.config).tokensPerImage,
        note: `${frames.frameCount} frames`,
      },
      readMore:
        'For full fidelity (audio + all motion) configure a media upload backend, or request a specific time range to sample it more densely.',
    };
  }
}

export function createNativeInlineReader(): MediaReader {
  return new NativeInlineReader();
}
