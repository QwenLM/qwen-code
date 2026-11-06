/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContentGeneratorConfigSourceKind } from '../core/contentGenerator.js';

/**
 * Describe why a model cannot accept a media modality.
 *
 * Both the read_file path and the OpenAI converter build the same refusal, so
 * the wording lives here rather than being duplicated at the two call sites.
 * `sourceKind` is the resolved `modalities` source: a value the user declared
 * and one guessed from the model name need different next steps
 * (QwenLM/qwen-code#16178).
 */
export function unsupportedModalityReason(
  modality: string,
  model: string,
  sourceKind?: ContentGeneratorConfigSourceKind,
  viaKind?: ContentGeneratorConfigSourceKind,
): string {
  const opening = `Model '${model}' does not support ${modality} input`;
  if (sourceKind === 'computed') {
    // `computed` is also what an env-only setup and a built-in model produce,
    // where there is no provider entry to edit; name both layers instead of
    // sending every operator to a key their configuration may not have.
    // A model routed through `modelProviders` ignores the top-level
    // `model.generationConfig`, so offering that key there names a setting
    // that never produced this value (QwenLM/qwen-code#16178).
    const declare =
      viaKind === 'modelProviders'
        ? `Declare "generationConfig": { "modalities": { "${modality}": true } } on its modelProviders entry, or re-select the model with /model if it is already declared there.`
        : `Declare "generationConfig": { "modalities": { "${modality}": true } } on its modelProviders entry, or "model.generationConfig.modalities" in settings, to enable it.`;
    return `${opening}: its input modalities were inferred from the model name. ${declare}`;
  }
  if (sourceKind === 'settings') {
    return `${opening}: the "model.generationConfig.modalities" setting is set without ${modality}. Check it and re-select the model with /model.`;
  }
  if (sourceKind === 'modelProviders') {
    return `${opening}: this provider entry's "generationConfig.modalities" is set without ${modality}. Check it and re-select the model with /model.`;
  }
  return `${opening}.`;
}
