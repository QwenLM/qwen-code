/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../config/config.js';
import { AuthType } from '../contentGenerator.js';
import type { Modality } from '../../utils/media/types.js';

/**
 * P2 · Per-provider media profile (Pattern P · mandatory data + provider
 * selection). Wrong compression/token parameters make a provider reject or
 * garble media, so this is not an optional plugin — it is always-on data
 * selected by provider, with a Default. Deployment can override the numbers, but
 * the profile always exists.
 *
 * Numbers are conservative, provider-published where available (image tile
 * sizing, per-second video/audio cost) and used only for cost *estimates* and
 * downscale caps — never for billing. Selection keys on the active auth type,
 * with a base-URL sniff to separate DashScope/Qwen-VL from generic OpenAI.
 */

export interface MediaProfile {
  id: string;
  /** Longest-edge pixel cap an image is downscaled to before inlining. */
  imageMaxLongEdge: number;
  /** Rough tokens-per-modality-unit used only for cost estimates (not billing). */
  tokensPerImage: number;
  tokensPerAudioSecond: number;
  tokensPerVideoSecond: number;
  /**
   * Whether this provider can fetch an uploaded `fileData.fileUri` (public URL /
   * Files API). Drives whether the upload transport is worth attempting.
   */
  supportsFileUri: boolean;
  /**
   * Which modalities can actually be delivered *by reference* (`fileData.fileUri`)
   * on this provider's request path. This is narrower than `supportsFileUri`:
   * e.g. the DashScope/OpenAI-compatible request only accepts image & video URLs
   * (`image_url`/`video_url`) — audio must be inlined (`input_audio` base64), so
   * uploading audio and referencing it by URL would be silently dropped. The
   * reader consults this to avoid that (fails closed with a remedy instead).
   */
  fileUriModalities: Modality[];
}

const DEFAULT_PROFILE: MediaProfile = {
  id: 'default',
  imageMaxLongEdge: 1568,
  tokensPerImage: 1200,
  tokensPerAudioSecond: 25,
  tokensPerVideoSecond: 300,
  supportsFileUri: true,
  fileUriModalities: ['image', 'video'],
};

/**
 * DashScope / Qwen-VL family. Qwen-VL downscales images to a token budget
 * (≈ up to 1280 long edge for the compatible endpoint) and accepts public
 * https/oss URLs for images and video, and for audio via input_audio.data
 * (verified live against qwen-omni on compatible-mode).
 */
const QWEN_PROFILE: MediaProfile = {
  id: 'qwen-vl',
  imageMaxLongEdge: 1280,
  tokensPerImage: 1024,
  tokensPerAudioSecond: 20,
  tokensPerVideoSecond: 256,
  supportsFileUri: true,
  fileUriModalities: ['image', 'audio', 'video'],
};

/** Google Gemini / Vertex — native long-context video, high per-image tiling. */
const GEMINI_PROFILE: MediaProfile = {
  id: 'gemini',
  imageMaxLongEdge: 3072,
  tokensPerImage: 258,
  tokensPerAudioSecond: 32,
  tokensPerVideoSecond: 300,
  supportsFileUri: true,
  fileUriModalities: ['image', 'audio', 'video'],
};

/** Anthropic Claude — images tiled to ~1568 long edge; no native audio/video. */
const ANTHROPIC_PROFILE: MediaProfile = {
  id: 'anthropic',
  imageMaxLongEdge: 1568,
  tokensPerImage: 1600,
  tokensPerAudioSecond: 0,
  tokensPerVideoSecond: 0,
  supportsFileUri: false,
  fileUriModalities: [],
};

/** Generic OpenAI-compatible (GPT-4o class): image tiles, no native a/v. */
const OPENAI_PROFILE: MediaProfile = {
  id: 'openai',
  imageMaxLongEdge: 2048,
  tokensPerImage: 1105,
  tokensPerAudioSecond: 0,
  tokensPerVideoSecond: 0,
  supportsFileUri: true,
  fileUriModalities: ['image', 'video'],
};

function looksLikeDashScope(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  const u = baseUrl.toLowerCase();
  return u.includes('dashscope') || u.includes('aliyuncs');
}

/** Select the media profile for the active provider. Always returns a profile. */
export function getMediaProfile(config: Config): MediaProfile {
  const cfg = config.getContentGeneratorConfig();
  const authType = cfg?.authType;
  const baseUrl = cfg?.baseUrl;
  switch (authType) {
    case AuthType.QWEN_OAUTH:
      return QWEN_PROFILE;
    case AuthType.USE_GEMINI:
    case AuthType.USE_VERTEX_AI:
      return GEMINI_PROFILE;
    case AuthType.USE_ANTHROPIC:
      return ANTHROPIC_PROFILE;
    case AuthType.USE_OPENAI:
      return looksLikeDashScope(baseUrl) ? QWEN_PROFILE : OPENAI_PROFILE;
    default:
      return looksLikeDashScope(baseUrl) ? QWEN_PROFILE : DEFAULT_PROFILE;
  }
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
