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
    _params: MediaReadParams,
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

    // Too large to inline: must upload so the provider can fetch a fileUri.
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
      if (err instanceof UploadNotConfiguredError) {
        throw new MediaReadError('over-budget', err.message, err.remedy);
      }
      throw err;
    }
  }
}

export function createNativeInlineReader(): MediaReader {
  return new NativeInlineReader();
}
