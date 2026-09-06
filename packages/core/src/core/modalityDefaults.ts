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
  // Qwen Plus models: image + video support
  [/^qwen3\.5-plus/, { image: true, video: true }],
  [/^qwen3\.6-plus/, { image: true, video: true }],
  [/^qwen3\.7-plus/, { image: true, video: true }],
  // Qwen 3.8 series: flash/plus support image + video; max supports image only
  [/^qwen3\.8-flash/, { image: true, video: true }],
  [/^qwen3\.8-plus/, { image: true, video: true }],
  [/^qwen3\.8-max/, { image: true }],
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
  // DeepSeek — text-only, except explicit vision variants
  // (QwenLM/qwen-code#10270)
  // -------------------
  [/^deepseek-.*vision/, { image: true }],
  [/^deepseek/, {}],

  // -------------------
  // Zhipu GLM — v-suffix ids are vision models; others are text-only
  // (QwenLM/qwen-code#10270)
  // -------------------
  [/^glm-[0-9.]+v/, { image: true }],
  // glm-5.3-flash natively integrates vision input (no v suffix)
  [/^glm-5\.3-flash/, { image: true }],
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
  [/^kimi-k3/, { image: true, video: true }],
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

/**
 * True for wire model ids in the qwen family: any `qwen*` id plus
 * `coder-model`, the QWEN_OAUTH default (DEFAULT_QWEN_MODEL in
 * config/models.ts, aliased to a Qwen 3.6 Plus hybrid), which doesn't
 * start with `qwen` but is the most common hybrid-thinking model for
 * first-time users. Shared by the pipeline's disable/tool-choice gates
 * and the DashScope provider's effort mapping so the family fact lives
 * in one place.
 */
export function isQwenFamilyWireModel(model: string | undefined): boolean {
  if (!model) {
    return false;
  }
  const normalized = model.toLowerCase();
  return normalized.startsWith('qwen') || normalized === 'coder-model';
}

/**
 * True for the qwen3.8-max wire model family — the only family that
 * reads the tiered `reasoning_effort` field directly. Prefix-matched so
 * dated snapshots and `-latest` aliases are covered, consistent with the
 * family pattern in MODALITY_PATTERNS above. Older qwen hybrids expose
 * only the on/off `enable_thinking` switch instead.
 */
export function isTieredEffortWireModel(model: string | undefined): boolean {
  if (!model) {
    return false;
  }
  return model.toLowerCase().startsWith('qwen3.8-max');
}
