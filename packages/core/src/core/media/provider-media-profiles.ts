/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../config/config.js';
import type { Modality } from '../../utils/media/types.js';

/**
 * P2 · Per-provider media profile (Pattern P · mandatory data + provider
 * selection). Wrong compression/token parameters make a provider reject or
 * garble media, so this is not an optional plugin — it is always-on data
 * selected by provider, with a Default. Deployment can override the numbers, but
 * the profile always exists.
 */

export interface MediaProfile {
  id: string;
  /** Longest-edge pixel cap an image is downscaled to before inlining. */
  imageMaxLongEdge: number;
  /** Rough tokens-per-modality-unit used only for cost estimates (not billing). */
  tokensPerImage: number;
  tokensPerAudioSecond: number;
  tokensPerVideoSecond: number;
}

const DEFAULT_PROFILE: MediaProfile = {
  id: 'default',
  imageMaxLongEdge: 1568,
  tokensPerImage: 1200,
  tokensPerAudioSecond: 25,
  tokensPerVideoSecond: 300,
};

/** Select the media profile for the active provider. Always returns a profile. */
export function getMediaProfile(_config: Config): MediaProfile {
  // (Per-provider branches slot in here as they are added.)
  return DEFAULT_PROFILE;
}

/** Cost estimate helper shared by readers, derived from the active profile. */
export function estimateModalityTokens(
  profile: MediaProfile,
  modality: Modality,
  units: number,
): number {
  switch (modality) {
    case 'image':
      return profile.tokensPerImage;
    case 'audio':
      return Math.ceil(profile.tokensPerAudioSecond * Math.max(units, 1));
    case 'video':
      return Math.ceil(profile.tokensPerVideoSecond * Math.max(units, 1));
    default:
      return profile.tokensPerImage;
  }
}
