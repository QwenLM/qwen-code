/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useReducer } from 'react';
import {
  QODER_PROVIDER_ID,
  declaredOutputTokens,
  type Config,
  type Model,
} from '@qwen-code/core';
import { useModelList } from '../contexts/ConfigContext.js';
import type { ContextWindowCapableModel } from '../utils/contextWindow.js';

export interface ModelEntry extends ContextWindowCapableModel {
  key: string;
  display_name: string;
  format: string;
  is_vl: boolean;
  is_reasoning: boolean;
  source: string;
  url: string;
  max_input_tokens: number;
  max_output_tokens?: number;
  available_context_windows?: readonly number[] | null;
  default_context_window?: number | null;
  context_window_is_estimate?: boolean;
  efforts?: readonly string[];
  supports_disabled?: boolean;
  default_effort?: string;
  enable: boolean;
  is_default: boolean;
  is_new: boolean;
  tags: readonly string[] | null;
  model_provider?: string;
}
function toModelEntry(model: Model): ModelEntry {
  const contextWindows = model.capabilities.contextWindows.map(
    ({ tokens }) => tokens,
  );
  const defaultContextWindow = model.defaultModelConfig?.context?.contextWindow;
  return {
    key: model.key,
    display_name: model.displayName,
    format: 'openai',
    is_vl: model.capabilities.vision,
    is_reasoning: model.capabilities.reasoning.supported,
    source: model.source,
    url: '',
    max_input_tokens: model.limits.maxContextTokens,
    max_output_tokens: declaredOutputTokens(model) ?? 8_192,
    ...(contextWindows.length > 0
      ? { available_context_windows: contextWindows }
      : {}),
    ...(defaultContextWindow !== undefined
      ? { default_context_window: defaultContextWindow }
      : {}),
    efforts: [...model.capabilities.reasoning.supportedEfforts],
    enable: model.enabled !== false,
    is_default: model.isDefault === true,
    is_new: false,
    tags: null,
    model_provider: model.source,
  };
}

/** Local custom models keep their editable entries; provider models fill the rest. */
function mergeModelEntries(
  registryModels: readonly ModelEntry[],
  providerModels: readonly ModelEntry[],
): ModelEntry[] {
  const byKey = new Map<string, ModelEntry>();
  for (const model of registryModels) byKey.set(model.key, model);
  for (const model of providerModels) {
    if (!byKey.has(model.key)) byKey.set(model.key, model);
  }
  return [...byKey.values()];
}

/** Shared /model and /agents model rows, including local registry entries. */
export function useModelSelectionEntries(
  config: Config | undefined,
  modelListRevision: number,
  listedModels: readonly Model[] = [],
) {
  const [, reloadRegistry] = useReducer((value: number) => value + 1, 0);
  // The registry is the metadata source for protocol labels and local model
  // edits. Sessions started straight on a custom provider never go through
  // the Qoder runtime path that populates it.
  useEffect(() => {
    if (!config) return;
    const providers = config.getLoadedSettings().merged.providers;
    if (!providers || Object.keys(providers).length === 0) return;
    if (config.getCustomProviderRegistry().getPublicModels().length > 0) return;
    let cancelled = false;
    void config.initializeCustomProviders().then(
      () => {
        if (!cancelled) reloadRegistry();
      },
      () => {
        // Keep the manager-backed rows; labels fall back to the provider id.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [config]);
  const liveModels = useModelList(config, modelListRevision, listedModels);
  const registryModels = config
    ? config
        .getCustomProviderRegistry()
        .getPublicModels()
        .map(
          (model): ModelEntry => ({
            key: model.key,
            display_name: model.displayName,
            format: model.format,
            is_vl: false,
            is_reasoning: Boolean(model.capabilities?.thinking),
            source: 'custom',
            url: '',
            max_input_tokens: 128_000,
            max_output_tokens: 8_192,
            efforts: model.capabilities?.thinking?.supportedEffortLevels
              ? [...model.capabilities.thinking.supportedEffortLevels]
              : undefined,
            enable: true,
            is_default: false,
            is_new: false,
            tags: null,
            model_provider: model.providerId,
          }),
        )
    : [];
  const merged = mergeModelEntries(
    registryModels,
    liveModels.map(toModelEntry),
  );
  const qoderModels = merged.filter(
    (model) => model.source === QODER_PROVIDER_ID,
  );
  const customProviderModels = merged.filter(
    (model) => model.source !== QODER_PROVIDER_ID,
  );
  return {
    models: merged,
    customProviderModels,
    // Qwen order: Qoder catalog entries first, then local/provider models.
    selectableModels: [...qoderModels, ...customProviderModels],
  };
}
