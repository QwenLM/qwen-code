/**
 * Core Agent Module
 *
 * Provides shared functionality for agent backends.
 * These modules are provider-agnostic and can be composed into any agent implementation.
 *
 * Modules:
 * - PermissionManager: Tool permission evaluation and mode management
 * - SourceManager: External data source state tracking
 * - PromptBuilder: System prompt and context building
 * - PathProcessor: Path expansion and normalization
 * - ConfigValidator: Pre-write configuration validation
 * - ConfigWatcherManager: Hot-reload config file watching
 * - SessionLifecycleManager: Session state and abort handling
 * - UsageTracker: Token usage and context window tracking
 * - PrerequisiteManager: Prerequisite reading enforcement (guide.md before source tools)
 */

// Types
export type {
  // Core types
  RecoveryMessage,
  PermissionManagerConfig,
  ToolPermissionResult,
  SourceManagerConfig,
  PromptBuilderConfig,
  ContextBlockOptions,
  PathProcessorConfig,
  ConfigValidatorConfig,
  ConfigValidationResult,
  ConfigFileType,
  // Re-exported from mode-types
  PermissionMode,
  ModeConfig,
  CompiledApiEndpointRule,
  CompiledBashPattern,
  MismatchAnalysis,
  PermissionPaths,
  // Re-exported from mode-manager
  ToolCheckResult,
} from './types.ts';

// Config Watcher Manager types
export type {
  ConfigWatcherManagerCallbacks,
  ConfigWatcherManagerConfig,
} from './config-watcher-manager.ts';

// Session Lifecycle types
export type {
  SessionState,
  SessionLifecycleConfig,
} from './session-lifecycle.ts';
export { AbortReason } from './session-lifecycle.ts';

// Usage Tracker types
export type {
  MessageUsage,
  SessionUsage,
  UsageUpdate,
  UsageTrackerConfig,
} from './usage-tracker.ts';

// Constants
export {
  PERMISSION_MODE_ORDER,
  PERMISSION_MODE_CONFIG,
  SAFE_MODE_CONFIG,
} from './types.ts';

// Permission Manager
export { PermissionManager } from './permission-manager.ts';

// Source Manager
export { SourceManager } from './source-manager.ts';

// Prompt Builder
export { PromptBuilder } from './prompt-builder.ts';

// Path Processor
export {
  PathProcessor,
  // Re-exported utilities
  expandPath,
  normalizePath,
  pathStartsWith,
  toPortablePath,
} from './path-processor.ts';

// Config Validator
export { ConfigValidator } from './config-validator.ts';

// Config Watcher Manager
export {
  ConfigWatcherManager,
  createConfigWatcherManager,
} from './config-watcher-manager.ts';

// Session Lifecycle
export {
  SessionLifecycleManager,
  createSessionLifecycleManager,
} from './session-lifecycle.ts';

// Usage Tracker
export {
  UsageTracker,
  createUsageTracker,
} from './usage-tracker.ts';

// PreToolUse Utilities
export {
  // Types
  type PreToolUseContext,
  type PathExpansionResult,
  type SkillQualificationResult,
  type MetadataStrippingResult,
  type ConfigValidationResult as PreToolUseConfigValidationResult,
  // Centralized pipeline types
  type PreToolUseCheckResult,
  type PreToolUseInput,
  type PermissionManagerLike,
  type PrerequisiteManagerLike,
  // Constants
  BUILT_IN_TOOLS,
  FILE_PATH_TOOLS,
  CONFIG_WRITE_TOOLS,
  // Functions
  expandToolPaths,
  qualifySkillName,
  stripToolMetadata,
  stripMcpMetadata, // deprecated alias for backwards compatibility
  validateConfigWrite,
  // Centralized pipeline
  runPreToolUseChecks,
  shouldPromptInAskMode,
} from './pre-tool-use.ts';

// Prerequisite Manager
export { PrerequisiteManager } from './prerequisite-manager.ts';
export type {
  PrerequisiteRule,
  PrerequisiteCheckResult,
  PrerequisiteManagerConfig,
} from './prerequisite-manager.ts';

// Re-export skill plugin constant (used by renderer for mention qualification)
export { AGENTS_PLUGIN_NAME } from '../../skills/types.ts';
