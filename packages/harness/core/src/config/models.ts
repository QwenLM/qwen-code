/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Model } from '../provider/model/model.js';

export const MODEL_ALIAS_AUTO = 'auto';

export const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001';

// Cap the thinking at 8192 to prevent run-away thinking loops.
export const DEFAULT_THINKING_MODE = 8192;

const LEGACY_SKILL_LISTING_MODELS = [
  'claude-3-opus',
  'claude-3-sonnet',
  'claude-3-haiku',
  'claude-3-5-sonnet',
  'claude-3-5-haiku',
  'claude-3-7-sonnet',
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-sonnet-4-0',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
];

/** Display-column estimate used only for the interactive Skill listing budget. */
export function getSkillListingColumnsPerToken(
  model: Model | undefined,
  key?: string,
): 3 | 4 {
  if (!model && !key) return 4;

  // Resolve listed keys to the upstream model id: direct-connection entries carry it on
  // their connection, everything else is identified by its key.
  const entry = model as
    | (Model & { connection?: { model?: string } })
    | undefined;
  const modelId = entry?.connection?.model || entry?.key || key || '';
  const normalized = modelId.trim().toLowerCase().replace(/[._]/g, '-');

  // Known IDs may carry a provider prefix or dated suffix. The unversioned
  // Opus/Sonnet 4 aliases mean 4.0; an explicit minor version must not match.
  return LEGACY_SKILL_LISTING_MODELS.some((id) => normalized.includes(id)) ||
    /claude-(opus|sonnet)-4(?!-\d(?!\d))/.test(normalized)
    ? 4
    : 3;
}

function capitalizeFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function getDisplayString(
  entry: Model | undefined,
  model: string = entry?.key ?? '',
) {
  // Listed models first — model keys like 'qwen-max' have a display name.
  if (entry?.displayName) {
    return capitalizeFirst(entry.displayName);
  }

  if (model === MODEL_ALIAS_AUTO) {
    return 'Auto';
  }

  return capitalizeFirst(model);
}

/**
 * The disambiguation suffix appended to custom-provider model labels: two
 * providers can expose the same display name, so the provider name is shown
 * alongside it unless the model is first-party-branded. Single source for the rule
 * shared by the `/model` list and the status line; system and direct-connection models
 * carry no suffix.
 */
export function customProviderDisplaySuffix(model: {
  source?: string;
  provider?: string;
}): string {
  return model.source === 'custom' &&
    model.provider &&
    model.provider !== 'qoder'
    ? ` (${model.provider})`
    : '';
}

/**
 * Checks if the model is a Pro model.
 */
export function isProModel(model: string): boolean {
  return model.toLowerCase().includes('pro');
}

/**
 * Checks if the model is a Gen 3 model.
 */
export function isGen3Model(model: string): boolean {
  return /^gemini-3(\.|-|$)/.test(model);
}

/**
 * Checks if the model is a "custom" model (not a built-in branded model).
 */
export function isCustomModel(model: string): boolean {
  return model !== MODEL_ALIAS_AUTO;
}

/**
 * Checks if the model is an auto model.
 */
export function isAutoModel(model: string): boolean {
  return model === MODEL_ALIAS_AUTO;
}

/** Shared implementation — checks the listed model's vision capability. */
function hasVisionCapability(model: Model | undefined): boolean {
  return model?.capabilities.vision ?? false;
}

/**
 * Checks if the model supports multimodal function responses (multimodal data nested within function response).
 * This is supported in Gen 3.
 *
 * @param model The model name to check.
 * @returns True if the model supports multimodal function responses.
 */
export function supportsMultimodalFunctionResponse(
  model: Model | undefined,
): boolean {
  return hasVisionCapability(model);
}

/**
 * Checks whether the given model accepts image inputs (vision-language).
 *
 * Backed by the listed model's `capabilities.vision`. When the snapshot is
 * missing the entry (e.g. models not yet listed or old-version backend), this
 * conservatively returns `false` so the runtime
 * blocks image input rather than silently sending images the model cannot
 * understand.
 *
 * Used to gate user image input (paste/drag/SDK content blocks) and image
 * tool reads (FileRead on .png/.jpg/.jpeg/.gif/.webp).
 *
 * @param model The model name to check.
 * @returns True if the model can ingest images.
 */
export function isVisionSupportedModel(model: Model | undefined): boolean {
  return hasVisionCapability(model);
}
