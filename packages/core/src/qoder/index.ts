/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// 中立读面契约，归 core/src/auth/；经本 barrel 继续对外同名导出。
export type { ApiKeyResolver } from '../auth/apiKeyResolver.js';
export type { BearerResolver } from '../auth/bearerResolver.js';

// Model types
export type {
  ModelStrategy,
  ContextConfig,
  ContextWindowConfigEntry,
  ThinkingConfig,
  ThinkingConfigDisabled,
  ThinkingConfigEnabled,
  EffortConfigEntry,
  LocalizedModelText,
  ServerModelJson,
  ServerModelJsonValue,
  ServerModelListEntry,
} from './models/types.js';

export * from '../host-action/store.js';

// Quota display types
export type {
  QoderQuotaDisplayLabel,
  QoderDedicatedResourcePackage,
} from './types.js';

export { redactTextForDebug } from './log-redaction.js';
export {
  isCustomProviderModel,
  isDirectConnectionModel,
  isQwenServerModel,
} from './models/qoder-model-fields.js';
export type {
  QoderListedModel,
  QoderModelFields,
} from './models/qoder-model-fields.js';

// Custom Providers used by SDK-facing provider configuration management.
export {
  parseCustomProviderSettings,
  supportsCustomProviderModelThinking,
} from '../provider/custom/index.js';
export type {
  CustomProviderRuntime,
  CustomProviderValidationIssue,
} from '../provider/custom/index.js';

// I18n — dynamic model descriptions with remote fetch + file cache
export {
  getI18nService,
  getStaticI18nService,
  initializeI18nService,
  installI18nService,
  DefaultI18nService,
  resetI18nService,
  parseMarkdownDescription,
} from '../i18n/index.js';
export type {
  I18nService,
  DynamicTextSnapshot,
  I18nSnapshot,
  I18nUiState,
  MessageParams,
  UiLanguagePreference,
  I18nCatalog,
} from '../i18n/index.js';
export {
  formatMessage,
  tokenizeMessage,
  getPlaceholderNames,
} from '../i18n/index.js';

// Business tracking context
export {
  BusinessProductCLI,
  BusinessTypeAgent,
  BusinessTypeCodeReview,
  BusinessStageInit,
  BusinessStageStart,
  BusinessStageProcessing,
  BusinessStageComplete,
  BusinessStageAbort,
  BusinessStageError,
} from './business-info.js';
export type {
  BusinessInfo,
  BusinessProduct,
  BusinessType,
  BusinessStage,
  CommandLocation,
  CmdInfo,
  EnvInfo,
} from './business-info.js';
export {
  isUiLanguagePreference,
  normalizeUiLanguagePreference,
  resolveUiLocale,
} from '../i18n/index.js';
export type { MessageToken } from '../i18n/index.js';

export { DefaultI18nCatalog } from '../i18n/default-i18n-catalog.js';
