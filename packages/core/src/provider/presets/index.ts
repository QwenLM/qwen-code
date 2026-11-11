/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type {
  BuildProviderEntryInput,
  PresetEndpoint,
  PresetGroup,
  PresetModel,
  PresetProtocol,
  PresetThinking,
  ProviderPreset,
  ProviderSettingsEntry,
} from './types.js';
export {
  ALIBABA_PRESETS,
  PROVIDER_PRESETS,
  QWENCLOUD_PRESETS,
  THIRD_PARTY_PRESETS,
  alibabaStandardPreset,
  codingPlanPreset,
  customProviderPreset,
  deepseekPreset,
  findPresetById,
  grokPreset,
  idealabPreset,
  minimaxPreset,
  modelscopePreset,
  moonshotPreset,
  openrouterPreset,
  qwencloudStandardPreset,
  qwencloudTokenPlanPreset,
  requestyPreset,
  tokenPlanPreset,
  zaiPreset,
} from './presets.js';
export {
  buildProviderSettingsEntry,
  providerIdForPreset,
  ProviderPresetError,
} from './install.js';
export { isGenerationModelId } from './modelClassification.js';
export {
  discoverProviderModels,
  type DiscoverProviderModelsOptions,
} from './modelDiscovery.js';
