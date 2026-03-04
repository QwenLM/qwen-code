/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================================================
// Configuration & Models
// ============================================================================

// Core configuration
export * from './config/config.js';
export { Storage } from './config/storage.js';
export * from './utils/configResolver.js';

// Model configuration
export {
  DEFAULT_QWEN_MODEL,
  DEFAULT_QWEN_FLASH_MODEL,
  DEFAULT_QWEN_EMBEDDING_MODEL,
  MAINLINE_CODER_MODEL,
} from './config/models.js';
export {
  type AvailableModel,
  type ModelCapabilities,
  type ModelConfig as ProviderModelConfig,
  type ModelConfigCliInput,
  type ModelConfigResolutionResult,
  type ModelConfigSettingsInput,
  type ModelConfigSourcesInput,
  type ModelConfigValidationResult,
  ModelRegistry,
  type ModelGenerationConfig,
  ModelsConfig,
  type ModelsConfigOptions,
  type ModelProvidersConfig,
  type ModelSwitchMetadata,
  type OnModelChangeCallback,
  QWEN_OAUTH_MODELS,
  resolveModelConfig,
  type ResolvedModelConfig,
  validateModelConfig,
} from './models/index.js';

// Output formatting
export * from './output/json-formatter.js';
export * from './output/types.js';

// ============================================================================
// Core Engine
// ============================================================================

export * from './core/client.js';
export * from './core/contentGenerator.js';
export * from './core/coreToolScheduler.js';
export * from './core/geminiChat.js';
export * from './core/geminiRequest.js';
export * from './core/logger.js';
export * from './core/nonInteractiveToolExecutor.js';
export * from './core/prompts.js';
export * from './core/tokenLimits.js';
export * from './core/turn.js';
export * from './core/geminiRequest.js';
export * from './core/coreToolScheduler.js';
export * from './core/nonInteractiveToolExecutor.js';
export * from './tools/tool-names.js';

// ============================================================================
// Tools
// ============================================================================

// Export utilities
export * from './utils/paths.js';
export * from './utils/schemaValidator.js';
export * from './utils/errors.js';
export * from './utils/debugLogger.js';
export * from './utils/getFolderStructure.js';
export * from './utils/memoryDiscovery.js';
export * from './utils/gitIgnoreParser.js';
export * from './utils/gitUtils.js';
export * from './utils/editor.js';
export * from './utils/quotaErrorDetection.js';
export * from './utils/fileUtils.js';
export * from './utils/retry.js';
export * from './utils/shell-utils.js';
export * from './utils/tool-utils.js';
export * from './utils/terminalSerializer.js';
export * from './utils/systemEncoding.js';
export * from './utils/textUtils.js';
export * from './utils/formatters.js';
export * from './utils/generateContentResponseUtilities.js';
export * from './utils/ripgrepUtils.js';
export * from './utils/filesearch/fileSearch.js';
export * from './utils/errorParsing.js';
export * from './utils/workspaceContext.js';
export * from './utils/ignorePatterns.js';
export * from './utils/partUtils.js';
export * from './utils/subagentGenerator.js';
export * from './utils/projectSummary.js';
export * from './utils/promptIdContext.js';
export * from './utils/thoughtUtils.js';
export * from './utils/toml-to-markdown-converter.js';
export * from './utils/yaml-parser.js';

// Config resolution utilities
export * from './utils/configResolver.js';

// Export services
export * from './services/fileDiscoveryService.js';
export * from './services/gitService.js';
export * from './services/chatRecordingService.js';
export * from './services/sessionService.js';
export * from './services/fileSystemService.js';

// Export IDE specific logic
export * from './ide/ide-client.js';
export * from './ide/ideContext.js';
export * from './ide/ide-installer.js';
export { IDE_DEFINITIONS, type IdeInfo } from './ide/detect-ide.js';
export * from './ide/constants.js';
export * from './ide/types.js';

// Export Shell Execution Service
export * from './services/shellExecutionService.js';

// Export base tool definitions
export * from './tools/tools.js';
export * from './tools/tool-error.js';
export * from './tools/tool-registry.js';

// Export subagents (Phase 1)
export * from './subagents/index.js';

// Export skills
export * from './skills/index.js';

// Export extension
export * from './extension/index.js';

// Export prompt logic
export * from './prompts/mcp-prompts.js';

// Export specific tool logic
export * from './tools/read-file.js';
export * from './tools/ls.js';
export * from './tools/grep.js';
export * from './tools/ripGrep.js';
export * from './tools/glob.js';
export * from './tools/edit.js';
export * from './tools/exitPlanMode.js';
export * from './tools/glob.js';
export * from './tools/grep.js';
export * from './tools/ls.js';
export * from './tools/lsp.js';
export * from './tools/memoryTool.js';
export * from './tools/mcp-client.js';
export * from './tools/mcp-client-manager.js';
export * from './tools/mcp-tool.js';
export * from './tools/read-file.js';
export * from './tools/ripGrep.js';
export * from './tools/sdk-control-client-transport.js';
export * from './tools/shell.js';
export * from './tools/skill.js';
export * from './tools/task.js';
export * from './tools/todoWrite.js';
export * from './tools/tool-error.js';
export * from './tools/tool-registry.js';
export * from './tools/tools.js';
export * from './tools/web-fetch.js';
export * from './tools/web-search/index.js';
export * from './tools/write-file.js';

// ============================================================================
// Services
// ============================================================================

export * from './services/chatRecordingService.js';
export * from './services/fileDiscoveryService.js';
export * from './services/fileSystemService.js';
export * from './services/gitService.js';
export * from './services/sessionService.js';
export * from './services/shellExecutionService.js';

// ============================================================================
// LSP Support
// ============================================================================

// LSP support
export * from './lsp/constants.js';
export * from './lsp/LspConfigLoader.js';
export * from './lsp/LspConnectionFactory.js';
export * from './lsp/LspLanguageDetector.js';
export * from './lsp/LspResponseNormalizer.js';
export * from './lsp/LspServerManager.js';
export * from './lsp/NativeLspClient.js';
export * from './lsp/NativeLspService.js';
export * from './lsp/types.js';

// ============================================================================
// MCP (Model Context Protocol)
// ============================================================================

export { MCPOAuthProvider } from './mcp/oauth-provider.js';
export type { MCPOAuthConfig } from './mcp/oauth-provider.js';
export { MCPOAuthTokenStorage } from './mcp/oauth-token-storage.js';
export { KeychainTokenStorage } from './mcp/token-storage/keychain-token-storage.js';
export type {
  OAuthCredentials,
  OAuthToken,
} from './mcp/token-storage/types.js';
export { OAuthUtils } from './mcp/oauth-utils.js';
export type {
  OAuthAuthorizationServerMetadata,
  OAuthProtectedResourceMetadata,
} from './mcp/oauth-utils.js';

// ============================================================================
// Telemetry
// ============================================================================

export { QwenLogger } from './telemetry/qwen-logger/qwen-logger.js';
export * from './telemetry/index.js';
export {
  logAuth,
  logExtensionDisable,
  logExtensionEnable,
  logIdeConnection,
  logModelSlashCommand,
} from './telemetry/loggers.js';
export {
  AuthEvent,
  ExtensionDisableEvent,
  ExtensionEnableEvent,
  ExtensionInstallEvent,
  ExtensionUninstallEvent,
  IdeConnectionEvent,
  IdeConnectionType,
  ModelSlashCommandEvent,
} from './telemetry/types.js';

// ============================================================================
// Extensions & Subagents
// ============================================================================

export * from './extension/index.js';
export * from './prompts/mcp-prompts.js';
export * from './skills/index.js';
export * from './subagents/index.js';

// ============================================================================
// Utilities
// ============================================================================

export * from './utils/browser.js';
export * from './utils/editor.js';
export * from './utils/errorParsing.js';
export * from './utils/errors.js';
export * from './utils/fileUtils.js';
export * from './utils/filesearch/fileSearch.js';
export * from './utils/formatters.js';
export * from './utils/generateContentResponseUtilities.js';
export * from './utils/getFolderStructure.js';
export * from './utils/gitIgnoreParser.js';
export * from './utils/gitUtils.js';
export * from './utils/ignorePatterns.js';
export * from './utils/memoryDiscovery.js';
export { OpenAILogger, openaiLogger } from './utils/openaiLogger.js';
export * from './utils/partUtils.js';
export * from './utils/pathReader.js';
export * from './utils/paths.js';
export * from './utils/promptIdContext.js';
export * from './utils/projectSummary.js';
export * from './utils/quotaErrorDetection.js';
export * from './utils/readManyFiles.js';
export * from './utils/request-tokenizer/supportedImageFormats.js';
export * from './utils/retry.js';
export * from './utils/ripgrepUtils.js';
export * from './utils/schemaValidator.js';
export * from './utils/shell-utils.js';
export * from './utils/subagentGenerator.js';
export * from './utils/systemEncoding.js';
export * from './utils/terminalSerializer.js';
export * from './utils/textUtils.js';
export * from './utils/thoughtUtils.js';
export * from './utils/toml-to-markdown-converter.js';
export * from './utils/tool-utils.js';
export * from './utils/workspaceContext.js';
export * from './utils/yaml-parser.js';
export * from './utils/jsonl-utils.js';

// ============================================================================
// OAuth & Authentication
// ============================================================================

export * from './qwen/qwenOAuth2.js';

// ============================================================================
// Testing Utilities
// ============================================================================

export { makeFakeConfig } from './test-utils/config.js';
export * from './test-utils/index.js';
