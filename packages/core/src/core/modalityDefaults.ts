/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { InputModalities } from './contentGenerator.js';
import { normalize } from './tokenLimits.js';

const FULL_MULTIMODAL: InputModalities = {
  image: true,
  pdf: true,
  audio: true,
  video: true,
};

/**
 * Ordered regex patterns: most specific -> most general (first match wins).
 * Default for unknown models is text-only (empty object = all false).
 */
const MODALITY_PATTERNS: Array<[RegExp, InputModalities]> = [
  // -------------------
  // Google Gemini — full multimodal
  // -------------------
  [/^gemini-3/, FULL_MULTIMODAL],
  [/^gemini-/, FULL_MULTIMODAL],

  // -------------------
  // OpenAI — image by default for all gpt/o-series models
  // -------------------
  [/^gpt-5/, { image: true }],
  [/^gpt-/, { image: true }],
  [/^o\d/, { image: true }],

  // -------------------
  // Anthropic Claude — image + pdf
  // -------------------
  [/^claude-/, { image: true, pdf: true }],

  // -------------------
  // Alibaba / Qwen
  // -------------------
  // Qwen Plus models: image + video support (Max models are text-only)
  [/^qwen3\.5-plus/, { image: true, video: true }],
  [/^qwen3\.6-plus/, { image: true, video: true }],
  [/^qwen3\.7-plus/, { image: true, video: true }],
  [/^coder-model$/, { image: true, video: true }],

  // Qwen VL (vision-language) models: image + video
  [/^qwen-vl-/, { image: true, video: true }],
  [/^qwen3-vl-/, { image: true, video: true }],

  // Qwen coder / text models: text-only
  [/^qwen3-coder-/, {}],
  // Qwen3.6-35B-A3B (local quant variants) — image + video
  [/^qwen3\.6-35b/, { image: true, video: true }],
  [/^qwen/, {}],

  // -------------------
  // DeepSeek — text-only
  // -------------------
  [/^deepseek/, {}],

  // -------------------
  // Zhipu GLM
  // -------------------
  [/^glm-4\.5v/, { image: true }],
  [/^glm-5(?:-|$)/, {}],
  [/^glm-/, {}],

  // -------------------
  // MiniMax — M3 supports image + video input; older models default to text-only
  // -------------------
  [/^minimax-m3/i, { image: true, video: true }],
  [/^minimax-/, {}],

  // -------------------
  // Moonshot / Kimi
  // -------------------
  [/^kimi-k2\./, { image: true, video: true }],
  [/^kimi-/, {}],

  // -------------------
  // ByteDance Doubao — Seed-series and *-vision / *-vl models accept image
  // input; other Doubao models (pro / lite / text) are text-only.
  // (QwenLM/qwen-code#4876)
  // -------------------
  // seedance (text→video) and seedream (text→image) are generation models with
  // text-only input — exclude them before the multimodal Seed chat series.
  [/^doubao-seed(ance|ream)/, {}],
  [/^doubao-seed/, { image: true }],
  [/^doubao-.*(vision|vl)/, { image: true }],
  [/^doubao/, {}],
];

/**
 * Return the default input modalities for a known model based on its name.
 *
 * Uses the same normalize-then-regex pattern as {@link tokenLimit}.
 * Returns `undefined` when no model-name pattern matches.
 */
export function detectDefaultModalities(
  model: string,
): InputModalities | undefined {
  const norm = normalize(model);
  for (const [regex, modalities] of MODALITY_PATTERNS) {
    if (regex.test(norm)) {
      return { ...modalities };
    }
  }
  return undefined;
}

/**
 * Return the default input modalities for a model based on its name.
 *
 * Uses the same normalize-then-regex pattern as {@link tokenLimit}.
 * Unknown models default to text-only (empty object) to avoid sending
 * unsupported media types that would cause unrecoverable API errors.
 */
export function defaultModalities(model: string): InputModalities {
  const modalities = detectDefaultModalities(model);
  if (modalities) {
    return modalities;
  }
  return {};
}
