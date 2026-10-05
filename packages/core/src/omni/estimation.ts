/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RecognizedMedia } from './recognition.js';

/**
 * Raw-resource token estimate for an omni media input.
 *
 * The formula set is versioned via `method` so a revised estimator (e.g.
 * one aligned with confirmed server-side accounting) can be added and
 * switched without touching call sites. Consumers must treat
 * `status: 'unavailable'` as "no estimate" — never guess missing fields.
 */
export interface OmniTokenEstimate {
  /** Estimated token count for the raw resource. */
  estimatedTokenCount: number;
  /** Estimator identity+version that produced this value. */
  method: 'raw-resource-v1';
  status: 'ok' | 'unavailable';
}

const AUDIO_TOKENS_PER_SECOND = 7;
/** Pixels per visual token: 32×32 patch, 2 pixels per patch cell. */
const VISUAL_PIXELS_PER_TOKEN = 32 * 32 * 2;

/** Positive, finite number — rejects 0, negatives, NaN and Infinity. */
function usable(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

/**
 * Estimate tokens from recognized raw-resource metadata (design doc §6.4):
 *
 *   audioTokens  = ceil(durationSeconds × 7)
 *   visualTokens = ceil(width × height × frameCount / (32 × 32 × 2))
 *
 * - static image → frameCount 1; animated image (GIF/APNG/animated WebP)
 *   → real frameCount from the probe when reported
 * - video → frameCount from ceil(duration × frameRate); audio track of a
 *   video is NOT separately estimated in v1 (the visual term dominates and
 *   the raw formula is already a conservative upper bound)
 * - any required field missing OR degenerate (zero/negative/non-finite) →
 *   status 'unavailable'. `'ok'` means a real estimate: a truncated capture
 *   probing as duration 0 must not produce a 0-token 'ok' that sails under
 *   the transport guard.
 */
export function estimateRawResourceTokens(
  media: RecognizedMedia,
): OmniTokenEstimate {
  const unavailable: OmniTokenEstimate = {
    estimatedTokenCount: 0,
    method: 'raw-resource-v1',
    status: 'unavailable',
  };

  switch (media.modality) {
    case 'audio': {
      const durationMs = media.metadata.durationMs;
      if (!usable(durationMs)) return unavailable;
      return {
        estimatedTokenCount: Math.ceil(
          (durationMs / 1000) * AUDIO_TOKENS_PER_SECOND,
        ),
        method: 'raw-resource-v1',
        status: 'ok',
      };
    }
    case 'image': {
      const { width, height, frameCount } = media.metadata;
      if (!usable(width) || !usable(height)) return unavailable;
      // Animated images (GIF/APNG/animated WebP) carry their real frame
      // count from the probe — a 300-frame GIF estimated as one frame would
      // sail under the transport guard at ~1/300 of its real cost. Static
      // images (and containers whose frame count ffprobe does not report)
      // keep frameCount 1 per the design formula.
      const frames = usable(frameCount) ? frameCount : 1;
      return {
        estimatedTokenCount: Math.ceil(
          (width * height * frames) / VISUAL_PIXELS_PER_TOKEN,
        ),
        method: 'raw-resource-v1',
        status: 'ok',
      };
    }
    case 'video': {
      const { width, height, durationMs, frameRate } = media.metadata;
      if (
        !usable(width) ||
        !usable(height) ||
        !usable(durationMs) ||
        !usable(frameRate)
      ) {
        return unavailable;
      }
      const frameCount = Math.ceil((durationMs / 1000) * frameRate);
      return {
        estimatedTokenCount: Math.ceil(
          (width * height * frameCount) / VISUAL_PIXELS_PER_TOKEN,
        ),
        method: 'raw-resource-v1',
        status: 'ok',
      };
    }
    default:
      return unavailable;
  }
}
