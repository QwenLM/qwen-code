/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  type ModelCapabilities,
  type ModelGenerationConfig,
  type ModelConfig,
  type ModelProvidersConfig,
  type ProviderProtocolConfig,
  type ResolvedModelConfig,
  type AvailableModel,
  type ModelSwitchMetadata,
  type RuntimeModelSnapshot,
  type ModalitySource,
} from './types.js';

export type {
  ProbeResultStore,
  ModalityProbeRecord,
} from '../services/modalityProbe/probe-store.js';

export {
  ModelRegistry,
  modelRegistryKey,
  resolveProviderProtocol,
} from './modelRegistry.js';

export { isImageGenerationCapable } from './image-generation-capability.js';

export {
  ModelsConfig,
  type ModelsConfigOptions,
  type OnModelChangeCallback,
} from './modelsConfig.js';

export { VERTEX_ADC_HINT } from './modelConfigErrors.js';

export {
  AUTH_ENV_MAPPINGS,
  CREDENTIAL_FIELDS,
  DEFAULT_MODELS,
  MODEL_GENERATION_CONFIG_FIELDS,
  PROVIDER_SOURCED_FIELDS,
  QWEN_OAUTH_ALLOWED_MODELS,
  QWEN_OAUTH_MODELS,
} from './constants.js';

// Model configuration resolver
export {
  resolveModelConfig,
  validateModelConfig,
  type ModelConfigSourcesInput,
  type ModelConfigCliInput,
  type ModelConfigSettingsInput,
  type ModelConfigResolutionResult,
  type ModelConfigValidationResult,
} from './modelConfigResolver.js';
