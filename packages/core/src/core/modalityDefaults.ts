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
  // Qwen3.5-Plus: image support
  [/^qwen3\.5-plus/, { image: true, video: true }],
  [/^coder-model$/, { image: true, video: true }],

  // Qwen VL (vision-language) models: image + video
  [/^qwen-vl-/, { image: true, video: true }],
  [/^qwen3-vl-/, { image: true, video: true }],
  [/^vision-model$/, { image: true, video: true }],

  // Qwen coder / text models: text-only
  [/^qwen3-coder-/, {}],
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
  // MiniMax — text-only
  // -------------------
  [/^minimax-/, {}],

  // -------------------
  // Moonshot / Kimi
  // -------------------
  [/^kimi-k2\.5/, { image: true, video: true }],
  [/^kimi-/, {}],
];

/**
 * Return the default input modalities for a model based on its name.
 *
 * Uses the same normalize-then-regex pattern as {@link tokenLimit}.
 * Unknown models default to text-only (empty object) to avoid sending
 * unsupported media types that would cause unrecoverable API errors.
 */
export function defaultModalities(model: string): InputModalities {
  const norm = normalize(model);
  for (const [regex, modalities] of MODALITY_PATTERNS) {
    if (regex.test(norm)) {
      return { ...modalities };
    }
  }
  return {};
}
