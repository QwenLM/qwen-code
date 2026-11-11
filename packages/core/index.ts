/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Side-effect import: when running as a Bun-compiled binary this extracts
// embedded native modules (sharp, node-pty) to a tmp dir and patches the
// require resolver BEFORE any other core export evaluates. No-op outside
// Bun-compile mode. Kept here (not in packages/cli/index.ts) so esbuild's
// SEA bundle doesn't have to resolve a cross-package deep import path.
import './src/bootstrap/bunNativesBootstrap.js';

export * from './src/index.js';
export { isContextAttachmentMessage } from './src/attachments/context-messages.js';
export { Storage } from './src/config/storage.js';
export { DEFAULT_EMBEDDING_MODEL } from './src/config/models.js';
export { DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD } from './src/config/config.js';
// NOTE: sessionTitleUtils is already exported via `export * from './src/index.js'`
// which includes `export * from './services/sessionTitleUtils.js'`.
// Do not add explicit re-exports here to avoid duplicate-export errors.

export {
  getToolUseDisplayMetadata,
  type ToolUseDisplayMetadata,
} from './src/tools/tool-use-display.js';
export {
  makeFakeConfig,
  createEmptyLoadedSettings,
} from './src/test-utils/config.js';
export * from './src/utils/pathReader.js';
export * from './src/utils/resultErrorCode.js';
export * from './src/utils/startupTrace.js';
export { getConfigHomeDirOverride } from './src/utils/paths.js';
export {
  resolveClientRequestId,
  REQUEST_ID_HEADER,
} from './src/utils/request-id.js';
export {
  normalizeProxyUrl,
  normalizeProxyUrlIfSupported,
} from './src/utils/proxy.js';
export {
  hookOutputSchema,
  normalizeHookOutput,
  validateHookOutput,
} from './src/hooks/hookOutputSchema.js';
export type { ValidatedHookOutput } from './src/hooks/hookOutputSchema.js';
export { KeychainTokenStorage } from './src/mcp/token-storage/keychain-token-storage.js';
export * from './src/utils/googleQuotaErrors.js';
export type { GoogleApiError } from './src/utils/googleErrors.js';
export { getQuotaTotalRemaining, isQuotaExhausted } from './src/qoder/types.js';
export type { QoderModelConfig } from './src/qoder/types.js';
export { getErrorStatus, ModelNotFoundError } from './src/utils/httpErrors.js';
export { raceWithAbortSignal } from './src/utils/abort-race.js';
export { getRawContextWindowSize } from './src/compression-v2/thresholds.js';
export {
  DEFAULT_MAX_OUTPUT_TOKENS,
  resolveMaxOutputTokens,
} from './src/qoder/models/output-tokens.js';
export {
  getSupportedContextWindows,
  normalizeContextWindows,
  parseContextWindowConfig,
  supportsContextWindow,
  type ContextWindowCapableModel,
  type ParsedContextWindowConfig,
} from './src/qoder/models/context-windows.js';
export {
  getEffectiveBlockedMarketplaces,
  isPluginBlockedByPolicy,
} from './src/plugins/pluginPolicy.js';
export * from './src/builtin-plugins/index.js';
export { BuiltinPluginRegistry } from './src/builtin-plugins/registry.js';
export type { BuiltinPluginContributions } from './src/builtin-plugins/registry.js';
export { EnvConfigService } from './src/config-service/env-config-service.js';
export type * from './src/builtin-plugins/types.js';

export type {
  HookDiagnostic,
  HookDiagnosticsSnapshot,
} from './src/hooks/hookDiagnostics.js';
