export * from './conversation-summary.ts';

// eslint-disable-next-line import/no-internal-modules
export {
  QwenAgent,
  QwenBackend,
  getQwenMemorySettingsViaAcp,
  setQwenMemorySettingsViaAcp,
  getQwenSettingsPathViaAcp,
  getQwenMemoryPathsViaAcp,
  listQwenProvidersViaAcp,
  connectQwenProviderViaAcp,
} from './qwen-agent.ts';
export * from './errors.ts';

// Export session-scoped-tools - tools scoped to a specific session
export {
  // Session-scoped tools provider
  getSessionScopedTools,
  cleanupSessionScopedTools,
  // Plan file management
  getSessionPlansDir,
  getLastPlanFilePath,
  clearPlanFileState,
  isPathInPlansDir,
  // Callback registry for session-scoped tool notifications
  registerSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
  mergeSessionScopedToolCallbacks,
  // Types
  type SessionScopedToolCallbacks,
  type BrowserPaneFns,
  // Auth request types (unified auth flow)
  type AuthRequest,
  type AuthRequestType,
  type AuthResult,
  type CredentialAuthRequest,
  type McpOAuthAuthRequest,
  type GoogleOAuthAuthRequest,
  type SlackOAuthAuthRequest,
  type MicrosoftOAuthAuthRequest,
  type CredentialInputMode,
} from './session-scoped-tools.ts';

// Export mode-manager - Centralized mode management
export {
  // Permission Mode API (primary)
  getPermissionMode,
  setPermissionMode,
  cyclePermissionMode,
  subscribeModeChanges,
  PERMISSION_MODE_ORDER,
  PERMISSION_MODE_CONFIG,
  type PermissionMode,
  getModeState,
  hydratePreviousPermissionMode,
  getPermissionModeDiagnostics,
  initializeModeState,
  cleanupModeState,
  // Tool blocking (centralized)
  shouldAllowToolInMode,
  blockWithReason,
  // Session state (lightweight per-message injection)
  getSessionState,
  formatSessionState,
  // Mode manager singleton (for advanced use cases)
  modeManager,
  // Default Plan mode patterns (for UI display)
  SAFE_MODE_CONFIG,
  // Types
  type ModeState,
  type ModeCallbacks,
  type ModeConfig,
  type PermissionModeChangedBy,
} from './mode-manager.ts';

// Export plan types and permission mode messages
export type {
  Plan,
  PlanStep,
  PlanState,
  PlanReviewRequest,
  PlanReviewResult,
} from './plan-types.ts';
export {
  PERMISSION_MODE_MESSAGES,
  PERMISSION_MODE_PROMPTS,
} from './plan-types.ts';

// Export thinking-levels - extended reasoning configuration
export {
  type ThinkingLevel,
  type ThinkingLevelDefinition,
  THINKING_LEVELS,
  DEFAULT_THINKING_LEVEL,
  getThinkingTokens,
  getThinkingLevelNameKey,
  isValidThinkingLevel,
} from './thinking-levels.ts';

// Export permissions-config - customizable permissions per workspace/source (permissions.json)
export {
  // Parser and validation
  parsePermissionsJson,
  validatePermissionsConfig,
  PermissionsConfigSchema,
  // API endpoint checking
  isApiEndpointAllowed,
  // Storage functions
  loadWorkspacePermissionsConfig,
  loadSourcePermissionsConfig,
  getWorkspacePermissionsPath,
  getSourcePermissionsPath,
  // Raw load/save (for CLI CRUD)
  loadRawWorkspacePermissions,
  loadRawSourcePermissions,
  saveWorkspacePermissions,
  saveSourcePermissions,
  // App-level default permissions (at ~/.craft-agent/permissions/)
  getAppPermissionsDir,
  ensureDefaultPermissions,
  loadDefaultPermissions,
  // Cache singleton
  permissionsConfigCache,
  // Types
  type ApiEndpointRule,
  type CompiledApiEndpointRule,
  type PermissionsCustomConfig,
  type PermissionsConfigFile,
  type MergedPermissionsConfig,
  type PermissionsContext,
} from './permissions-config.ts';

// Export BaseAgent - shared abstract class for all agent backends
export {
  BaseAgent,
  // Mini agent configuration (centralized for all backends)
  type MiniAgentConfig,
  MINI_AGENT_TOOLS,
  MINI_AGENT_MCP_KEYS,
} from './base-agent.ts';

// Export backend abstraction - unified interface for AI agents
// Qwen backend abstraction
export {
  // Factory (createAgent is the preferred name, createBackend is kept for backward compat)
  createBackend,
  createAgent,
  detectProvider,
  getAvailableProviders,
  // Types
  type AgentBackend,
  type AgentProvider,
  type BackendConfig,
  type PermissionCallback,
  type PlanCallback,
  type AuthCallback,
  type SourceChangeCallback,
  type SourceActivationCallback,
  type ChatOptions,
  type RecoveryMessage,
  type SdkMcpServerConfig as BackendMcpServerConfig,
  // Enums
  AbortReason as BackendAbortReason,
} from './backend/index.ts'; // eslint-disable-line import/no-internal-modules

// Export core utilities for shared agent logic
// eslint-disable-next-line import/no-internal-modules
export * from './core/index.ts';

// Export browser tool name normalization helpers
export {
  LEGACY_BROWSER_TOOL_ALIASES,
  normalizeCanonicalBrowserToolName,
  normalizeBrowserToolName,
  isCanonicalBrowserToolName,
  isBrowserToolNameOrAlias,
} from './browser-tool-names.ts';

// Export PowerShell validator root setter (for Electron startup on Windows)
export { setPowerShellValidatorRoot } from './powershell-validator.ts';
