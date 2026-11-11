/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { PrepareModelSelection } from '../provider/model/modelSelector.js';
import { createModelSelectionPolicy } from '../core/model-policy.js';
import { createModelRequestGuard } from '../provider/session-model.js';

import { withModelRequestRetryConfig } from '../model-request/retry-context.js';

import type { PluginManagerFactory } from '../plugins/management/pluginManager.js';
import type { SessionPluginRuntime } from '../plugins/management/sessionPluginRuntime.js';
import { resetCodeModeSession } from '../codemode/session.js';
import {
  DEFAULT_SKILL_LISTING_MAX_DESC_CHARS,
  DEFAULT_SKILL_LISTING_BUDGET_FRACTION,
} from '../skills/skillListingDefaults.js';

import type { SystemPrompt } from '../prompts/types.js';
import { ModelProviderManager } from '../provider/impl/modelProviderManager.js';
import type { ModelProvider } from '../provider/modelProvider.js';
import type { Model, ModelConfig } from '../provider/model/model.js';
import { resolveModelName } from '../provider/model/resolveModelName.js';
import { ModelTransportManager } from '../provider/transport/modelTransportManager.js';
import { ChatCompletionsTransport } from '../provider/transport/impl/chatCompletionsTransport.js';
import { MessagesTransport } from '../provider/transport/impl/messagesTransport.js';
import { ResponsesTransport } from '../provider/transport/impl/responsesTransport.js';
import { GeminiTransport } from '../provider/transport/impl/geminiTransport.js';
import type { CustomProviderManager } from '../provider/custom/customProviderManager.js';
import type { BuiltinPluginContributions } from '../builtin-plugins/registry.js';
import { syncBuiltinPluginTools } from '../builtin-plugins/tool.js';
import { CONFIG_DIR } from '../utils/paths.js';
import { PermissionModeUnavailableError } from '../permissions/manager/policy.js';

import { createToolFileStateCache } from '../utils/fileStateCache.js';
import * as path from 'node:path';
import process from 'node:process';
import type { FileHistoryManager } from '../file-history/file-history.js';
import type {
  WorktreeCreationSettings,
  WorktreeEntryRequest,
  WorktreeSettings,
} from '../services/worktree/contracts.js';
import {
  enterConfigWorktree,
  restoreConfigWorktree,
  releaseConfigWorktreeOwnership,
} from './worktreeRuntime.js';
export type {
  WorktreeCreationSettings,
  WorktreeSettings,
} from '../services/worktree/contracts.js';
import type {
  ContextManagementConfig,
  ToolOutputMaskingConfig,
} from '../context/types.js';
export type { SessionResumeData } from '../services/sessionResumeData.js';
import {
  AuthType,
  ResourceService,
  SettingsService,
  type LoadedSettings,
} from '@qwen-code/resource';
import {
  getClientMetadata,
  ENV_MCP_INIT_BUDGET_MS,
  ENV_PLAN_MODE_INTERVIEW_PHASE,
  ENV_PLAN_PHASE4_VARIANT,
  getAutoMemoryHeadlessProjectEnvOverride,
  getAutoMemoryHeadlessUserEnvOverride,
  isAutoMemoryHeadlessEnvEnabled,
} from './brand.js';
import { FakeResponseStore } from '../core/fakeResponseStore.js';
import { getModelRequestIdentity } from './modelRequestIdentity.js';
import {
  CustomProviderAccess,
  type CustomProviderAccessMode,
  type CustomProviderAccessState,
} from './custom-provider-access.js';
import {
  CustomProviderRegistry,
  formatCustomProviderConfigurationWarnings,
  isReservedProviderId,
  type CustomProviderModelDescriptor,
  type CustomProvidersState,
  type CustomProvidersInactiveReason,
} from '../provider/custom/index.js';
import {
  resolveTasksEnabled,
  resolveWorktreeEnabled,
} from './feature-flags.js';
import { tagScope } from './mcpServerScope.js';
import type {
  EditableSettingSource,
  PermissionsSettingsJson,
} from '../permissions/settings/permissionsLoader.js';
import {
  type SessionState,
  createSessionState,
} from '../thread-manager/session/index.js';
import {
  getAutoMemoryFeatureGateConfig,
  isAutoMemoryFeatureGateEnabled as resolveAutoMemoryFeatureGateEnabled,
  setAutoMemoryFeatureGateChangeHandler,
} from '../config-service/features/autoMemory.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { StreamingToolExecutor } from '../tool-executor/index.js';
import type { ToolExecutor } from '../tool-executor/index.js';
import { ensureConfigReadyForRequest } from '../config-service/index.js';
import {
  getCodeModeFeatureConfig,
  type CodeModeFeatureConfig,
} from '../config-service/features/codeMode.js';
import { isKeptByAllowList } from '../tools/tool-exposure.js';
import {
  isCodeModeSupported,
  resolveCodeModeExposure,
  type CodeModeExposure,
  type CodeModeSetting,
} from '../codemode/settings.js';
import { ReadFileTool } from '../tools/read-file.js';
import { RipGrepTool } from '../tools/ripGrep.js';
import { GlobTool } from '../tools/glob.js';
import { ActivateSkillTool } from '../tools/activate-skill.js';
import { EditTool } from '../tools/edit.js';
import { NotebookEditTool } from '../tools/notebook-edit.js';
import { ShellTool } from '../tools/shell.js';
import { PowerShellTool } from '../tools/powerShell.js';
import {
  resolveShellCapabilitySnapshot,
  type ShellCapabilitySnapshot,
} from '../tools/powerShellFeatureGate.js';
import { getPowerShellRuntime } from '../utils/shell/powerShell.js';
import { MonitorTool } from '../tools/monitor.js';
import { TaskStopTool } from '../tools/task-stop.js';
import {
  BashInputTool,
  BashOutputTool,
  BashResizeTool,
} from '../tools/bash-pty.js';
import { isBashPtyToolsEnabled } from '../tools/bash-pty-feature-gate.js';
import { WriteFileTool } from '../tools/write-file.js';
import { WebFetchTool } from '../tools/web-fetch.js';
import {
  deriveLocalContextFilenames,
  normalizeContextFilenames,
} from '../tools/memoryTool.js';
import { AskUserTool } from '../tools/ask-user.js';
import { UpdateTopicTool } from '../tools/topicTool.js';
import { TopicState } from './topicState.js';
import { ExitPlanModeTool } from '../tools/exit-plan-mode.js';
import { EnterPlanModeTool } from '../tools/enter-plan-mode.js';
import { EnterWorktreeTool } from '../tools/enter-worktree.js';
import { ExitWorktreeTool } from '../tools/exitWorktree.js';
import type { HookDefinition, HookEventName } from '../hooks/types.js';

/** Hook definitions keyed by event name — used for per-source hook storage. */
type HookDefinitionsByEvent = { [K in HookEventName]?: HookDefinition[] };
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import { uiTelemetryService } from '../services/session-stats.js';
import { coreEvents, CoreEvent } from '../utils/events.js';
import {
  DEFAULT_COMPRESSION_CONFIG,
  type CompressionConfig,
} from '../compression-v2/config.js';
import { tokenLimit } from '../core/tokenLimits.js';
import { DEFAULT_EMBEDDING_MODEL } from './models.js';
import { shouldAttemptBrowserLaunch } from '../utils/browser.js';
import type { MCPOAuthConfig } from '../mcp/connector/oauth/provider.js';
import type {
  MCPServerConfig,
  McpPluginOwner,
} from '../mcp/mcpServerConfig.js';
export {
  AuthProviderType,
  MCPServerConfig,
  createSdkMcpServerConfig,
  type MCPServerConfigFields,
  type McpPluginOwner,
  type McpServerScope,
  type McpToolRuntimeOverride,
} from '../mcp/mcpServerConfig.js';
export { findUnavailableConfiguredCustomProviderModel } from './customProviderAvailability.js';
import type { BuiltinSessionContext } from '../builtin-plugins/types.js';
import { getSessionArtifactProjectRoots } from '../services/sessionArtifactRoots.js';
import { CronCreateTool } from '../tools/cron-create.js';
import { CronDeleteTool } from '../tools/cron-delete.js';
import { CronListTool } from '../tools/cron-list.js';
import { ScheduleWakeupTool } from '../tools/schedule-wakeup.js';
import { CronManager } from '../cron/cronManager.js';
import { CronTurn } from '../cron/cron-turn.js';
import type { TurnHookModuleFactory } from '../core/turn-hooks.js';
import {
  StandardFileSystemService,
  type FileSystemService,
} from '../services/fileSystemService.js';
import {
  TaskCreateTool,
  TaskGetTool,
  TaskListTool,
  TaskUpdateTool,
} from '../tools/taskTools.js';
import {
  GetGoalTool,
  CreateGoalTool,
  UpdateGoalTool,
} from '../tools/goalTools.js';
import { GoalManager } from '../goal/GoalManager.js';
import { GoalStorage } from '../goal/GoalStorage.js';
import { WriteTodosTool } from '../tools/write-todos.js';
import type { FallbackModelHandler } from '../fallback/types.js';
import { ModelAvailabilityService } from '../availability/modelAvailabilityService.js';
import { OutputFormat } from '../output/types.js';
import { PlanStateManager } from '../plan/planStateManager.js';
import {
  type AgentModelConfig,
  resolveConfiguredAgentModel,
} from '../agents/agentModelConfig.js';
import { MemoryContextManager } from '../context/memoryContextManager.js';
import { TaskStore } from '../tasks/task-store.js';
import { resolveTaskListId } from '../tasks/task-list-id.js';
import {
  mergeLlmGenerationConfigs,
  normalizeLlmGenerationConfig,
  type LlmGenerationConfig,
} from './generation-config.js';
import {
  getSupportedContextWindows,
  resolveContextWindow,
} from '../qoder/models/context-windows.js';
import { findUnsupportedModelConfig } from '../provider/model/modelConfig.js';

/** Capability facts of a session model consulted by context-window checks. */
interface SessionModelCapabilities {
  /** Server model, direct-connection model, or custom provider model. */
  readonly kind: 'qoder' | 'direct' | 'custom';
  maxInputTokens: number;
  readonly availableContextWindows?: readonly number[];
  readonly defaultContextWindow?: number;
}

function listedModelCapabilities(model: Model): SessionModelCapabilities {
  const windows = model.capabilities.contextWindows.map(
    (window) => window.tokens,
  );
  const defaultWindow = model.defaultModelConfig?.context?.contextWindow;
  return {
    kind:
      model.source !== 'qoder'
        ? 'custom'
        : 'connection' in model
          ? 'direct'
          : 'qoder',
    maxInputTokens: model.limits.maxContextTokens,
    ...(windows.length > 0 ? { availableContextWindows: windows } : {}),
    ...(defaultWindow !== undefined
      ? { defaultContextWindow: defaultWindow }
      : {}),
  };
}

/** Custom provider route capabilities. */
function customProviderModelCapabilities(
  model: CustomProviderModelDescriptor,
): SessionModelCapabilities {
  return { kind: 'custom', maxInputTokens: model.contextWindow };
}
import { isContextWindowSelectionEnabled } from '../config-service/features/contextWindowSelection.js';

/**
 * What a caller knows about a permission mode change that the setter cannot see.
 *
 * `trigger` answers where the change came from; the rest describes the entry point
 * that made it. Used for diagnostics only.
 */
export interface PermissionModeChangeTelemetryContext {
  trigger?:
    | 'slash'
    | 'shortcut'
    | 'remote'
    | 'tool'
    | 'hook'
    | 'config'
    | 'startup'
    | 'unknown';
  persisted?: boolean;
  settingScope?: string;
}

// Re-export OAuth config type
export type { MCPOAuthConfig, AnyToolInvocation, AnyDeclarativeTool };
import type { AnyToolInvocation, AnyDeclarativeTool } from '../tools/tools.js';
import { WorkspaceContext } from '../utils/workspaceContext.js';
import { Storage } from './storage.js';
import type { ShellExecutionConfig } from '../services/shellExecutionService.js';
import {
  initializeShellSession,
  runWithShellSession,
  setCwdChangedCallback,
} from '../utils/Shell.js';
import {
  type AgentResourceView,
  type OutputStyleResourceView,
  type ProjectResource,
  type ProjectResourceOptions,
  type ResourceHandle,
  type SkillResourceView,
  type UserResource,
} from '@qwen-code/resource';
import type {
  AgentResourceDefinition,
  AgentResourceLoadError,
  ResourceChangeEvent,
  SkillDefinition,
  SkillLoadError,
} from '@qwen-code/resource';
import {
  createConfigStartupRuntime,
  type ConfigStartupGate,
  type StartupDegradation,
  type StartupGateResult,
  type StartupRuntime,
  type StartupSnapshot,
} from '../startup/startupRuntime.js';
import { FileExclusions } from '../utils/ignorePatterns.js';
import {
  InMemoryToolCallSnapshotStore,
  type ToolCallSnapshotStore,
} from '../tool-executor/tool-call-snapshot.js';
import type { Message } from '../protocol/transcript/message.js';
import type { EventEmitter } from 'node:events';
import type { PermissionMode } from '../permissions/manager/decision/index.js';
import { permissionRulesFromStartup } from '../permissions/settings/startup-rules.js';
import type { SessionPermissionManager as SessionPermissionAPI } from '../permissions/manager/session-permission-manager.js';
import { loadPermissionRulesFromLoadedSettings } from '../permissions/settings/rule-sources.js';
import {
  hasAutoModeBlock,
  readGlobalAutoModeUserConfig,
} from '../permissions/permission-modes/auto/classifier-init.js';
import { createEagerMcpToolChecker } from '../permissions/config-checker-deps.js';
import { resolveStartupPermissionMode } from '../permissions/settings/startup-mode.js';
import { createClassifierInputsForConfig } from '../permissions/config-checker-deps.js';
import type { PermissionManager } from '../permissions/manager/permission-manager.js';
import {
  AUTO_MODE_UNSUPPORTED_MESSAGE,
  BYPASS_PERMISSIONS_DISABLED_MESSAGE,
  isAutoMode,
  isDefaultMode,
  isPlanStateBlockedByMode,
  isYoloMode,
  PLAN_MODE_FORCE_EXITED_MESSAGE,
} from '../permissions/permission-modes/index.js';
import { PermissionTelemetry } from '../permissions/permission-ask-channel.js';
import { createSettingsAccessor } from '../permissions/settings/settingsAccessorFactory.js';
import {
  permissionRuleValueFromString,
  isMcpName,
  mcpToolNameMatchesRule,
} from '../permissions/manager/decision/index.js';
import {
  loadAllPermissionRulesFromDisk,
  rulesToPermissionRules,
} from '../permissions/settings/permissionsLoader.js';
import { HookSystem, hasBlockingResult } from '../hooks/index.js';
import { getSessionEnvScript as resolveSessionEnvScript } from '../hooks/sessionEnvironment.js';
import type { HierarchicalMemory } from './memory.js';
import { AgentRegistry } from '../agents/registry/agentRegistry.js';
import { readAgentSelectionDefaults } from '../agents/agentModelConfig.js';
import { AgentTool } from '../agents/subagent-tool.js';
import { createAgentTeamTools } from '../agents/teams/agent-team-tools.js';
import {
  isCrossSessionMessagingEnabled,
  isListAgentsToolEnabled,
} from '../messaging/cross-session-feature.js';
import { ListAgentsTool } from '../messaging/list-agents-tool.js';
import {
  deriveSessionTeamName,
  isInProcessTeammateFeatureEnabled,
} from '../agents/teams/agent-teams-feature.js';
import {
  ensureAgentTeam,
  removeAgentTeam,
} from '../agents/teams/agent-team-runtime.js';
import { WorkflowTool } from '../workflows/index.js';
import { runLogger } from '../utils/runLogger.js';
import { SkillManager } from '../skills/skillManager.js';
import { loadOutputStylesFromDir } from '../prompts/outputStyles/loader.js';
import type {
  OutputStyleConfig,
  ResolvedOutputStyle,
} from '../prompts/outputStyles/types.js';
import { OutputStyleManager } from '../prompts/outputStyles/outputStyleManager.js';
import { startupProfiler } from '../utils/startupProfiler.js';
import {
  StartupDiagnostics,
  type StartupPhaseObserver,
} from '../startup/startupDiagnostics.js';
import { traceStartupStep } from '../utils/startupTrace.js';
import type { AgentDefinition, AgentSource } from '../agents/types.js';
import { isSubpath, resolveToRealPath } from '../utils/paths.js';
import { isAgentMemoryPath } from '../agents/agentMemory.js';
import { toAgentDefinitionLike } from '../agents/agent-setup.js';
import type { AgentDefinitionLike } from '../prompts/types.js';
import { InjectionService } from './injectionService.js';
import { setTaskOutputDir } from '../utils/task/diskOutput.js';
import type { AgentLoopContext } from './agent-loop-context.js';
import type { TaskRegistry } from '../tasks/task-registry.js';
import { TranscriptStore } from '../services/transcript/store.js';
import { getSessionTranscriptPath } from '../services/transcript-paths.js';
import type {
  TranscriptMessage,
  TranscriptWorktreeSession,
} from '../protocol/transcript/entry.js';
import {
  emitSessionPhaseFinished,
  emitSessionPhaseStarted,
} from '../utils/diagnosticInterceptors.js';

/**
 * Per-session auth snapshot.
 *
 * Only `authType` has persistent readers; the remaining fields are transport
 * inputs that `refreshAuth` callers may pass through.
 */
export type ContentGeneratorConfig = {
  apiKey?: string;
  authType?: AuthType;
  proxy?: string;
  baseUrl?: string;
  customHeaders?: Record<string, string>;
};

function createContentGeneratorConfig(
  config: Config,
  authType: AuthType | undefined,
  baseUrl?: string,
  customHeaders?: Record<string, string>,
): ContentGeneratorConfig {
  return {
    authType,
    proxy: config.getProxy(),
    baseUrl,
    customHeaders,
  };
}

export interface SessionRuntimeRefreshOptions {
  refreshTools?: boolean;
  refreshSystemPrompt?: boolean;
  resetModelRouting?: boolean;
  /** Drop captured request fields without rebuilding prompt/tool caches. */
  invalidateRequestSnapshot?: boolean;
}

export interface SessionRuntimeBinding {
  refreshRuntimeContext(
    options: SessionRuntimeRefreshOptions,
  ): void | Promise<void>;
  stripThoughtsFromConversationHistory?(): void;
  persistSessionTitle?(title: string): void | Promise<void>;
  recordWorktreeState?(
    state: TranscriptWorktreeSession | null,
    discardLegacyFileHistorySnapshots?: boolean,
  ): void | Promise<void>;
  getTranscriptPath?(): string | undefined;
  synchronizeWorktreeRuntimeState?(
    state: TranscriptWorktreeSession | null,
  ): void;
  activeConversation?: ActiveConversation;
}

/** The persisted conversation the session is currently on, for state derived from it. */
export interface ActiveConversation {
  /** Changes whenever the active chain is replaced, such as on resume, rewind or reset. */
  revision(): number;
  /** The active chain across Compact Boundaries, oldest first. */
  readChain(): Promise<readonly TranscriptMessage[]>;
}

export interface AccessibilitySettings {
  /** @deprecated Use ui.statusHints instead. */
  enableLoadingPhrases?: boolean;
  screenReader?: boolean;
}

export interface SummarizeToolOutputSettings {
  tokenBudget?: number;
}

export interface PlanSettings {
  enabled?: boolean;
  directory?: string;
}

export interface OutputSettings {
  format?: OutputFormat;
}

export interface ADKSettings {
  agentSessionNoninteractiveEnabled?: boolean;
  agentSessionInteractiveEnabled?: boolean;
}

export interface AgentRunConfig {
  maxTimeMinutes?: number;
  maxTurns?: number;
}

/**
 * Override configuration for a specific agent.
 * Generic fields (modelConfig, runConfig, enabled) are standard across all agents.
 */
export interface AgentOverride {
  modelConfig?: AgentModelConfig;
  runConfig?: AgentRunConfig;
  enabled?: boolean;
  tools?: string[];
  mcpServers?: Record<string, MCPServerConfig>;
}

export interface AgentSettings {
  overrides?: Record<string, AgentOverride>;
}

export interface CustomTheme {
  type: 'custom';
  name: string;

  text?: {
    primary?: string;
    secondary?: string;
    link?: string;
    accent?: string;
    response?: string;
  };
  background?: {
    primary?: string;
    diff?: {
      added?: string;
      removed?: string;
    };
  };
  border?: {
    default?: string;
  };
  ui?: {
    comment?: string;
    symbol?: string;
    active?: string;
    focus?: string;
    gradient?: string[];
  };
  status?: {
    error?: string;
    success?: string;
    warning?: string;
  };

  // Legacy properties (all optional)
  Background?: string;
  Foreground?: string;
  LightBlue?: string;
  AccentBlue?: string;
  AccentPurple?: string;
  AccentCyan?: string;
  AccentGreen?: string;
  AccentYellow?: string;
  AccentRed?: string;
  DiffAdded?: string;
  DiffRemoved?: string;
  Comment?: string;
  Gray?: string;
  DarkGray?: string;
  GradientColors?: string[];
}

export interface ExtensionInstallMetadata {
  source: string;
  type: 'git' | 'local' | 'link' | 'github-release';
  releaseTag?: string; // Only present for github-release installs.
  ref?: string;
  autoUpdate?: boolean;
  allowPreRelease?: boolean;
}

import {
  DEFAULT_FILE_FILTERING_OPTIONS,
  DEFAULT_MEMORY_FILE_FILTERING_OPTIONS,
  type FileFilteringOptions,
} from './constants.js';
export {
  DEFAULT_CHAT_MODEL_MAX_ATTEMPTS,
  DEFAULT_CHAT_MODEL_MAX_RETRIES,
} from './modelRequestConfig.js';
import { normalizeMaxAttempts } from './modelRequestConfig.js';
import {
  DEFAULT_TOOL_PROTECTION_THRESHOLD,
  DEFAULT_MIN_PRUNABLE_TOKENS_THRESHOLD,
  DEFAULT_PROTECT_LATEST_TURN,
} from '../context/toolOutputMaskingDefaults.js';

import type { LoadedPlugin, PluginError } from '../plugins/types.js';
import { getLoadedPluginId } from '../plugins/management/pluginDependencies.js';
import type { SessionMcpManager } from '../mcp/sessionMcpManager/index.js';
import type { SessionMcpStartupSnapshot } from '../mcp/sessionMcpManager/index.js';
import { McpManager } from '../mcp/mcpManager.js';
import { createDefaultMcpConnectorMap } from '../mcp/connector/defaultConnectorMap.js';
import { registerLazyMcpMetaTools } from '../tools/mcp-lazy/index.js';
import { McpElicitationHost } from '../mcp/elicitation.js';
import { normalizeProxyUrlIfSupported } from '../utils/proxy.js';
import type { EnvironmentSanitizationConfig } from '../services/environmentSanitization.js';
import {
  getErrorMessage,
  FatalAuthenticationError,
  FatalInputError,
} from '../utils/errors.js';
import {
  applyDisallowedTools,
  parseAgentToolExpression,
  AGENT_TOOL_NAME,
  WORKFLOW_TOOL_NAME,
} from '../tools/tool-names.js';
import type { SystemPromptAssembler } from '../prompts/system-prompt-assembler.js';

export type { FileFilteringOptions };
export {
  DEFAULT_FILE_FILTERING_OPTIONS,
  DEFAULT_MEMORY_FILE_FILTERING_OPTIONS,
};

export const DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD = 40_000;
const SETTINGS_WATCH_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

const PERMISSION_SETTING_SCOPE: Record<
  EditableSettingSource,
  'user' | 'project' | 'local'
> = {
  userSettings: 'user',
  projectSettings: 'project',
  localSettings: 'local',
};

/**
 * Default maximum time the non-interactive (`-p`), SDK, and ACP entry points
 * wait for MCP servers to finish their initial `initialize` + `tools/list`
 * handshake before proceeding without them.
 *
 * This is a bounded first-turn window, not the per-server connect deadline
 * ({@link MCP_CONNECT_TIMEOUT_MSEC}, 30s): servers still connecting keep
 * running in the background and are picked up by `applyMcpToolRegistration()`
 * if they succeed late. Keep it well below the connect deadline so a single
 * slow server cannot block the first turn for the full connect timeout.
 *
 * Overridable at runtime via {@link ENV_MCP_INIT_BUDGET_MS}; see
 * {@link getNonInteractiveMcpBudgetMs}.
 *
 * Exported so tests can monkey-patch it via module replacement when they
 * need to exercise budget-exceeded behavior without actually waiting.
 */
export const NON_INTERACTIVE_MCP_BUDGET_MS = 5_000;

/** Upper bound accepted for the startup MCP wait budget (10 minutes). */
const MAX_NON_INTERACTIVE_MCP_BUDGET_MS = 10 * 60 * 1_000;

/**
 * Resolve the MCP initialization wait budget for non-interactive/SDK/ACP
 * startup.
 *
 * Defaults to {@link NON_INTERACTIVE_MCP_BUDGET_MS} and can be overridden via
 * the product-prefixed {@link ENV_MCP_INIT_BUDGET_MS} variable (integer
 * milliseconds). `0` disables the wait entirely; missing, non-integer,
 * negative, hex/scientific, or over-10-minute values fall back to the default
 * with a warning so a misconfiguration cannot silently change startup
 * behavior.
 */
function getNonInteractiveMcpBudgetMs(): number {
  const envValue = process.env[ENV_MCP_INIT_BUDGET_MS]?.trim();
  if (!envValue) return NON_INTERACTIVE_MCP_BUDGET_MS;
  const parsed = /^\d+$/.test(envValue) ? Number(envValue) : Number.NaN;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > MAX_NON_INTERACTIVE_MCP_BUDGET_MS
  ) {
    runLogger.warn(
      `Invalid ${ENV_MCP_INIT_BUDGET_MS}="${envValue}"; ` +
        `expected an integer between 0 and ${MAX_NON_INTERACTIVE_MCP_BUDGET_MS}ms. ` +
        `Falling back to ${NON_INTERACTIVE_MCP_BUDGET_MS}ms.`,
    );
    return NON_INTERACTIVE_MCP_BUDGET_MS;
  }
  return parsed;
}

export type McpInitializationWaitStrategy = 'none' | 'budget' | 'full';

/** What the startup MCP wait did, for `mcp.wait` diagnostics only. */
interface McpStartupWaitResult {
  readonly strategy: McpInitializationWaitStrategy;
  /** 0 unless the strategy is `budget`. */
  readonly budgetMs: number;
  /** Time between kicking off session MCP initialization and this wait starting. */
  readonly elapsedSinceStartMs: number;
  readonly outcome: 'settled' | 'failed' | 'budget_exhausted' | 'skipped';
  readonly before: SessionMcpStartupSnapshot;
  readonly after: SessionMcpStartupSnapshot;
}

const EMPTY_MCP_STARTUP_SNAPSHOT: SessionMcpStartupSnapshot = {
  active: 0,
  pending: 0,
  tools: 0,
};

/**
 * Callbacks for checking MCP server enablement status.
 * These callbacks are provided by the CLI package to bridge
 * the enablement state to the core package.
 */
export interface McpEnablementCallbacks {
  /** Check if a server is disabled for the current session only */
  isSessionDisabled: (serverId: string) => boolean;
  /** Check if a server is enabled in the file-based configuration */
  isFileEnabled: (serverId: string) => Promise<boolean>;
}

export interface DreamSettings {
  enabled?: boolean;
  minHours?: number;
  minSessions?: number;
  scanThrottleMinutes?: number;
}

/**
 * Per-model persisted user preferences. Generation fields are flattened for a
 * hand-editable settings shape; `contextWindow` lives alongside them.
 */
export interface ModelPreferenceEntry extends LlmGenerationConfig {
  contextWindow?: number;
  /**
   * Deprecated settings compatibility only. New settings flatten generation
   * fields directly onto this preference entry.
   * @deprecated Use the flattened generation fields on ModelPreferenceEntry.
   */
  generation?: LlmGenerationConfig;
  /** @deprecated Function switches were removed; kept so old settings stay valid. */
  functionSwitchSelections?: Record<string, string>;
}

/**
 * Reads generation fields from a model preference. New flattened fields win
 * over the deprecated nested `generation` object while missing fields continue
 * to fall back during migration.
 */
export function generationConfigFromModelPreference(
  entry: ModelPreferenceEntry | undefined,
): LlmGenerationConfig | undefined {
  if (!entry) return undefined;
  // Flattened fields win over the deprecated nested `generation`; reasoning is
  // merged independently. This is the same precedence boundary transports use.
  return mergeLlmGenerationConfigs(entry.generation, entry);
}

/**
 * Replaces all generation fields on a preference using the flattened settings
 * representation and removes the deprecated nested wrapper.
 */
export function modelPreferenceWithGeneration(
  entry: ModelPreferenceEntry,
  generation: LlmGenerationConfig | undefined,
): ModelPreferenceEntry {
  const {
    generation: _legacyGeneration,
    temperature: _temperature,
    topP: _topP,
    topK: _topK,
    maxTokens: _maxTokens,
    reasoning: _reasoning,
    ...nonGeneration
  } = entry;
  const normalized = normalizeLlmGenerationConfig(generation);
  return { ...nonGeneration, ...(normalized ?? {}) };
}

export type SessionSettingsScope =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings';

/** Session projection over process-owned Settings file sources. */
export interface SessionSettingsChangeManager {
  watchChanges(callbacks: {
    acceptChange: (
      source: 'user_settings' | 'project_settings' | 'local_settings',
      filePath: string,
    ) => Promise<boolean | { accepted: boolean; refreshSource: boolean }>;
    onChange: (source: SessionSettingsScope) => void;
  }): Promise<() => void>;
}

export interface ConfigParameters {
  sessionId: string;
  sessionPersistence?: boolean;
  transcriptStore?: TranscriptStore;
  /**
   * 每个 Config 在构造期调用一次，必须返回本会话独占的新 provider 实例，
   * 由本会话 ModelProviderManager 启停。可借用 framework 的 Client、resolver
   * 和 transport，但不得返回由 framework 启停的共享 provider 单例。
   * 主模型由 Manager 在选模时通过 context 传递；同时绑定本会话选模准备规则。
   */
  modelProviderFactory?: (
    selection: Pick<
      ModelProviderManager,
      'listModels' | 'setSelectionPreparation' | 'setModelAccessCheck'
    >,
    accessMode?: CustomProviderAccessMode,
  ) => readonly ModelProvider[];
  pluginManagerFactory?: PluginManagerFactory;
  /** 优先借用传入的注册表；未传入时构造支持三种通用协议的注册表。 */
  modelTransportManager?: ModelTransportManager;
  /** 借用 framework 的配置管理器，不负责创建和销毁。 */
  customProviderManager?: CustomProviderManager;
  clientName?: string;
  clientVersion?: string;
  embeddingModel?: string;
  targetDir: string;
  debugMode: boolean;
  question?: string;

  coreTools?: string[];
  mainAgentTools?: string[];
  excludeTools?: string[];
  mcpServerCommand?: string;
  mcpServers?: Record<string, MCPServerConfig>;
  /** Whether settings.json / .mcp.json may contribute MCP servers. */
  mcpSettingsSourcesEnabled?: boolean;
  /** Whether enabled plugins may contribute MCP servers. */
  pluginMcpServersEnabled?: boolean;
  mcpEnablementCallbacks?: McpEnablementCallbacks;
  /**
   * Process-level MCP pool owned by the application framework. Sessions share
   * this instance; embedded/test callers may omit it and get a local pool.
   */
  mcpManager?: McpManager;
  mcpInitializationWaitStrategy?: McpInitializationWaitStrategy;
  /** Optional sink for existing per-session config startup phases. */
  startupPhaseObserver?: StartupPhaseObserver;
  userMemory?: string | HierarchicalMemory;
  memoryMdFileCount?: number;
  memoryMdFilePaths?: string[];
  permissionMode?: PermissionMode;
  /** --permission-mode 原始值；模式决策在 Config 内完成。 */
  permissionModeFlag?: string;
  /** 进程级权限管理器；会话据此派生自己的权限对象，省略则不建权限对象。 */
  permissionManager?: PermissionManager;
  /** `--allowed-tools`：只允许这些工具。 */
  allowedTools?: string[];
  /** `--disallowed-tools`：禁用这些工具。 */
  disallowedTools?: string[];
  contextFileName?: string | string[];
  accessibility?: AccessibilitySettings;
  /** Caller-owned settings instance; Config does not load or copy it. */
  loadedSettings: LoadedSettings;
  /**
   * Reader for top-level settings sections, supplied at Config construction
   * by the CLI. Config forwards calls verbatim; it does not store its own
   * copy of the merged settings and does not re-read files. The reader
   * returns the value loaded at process start; hot reloads are not observed
   * by this channel today, which matches AI Tracking's restart-to-apply
   * semantics. Omit to disable the plugin-agnostic settings read path.
   */
  getSetting?: (section: string) => unknown;
  /**
   * Reader for the complete merged settings snapshot of this session.
   * Config forwards calls verbatim and does not re-read files.
   */
  getSettings?: () => unknown;
  /**
   * Reader for invocation-only settings such as SDK `--settings` overrides.
   * Unlike getSetting, this excludes persisted user/project/local values.
   */
  getLaunchSetting?: (section: string) => unknown;
  usageStatisticsEnabled?: boolean;
  fileFiltering?: {
    respectGitIgnore?: boolean;
    respectBrandIgnore?: boolean;
    enableRecursiveFileSearch?: boolean;
    enableFuzzySearch?: boolean;
    /** @deprecated Recursive @ completion no longer limits its candidate set. */
    maxFileCount?: number;
    searchTimeout?: number;
    customIgnoreFilePaths?: string[];
  };
  fileCheckpointing?: boolean;
  proxy?: string;
  allowedHttpHookUrls?: string[];
  cwd: string;
  fileDiscoveryService?: FileDiscoveryService;
  includeDirectories?: string[];
  model: string;
  /** model 的输入来源；省略时按配置输入处理。 */
  modelSource?: 'cli' | 'config';
  /** UltraCode value resolved from persisted/flag settings at startup. */
  ultracode?: boolean;
  /** Enables the local-TUI `ultracode` keyword trigger. */
  workflowKeywordTriggerEnabled?: boolean;
  /**
   * 启动参数（--reasoning-effort / --thinking / --context-window /
   * --max-output-tokens）归一后的本会话主模型偏好：manager 启动后以
   * session-only 方式写入主模型；显式 undefined 表示清除已存值。
   */
  launchModelConfig?: ModelConfig;
  /** Reasoning effort specified via --reasoning-effort CLI flag. */
  cliReasoningEffort?: string;
  /** Context window specified via --context-window CLI flag. */
  cliContextWindow?: string;
  acpMode?: boolean;
  /** Allows read-only Bash concurrency; each execution host opts in. */
  parallelReadOnlyShell?: boolean;
  /** Emits results as available; otherwise finalizes in submission order. */
  parallelToolStreaming?: boolean;
  canConsumeAsyncRewake?: boolean;
  enableExtensionReloading?: boolean;
  /** Pre-loaded plugins (from PluginLoader or built-in plugin system). */
  plugins?: LoadedPlugin[];
  sessionPlugins?: SessionPluginRuntime;
  allowedMcpServers?: string[];
  blockedMcpServers?: string[];
  allowedEnvironmentVariables?: string[];
  blockedEnvironmentVariables?: string[];
  enableEnvironmentVariableRedaction?: boolean;
  noBrowser?: boolean;
  summarizeToolOutput?: Record<string, SummarizeToolOutputSettings>;
  folderTrust?: boolean;
  loadMemoryFromIncludeDirectories?: boolean;
  importFormat?: 'tree' | 'flat';
  discoveryMaxDirs?: number;
  compressionConfig?: Partial<CompressionConfig>;
  interactive?: boolean;
  trustedFolder?: boolean;
  useBackgroundColor?: boolean;
  useAlternateBuffer?: boolean;
  useTerminalBuffer?: boolean;
  useRenderProcess?: boolean;
  useRipgrep?: boolean;
  shellExecutionConfig?: ShellExecutionConfig;
  extensionManagement?: boolean;
  truncateToolOutputThreshold?: number;
  eventEmitter?: EventEmitter;
  output?: OutputSettings;
  adk?: ADKSettings;
  continueOnFailedApiCall?: boolean;
  retryFetchErrors?: boolean;
  maxAttempts?: number;
  shellToolInactivityTimeout?: number;
  fakeResponses?: string;
  recordResponses?: string;
  rawOutput?: boolean;
  acceptRawOutputRisk?: boolean;
  enableHooks?: boolean;
  enableHooksUI?: boolean;
  contextManagement?: Partial<ContextManagementConfig>;
  hooks?: HookDefinitionsByEvent;
  projectHooks?: HookDefinitionsByEvent;
  localHooks?: HookDefinitionsByEvent;
  userHooks?: HookDefinitionsByEvent;
  flagHooks?: HookDefinitionsByEvent;
  enableAgents?: boolean;
  allowedAgentSources?: AgentSource[];
  settingSources?: string[];
  /** Raw JSON string from --agents CLI flag for inline agent definitions. */
  inlineAgentsJson?: string;
  /** Agent name to use as the main session agent (from --agent or settings). */
  sessionAgent?: string;
  /** Custom system prompt from --system-prompt CLI flag. */
  customSystemPrompt?: string;
  /** Prompt text appended to the effective system prompt from --append-system-prompt CLI flag. */
  appendSystemPrompt?: string;
  /**
   * Pre-resolved output style for embedders that construct Config directly.
   * Takes precedence over outputStyleName and skips startup resolution.
   */
  outputStyle?: ResolvedOutputStyle;
  /** Requested output style, resolved after workspace resources initialize. */
  outputStyleName?: string;
  /** Preferred response language (pre-trimmed). */
  language?: string;
  enableEventDrivenScheduler?: boolean;
  skillsSupport?: boolean;
  loadSkillsFromAgentsDirectory?: boolean;
  disabledSkills?: string[];
  adminSkillsEnabled?: boolean;
  /**
   * When true, skip the built-in/bundled skills shipped with the CLI binary
   * (both the `packages/core/src/skills/builtin/*.md` filesystem entries and
   * the programmatic bundled skills registered by `initBundledSkills()`).
   * User, project, and plugin skill discovery is unaffected — use
   * `adminSkillsEnabled: false` to disable everything.
   */
  disableBuiltinSkills?: boolean;
  /**
   * When provided, load only these built-in/bundled skill names. This explicit
   * allowlist takes precedence over `disableBuiltinSkills`, allowing SDK
   * callers to restore a deterministic subset while retaining their default
   * `--disable-builtin-skills` launch policy.
   */
  enableBuiltinSkills?: string[];
  disableSkillShellExecution?: boolean;
  skillVisibilityOverrides?: Record<
    string,
    'on' | 'name-only' | 'user-invocable-only' | 'off'
  >;
  skillListingMaxDescChars?: number;
  skillListingBudgetFraction?: number;
  autoDistillation?: boolean;
  autoMemoryEnabled?: boolean;
  autoMemoryUserScopeEnabled?: boolean;
  dream?: DreamSettings;
  worktree?: WorktreeCreationSettings;
  memoryBoundaryMarkers?: string[];
  agentsMdExcludes?: string[];
  topicUpdateNarration?: boolean;

  disableLLMCorrection?: boolean;
  plan?: boolean;
  planSettings?: PlanSettings;
  worktreeSettings?: WorktreeSettings;
  modelSteering?: boolean;
  onModelChange?: (model: string) => boolean | void;
  mcpEnabled?: boolean;
  /**
   * When true, enable the lazy MCP loading scheme — three meta tools
   * (mcp_list / mcp_get / mcp_call) instead of N individual tool schemas.
   * Engages whenever there's at least one connected MCP server; falls back
   * to eager registration when no MCP servers are active or when this
   * setting is false. Defaults to false (opt-in via settings.mcp.lazyLoad
   * or the MCP lazy-load environment variable set to 1). Enabled CodeMode `only` mode uses deferred
   * registration instead. See packages/core/src/tools/mcp-lazy/.
   */
  mcpLazyLoad?: boolean;
  /**
   * Where the initial MCP lazy-load value came from. Only the built-in
   * default follows the process-scoped default; explicit user or environment
   * choices must remain authoritative.
   */
  mcpLazyLoadSource?: 'default' | 'settings' | 'environment';
  extensionsEnabled?: boolean;
  agents?: AgentSettings;
  onReload?: () => Promise<{
    disabledSkills?: string[];
    adminSkillsEnabled?: boolean;
    agents?: AgentSettings;
    hooks?: HookDefinitionsByEvent;
    projectHooks?: HookDefinitionsByEvent;
    localHooks?: HookDefinitionsByEvent;
    userHooks?: HookDefinitionsByEvent;
    flagHooks?: HookDefinitionsByEvent;
  }>;
  /** Legacy cache invalidation before explicit hook reloads. */
  onSettingsCacheInvalidate?: () => void;
  /** Explicit hook reloads re-read this session's persisted Settings scopes. */
  onManualSettingsReload?: () => void;
  /** Called when the settings watcher accepts an external file change. */
  onExternalSettingsChange?: () => void | Promise<void>;
  /** Session-owned projection; SettingsService owns file reads and watches. */
  sessionSettingsManager?: SessionSettingsChangeManager;
  /** Raw local settings.providers value, parsed when this runtime supports local providers. */
  customProviderSettings?: unknown;
  /** Runtime shape; any product-specific access rules come from providers. */
  customProviderAccessMode?: CustomProviderAccessMode;
  /** Callback to check if external @import references have been approved. */
  isExternalImportApproved?: () => boolean;
  /**
   * 应用共享的文件资源服务，由 Framework / 嵌入宿主创建和关闭。
   * 独立构造未注入时使用私有实例；Config 的设置、权限和运行状态仍属于会话。
   */
  resourceService?: ResourceService;
  /** Shared across project replacements; the application owns disposal. */
  settingsService?: SettingsService;
  /** 应用拥有 Registry，Config 只读贡献、订阅变化。 */
  builtinPlugins?: BuiltinPluginContributions;
  builtinPluginsInitialization?: Promise<unknown>;
}

function normalizeContextWindow(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/** 区分「显式给出 undefined（清除）」与「未给出」。 */
function hasOwnField<T extends object>(
  value: T | undefined,
  key: keyof T,
): boolean {
  return value !== undefined && Object.hasOwn(value, key);
}

function isContextWindowConfigEnabled(): boolean {
  return isContextWindowSelectionEnabled();
}

/**
 * 旧版输入里的 `plan` 是会话级工作状态请求（由 PlanStateManager 承接），不是
 * 权限模式：权限模式的起点是 default，也不该被当成非法值告警。
 */
function permissionModeWithoutPlanRequest(
  raw: string | undefined,
): string | undefined {
  if (!raw) return raw;
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '') === 'plan'
    ? 'default'
    : raw;
}

type SkillResourceProjection = {
  skills: readonly SkillDefinition[];
  loadErrors: readonly SkillLoadError[];
};

/** A session's merged read surface over process and workspace resources. */
class SessionResourceViews {
  readonly skills: SkillResourceView;
  readonly agents: AgentResourceView;
  readonly outputStyles: OutputStyleResourceView;
  private readonly skillsReady: Promise<void>;
  private readonly skillsWatcherReady: Promise<void>;
  private readonly observedReadiness = new Set<string>();

  constructor(
    readonly user: UserResource,
    readonly project: ResourceHandle,
    loadFromAgentsDirectory: boolean,
    includeUserSkillErrors: boolean,
    private readonly diagnostics: StartupDiagnostics,
  ) {
    const projectSkills = project.project.skills;
    const userSkills = user.getSkills({ loadFromAgentsDirectory });
    this.skillsReady = userSkills.ready;
    this.skillsWatcherReady = userSkills.watcherReady;
    this.skills = {
      getAllDiscoveredSkills: () => [
        ...projectSkills.getAllDiscoveredSkills(),
        ...userSkills.getAllDiscoveredSkills(),
      ],
      getLoadErrors: () => [
        ...projectSkills.getLoadErrors(),
        ...(includeUserSkillErrors ? userSkills.getLoadErrors() : []),
      ],
      onDidChange: (listener) => {
        const stopUser = userSkills.onDidChange((events, snapshot) =>
          listener(events, {
            discoveredSkills: [
              ...projectSkills.getAllDiscoveredSkills(),
              ...snapshot.discoveredSkills,
            ],
            loadErrors: [
              ...projectSkills.getLoadErrors(),
              ...(includeUserSkillErrors ? snapshot.loadErrors : []),
            ],
          }),
        );
        const stopProject = projectSkills.onDidChange((events, snapshot) =>
          listener(events, {
            discoveredSkills: [
              ...snapshot.discoveredSkills,
              ...userSkills.getAllDiscoveredSkills(),
            ],
            loadErrors: [
              ...snapshot.loadErrors,
              ...(includeUserSkillErrors ? userSkills.getLoadErrors() : []),
            ],
          }),
        );
        return () => {
          stopUser();
          stopProject();
        };
      },
    };
    this.agents = {
      getAllDiscoveredAgents: () => [
        ...user.agents.getAllDiscoveredAgents(),
        ...project.project.agents.getAllDiscoveredAgents(),
      ],
      getLoadErrors: () => [
        ...user.agents.getLoadErrors(),
        ...project.project.agents.getLoadErrors(),
      ],
    };
    this.outputStyles = {
      getAllDiscoveredOutputStyles: () => [
        ...user.outputStyles.getAllDiscoveredOutputStyles(),
        ...project.project.outputStyles.getAllDiscoveredOutputStyles(),
      ],
      getLoadErrors: () => [
        ...user.outputStyles.getLoadErrors(),
        ...project.project.outputStyles.getLoadErrors(),
      ],
    };
  }

  isForContext(options: ProjectResourceOptions): boolean {
    return this.project.isForContext(options);
  }

  get ready(): Promise<void> {
    return Promise.all([
      this.observeReady('resources.snapshot.user_wait', this.user.ready),
      this.observeReady(
        'resources.snapshot.user_skills_wait',
        this.skillsReady,
      ),
      this.observeReady('resources.snapshot.project_wait', this.project.ready),
    ]).then(() => undefined);
  }

  get watcherReady(): Promise<void> {
    return this.ready.then(() =>
      Promise.all([
        this.observeReady(
          'resources.background.user_watcher_wait',
          this.user.watcherReady,
        ),
        this.observeReady(
          'resources.background.skills_watcher_wait',
          this.skillsWatcherReady,
        ),
        this.observeReady(
          'resources.background.project_watcher_wait',
          this.project.watcherReady,
        ),
      ]).then(() => undefined),
    );
  }

  private observeReady(name: string, promise: Promise<void>): Promise<void> {
    // Observe the existing dependency only once; never start a load or turn a
    // background watcher into a snapshot readiness gate.
    if (!this.observedReadiness.has(name)) {
      this.observedReadiness.add(name);
      this.diagnostics.phase(name, () => promise);
    }
    return promise;
  }

  release(): Promise<void> {
    return this.project.release();
  }
}

export class Config implements AgentLoopContext {
  private builtinPluginsEnabled = false;
  private builtinPluginsDisposed = false;
  private readonly builtinPlugins?: BuiltinPluginContributions;
  private readonly builtinPluginsInitialization?: Promise<unknown>;
  private unsubscribeBuiltinPlugins?: () => void;
  private builtinRefreshPending = false;
  private builtinRefresh: Promise<void> = Promise.resolve();
  private readonly builtinToolNames = new Set<string>();

  enableBuiltinPluginsForTui(): void {
    this.enableBuiltinPlugins();
  }

  private enableBuiltinPlugins(): void {
    if (this.initialized || this.initPromise || this.interactiveInitPromise) {
      throw new Error(
        'Builtin plugins must be enabled before Config initialization',
      );
    }
    this.builtinPluginsEnabled = true;
    if (!this.hookSystem) {
      this.initializeHookSystemSync();
    }
  }

  /** Explicit CLI opt-in for SDK, ACP and other non-interactive configurations. */
  enableBuiltinPluginsForHeadless(): void {
    this.enableBuiltinPlugins();
  }

  readonly fileReadState = createToolFileStateCache();
  private _toolRegistry!: ToolRegistry;
  // Keep rollout stable for this session's registered tools and MCP exposure.
  private codeModeFeatureConfig?: CodeModeFeatureConfig;
  private mcpClientManager?: SessionMcpManager;
  private registeredMcpTools = new Map<string, Set<string>>();
  private readonly mcpManager?: McpManager;
  private resolvedMcpManager?: McpManager;
  private proxyRequestIgnored = false;
  private elicitationHost?: McpElicitationHost;
  private allowedMcpServers: string[];
  private blockedMcpServers: string[];
  private allowedEnvironmentVariables: string[];
  private blockedEnvironmentVariables: string[];
  private readonly enableEnvironmentVariableRedaction: boolean;
  private agentRegistry!: AgentRegistry;
  private skillManager!: SkillManager;
  private goalManager?: GoalManager;
  private outputStyleResourceInitialization: Promise<void> | undefined;
  private outputStyleResourceWorkingDir: string | undefined;
  private sessionOutputStyles: OutputStyleConfig[] | undefined;
  private get resourceProject(): ProjectResource | null {
    return this.resourceViews?.project.project ?? null;
  }
  // The last resource snapshot accepted by this session's ConfigChange hook.
  private skillResourceSnapshot: SkillResourceProjection | undefined;
  private skillResourceChangeId = 0;
  private appliedSkillResourceChangeId = 0;
  private resourceViews: SessionResourceViews | undefined;
  private skillResourceUnsubscribes: Array<() => void> = [];
  private initialSkillsInitializationPromise?: Promise<void>;
  private reloadHooksInFlight: Promise<void> | null = null;
  private reloadHooksPendingAfter = false;
  private reloadSkillsInFlight: Promise<void> | null = null;
  private reloadSkillsPendingAfter = false;
  private reloadAgentsInFlight: Promise<void> | null = null;
  private reloadAgentsPendingAfter = false;
  private _sessionId: string;
  private readonly sessionPersistence: boolean;
  private readonly clientName: string | undefined;
  private clientVersion: string;
  private fileSystemService: FileSystemService;
  private taskStore?: TaskStore;
  readonly topicState = new TopicState(() => this.getSessionId());
  private contentGeneratorConfig!: ContentGeneratorConfig;
  private readonly embeddingModel: string;
  private targetDir: string;
  private workspaceContext: WorkspaceContext;
  private readonly debugMode: boolean;
  private readonly question: string | undefined;
  private worktreeSettings: WorktreeSettings | undefined;

  private readonly coreTools: string[] | undefined;
  private readonly mainAgentTools: string[] | undefined;
  private readonly excludeTools: string[] | undefined;
  private readonly mcpServerCommand: string | undefined;
  private readonly mcpEnabled: boolean;
  private readonly mcpSettingsSourcesEnabled: boolean;
  private readonly pluginMcpServersEnabled: boolean;
  private mcpLazyLoad: boolean;
  private readonly mcpLazyLoadSource: 'default' | 'settings' | 'environment';
  private diskMcpServers: Record<string, MCPServerConfig> | undefined;
  private dynamicMcpServers: Record<string, MCPServerConfig> = {};
  private readonly mcpEnablementCallbacks?: McpEnablementCallbacks;
  private userMemory: string | HierarchicalMemory;
  private memoryMdFileCount: number;
  private memoryMdFilePaths: string[];
  /**
   * The context filenames this session reads memory from, normalized once at
   * construction and never mutated afterwards.
   *
   * Per-Config rather than module-level: which file counts as the project's
   * context file is a property of a session's settings, not of the process. Two
   * sessions in one process may legitimately disagree — one project configures
   * `CUSTOM.md`, another keeps the default — and a shared variable forces the
   * second construction to silently rewrite the first session's memory layout.
   */
  private readonly contextFilenames: string[];
  private readonly accessibility: AccessibilitySettings;
  private readonly loadedSettings: LoadedSettings;
  private readonly settingsReader: (section: string) => unknown;
  private readonly allSettingsReader: () => unknown;
  private readonly launchSettingsReader: (section: string) => unknown;
  private readonly usageStatisticsEnabled: boolean;
  private sessionRuntimeBinding?: SessionRuntimeBinding;
  private readonly modelAvailabilityService: ModelAvailabilityService;
  private readonly fileFiltering: {
    respectGitIgnore: boolean;
    respectBrandIgnore: boolean;
    enableRecursiveFileSearch: boolean;
    enableFuzzySearch: boolean;
    maxFileCount: number;
    searchTimeout: number;
    customIgnoreFilePaths: string[];
  };
  private fileDiscoveryService: FileDiscoveryService | null = null;
  private readonly fileCheckpointing: boolean;
  private fileHistoryManager?: FileHistoryManager;
  private readonly transcriptStore: TranscriptStore;
  private proxy: string | undefined;
  private readonly allowedHttpHookUrls: string[] | undefined;
  private cwd: string;
  private customProviderSettings: unknown;
  private readonly customProviderAccessMode: CustomProviderAccessMode;
  private readonly customProviderAccess: CustomProviderAccess;
  /**
   * `AgentsRefreshed` 的退订句柄。它是会话级事件（payload 带 sessionId，发射侧
   * agentRegistry 打的是自己 Config 的 sessionId），因此订阅必须走 onSessionEvent，
   * 由它返回退订函数，而不是自己配 on/off 对（见 events.ts 的 onSessionEvent 文档：
   * 手写 payload.sessionId 比对会漏、会写错，且无法被门禁检查）。
   */
  private agentsRefreshedUnsubscribe: (() => void) | undefined;
  private customProvidersInitialized = false;
  private customProvidersDisposed = false;
  private readonly customProviderRegistry = new CustomProviderRegistry();
  private customProvidersState: CustomProvidersState = {
    status: 'not_configured',
  };
  /** 启动期 UltraCode；主模型已存显式 effort 时在启动参数落地阶段关闭。 */
  private baseUltracode: boolean;
  private ultracodeOverride: boolean | undefined;
  private readonly workflowKeywordTriggerEnabled: boolean;
  /** 启动参数归一的主模型偏好，manager 启动后写入一次。 */
  private readonly launchModelConfig: ModelConfig | undefined;
  private launchModelConfigApplied = false;
  /** Last disk values applied to this runtime, independent of settings watchers. */
  private lastAppliedSavedModel: string | undefined;
  /** 模型输入只存一份，是否已应用由 modelSelectionRevision 判断。 */
  private readonly modelInput: Readonly<{
    value: string;
    source: 'cli' | 'config';
  }>;
  private readonly cliReasoningEffort: string | undefined;
  private readonly cliContextWindow: string | undefined;

  /** Unified task registry for tracking background shell + agent tasks. Set by CLI layer. */
  taskRegistry?: TaskRegistry;
  // null = unknown (quota not fetched); true = has access; false = definitively no access
  private hasAccessToPreviewModel: boolean | null = null;
  private readonly noBrowser: boolean;
  private readonly folderTrust: boolean;

  private _activeModel: string;
  private readonly enableExtensionReloading: boolean;
  /** Loaded plugins from the plugin system (replacing extensions). */
  private _plugins: LoadedPlugin[];
  /** Errors from the local disk/plugin loading pass. */
  private _pluginErrors: PluginError[] = [];
  /** Late errors from the managed plugin download/update sync. */
  private _pluginSyncErrors: PluginError[] = [];
  fallbackModelHandler?: FallbackModelHandler;
  /** Reload plugins from disk for this session.
   *
   * Returns the freshly-loaded enabled plugins plus any errors encountered
   * (broken manifests, missing manifest-declared paths, etc.). The CLI layer
   * surfaces `errors.length` as `error_count` in the `reload_plugins`
   * control response so SDK hosts can detect a partial reload.
   */
  reloadPlugins?: () => Promise<{
    enabled: LoadedPlugin[];
    errors: PluginError[];
  }>;
  /** Injected by CLI layer to validate settings file content before write/edit. */
  private settingsContentValidator?: (
    filePath: string,
    content: string,
  ) => string | null;
  private quotaErrorOccurred: boolean = false;
  private _promptAssembler?: SystemPromptAssembler;
  private modelQuotas: Map<
    string,
    { remaining: number; limit: number; resetTime?: string }
  > = new Map();
  private readonly summarizeToolOutput:
    | Record<string, SummarizeToolOutputSettings>
    | undefined;
  private readonly acpMode: boolean = false;
  private shellCapabilities?: Promise<ShellCapabilitySnapshot>;
  private shellCapabilitySnapshot?: ShellCapabilitySnapshot;
  private powerShellRuntime: Awaited<ReturnType<typeof getPowerShellRuntime>> =
    null;
  private readonly parallelReadOnlyShell: boolean;
  private readonly parallelToolStreaming: boolean;
  private readonly canConsumeAsyncRewake: boolean = false;
  private readonly loadMemoryFromIncludeDirectories: boolean = false;
  private readonly importFormat: 'tree' | 'flat';
  private readonly discoveryMaxDirs: number;
  private readonly compressionConfig: CompressionConfig;
  /** Public for testing only */
  readonly interactive: boolean;
  private hideInteractiveTools = false;
  private trustedFolder: boolean | undefined;
  private readonly useRipgrep: boolean;
  private readonly useBackgroundColor: boolean;
  private readonly useAlternateBuffer: boolean;
  private readonly useTerminalBuffer: boolean;
  private readonly useRenderProcess: boolean;
  private shellExecutionConfig: ShellExecutionConfig;
  private readonly truncateToolOutputThreshold: number;
  private compressionTruncationCounter = 0;
  private initialized = false;
  private initPromise: Promise<void> | undefined;
  private interactiveInitPromise: Promise<void> | undefined;
  private hydrationPromise: Promise<void> | undefined;
  private readonly agentTeamSessionInitializations = new Map<
    string,
    Promise<string>
  >();
  private readonly ownedAgentTeamNames = new Set<string>();
  private agentTeamSessionsDisposed = false;
  private mcpInitializationPromise: Promise<StartupDegradation[]> | null = null;
  private mcpInitializationStartedAt: number | undefined;
  private readonly mcpInitializationWaitStrategy: McpInitializationWaitStrategy;
  private fakeResponseStorePromise: Promise<FakeResponseStore> | undefined;
  readonly storage: Storage;
  private readonly fileExclusions: FileExclusions;
  private readonly eventEmitter?: EventEmitter;
  private readonly _toolCallSnapshots: ToolCallSnapshotStore;
  private _toolExecutor: ToolExecutor | undefined;
  private readonly outputSettings: OutputSettings;

  private readonly agentSessionNoninteractiveEnabled: boolean;

  private readonly continueOnFailedApiCall: boolean;
  private readonly retryFetchErrors: boolean;
  private readonly maxAttempts: number;
  private readonly shellToolInactivityTimeout: number;
  readonly fakeResponses?: string;
  readonly recordResponses?: string;
  private readonly disableYoloMode: boolean;
  private autoModeWorkspaceWarningIssued = false;
  private permissionAskHandler?: Parameters<
    SessionPermissionAPI['setAskHandler']
  >[0];
  private readonly rawOutput: boolean;
  private readonly acceptRawOutputRisk: boolean;
  private pendingIncludeDirectories: string[];
  private readonly enableHooks: boolean;

  private hooks: HookDefinitionsByEvent | undefined;
  private projectHooks:
    | (HookDefinitionsByEvent & { disabled?: string[] })
    | undefined;
  private localHooks: HookDefinitionsByEvent | undefined;
  private userHooks: HookDefinitionsByEvent | undefined;
  private flagHooks: HookDefinitionsByEvent | undefined;
  private _allHooksDisabled: boolean;
  private releaseCwdChangedCallback?: () => void;
  private hookSystem?: HookSystem;
  private readonly onModelChange:
    | ((model: string) => boolean | void)
    | undefined;
  private readonly onReload:
    | (() => Promise<{
        disabledSkills?: string[];
        adminSkillsEnabled?: boolean;
        agents?: AgentSettings;
        hooks?: HookDefinitionsByEvent;
        projectHooks?: HookDefinitionsByEvent;
        localHooks?: HookDefinitionsByEvent;
        userHooks?: HookDefinitionsByEvent;
        flagHooks?: HookDefinitionsByEvent;
      }>)
    | undefined;

  private readonly onSettingsCacheInvalidate: (() => void) | undefined;
  private readonly onManualSettingsReload: (() => void) | undefined;
  private readonly onExternalSettingsChange:
    | (() => void | Promise<void>)
    | undefined;

  private readonly enableAgents: boolean;
  private readonly allowedAgentSources: AgentSource[] | undefined;
  private readonly settingSources: string[] | undefined;
  private readonly inlineAgentsJson: string | undefined;
  private readonly sessionAgent: string | undefined;
  private readonly customSystemPrompt: string | undefined;
  private readonly appendSystemPrompt: string | undefined;
  private outputStyleManager!: OutputStyleManager;
  private initialResourceProjectConfigDir: string | undefined;
  private readonly language: string | undefined;
  /**
   * When `--agent <name>` or settings.agent is set, this holds the resolved
   * definition so that the system prompt, model, and tool configuration can
   * be applied to the main session.
   */
  private sessionAgentDefinition: AgentDefinition | undefined;
  private sessionAgentApplication: Promise<void> | undefined;
  private agents: AgentSettings;
  private readonly enableEventDrivenScheduler: boolean;
  private readonly skillsSupport: boolean;
  /** The current workspace's effective setting for both compatibility sources. */
  private readonly loadSkillsFromAgentsDirectory: boolean;
  private disabledSkills: string[];
  private readonly adminSkillsEnabled: boolean;
  private readonly disableBuiltinSkills: boolean;
  private readonly enableBuiltinSkills: string[] | undefined;
  private readonly disableSkillShellExecution: boolean;
  private skillVisibilityOverrides: Record<
    string,
    'on' | 'name-only' | 'user-invocable-only' | 'off'
  >;
  private readonly skillListingMaxDescChars?: number;
  private readonly skillListingBudgetFraction?: number;
  private readonly startupRuntime = createConfigStartupRuntime();
  private readonly startupPhaseObserver?: StartupPhaseObserver;
  private readonly skillChangeListeners = new Set<() => void>();
  private readonly deliveredSkillChangeVersions = new Map<() => void, number>();
  private skillChangeVersion = 0;
  private skillChangeDispatchQueued = false;
  private readonly sessionSettingsManager?: SessionSettingsChangeManager;
  private settingsUnwatch?: () => void;
  private settingsWatchStarted = false;
  private settingsWatchDisposed = false;
  private settingsWatchRetryTimer?: ReturnType<typeof setTimeout>;
  private settingsWatchRetryAttempt = 0;
  private reloadHooksNeedsManualSettingsRefresh = false;
  private readonly autoMemoryEnabled: boolean | undefined;
  private readonly autoMemoryUserScopeEnabled: boolean | undefined;
  private readonly dreamSettings: DreamSettings;
  private readonly worktreeCreationSettings: WorktreeCreationSettings;
  private readonly memoryBoundaryMarkers: readonly string[];
  private readonly agentsMdExcludes: readonly string[];
  private readonly topicUpdateNarration: boolean;
  private readonly planEnabled: boolean;
  private readonly tasksEnabled: boolean;
  private readonly modelSteering: boolean;
  private memoryContextManager?: MemoryContextManager;
  private sdkMemoryRequestActive = false;
  private sdkMemoryGenerationEnabled = false;
  private sdkMemoryConsumptionEnabled = false;
  private sdkMemoryProjectScopeEnabled: boolean | undefined;
  private sdkMemoryUserScopeEnabled: boolean | undefined;
  private sdkMemorySuppressNativeAutoMemory = false;
  private sdkSkillEvolutionRequestActive = false;
  private sdkMemoryContext?: Record<string, string>;
  private sdkMemoryFileStates: ReadonlyArray<{
    filePath: string;
    content: string;
    timestamp: number;
    isPartialView?: boolean;
    retainIfMissing?: boolean;
  }> = [];
  private readonly isExternalImportApproved?: () => boolean;
  private readonly contextManagement: ContextManagementConfig;
  private terminalBackground: string | undefined = undefined;
  private permissionMode: PermissionMode;
  /** 信任降级前用户请求的模式；目录受信任后恢复。 */
  private readonly requestedPermissionMode: PermissionMode;
  private readonly permissionManager?: PermissionManager;
  private readonly allowedTools: string[] | undefined;
  private readonly disallowedTools: string[] | undefined;
  private sessionPermissionManager?: import('../permissions/manager/session-permission-manager.js').SessionPermissionManager;
  /** Debounce timer for heavy side-effects after mode switch. */
  private _modeSwitchSideEffectTimer: ReturnType<typeof setTimeout> | null =
    null;
  readonly injectionService: InjectionService;
  private approvedPlanPath: string | undefined;
  /** Pre-approved Bash prompt categories from exit_plan_mode.allowedPrompts. */
  private _preApprovedPrompts: Array<{ tool: 'Bash'; prompt: string }> = [];
  /** Session-scoped plan mode lifecycle state manager. */
  readonly planStateManager: PlanStateManager;
  /**
   * 本会话的 cron 调度器、一次性唤醒定时器与非持久任务存储。
   *
   * 挂在 Config 上而不是模块级：一个进程可以并发跑多个会话，模块级的
   * `scheduler` / `wakeup*` / `sessionTasks` 会让第二个会话复用第一个会话的
   * 调度器、覆盖它的定时器、看到并删掉它的会话级任务。详见
   * `cron/cronManager.ts` 的文件头。
   */
  private readonly cronManager: CronManager;
  /** 会话装配的执行扩展；工厂延迟取得管理器，每轮单独保存领取记录。 */
  readonly turnHookFactories: readonly TurnHookModuleFactory[] = Object.freeze([
    () => new CronTurn(() => this.getCronManager()).turnHookModule,
  ]);
  /**
   * Per-session permission bookkeeping: the check sequence that tells a recheck
   * from the original check, and the ask-settlement facts the presenter records
   * and the gate consumes.
   *
   * One per session, like the permission-owned AutoClassifier. These used to be
   * module-level maps keyed by `sessionId\u241f toolCallId`; a process serving
   * several sessions then shared one eviction cap, so a busy session could drop
   * another's entry, and a tool call id collision across sessions would let one
   * read or consume the other's recorded answer.
   */
  readonly permissionTelemetry: PermissionTelemetry;

  /** 借用应用的文件资源，不接管其生命周期。 */
  readonly resourceService: ResourceService;
  private readonly settingsService: SettingsService;
  /**
   * 会话级 provider 组合面；构造期建立，本会话内不变，随 Config 释放时停掉。
   */
  private readonly modelProviderManager: ModelProviderManager;
  /** 会话级 provider 工厂（入参原样持有）：供重建链为新会话再建一组实例。 */
  private readonly modelProviderFactory?: ConfigParameters['modelProviderFactory'];
  /** 借用 framework 的 provider；项目级 provider 只进 manager，不在此列。 */
  private readonly modelProviders: readonly ModelProvider[];
  private readonly pluginManagerFactory?: PluginManagerFactory;
  private readonly modelTransportManager: ModelTransportManager;
  private readonly customProviderManager?: CustomProviderManager;
  /**
   * 会话级状态；Config 平替的「会话」一半。在 Config 构造过程中创建，随会话释放。
   * 会话级对象逐步从 Config 迁移到此。
   */
  readonly sessionState: SessionState;

  constructor(params: ConfigParameters) {
    this._sessionId = params.sessionId;
    // 会话共享文件来源，但有效设置和运行状态保持独立。
    this.resourceService = params.resourceService ?? new ResourceService();
    this.settingsService = params.settingsService ?? new SettingsService();
    this.modelTransportManager =
      params.modelTransportManager ??
      new ModelTransportManager([
        new ChatCompletionsTransport(),
        new MessagesTransport(),
        new ResponsesTransport(),
        new GeminiTransport(),
      ]);
    this.modelProviderFactory = params.modelProviderFactory;
    let selectionPreparation: PrepareModelSelection | undefined;
    let modelAccessCheck: Parameters<
      ModelProviderManager['setModelAccessCheck']
    >[0];
    this.modelProviders = withModelRequestRetryConfig(
      this,
      () =>
        params.modelProviderFactory?.(
          {
            listModels: (options) =>
              this.modelProviderManager.listModels(options),
            setSelectionPreparation: (prepare) => {
              selectionPreparation = prepare;
            },
            setModelAccessCheck: (check) => {
              modelAccessCheck = check;
            },
          },
          params.customProviderAccessMode ?? 'local',
        ) ?? [],
    );
    this.pluginManagerFactory = params.pluginManagerFactory;
    this.modelProviderManager = new ModelProviderManager({
      readAgentSelectionDefaults: (request, purpose) =>
        readAgentSelectionDefaults(this, request, purpose),
      createSelectionRequestGuard: (signal) =>
        createModelRequestGuard(this, signal),
      userProviders: this.modelProviders,
      modelTransportManager: this.modelTransportManager,
      projectPath: params.cwd,
      settingsService: this.settingsService,
      onModelConfigChange: (model, next, previous) =>
        this.emitModelConfigChanges(model.key, next, previous),
    });
    this.modelProviderManager.setSelectionPreparation(selectionPreparation);
    this.modelProviderManager.setModelAccessCheck(modelAccessCheck);
    this.customProviderManager = params.customProviderManager;
    this.builtinPlugins = params.builtinPlugins;
    this.builtinPluginsInitialization = params.builtinPluginsInitialization;
    this.builtinPluginsEnabled = params.builtinPlugins !== undefined;
    // 会话级状态在 Config 构造过程中创建：一个 Config 对应一个 SessionState。
    this.sessionState = createSessionState({ sessionId: this._sessionId });
    this.sessionPersistence = params.sessionPersistence ?? true;
    this.transcriptStore = params.transcriptStore ?? new TranscriptStore();
    this.clientName = params.clientName;
    this.clientVersion = params.clientVersion ?? 'unknown';
    this.approvedPlanPath = undefined;
    this.planStateManager = new PlanStateManager();
    this.cronManager = new CronManager({
      // 每次读都走 getSessionId()，/resume、/clear、fork 之后归属门禁自动跟着换，
      // 不需要重启调度器，也不需要外部再注册一个 sessionId provider。
      getSessionId: () => this.getSessionId(),
    });
    this.permissionTelemetry = new PermissionTelemetry();
    this.embeddingModel = params.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;

    this.targetDir = path.resolve(params.targetDir);
    this.folderTrust = params.folderTrust ?? false;
    this.workspaceContext = new WorkspaceContext(this.targetDir, []);
    this.pendingIncludeDirectories = params.includeDirectories ?? [];
    this.debugMode = params.debugMode;
    this.question = params.question;
    this.worktreeSettings = params.worktreeSettings;

    // Assigned before anything that can read it: FileExclusions and the memory
    // context manager both reach these names through `this`.
    this.contextFilenames = normalizeContextFilenames(params.contextFileName);

    this.disableYoloMode =
      params.loadedSettings.merged.security?.disableYoloMode === true;
    const startupMode = resolveStartupPermissionMode({
      // plan 不是权限模式：旧版的 plan 请求由会话侧路由到 PlanStateManager，
      // 权限模式的起点是 default，也不该被当成非法值告警。
      flagMode: permissionModeWithoutPlanRequest(params.permissionModeFlag),
      settingsMode: permissionModeWithoutPlanRequest(
        String(
          params.loadedSettings.merged.general?.defaultPermissionMode ?? '',
        ) || undefined,
      ),
      explicitMode: params.permissionMode,
      trustedFolder: params.folderTrust
        ? (params.trustedFolder ?? false)
        : true,
      disableYoloMode: this.disableYoloMode,
    });
    this.permissionMode = startupMode.mode;
    this.requestedPermissionMode = startupMode.requestedMode;
    this.permissionManager = params.permissionManager;
    this.allowedTools = params.allowedTools;
    this.disallowedTools = params.disallowedTools;

    this.fileSystemService = new StandardFileSystemService();

    this.coreTools = params.coreTools;
    this.mainAgentTools = params.mainAgentTools;
    this.excludeTools = params.excludeTools;
    this.mcpServerCommand = params.mcpServerCommand;
    this.diskMcpServers = params.mcpServers;
    this.mcpEnablementCallbacks = params.mcpEnablementCallbacks;
    this.mcpManager = params.mcpManager;
    this.mcpEnabled = params.mcpEnabled ?? true;
    this.mcpSettingsSourcesEnabled = params.mcpSettingsSourcesEnabled ?? true;
    this.pluginMcpServersEnabled = params.pluginMcpServersEnabled ?? true;
    this.mcpLazyLoad = params.mcpLazyLoad ?? true;
    this.mcpLazyLoadSource = params.mcpLazyLoadSource ?? 'default';
    this.allowedMcpServers = params.allowedMcpServers ?? [];
    this.blockedMcpServers = params.blockedMcpServers ?? [];
    this.allowedEnvironmentVariables = params.allowedEnvironmentVariables ?? [];
    this.blockedEnvironmentVariables = params.blockedEnvironmentVariables ?? [];
    this.enableEnvironmentVariableRedaction =
      params.enableEnvironmentVariableRedaction ?? false;
    this.userMemory = params.userMemory ?? '';
    this.memoryMdFileCount = params.memoryMdFileCount ?? 0;
    this.memoryMdFilePaths = params.memoryMdFilePaths ?? [];
    this.accessibility = params.accessibility ?? {};
    this.loadedSettings = params.loadedSettings;
    this.lastAppliedSavedModel = this.loadedSettings.merged.model?.name;
    this.settingsReader = params.getSetting ?? (() => undefined);
    this.allSettingsReader = params.getSettings ?? (() => undefined);
    this.launchSettingsReader = params.getLaunchSetting ?? (() => undefined);
    this.usageStatisticsEnabled = params.usageStatisticsEnabled ?? true;

    this.fileFiltering = {
      respectGitIgnore:
        params.fileFiltering?.respectGitIgnore ??
        DEFAULT_FILE_FILTERING_OPTIONS.respectGitIgnore,
      respectBrandIgnore:
        params.fileFiltering?.respectBrandIgnore ??
        DEFAULT_FILE_FILTERING_OPTIONS.respectBrandIgnore,
      enableRecursiveFileSearch:
        params.fileFiltering?.enableRecursiveFileSearch ?? true,
      enableFuzzySearch: params.fileFiltering?.enableFuzzySearch ?? true,
      maxFileCount:
        params.fileFiltering?.maxFileCount ??
        DEFAULT_FILE_FILTERING_OPTIONS.maxFileCount ??
        20000,
      searchTimeout:
        params.fileFiltering?.searchTimeout ??
        DEFAULT_FILE_FILTERING_OPTIONS.searchTimeout ??
        5000,
      customIgnoreFilePaths: params.fileFiltering?.customIgnoreFilePaths ?? [],
    };
    this.fileCheckpointing = params.fileCheckpointing ?? true;
    this.proxy = normalizeProxyUrlIfSupported(params.proxy);
    this.proxyRequestIgnored = Boolean(params.proxy && !this.proxy);
    this.allowedHttpHookUrls = params.allowedHttpHookUrls;
    this.cwd = params.cwd ?? process.cwd();
    this.fileDiscoveryService = params.fileDiscoveryService ?? null;
    this.customProviderSettings = params.customProviderSettings;
    this.customProviderAccessMode = params.customProviderAccessMode ?? 'local';
    this.customProviderAccess = new CustomProviderAccess({
      getIdentity: () => this.getModelRequestIdentity(),
      isEnabled: () => this.isCustomProviderEntryEnabled(),
      check: async () => true,
      onChange: (state) => this.onCustomProviderAccessChanged(state),
    });
    this.isExternalImportApproved = params.isExternalImportApproved;
    this.baseUltracode = params.ultracode ?? false;
    this.workflowKeywordTriggerEnabled =
      params.workflowKeywordTriggerEnabled ?? true;
    this.launchModelConfig = params.launchModelConfig;
    this.modelInput = {
      value: params.model,
      source: params.modelSource ?? 'config',
    };
    this.cliReasoningEffort = params.cliReasoningEffort;
    this.cliContextWindow = params.cliContextWindow;
    this._activeModel = params.model;
    this.enableAgents = params.enableAgents ?? true;
    this.allowedAgentSources = params.allowedAgentSources;
    this.settingSources = params.settingSources;
    this.inlineAgentsJson = params.inlineAgentsJson;
    this.sessionAgent = params.sessionAgent;
    this.customSystemPrompt = params.customSystemPrompt;
    this.appendSystemPrompt = params.appendSystemPrompt;
    // `default` (and unset) collapses to undefined so the assembler does
    // not emit a `# Output Style: default` block. Unresolved styles are loaded
    // during initialization, after additional workspace directories are added.
    this.outputStyleManager = new OutputStyleManager({
      name: params.outputStyle?.name ?? params.outputStyleName,
      preResolved: params.outputStyle,
    });
    this.language = params.language || undefined;
    this.agents = params.agents ?? {};
    this.planEnabled = params.plan ?? true;
    this.tasksEnabled = resolveTasksEnabled();
    this.enableEventDrivenScheduler = params.enableEventDrivenScheduler ?? true;
    this.skillsSupport = params.skillsSupport ?? true;
    this.loadSkillsFromAgentsDirectory =
      params.loadSkillsFromAgentsDirectory ?? false;
    this.disabledSkills = params.disabledSkills ?? [];
    this.adminSkillsEnabled = params.adminSkillsEnabled ?? true;
    this.disableBuiltinSkills = params.disableBuiltinSkills ?? false;
    this.enableBuiltinSkills = params.enableBuiltinSkills
      ? [...params.enableBuiltinSkills]
      : undefined;
    this.disableSkillShellExecution =
      params.disableSkillShellExecution ?? false;
    this.skillVisibilityOverrides = params.skillVisibilityOverrides ?? {};
    this.skillListingMaxDescChars = params.skillListingMaxDescChars;
    this.skillListingBudgetFraction = params.skillListingBudgetFraction;
    this.modelAvailabilityService = new ModelAvailabilityService();
    // In TUI sessions an omitted scope setting inherits the QCS auto_memory
    // rollout. Explicit settings remain independent and take precedence.
    this.autoMemoryEnabled = params.autoMemoryEnabled;
    this.autoMemoryUserScopeEnabled = params.autoMemoryUserScopeEnabled;
    setAutoMemoryFeatureGateChangeHandler(() => {
      this.handleAutoMemoryFeatureGateChange();
    });
    this.dreamSettings = params.dream ?? {};
    this.worktreeCreationSettings = params.worktree ?? {};
    this.memoryBoundaryMarkers = params.memoryBoundaryMarkers ?? ['.git'];
    this.agentsMdExcludes = params.agentsMdExcludes ?? [];
    this.contextManagement = {
      enabled: params.contextManagement?.enabled ?? false,
      tools: {
        outputMasking: {
          protectionThresholdTokens:
            params.contextManagement?.tools?.outputMasking
              ?.protectionThresholdTokens ?? DEFAULT_TOOL_PROTECTION_THRESHOLD,
          minPrunableThresholdTokens:
            params.contextManagement?.tools?.outputMasking
              ?.minPrunableThresholdTokens ??
            DEFAULT_MIN_PRUNABLE_TOKENS_THRESHOLD,
          protectLatestTurn:
            params.contextManagement?.tools?.outputMasking?.protectLatestTurn ??
            DEFAULT_PROTECT_LATEST_TURN,
        },
      },
    };
    this.topicUpdateNarration = params.topicUpdateNarration ?? false;
    this.modelSteering = params.modelSteering ?? false;
    this.injectionService = new InjectionService(() =>
      this.isModelSteeringEnabled(),
    );
    this.acpMode = params.acpMode ?? false;
    this.canConsumeAsyncRewake = params.canConsumeAsyncRewake ?? false;
    const sessionPlugins = params.sessionPlugins;
    this._plugins = sessionPlugins?.plugins ?? params.plugins ?? [];
    if (sessionPlugins) {
      this._pluginErrors = sessionPlugins.errors;
      const reload = sessionPlugins.reload;
      this.reloadPlugins = async () => {
        const { plugins, errors } = await reload();
        this.setPlugins(plugins);
        this.setPluginErrors(errors);
        return { enabled: plugins, errors };
      };
    }
    this.noBrowser = params.noBrowser ?? false;
    this.summarizeToolOutput = params.summarizeToolOutput;
    this.folderTrust = params.folderTrust ?? false;
    this.loadMemoryFromIncludeDirectories =
      params.loadMemoryFromIncludeDirectories ?? false;
    this.importFormat = params.importFormat ?? 'tree';
    this.discoveryMaxDirs = params.discoveryMaxDirs ?? 200;
    this.compressionConfig = {
      autoCompact: {
        maxConsecutiveFailures:
          params.compressionConfig?.autoCompact?.maxConsecutiveFailures ??
          DEFAULT_COMPRESSION_CONFIG.autoCompact.maxConsecutiveFailures,
      },
    };
    this.interactive = params.interactive ?? false;
    this.parallelReadOnlyShell = params.parallelReadOnlyShell ?? false;
    this.parallelToolStreaming = params.parallelToolStreaming ?? false;
    this.trustedFolder = params.trustedFolder;
    this.useRipgrep = params.useRipgrep ?? true;
    this.useBackgroundColor = params.useBackgroundColor ?? true;
    this.useAlternateBuffer = params.useAlternateBuffer ?? false;
    this.useTerminalBuffer = params.useTerminalBuffer ?? true;
    this.useRenderProcess = params.useRenderProcess ?? true;

    this.shellExecutionConfig = {
      pager: params.shellExecutionConfig?.pager ?? 'cat',
      sanitizationConfig: this.sanitizationConfig,
    };
    this.truncateToolOutputThreshold =
      params.truncateToolOutputThreshold ??
      DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD;
    this.mcpInitializationWaitStrategy =
      params.mcpInitializationWaitStrategy ??
      (params.interactive && !params.acpMode ? 'none' : 'budget');
    this.startupPhaseObserver = params.startupPhaseObserver;
    this.enableHooks = params.enableHooks ?? true;
    this._allHooksDisabled = !(params.enableHooks ?? true);

    this.continueOnFailedApiCall = params.continueOnFailedApiCall ?? true;
    this.shellToolInactivityTimeout =
      (params.shellToolInactivityTimeout ?? 300) * 1000; // 5 minutes
    this.enableExtensionReloading = params.enableExtensionReloading ?? false;
    this.storage = new Storage(this.targetDir, this._sessionId);
    this.storage.setCustomPlansDir(params.planSettings?.directory);

    this.fakeResponses = params.fakeResponses;
    this.recordResponses = params.recordResponses;
    this.fileExclusions = new FileExclusions(this);
    this.eventEmitter = params.eventEmitter;

    this._toolCallSnapshots = new InMemoryToolCallSnapshotStore();
    this.skillManager = new SkillManager();
    this.outputSettings = {
      format: params.output?.format ?? OutputFormat.TEXT,
    };

    this.agentSessionNoninteractiveEnabled =
      params.adk?.agentSessionNoninteractiveEnabled ?? false;
    this.retryFetchErrors = params.retryFetchErrors ?? true;
    this.maxAttempts = normalizeMaxAttempts(params.maxAttempts);
    this.rawOutput = params.rawOutput ?? false;
    this.acceptRawOutputRisk = params.acceptRawOutputRisk ?? false;

    if (params.hooks) {
      this.hooks = params.hooks;
    }
    if (params.projectHooks) {
      this.projectHooks = params.projectHooks;
    }
    if (params.localHooks) {
      this.localHooks = params.localHooks;
    }
    if (params.userHooks) {
      this.userHooks = params.userHooks;
    }
    if (params.flagHooks) {
      this.flagHooks = params.flagHooks;
    }

    this.onModelChange = params.onModelChange;
    this.onReload = params.onReload;
    this.onSettingsCacheInvalidate = params.onSettingsCacheInvalidate;
    this.onManualSettingsReload = params.onManualSettingsReload;
    this.onExternalSettingsChange = params.onExternalSettingsChange;
    this.sessionSettingsManager = params.sessionSettingsManager;

    // Initialize HookSystem eagerly during construction.
    // HookSystem only depends on already-available config params (hooks definitions,
    // extensions, trusted folder state, disabled hooks list) — no async I/O needed.
    // This ensures hooks are ready before any lifecycle event fires (e.g., WorktreeCreate,
    // CwdChanged), eliminating
    // timing bugs where early events are silently dropped.
    if (this.acpMode) {
      initializeShellSession(this, this.getWorkingDir());
    }
    runWithShellSession(this, () => this.initializeHookSystemSync());

    // Enable iterative interview-phase planning workflow when requested.
    if (process.env[ENV_PLAN_MODE_INTERVIEW_PHASE] === 'true') {
      this.planStateManager.enableInterviewPhase();
    }

    // Apply Phase 4 plan instruction variant when requested.
    const phase4Variant = process.env[ENV_PLAN_PHASE4_VARIANT];
    if (
      phase4Variant &&
      ['control', 'trim', 'cut', 'cap'].includes(phase4Variant)
    ) {
      this.planStateManager.setPhase4Variant(
        phase4Variant as import('../plan/planStateManager.js').PlanPhase4Variant,
      );
    }
  }

  get config(): Config {
    return this;
  }

  /** 进程级状态由调用方持有，在所有会话关闭后负责销毁。 */
  getResourceService(): ResourceService {
    return this.resourceService;
  }

  /** 判断全局/托管策略限制；来源由会话权限对象统一持有。 */
  getPermissionModeRestriction(mode: PermissionMode): string | undefined {
    return this.permission?.getModeRestriction(mode);
  }

  /** 显式切换校验模型；初始化尚未选模时可以延后。 */
  private getLocalPermissionModeRestriction(
    mode: PermissionMode,
    requireModel = true,
  ): string | undefined {
    if (isYoloMode(mode) && this.disableYoloMode) {
      return BYPASS_PERMISSIONS_DISABLED_MESSAGE;
    }
    // 初始化前主模型尚未选定时，延后模型校验。
    if (
      isAutoMode(mode) &&
      (requireModel || this.isInitialized() || this.getModel() !== '') &&
      !this.isAutoModeClassifierModelAvailable()
    ) {
      return AUTO_MODE_UNSUPPORTED_MESSAGE;
    }
    if (!this.isTrustedFolder() && !isDefaultMode(mode)) {
      return 'Cannot enable privileged permission modes in an untrusted folder.';
    }
    return undefined;
  }

  getSettingsService(): SettingsService {
    return this.settingsService;
  }

  /** 会话级 provider 组合面；推理依赖它，生命周期由 _initialize 启动。 */
  hasModelProviderManager(): boolean {
    return this.modelProviderManager.hasProviders();
  }

  getModelProviderManager(): ModelProviderManager {
    return this.modelProviderManager;
  }

  /** provider 工厂读面：重建链用它给新会话建自己的一组实例，不复用本会话实例。 */
  getModelProviderFactory(): ConfigParameters['modelProviderFactory'] {
    return this.modelProviderFactory;
  }

  /** Product selection is application-owned; each caller supplies its own settings and cwd. */
  getPluginManagerFactory(): PluginManagerFactory | undefined {
    return this.pluginManagerFactory;
  }

  /** 有效 transport 查找面；共享实例或本地缺省实例均供 Custom Provider 与重建链复用。 */
  getModelTransportManager(): ModelTransportManager {
    return this.modelTransportManager;
  }

  getBuiltinPluginContributions(): BuiltinPluginContributions | undefined {
    return this.builtinPluginsEnabled ? this.builtinPlugins : undefined;
  }

  getBuiltinPluginsInitialization(): Promise<unknown> | undefined {
    return this.builtinPluginsInitialization;
  }

  /** Product-contributed output styles only once the plugin registry is ready. */
  private getProductOutputStyles(): readonly OutputStyleConfig[] {
    const contributions = this.getBuiltinPluginContributions();
    return contributions?.isReady()
      ? contributions.getOutputStyleDefinitions()
      : [];
  }

  private refreshBuiltinPluginContributions(): Promise<void> {
    if (this.builtinPluginsDisposed) return Promise.resolve();
    if (!this.initialized) {
      this.builtinRefreshPending = true;
      return Promise.resolve();
    }
    this.builtinRefresh = this.builtinRefresh
      .catch(() => {})
      .then(async () => {
        if (this.builtinPluginsDisposed) return;
        if (this._toolRegistry)
          syncBuiltinPluginTools(
            this._toolRegistry,
            this.builtinToolNames,
            this.builtinPlugins,
          );
        await this.hookSystem?.initialize({ emitToFeed: false });
        await this.initialSkillsInitializationPromise;
        if (!this.builtinPluginsDisposed) await this.reloadSkills();
      });
    return this.builtinRefresh;
  }

  /** 会话级状态（Config 平替的「会话」一半）。 */
  getSessionState(): SessionState {
    return this.sessionState;
  }

  /**
   * Eagerly initializes HookSystem during Config construction.
   *
   * HookRegistry.initialize() is synchronous in practice (reads from already-loaded
   * config params, no disk/network I/O). We invoke it here so that HookSystem is
   * available immediately after Config is created, before `initialize()` is called.
   * This prevents timing bugs where early lifecycle events (WorktreeCreate,
   * CwdChanged, SessionStart) fire before `_initialize()` runs and silently
   * short-circuit through optional chaining on `getHookSystem()`.
   */
  private initializeHookSystemSync(): void {
    if (!this.getEnableHooks() && !this.builtinPluginsEnabled) {
      return;
    }

    this.hookSystem = new HookSystem(this);
    // HookRegistry.initialize() is declared async but is purely synchronous —
    // it calls processHooksFromConfig() which only reads config params and
    // pushes entries into an array. We still need to call it to populate the
    // registry; wrapping in void to handle the resolved promise.
    void this.hookSystem.initialize();

    // 仅 TUI 使用全局回调；ACP 回调保存在 Config 隔离的 Shell 状态中。
    // Headless 的 Worktree 事务直接通知所属 Hook，不能覆盖其他会话的全局回调。
    if (this.interactive || this.acpMode) {
      this.releaseCwdChangedCallback = setCwdChangedCallback(
        this.hookSystem.onCwdChanged,
      );
    }
  }

  /** Starts MCP servers declared by loaded plugins. */
  private async startPluginMcpServers(): Promise<void> {
    if (!this.getPluginMcpServersEnabled()) return;

    const mcpManager = this.getMcpClientManager();
    if (!mcpManager) return;

    for (const plugin of this.getEnabledPlugins()) {
      if (!plugin.mcpServers || Object.keys(plugin.mcpServers).length === 0) {
        continue;
      }

      const owner: McpPluginOwner = {
        name: plugin.name,
        path: plugin.path,
        mcpServers: plugin.mcpServers,
        id: getLoadedPluginId(plugin),
      };

      await mcpManager.startPlugin(owner);
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getStartupRuntime(): StartupRuntime<ConfigStartupGate> {
    return this.startupRuntime;
  }

  getStartupReadinessSnapshot(): StartupSnapshot<ConfigStartupGate> {
    return this.startupRuntime.snapshot();
  }

  waitForStartupGate(
    gate: ConfigStartupGate,
    options?: { signal?: AbortSignal },
  ): Promise<StartupGateResult> {
    return this.startupRuntime.when(gate, options);
  }

  /**
   * Dedups initialization requests using a shared promise that is only resolved
   * once.
   */
  async initialize(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }
    if (this.interactiveInitPromise) {
      this.initPromise = this.interactiveInitPromise.then(
        () => this.hydrationPromise,
      );
      return this.initPromise;
    }

    this.initPromise = this._initialize({ deferHydration: false });

    return this.initPromise;
  }

  async initializeForInteractiveStartup(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.interactiveInitPromise) {
      return this.interactiveInitPromise;
    }
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.interactiveInitPromise = this._initialize({ deferHydration: true });
    return this.interactiveInitPromise;
  }

  /** 请求的代理未能生效（非法或被规范化丢弃）。 */
  isProxyRequestIgnored(): boolean {
    return this.proxyRequestIgnored;
  }

  async hydrateAfterFirstRender(): Promise<void> {
    if (this.hydrationPromise) {
      return this.hydrationPromise;
    }
    if (!this.interactiveInitPromise) {
      await this.initialize();
      return;
    }
    await this.interactiveInitPromise;
    return this.hydrationPromise;
  }

  private async _initialize(options: {
    deferHydration: boolean;
  }): Promise<void> {
    try {
      await this._initializeUnchecked(options);
    } catch (err: unknown) {
      if (this.startupRuntime.snapshot().base.status === 'pending') {
        const message =
          err instanceof Error ? err.message : 'Config initialization failed';
        this.startupRuntime.markFailed('base', {
          code: 'config-initialization-failed',
          message,
          error: err,
        });
      }
      throw err;
    }
  }

  private async _initializeUnchecked(options: {
    deferHydration: boolean;
  }): Promise<void> {
    this.initPermission();
    const initializationStartedAt = Date.now();
    // 初始化快照等待首读；模式限制在请求和工具执行入口检查。
    await this.permissionManager?.getManagedPolicy().whenReady?.();
    const diagnostics = new StartupDiagnostics(
      this.getSessionId(),
      this.getTargetDir(),
      this.startupPhaseObserver,
    );
    runLogger.log('[Config] Initializing storage');
    await diagnostics.phase('config.storage', () => this.storage.initialize());
    setTaskOutputDir(this.storage.getIsolatedTasksDir());
    // 会话级 provider 组合面的生命周期：start 幂等，提前触发过则是空操作。
    // 只做本地装载，不拉远端模型目录：初始化早于认证，目录读取与启动参数
    // 偏好写入统一由认证后的 reconcileModelWithListedModels 承担。
    await diagnostics.phase('config.model_providers', () =>
      this.modelProviderManager.start(),
    );
    if (this.builtinPluginsEnabled && this.builtinPlugins) {
      // 先订阅再等待，避免初始化期间的变化漏掉；不初始化或关闭共享插件。
      this.unsubscribeBuiltinPlugins ??= this.builtinPlugins.subscribeChanged(
        () => this.refreshBuiltinPluginContributions(),
      );
      await diagnostics.phase('config.builtin_plugins', async () => {
        await this.builtinPluginsInitialization;
      });
      await diagnostics.phase('config.hooks', async () => {
        await this.hookSystem?.initialize({ emitToFeed: false });
      });
    }
    // Add pending directories to workspace context
    this.workspaceContext.addDirectories(this.pendingIncludeDirectories);

    // Initialize centralized FileDiscoveryService
    const discoverToolsHandle = startupProfiler.start('discover_tools');
    this.getFileService();

    // Agent definitions are initialized before the tool registry, so resolve
    // the session shell first to let Windows fallback agents name the actual
    // shell tool instead of assuming Git Bash.
    await diagnostics.phase('config.shell', () =>
      this.resolveShellCapabilities(),
    );
    // AgentRegistry consumes the initial user/project snapshot from resources.
    // Skills reuse the same manager later during background hydration.
    runLogger.log('[Config] Initializing resources');
    await diagnostics.phase('config.resources', () =>
      this.initializeResources(),
    );
    await diagnostics.phase('config.output_style', () =>
      this.initializeOutputStyle(),
    );
    this.agentRegistry = new AgentRegistry(this);
    runLogger.log('[Config] Initializing agent registry');
    await diagnostics.phase('config.agents', () =>
      this.agentRegistry.initialize(),
    ); // 初始化 subagent

    // 必须按会话过滤：单进程多会话（daemon）下 coreEvents 是进程级总线，裸订阅会让
    // A 会话刷新 agent 时，B/C… 每个会话都跑一遍 registerSubAgentTools +
    // refreshSessionToolsAndPromptIfInitialized()（活的 prompt/工具刷新）——一次刷新
    // 被放大成 N 次副作用。
    this.agentsRefreshedUnsubscribe = coreEvents.onSessionEvent(
      CoreEvent.AgentsRefreshed,
      this.getSessionId(),
      this.onAgentsRefreshed,
    );

    runLogger.log('[Config] Initializing tool registry');
    this._toolRegistry = await diagnostics.phase('config.tools', () =>
      this.createToolRegistry(),
    ); // 注册 Tool

    discoverToolsHandle?.end();
    const mcpManager = this.mcpManager ?? this.createSessionLocalMcpManager();
    if (!this.mcpManager) await mcpManager.init();
    else await mcpManager.ready();
    this.resolvedMcpManager = mcpManager;
    this.mcpClientManager = mcpManager.createSessionMcpManager(this, {
      cwd: this.getTargetDir(),
      eventEmitter: this.eventEmitter,
      lazyMode: this.getMcpLazyLoad(),
      elicitationHost: this.getElicitationHost(),
    });
    this.permission?.setSessionMcpManager(this.mcpClientManager);
    this.applyMcpToolRegistration();
    // We do not await this promise so that the CLI can start up even if
    // MCP servers are slow to connect.
    this.mcpInitializationStartedAt = performance.now();
    this.mcpInitializationPromise = Promise.allSettled([
      this.mcpClientManager.initialize(),
      this.startPluginMcpServers(),
    ]).then((results) => {
      const failures: StartupDegradation[] = [];
      for (const result of results) {
        if (result.status === 'rejected') {
          runLogger.error('Error initializing MCP clients:', result.reason);
          failures.push({
            code: 'mcp-initialization-failed',
            message:
              result.reason instanceof Error
                ? result.reason.message
                : 'MCP initialization failed',
            error: result.reason,
          });
        }
      }
      if (failures.length > 0) {
        this.startupRuntime.markDegraded('mcp-budget', failures);
      }
      this.startupRuntime.emitChange('mcp');
      // NOTE: 'commands' currently has no subscribers, and should not gain one.
      // slashCommandProcessor already subscribes to 'skills', and
      // emitSkillChange() emits both — subscribing to 'commands' would rebuild
      // the whole slash-command catalog twice per skill change.
      this.startupRuntime.emitChange('commands');
      return failures;
    });

    this.startupRuntime.markStarted('commands');
    const skillsInitializationPromise = diagnostics
      .phase('skills.initialize', () => this.initializeSkills(diagnostics))
      .then(() => {
        this.startupRuntime.markReady('commands');
        this.emitSkillChange();
      })
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : 'Skill discovery failed';
        runLogger.warn('[Config] Skill discovery failed:', message);
        this.startupRuntime.markDegraded('commands', {
          code: 'skills-discovery-failed',
          message,
          error: err,
        });
        this.emitSkillChange();
      });
    void skillsInitializationPromise.catch(() => {});
    this.initialSkillsInitializationPromise = skillsInitializationPromise;

    // Initialize settings file watcher for runtime ConfigChange detection
    this.initializeSettingsWatcher();

    // HookSystem is already initialized eagerly in the constructor via
    // initializeHookSystemSync(). No need to initialize it here again.

    // Apply session agent as soon as the base registry exists. Full hydration
    // can continue in the background for TUI startup.
    await this.applySessionAgent();
    runLogger.log('[Config] Initializing agent team');
    await diagnostics.phase('config.agent_team', () =>
      this.initializeAgentTeamSession(),
    );
    this.initialized = true;
    this.startupRuntime.markReady('base');
    if (this.builtinRefreshPending) {
      this.builtinRefreshPending = false;
      void this.refreshBuiltinPluginContributions().catch((error) =>
        runLogger.warn('[Config] builtin contributions refresh failed', error),
      );
    }
    runLogger.log('[Config] Base initialization completed', {
      sessionId: this.getSessionId(),
      pid: process.pid,
      durationMs: Date.now() - initializationStartedAt,
    });

    this.hydrationPromise = this.hydrateRuntimeAfterBaseInitialization(
      skillsInitializationPromise,
      diagnostics,
    );
    if (options.deferHydration) {
      void this.hydrationPromise.catch((err: unknown) => {
        runLogger.warn(
          '[Config] Background startup hydration failed:',
          err instanceof Error ? err.message : err,
        );
      });
      return;
    }

    await this.hydrationPromise;
  }

  private async hydrateRuntimeAfterBaseInitialization(
    skillsInitializationPromise: Promise<void>,
    diagnostics: StartupDiagnostics,
  ): Promise<void> {
    // Refresh project memory first. Memory discovery is local filesystem work
    // whose startup gate declares only `base` as a dependency, so it must not
    // sit behind the MCP wait and skill discovery below — that ordering was an
    // accidental serialization that delayed the memory-file count (and the TUI
    // header's tips) by seconds on repos with MCP servers configured.
    this.startupRuntime.markStarted('memory');
    const memoryHandle = startupProfiler.start('refresh_memory_context');
    try {
      this.memoryContextManager = new MemoryContextManager(
        this,
        this.isExternalImportApproved,
      );
      // The first measurement notifies even if an internal refresh wins the
      // startup race; hydration itself must not replay that notification.
      await diagnostics.phase('memory.refresh', () =>
        this.memoryContextManager!.refresh('session_start', {
          notifyAgentsMdSizeWarning: false,
          observeOperation: (name, action) =>
            diagnostics.operation(name, action),
        }),
      );
      this.startupRuntime.markReady('memory');
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Memory context refresh failed';
      runLogger.warn('[Config] Memory context refresh failed:', message);
      this.startupRuntime.markDegraded('memory', {
        code: 'memory-refresh-failed',
        message,
        error: err,
      });
    } finally {
      memoryHandle?.end();
    }

    try {
      await diagnostics.phase(
        'mcp.wait',
        () => this.waitForMcpInitializationDuringStartup(),
        (result) => ({
          strategy: result.strategy,
          budget_ms: result.budgetMs,
          elapsed_since_start_ms: result.elapsedSinceStartMs,
          outcome: result.outcome,
          active_before: result.before.active,
          pending_before: result.before.pending,
          tools_before: result.before.tools,
          active_after: result.after.active,
          pending_after: result.after.pending,
          tools_after: result.after.tools,
        }),
      );
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'MCP initialization wait failed';
      runLogger.warn('[Config] MCP initialization wait failed:', message);
      this.startupRuntime.markDegraded('mcp-budget', {
        code: 'mcp-initialization-failed',
        message,
        error: err,
      });
    }

    try {
      // Discovery already runs in parallel; this measures only the remaining wait.
      await diagnostics.phase('skills.wait', () => skillsInitializationPromise);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Skill discovery failed';
      runLogger.warn('[Config] Skill discovery failed:', message);
      this.startupRuntime.markDegraded('commands', {
        code: 'skills-discovery-failed',
        message,
        error: err,
      });
    }
    if (this.skillsSupport) {
      try {
        this.emitSkillChange();
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'Skill change emit failed';
        runLogger.warn('[Config] Skill change emit failed:', message);
        this.startupRuntime.markDegraded('commands', {
          code: 'skills-emit-failed',
          message,
          error: err,
        });
      }
    }
  }

  /** Diagnostics only: a snapshot failure must not change the startup wait. */
  private mcpStartupSnapshot(): SessionMcpStartupSnapshot {
    try {
      return (
        this.mcpClientManager?.getStartupSnapshot() ??
        EMPTY_MCP_STARTUP_SNAPSHOT
      );
    } catch {
      return EMPTY_MCP_STARTUP_SNAPSHOT;
    }
  }

  private async waitForMcpInitializationDuringStartup(): Promise<McpStartupWaitResult> {
    const strategy = this.mcpInitializationWaitStrategy;
    const before = this.mcpStartupSnapshot();
    const elapsedSinceStartMs =
      this.mcpInitializationStartedAt === undefined
        ? 0
        : Math.round(performance.now() - this.mcpInitializationStartedAt);
    const result = (
      outcome: McpStartupWaitResult['outcome'],
      budgetMs = 0,
    ): McpStartupWaitResult => ({
      strategy,
      budgetMs,
      elapsedSinceStartMs,
      outcome,
      before,
      after: this.mcpStartupSnapshot(),
    });

    if (!this.mcpInitializationPromise) {
      this.startupRuntime.markReady('mcp-budget');
      return result('skipped');
    }

    switch (strategy) {
      case 'none':
        if (
          this.startupRuntime.snapshot()['mcp-budget'].status !== 'degraded'
        ) {
          this.startupRuntime.markReady('mcp-budget');
        }
        return result('skipped');
      case 'full':
        if ((await this.mcpInitializationPromise).length > 0) {
          return result('failed');
        }
        this.startupRuntime.markReady('mcp-budget');
        return result('settled');
      case 'budget':
        break;
      default: {
        const exhaustive: never = strategy;
        return exhaustive;
      }
    }

    // Headless, SDK, and ACP startup should get a bounded chance to discover
    // tools before the first turn. Slow MCP servers continue connecting in the
    // background and register late arrivals through applyMcpToolRegistration().
    const budgetMs = getNonInteractiveMcpBudgetMs();
    let budgetTimeout: ReturnType<typeof setTimeout> | undefined;
    const budgetTimer = new Promise<'budget'>((resolve) => {
      budgetTimeout = setTimeout(() => resolve('budget'), budgetMs);
    });
    try {
      const outcome = await Promise.race([
        this.mcpInitializationPromise.then((failures) => ({
          type: 'settled' as const,
          failures,
        })),
        budgetTimer,
      ]);
      if (outcome === 'budget') {
        const message =
          `MCP initialization still running after ${budgetMs}ms; ` +
          `proceeding without waiting. Slow servers will arrive late or fail their own connect timeout.`;
        runLogger.warn(message);
        this.startupRuntime.markDegraded('mcp-budget', {
          code: 'mcp-budget-timeout',
          message,
        });
        return result('budget_exhausted', budgetMs);
      } else if (outcome.failures.length > 0) {
        return result('failed', budgetMs);
      } else {
        this.startupRuntime.markReady('mcp-budget');
        return result('settled', budgetMs);
      }
    } finally {
      // Always clear the pending timeout so a fast-settle doesn't leave a
      // dangling handle that delays Node's graceful exit.
      if (budgetTimeout !== undefined) {
        clearTimeout(budgetTimeout);
      }
    }
  }

  private async initializeSkills(
    diagnostics: StartupDiagnostics,
  ): Promise<void> {
    if (this.skillsSupport) {
      const skillsHandle = startupProfiler.start('discover_skills');
      try {
        this.getSkillManager().setAdminSettings(this.adminSkillsEnabled);
        this.getSkillManager().setDisableBuiltinSkills(
          this.disableBuiltinSkills,
        );
        this.getSkillManager().setEnabledBuiltinSkills(
          this.enableBuiltinSkills,
        );
        if (this.adminSkillsEnabled) {
          await diagnostics.operation('skills.discover', () =>
            this.getSkillManager().discoverSkills({
              allowedSources: this.allowedAgentSources,
              plugins: this.getEnabledPlugins(),
              resourceSkills: this.skillResourceSnapshot?.skills ?? [],
              resourceSkillLoadErrors:
                this.skillResourceSnapshot?.loadErrors ?? [],
              config: this,
            }),
          );
          this.getSkillManager().setDisabledSkills(this.disabledSkills);
          this.getSkillManager().setSkillVisibilityOverrides(
            this.skillVisibilityOverrides,
          );

          // ActivateSkillTool has a static schema. The discovered skill list is
          // delivered separately, so rebuilding the tool here would only change
          // Map insertion order and destabilize the request prefix.
        }
      } finally {
        skillsHandle?.end();
      }
    }
  }

  /** @internal Load the scoped resource views during loadCliConfig without starting runtime services. */
  async prepareResourceView(): Promise<void> {
    const views = this.getOrCreateResourceViews();
    await views.ready;
  }

  /**
   * Acquires the process-global user resource and this workspace's project
   * handle. The project context is reused while its inputs are unchanged.
   */
  private getOrCreateResourceViews(): SessionResourceViews {
    const allowedSources = this.getAllowedResourceSources();
    const projectOptions: ProjectResourceOptions = {
      cwd: this.getTargetDir(),
      homeDir: path.dirname(Storage.getGlobalAgentsDir()),
      configDirName: path.basename(this.storage.getConfigDir()),
      projectConfigDirOverride: this.storage.getConfigDir(),
      additionalDirectories: this.getIncludeDirectories(),
      isTrusted: this.isTrustedFolder(),
      loadFromAgentsDirectory: this.loadSkillsFromAgentsDirectory,
      projectAgentSkillsDirOverride: this.storage.getProjectAgentSkillsDir(),
      skillSettings: { allowedSources },
      agentSettings: {
        allowedSources: this.isAgentsEnabled() ? allowedSources : [],
      },
    };
    const previousViews = this.resourceViews;
    if (previousViews?.isForContext(projectOptions)) return previousViews;

    const replacementViews = traceStartupStep('resources.acquire_view', () => {
      const service = this.resourceService;
      const user = service.getUserResource();
      const project = service.getProjectResource(projectOptions);
      return new SessionResourceViews(
        user,
        project,
        this.loadSkillsFromAgentsDirectory,
        allowedSources?.includes('user') ?? true,
        new StartupDiagnostics(
          this.getSessionId(),
          this.getTargetDir(),
          this.startupPhaseObserver,
        ),
      );
    });

    for (const unsubscribe of this.skillResourceUnsubscribes.splice(0)) {
      unsubscribe();
    }
    this.resourceViews = replacementViews;
    if (previousViews) {
      void previousViews.release().catch((error) => {
        runLogger.error(
          `[Config] Failed to release previous resource context: ${getErrorMessage(error)}`,
        );
      });
    }
    this.outputStyleResourceInitialization = undefined;
    this.outputStyleResourceWorkingDir = undefined;
    this.sessionOutputStyles = undefined;

    void replacementViews.watcherReady.catch((error) => {
      runLogger.warn(
        '[Config] Resource watcher startup degraded; continuing with initial snapshots',
        {
          sessionId: this.getSessionId(),
          pid: process.pid,
          code: (error as NodeJS.ErrnoException)?.code,
          error: getErrorMessage(error),
        },
      );
    });

    this.initialResourceProjectConfigDir = this.storage.getConfigDir();
    this.skillResourceUnsubscribes.push(
      replacementViews.skills.onDidChange((events, snapshot) =>
        this.applyChangedSkillResource(events, {
          skills: snapshot.discoveredSkills,
          loadErrors: snapshot.loadErrors,
        }).catch((error) => {
          // Explicit reloads propagate failures; file events only log.
          if (!events?.length) throw error;
          runLogger.error(
            `[Config] Failed to apply changed Skill resource snapshot: ${getErrorMessage(error)}`,
          );
        }),
      ),
    );
    return replacementViews;
  }

  private async initializeResources(): Promise<void> {
    const diagnostics = new StartupDiagnostics(
      this.getSessionId(),
      this.getTargetDir(),
      this.startupPhaseObserver,
    );
    const views = this.getOrCreateResourceViews();
    const startedAt = Date.now();
    await diagnostics.phase('resources.ready', () => views.ready);
    this.skillResourceSnapshot = this.readSkillResourceSnapshot();
    const projectRoot = this.getSessionArtifactProjectRoot();
    if (
      !this.outputStyleResourceInitialization &&
      this.initialResourceProjectConfigDir !== undefined &&
      path.resolve(this.initialResourceProjectConfigDir) ===
        path.resolve(projectRoot, CONFIG_DIR)
    ) {
      // The initial snapshot already read this directory. Worktree/original
      // project mismatches still use the explicit reload path below.
      this.outputStyleResourceWorkingDir = projectRoot;
      this.outputStyleResourceInitialization = views.ready;
    }
    runLogger.log('[Config] Initial resource snapshot completed', {
      sessionId: this.getSessionId(),
      pid: process.pid,
      durationMs: Date.now() - startedAt,
    });
  }

  private readSkillResourceSnapshot(): SkillResourceProjection {
    return {
      skills: this.resourceViews?.skills.getAllDiscoveredSkills() ?? [],
      loadErrors: this.resourceViews?.skills.getLoadErrors() ?? [],
    };
  }

  private async applyChangedSkillResource(
    events: readonly ResourceChangeEvent[] | undefined,
    candidate: SkillResourceProjection,
  ): Promise<void> {
    const changeId = ++this.skillResourceChangeId;
    // Explicit reloads retain their existing behavior; only file changes run
    // the session's current hooks, including hooks registered after startup.
    if (events?.length) {
      try {
        const result = await this.getHookSystem()?.fireConfigChangeEvent(
          'skills',
          events[0].path,
        );
        if (result && hasBlockingResult(result)) return;
      } catch (error) {
        runLogger.error(
          `[Config] ConfigChange hook failed before Skill resource reload: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    // Resource watching starts before the CLI's initial SkillManager
    // projection is complete. Defer change application until that first
    // projection settles so an older initial discovery cannot overwrite a
    // newer resource Skill snapshot.
    await this.initialSkillsInitializationPromise?.catch(() => undefined);
    // An explicit reload or a newer accepted notification wins over a slow hook.
    if (!this.resourceProject || changeId < this.appliedSkillResourceChangeId)
      return;
    this.appliedSkillResourceChangeId = changeId;
    this.skillResourceSnapshot = candidate;
    await this.reloadSkillsFromResourceSnapshot();
  }

  /**
   * Resolves the session agent from the registry and applies its model and
   * tool restrictions to the main session.  The system prompt is applied
   * lazily in PromptProvider via `getSessionAgentDefinition()`.
   *
   * Public and idempotent: `Config.initialize()` calls this once at the end
   * of startup, but SDK-injected agents arrive later via the `initialize`
   * control request (see headlessSession's `maybeRegisterSdkAgents`). When
   * `--agent <name>` points at an SDK-injected agent, the first call is a
   * no-op and the SDK-side registration path re-invokes this method. The
   * Concurrent callers await the same application. Only a completed application
   * publishes `sessionAgentDefinition`; a failure remains retryable.
   */
  async applySessionAgent(): Promise<void> {
    if (!this.sessionAgent) return;
    if (this.sessionAgentDefinition) return; // idempotent: already applied
    if (this.sessionAgentApplication) return this.sessionAgentApplication;

    const definition = this.agentRegistry.getDefinition(this.sessionAgent);
    if (!definition) {
      runLogger.debug(
        `Warning: session agent "${this.sessionAgent}" not found in agent registry. Ignoring.`,
      );
      return;
    }

    const application = this.applySessionAgentDefinition(definition);
    this.sessionAgentApplication = application;
    try {
      await application;
    } finally {
      this.sessionAgentApplication = undefined;
    }
  }

  private async applySessionAgentDefinition(
    definition: AgentDefinition,
  ): Promise<void> {
    // Apply the agent's model if specified and not "inherit".
    if (definition.kind === 'local') {
      const agentModel = definition.modelConfig?.model?.trim();
      if (agentModel && agentModel !== 'inherit') {
        const resolved = await resolveConfiguredAgentModel(
          this.getModelProviderManager(),
          agentModel,
        );
        if (!(await this.setModel(resolved?.key ?? agentModel, true))) {
          throw new Error(
            `Could not apply model "${agentModel}" for session agent "${this.sessionAgent}".`,
          );
        }
        runLogger.debug(`Session agent model override: ${agentModel}`);
      }

      // Apply tool allow/deny lists to the main tool registry.
      const agentTool = this._toolRegistry.getTool(AGENT_TOOL_NAME);
      const typedAgentTool =
        agentTool instanceof AgentTool ? agentTool : undefined;

      if (definition.disallowedTools && definition.disallowedTools.length > 0) {
        applyDisallowedTools(
          definition.disallowedTools,
          (name) => this._toolRegistry.unregisterTool(name),
          typedAgentTool
            ? (name) => typedAgentTool.disableAgentType(name)
            : undefined,
        );
        runLogger.debug(
          `Session agent disallowed tools: ${definition.disallowedTools.join(', ')}`,
        );
      }

      if (
        definition.toolConfig?.tools &&
        definition.toolConfig.tools.length > 0
      ) {
        // Build the allowed set and collect Agent(name) types in a single pass.
        const allowed = new Set<string>();
        const agentTypeNames = new Set<string>();

        for (const toolRef of definition.toolConfig.tools) {
          if (typeof toolRef !== 'string') continue;
          const trimmed = toolRef.trim();
          const agentNames = parseAgentToolExpression(trimmed);
          if (agentNames) {
            allowed.add(AGENT_TOOL_NAME);
            for (const n of agentNames) {
              allowed.add(n);
              agentTypeNames.add(n);
            }
          } else {
            allowed.add(trimmed);
          }
        }

        // A wildcard means "all tools" — skip filtering.
        if (!allowed.has('*')) {
          const allNames = this._toolRegistry.getAllToolNames();
          for (const name of allNames) {
            const tool = this._toolRegistry.getKnownTool(name);
            if (tool ? !isKeptByAllowList(tool, allowed) : !allowed.has(name)) {
              this._toolRegistry.unregisterTool(name);
            }
          }
          runLogger.debug(
            `Session agent allowed tools: ${[...allowed].join(', ')}`,
          );
        }

        if (agentTypeNames.size > 0 && typedAgentTool) {
          typedAgentTool.setAllowedAgentTypes(agentTypeNames);
        }
      }
    }
    this.sessionAgentDefinition = definition;
    runLogger.debug(
      `Session agent "${this.sessionAgent}" resolved (kind: ${definition.kind}).`,
    );
  }

  async refreshAuth(
    authMethod: AuthType,
    _apiKey?: string,
    baseUrl?: string,
    customHeaders?: Record<string, string>,
    _options?: { skipModelsAwait?: boolean },
  ) {
    const previousAuthType = this.contentGeneratorConfig?.authType;

    // Reset availability service when switching auth
    this.modelAvailabilityService.reset();

    // Clear stale authType during the transition.
    if (this.contentGeneratorConfig) {
      this.contentGeneratorConfig.authType = undefined;
    }

    const newContentGeneratorConfig = createContentGeneratorConfig(
      this,
      authMethod,
      baseUrl,
      customHeaders,
    );
    // Only assign to instance properties after successful initialization
    this.contentGeneratorConfig = newContentGeneratorConfig;

    if (
      previousAuthType === AuthType.QODER_BROWSER &&
      this.sessionRuntimeBinding
    ) {
      this.stripThoughtsFromConversationHistory();
    }

    const authType = this.contentGeneratorConfig.authType;
    if (
      !this.fakeResponses &&
      (authType === AuthType.QODER_BROWSER || authType === AuthType.QODER_PAT)
    ) {
      this.setHasAccessToPreviewModel(true);
    }
  }

  private getAvailableModelsErrorHint(models: readonly Model[]): string {
    const visibleModels = models.filter((model) => model.enabled !== false);
    const modelNames = Array.from(
      new Set(
        visibleModels.map((model) => model.displayName.trim() || model.key),
      ),
    );

    if (modelNames.length === 0) return '';

    return [
      '',
      'Available models:',
      ...modelNames.map((modelName) => `  - ${modelName}`),
    ].join('\n');
  }

  private getInvalidModelErrorMessage(
    model: string,
    models: readonly Model[],
  ): string {
    const availableModelsHint = this.getAvailableModelsErrorHint(models);
    const availableModelsSuffix = availableModelsHint
      ? `${availableModelsHint}\n`
      : ' ';
    return (
      `Invalid model "${model}".${availableModelsSuffix}` +
      'Use /model to see available models.'
    );
  }

  /**
   * Degrades the session to the server default model after the listed
   * models confirmed the configured model no longer exists.
   *
   * Preserving an unroutable key would make every request fail with
   * ModelNotFoundError, so this keeps the session usable and tells the user how
   * to pick a different model. `settings.json` is deliberately not rewritten:
   * the miss may be a transient listing gap and the saved preference should
   * survive it. Direct-connection and Custom Provider models are intentionally not
   * eligible because an automatic fallback must not cross provider boundaries.
   */
  private async fallBackToListedDefaultModel(
    models: readonly Model[],
    unavailableModel = this.getModel(),
  ): Promise<void> {
    const defaultKey = models.find(
      (model) => model.isDefault === true && model.enabled !== false,
    )?.key;

    if (!defaultKey || defaultKey === unavailableModel) {
      runLogger.warn(
        `[config] Model "${unavailableModel}" not found in listed models and no server default model is available; keeping the configured model rather than switching providers automatically.`,
      );
      coreEvents.emitFeedback(
        'warning',
        `Model "${unavailableModel}" is not available right now, and no default model can be selected. Use /model to choose another model.`,
      );
      return;
    }

    // Reuse the normal session-only switch path so observers update the TUI
    // immediately and the fallback model's preferences are restored without
    // rewriting the user's saved model choice.
    if (!(await this.setModel(defaultKey, true))) return;
    runLogger.warn(
      `[config] Model "${unavailableModel}" is not in the listed models; falling back to default model "${defaultKey}" for this session.`,
    );
    coreEvents.emitFeedback(
      'warning',
      `Model "${unavailableModel}" is not available right now; using "${defaultKey}" instead. Use /model to choose another model.`,
    );
  }

  /**
   * Reconcile the saved/CLI-supplied model against the listed models:
   * canonical key match keeps the model, case-insensitive match normalizes it,
   * 空模型使用目录默认模型；显式 CLI 模型不存在时，按选项报错、回退或延迟校验。
   * 回退直接切换会话模型 key，不依赖 auto 是否已列出或其 provider 归属。
   * SDK model-policy 会话可延迟校验，等待 policy-selected provider 加载。
   *
   * A saved server model that is missing from an already-trustworthy listing
   * degrades to the listed default instead of being preserved, because the
   * routing layer would otherwise reject every request for it.
   */
  async reconcileModelWithListedModels(options?: {
    modelsWereAwaited?: boolean;
    onInvalidCliModel?: 'throw' | 'fallback' | 'defer';
  }): Promise<void> {
    const manager = this.modelProviderManager;
    const currentKey = this.getModel();
    const revision = this.modelSelectionRevision;
    const modelKey =
      revision === 0 ? this.modelInput.value || currentKey : currentKey;
    const isCliModel =
      this.modelInput.source === 'cli' && Boolean(this.modelInput.value);
    const identity = this.getModelRequestIdentity();
    const sessionId = this.getSessionId();
    const models = await manager.listModels();
    if (
      revision !== this.modelSelectionRevision ||
      this.getModel() !== currentKey ||
      identity !== this.getModelRequestIdentity()
    )
      return;
    this.dropContextWindowsWhenDisabled(models);
    const hasListedModels = models.length > 0;
    const modelsWereAwaited = options?.modelsWereAwaited ?? true;
    const onInvalidCliModel = options?.onInvalidCliModel ?? 'fallback';

    if (modelKey) {
      let entry: Model | undefined;
      try {
        entry = await manager.getModel(modelKey);
      } catch (error) {
        // An unrelated provider may require login while a listed Custom model
        // still resolves through the existing startup display-name path.
        const match =
          isCliModel && revision === 0
            ? resolveModelName(models, modelKey.trim())
            : undefined;
        if (
          !(error instanceof FatalAuthenticationError) ||
          (!match?.model && !match?.ambiguous)
        )
          throw error;
      }
      if (
        revision !== this.modelSelectionRevision ||
        this.getModel() !== currentKey ||
        identity !== this.getModelRequestIdentity()
      )
        return;
      // 仅启动 CLI 输入兼容展示名；成功后锚定 canonical key，不重放原始输入。
      if (!entry && isCliModel && revision === 0) {
        const match = resolveModelName(models, modelKey.trim());
        if (match.ambiguous) {
          if (!modelsWereAwaited) return;
          throw new FatalInputError(
            `Ambiguous model "${modelKey}". Specify a model key: ${match.ambiguous.map((model) => model.key).join(', ')}.`,
          );
        }
        entry = match.model;
      }
      // Names and keys, including a saved model, must use the same access
      // decision. Keep provisional startup and SDK policy validation deferred.
      if (
        this.isConfiguredCustomProviderModelKey(entry?.key ?? modelKey, entry)
      ) {
        if (
          (!modelsWereAwaited || onInvalidCliModel === 'defer') &&
          !this.canUseCustomProviders()
        )
          return;
        await this.waitForCustomProviderAccess({ identity });
        if (
          revision !== this.modelSelectionRevision ||
          this.getModel() !== currentKey ||
          identity !== this.getModelRequestIdentity() ||
          sessionId !== this.getSessionId()
        )
          return;
      }
      if (entry?.enabled === false && isCliModel) {
        if (!modelsWereAwaited) return;
        throw new FatalInputError(`Model "${modelKey}" is not available.`);
      }
      if (entry) {
        manager.setMainModel(entry);
        this._activeModel = entry.key;
        if (revision === 0) this.modelSelectionRevision++;
        if (entry.key !== modelKey) {
          runLogger.debug(
            `[config] Normalized model key "${modelKey}" → "${entry.key}"`,
          );
        }
      } else if (onInvalidCliModel === 'defer') {
        // SDK 控制会话允许空模型清单及暂时失效的已保存模型，交给推理路由校验。
        return;
      } else if (isCliModel) {
        // 非阻塞目录可能只有缓存中的 auto，保留输入等待首轮权威校正。
        if (!modelsWereAwaited) return;
        if (onInvalidCliModel === 'throw') {
          throw new FatalInputError(
            this.getInvalidModelErrorMessage(modelKey, models),
          );
        }
        if (!(await this.setModel('auto', true))) return;
        runLogger.warn(
          `[config] Model "${modelKey}" is not in the listed models; falling back to auto for this session.`,
        );
        coreEvents.emitFeedback(
          'warning',
          `Model "${modelKey}" is not available right now; using "auto" instead. Use /model to choose another model.`,
        );
      } else {
        const authType = this.contentGeneratorConfig?.authType;
        const canPreserveForFirstPartyBackend =
          (authType === AuthType.QODER_BROWSER ||
            authType === AuthType.QODER_PAT) &&
          this.hasAccessToPreviewModel === true;

        if (canPreserveForFirstPartyBackend) {
          // A non-empty listed snapshot came from the providers themselves,
          // so a miss there is the same miss inference selection will hit.
          if (hasListedModels) {
            // The listing is loaded and confirms the saved model is gone
            // (removed, disabled, or temporarily invisible). Preserving it
            // would make every request fail in routing with no way out except
            // editing settings, so degrade to the listed default for this
            // session instead. The saved preference is intentionally left
            // untouched so a transient listing gap does not silently discard
            // the user's model choice.
            await this.fallBackToListedDefaultModel(models);
          } else {
            runLogger.warn(
              `[config] Model "${modelKey}" not found in listed models; preserving saved model for backend validation.`,
            );
          }
        } else if (modelsWereAwaited || hasListedModels) {
          // Model saved in settings is no longer available (removed from
          // the server model list or a direct-connection entry failed to load). Surface the same
          // actionable hint used for invalid CLI-supplied models.
          throw new FatalInputError(
            this.getInvalidModelErrorMessage(modelKey, models),
          );
        } else {
          runLogger.warn(
            `[config] Model "${modelKey}" not found in listed models; passing through to backend for validation.`,
          );
        }
      }
    } else {
      const fallback = models.find(
        (model) => model.isDefault === true && model.enabled !== false,
      );
      if (fallback) {
        manager.setMainModel(fallback);
        this._activeModel = fallback.key;
        if (revision === 0) this.modelSelectionRevision++;
      }
    }

    // 校正后的主模型同步启动参数；已存偏好若与新目录不符，由 select 按能力修正。
    const listed = models.find((model) => model.key === this.getModel());
    if (listed) this.anchorMainModel(listed);
  }

  get promptId(): string {
    return this._sessionId;
  }

  getConversationMessages(): readonly Message[] {
    if (this.getConversationMessagesOverride) {
      return this.getConversationMessagesOverride();
    }
    runLogger.warn(
      '[Config] getConversationMessages called before session binding registered; returning empty history.',
    );
    return [];
  }

  stripThoughtsFromConversationHistory(): void {
    if (this.sessionRuntimeBinding?.stripThoughtsFromConversationHistory) {
      this.sessionRuntimeBinding.stripThoughtsFromConversationHistory();
    }
  }

  /**
   * @deprecated Do not access directly on Config.
   * Use the injected AgentLoopContext instead.
   */
  get toolRegistry(): ToolRegistry {
    return this._toolRegistry;
  }

  /**
   * @deprecated Do not access directly on Config.
   * Use the injected AgentLoopContext instead.
   */
  /**
   * @deprecated Do not access directly on Config.
   * Use the injected AgentLoopContext instead.
   */
  get toolCallSnapshots(): ToolCallSnapshotStore {
    return this._toolCallSnapshots;
  }

  /** Session-level tool executor shared by every agent in this session. */
  getToolExecutor(): ToolExecutor {
    return (this._toolExecutor ??= new StreamingToolExecutor());
  }

  /** Releases the session executor and the root registry's MCP subscription. */
  disposeToolExecution(): void {
    this._toolExecutor?.dispose();
    this._toolExecutor = undefined;
    this._toolRegistry?.dispose();
  }

  // ── Fork subagent context accessors ──────────────────────────────────────
  // These are optional on AgentLoopContext and wired at runtime by QueryEngine.

  /** Returns the current conversation history. Set by the active session owner. */
  getConversationMessagesOverride?: () => readonly Message[];

  /**
   * Returns the parent's system prompt blocks. Derived from
   * `getPromptBuildResult` by `registerForkContextAccessors`.
   */
  getSystemPrompt?: () => SystemPrompt | undefined;

  /** Returns the parent's last prompt build result. Set by QueryEngine. */
  getPromptBuildResult?: () =>
    | import('../prompts/types.js').PromptBuildResult
    | undefined;

  /** Returns the parent's exact tool schemas for fork useExactTools. Set by QueryEngine. */
  getParentToolSchemas?: () => Array<
    import('../provider/modelStreamRequest.js').ModelStreamTool
  >;

  /** Returns the parent's last cache-safe model request snapshot. Set by QueryEngine. */
  getCacheSafeQuerySnapshot?:
    | (() =>
        | import('../core/cache-safe-query-snapshot.js').CacheSafeQuerySnapshot
        | null)
    | undefined;

  /**
   * Registers fork context accessors. Called by QueryEngine once per session.
   * These enable the fork subagent path to access parent state for
   * byte-identical prompt-cache sharing.
   */
  registerForkContextAccessors(
    accessors:
      | {
          getConversationMessages: () => readonly Message[];
          /**
           * Single source of truth for the parent prompt: the blocks are
           * derived from it, so the two accessors cannot report different
           * prompts.
           */
          getPromptBuildResult: () =>
            | import('../prompts/types.js').PromptBuildResult
            | undefined;
          getParentToolSchemas?: () => Array<
            import('../provider/modelStreamRequest.js').ModelStreamTool
          >;
          getCacheSafeQuerySnapshot?: () =>
            | import('../core/cache-safe-query-snapshot.js').CacheSafeQuerySnapshot
            | null;
        }
      | undefined,
  ): void {
    this.getConversationMessagesOverride = accessors?.getConversationMessages;
    const getPromptBuildResult = accessors?.getPromptBuildResult;
    this.getPromptBuildResult = getPromptBuildResult;
    this.getSystemPrompt = getPromptBuildResult
      ? () => getPromptBuildResult()?.blocks
      : undefined;
    this.getParentToolSchemas = accessors?.getParentToolSchemas;
    this.getCacheSafeQuerySnapshot = accessors?.getCacheSafeQuerySnapshot;
  }

  registerSessionRuntimeBinding(
    binding: SessionRuntimeBinding | undefined,
  ): void {
    this.sessionRuntimeBinding = binding;
  }

  synchronizeWorktreeRuntimeState(
    state: TranscriptWorktreeSession | null,
  ): void {
    this.sessionRuntimeBinding?.synchronizeWorktreeRuntimeState?.(state);
  }

  getActiveConversation(): ActiveConversation | undefined {
    return this.sessionRuntimeBinding?.activeConversation;
  }

  /** Writer 就绪后显式调用，不在构造或 initialize 阶段切换工作目录。 */
  async enterWorktree(
    request: WorktreeEntryRequest,
    record?: Config['recordWorktreeState'],
  ) {
    return enterConfigWorktree(
      this,
      request,
      this.resolveWorktreeStateRecorder(record),
    );
  }

  async restoreWorktree(
    state: TranscriptWorktreeSession,
    record?: Config['recordWorktreeState'],
  ) {
    return restoreConfigWorktree(
      this,
      state,
      this.resolveWorktreeStateRecorder(record),
    );
  }

  private resolveWorktreeStateRecorder(
    record?: Config['recordWorktreeState'],
  ): Config['recordWorktreeState'] {
    if (!this.sessionPersistence) {
      throw new Error(
        'Worktree entry requires session persistence. Enable session persistence and retry.',
      );
    }
    if (record) return record;
    if (!this.sessionRuntimeBinding?.recordWorktreeState) {
      throw new Error(
        'Worktree state requires an active transcript writer and session persistence.',
      );
    }
    return (...args) => this.recordWorktreeState(...args);
  }

  async recordWorktreeState(
    state: TranscriptWorktreeSession | null,
    discardLegacyFileHistorySnapshots?: boolean,
  ): Promise<void> {
    if (
      !this.sessionPersistence ||
      !this.sessionRuntimeBinding?.recordWorktreeState
    ) {
      throw new Error(
        'Worktree state requires an active transcript writer and session persistence.',
      );
    }
    if (discardLegacyFileHistorySnapshots) {
      await this.sessionRuntimeBinding.recordWorktreeState(state, true);
    } else {
      await this.sessionRuntimeBinding.recordWorktreeState(state);
    }
  }

  async persistSessionTitle(title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) {
      return;
    }

    await this.sessionRuntimeBinding?.persistSessionTitle?.(trimmed);
  }

  /** 工作目录切换后刷新文件发现；项目资源继续绑定原项目，不在此重建。 */
  refreshRuntimeWorkspaceServices(): void {
    this.fileDiscoveryService = null;
  }

  getSessionId(): string {
    return this.promptId;
  }

  /**
   * 本会话的 cron / 定时器运行时：调度器生命周期、ScheduleWakeup 一次性定时器、
   * 非持久任务存储，以及 durable 任务的归属指纹。
   *
   * 所有定时器相关的能力都必须从这里进，不要绕过它去碰模块级状态——模块级的
   * 那些槽位已经删掉了，绕过它的调用点编译不过，这是有意为之。
   */
  getCronManager(): CronManager {
    return this.cronManager;
  }

  async initializeAgentTeamSession(): Promise<string | undefined> {
    if (!isInProcessTeammateFeatureEnabled()) {
      return undefined;
    }
    if (this.agentTeamSessionsDisposed) {
      throw new Error('Cannot initialize an Agent Team after config disposal.');
    }

    const sessionId = this.getSessionId();
    const existing = this.agentTeamSessionInitializations.get(sessionId);
    if (existing) {
      return existing;
    }

    const teamName = deriveSessionTeamName(sessionId);
    const initialization = ensureAgentTeam({
      teamName,
      leadSessionId: sessionId,
    })
      .then(() => {
        this.ownedAgentTeamNames.add(teamName);
        return teamName;
      })
      .catch((error) => {
        this.agentTeamSessionInitializations.delete(sessionId);
        throw error;
      });
    this.agentTeamSessionInitializations.set(sessionId, initialization);
    return initialization;
  }

  async waitForAgentTeamSession(): Promise<string | undefined> {
    if (!isInProcessTeammateFeatureEnabled()) {
      return undefined;
    }
    const initialization = this.agentTeamSessionInitializations.get(
      this.getSessionId(),
    );
    if (!initialization) {
      throw new Error(
        'Agent Team session is not initialized. Initialize the config before spawning a teammate.',
      );
    }
    return initialization;
  }

  async cleanupAgentTeamSessions(): Promise<void> {
    if (this.agentTeamSessionsDisposed) {
      return;
    }
    this.agentTeamSessionsDisposed = true;

    await Promise.allSettled(this.agentTeamSessionInitializations.values());
    const teamNames = [...this.ownedAgentTeamNames];
    this.agentTeamSessionInitializations.clear();
    this.ownedAgentTeamNames.clear();
    await Promise.all(teamNames.map((teamName) => removeAgentTeam(teamName)));
  }

  getPromptAssembler(): SystemPromptAssembler | undefined {
    return this._promptAssembler;
  }

  setPromptAssembler(assembler: SystemPromptAssembler): void {
    this._promptAssembler = assembler;
  }

  getWorktreeSettings(): WorktreeSettings | undefined {
    return this.worktreeSettings;
  }

  setWorktreeSettings(settings: WorktreeSettings | undefined): void {
    this.worktreeSettings = settings;
  }

  getClientName(): string | undefined {
    return this.clientName;
  }

  getClientType(): string | undefined {
    return getClientMetadata().client_type;
  }

  setSessionId(sessionId: string): void {
    if (sessionId !== this._sessionId) void resetCodeModeSession(this);
    this._sessionId = sessionId;
    if (this.initialized && isInProcessTeammateFeatureEnabled()) {
      void this.initializeAgentTeamSession().catch((error) => {
        runLogger.error(
          `[Config] Failed to initialize Agent Team for session ${sessionId}:`,
          error,
        );
      });
    }
  }

  setFileHistoryManager(manager: FileHistoryManager | undefined): void {
    this.fileHistoryManager = manager;
  }

  getFileHistoryManager(): FileHistoryManager | undefined {
    return this.fileHistoryManager;
  }

  getTranscriptStore(): TranscriptStore {
    return this.transcriptStore;
  }

  getSessionPersistence(): boolean {
    return this.sessionPersistence;
  }

  async getFakeResponseStore(): Promise<FakeResponseStore | undefined> {
    if (!this.fakeResponses) {
      return undefined;
    }
    this.fakeResponseStorePromise ??= FakeResponseStore.fromFile(
      this.fakeResponses,
    );
    return this.fakeResponseStorePromise;
  }

  setTerminalBackground(terminalBackground: string | undefined): void {
    this.terminalBackground = terminalBackground;
  }

  getTerminalBackground(): string | undefined {
    return this.terminalBackground;
  }

  shouldLoadMemoryFromIncludeDirectories(): boolean {
    return this.loadMemoryFromIncludeDirectories;
  }

  getImportFormat(): 'tree' | 'flat' {
    return this.importFormat;
  }

  getDiscoveryMaxDirs(): number {
    return this.discoveryMaxDirs;
  }

  getContentGeneratorConfig(): ContentGeneratorConfig {
    return this.contentGeneratorConfig;
  }

  /** 主模型 key 的唯一真源是 manager 锚点；Config 不自持一份。 */
  getModel(): string {
    return this.modelProviderManager.getMainModelKey();
  }

  /**
   * 窗口选择开关关闭时，会话内清除各模型已存的窗口偏好（不写盘），
   * 选模回落到模型默认窗口；开关打开后的新会话照常读取磁盘偏好。
   */
  private dropContextWindowsWhenDisabled(models: readonly Model[]): void {
    if (isContextWindowConfigEnabled()) return;
    const manager = this.modelProviderManager;
    for (const model of models) {
      if (manager.getModelConfig(model)?.context?.contextWindow === undefined) {
        continue;
      }
      manager.setModelConfig(model, { context: { contextWindow: undefined } });
    }
  }

  /**
   * 锚定主模型；启动参数只在首次目录校正时写入，之后的锚定不再重放，
   * 避免覆盖用户在会话中的修改。
   */
  private anchorMainModel(main: Model): void {
    this.modelProviderManager.setMainModel(main);
    if (this.launchModelConfigApplied) return;
    this.launchModelConfigApplied = true;
    const launch = this.launchModelConfig ?? {};
    let reasoning = launch.reasoning;
    // settings.ultracode 只在用户没有显式 effort 时生效：启动参数未给 effort，
    // 且该模型也没有已存 effort，才补 xhigh；已存 effort 视为显式选择，关闭 UltraCode。
    if (this.baseUltracode && !hasOwnField(reasoning, 'effort')) {
      if (
        this.modelProviderManager.getModelConfig(main)?.reasoning?.effort !==
        undefined
      ) {
        this.baseUltracode = false;
      } else {
        reasoning = { ...reasoning, effort: 'xhigh' };
      }
    }
    const patch = this.withoutUnsupportedModelConfig(main, {
      ...launch,
      ...(reasoning ? { reasoning } : {}),
    });
    if (
      patch.reasoning === undefined &&
      patch.context === undefined &&
      patch.sampling === undefined
    ) {
      return;
    }
    this.modelProviderManager.setModelConfig(main, patch);
  }

  /** 逐字段剔除模型不支持的 effort / contextWindow，并告警说明被忽略的启动参数。 */
  private withoutUnsupportedModelConfig(
    model: Model,
    patch: ModelConfig,
  ): ModelConfig {
    let { reasoning, context } = patch;
    if (
      reasoning?.effort !== undefined &&
      findUnsupportedModelConfig(model, {
        reasoning: { effort: reasoning.effort },
      })
    ) {
      runLogger.warn(
        `[Config] Ignoring reasoning effort '${reasoning.effort}': unsupported by model '${model.key}'.`,
      );
      const { effort: _effort, ...rest } = reasoning;
      reasoning = rest;
    }
    if (
      context?.contextWindow !== undefined &&
      (!isContextWindowConfigEnabled() ||
        findUnsupportedModelConfig(model, {
          context: { contextWindow: context.contextWindow },
        }))
    ) {
      runLogger.warn(
        `[Config] Ignoring context window ${context.contextWindow}: unsupported by model '${model.key}'.`,
      );
      const { contextWindow: _contextWindow, ...rest } = context;
      context = rest;
    }
    const { reasoning: _reasoning, context: _context, ...rest } = patch;
    return {
      ...rest,
      ...(reasoning && Object.keys(reasoning).length > 0 ? { reasoning } : {}),
      ...(context && Object.keys(context).length > 0 ? { context } : {}),
    };
  }

  /** 会话恢复按输入来源判断覆盖优先级，不另存一份 CLI 模型值。 */
  getCliModel(): string | undefined {
    return this.modelInput.source === 'cli' ? this.modelInput.value : undefined;
  }

  getCliReasoningEffort(): string | undefined {
    return this.cliReasoningEffort;
  }

  getCliContextWindow(): string | undefined {
    return this.cliContextWindow;
  }

  getUltracode(): boolean {
    return this.ultracodeOverride ?? this.baseUltracode;
  }

  setUltracode(enabled: boolean): void {
    this.ultracodeOverride = enabled;
  }

  clearUltracodeOverride(): void {
    this.ultracodeOverride = undefined;
  }

  getWorkflowKeywordTriggerEnabled(): boolean {
    return this.workflowKeywordTriggerEnabled;
  }

  isWorkflowToolAvailable(): boolean {
    const registry = this._toolRegistry as ToolRegistry | undefined;
    return registry ? registry.hasToolEnabled(WORKFLOW_TOOL_NAME) : true;
  }

  isUltracodeAvailable(listed: Model | undefined): boolean {
    return (
      this.isWorkflowToolAvailable() &&
      listed?.capabilities.reasoning.supportedEfforts.includes('xhigh') === true
    );
  }

  isUltracodeActive(listed: Model | undefined): boolean {
    return (
      this.getUltracode() &&
      this.isUltracodeAvailable(listed) &&
      listed !== undefined &&
      this.modelProviderManager.getModelConfig(listed)?.reasoning?.effort ===
        'xhigh'
    );
  }

  /** 已存的 contextWindow 偏好；功能开关关闭时视为未配置。 */
  private getConfiguredContextWindow(
    target: Model | undefined,
  ): number | undefined {
    if (!target || !isContextWindowConfigEnabled()) return undefined;
    return normalizeContextWindow(
      this.modelProviderManager.getModelConfig(target)?.context?.contextWindow,
    );
  }

  getEffectiveContextWindow(
    model: Model | undefined,
    modelKey: string = model?.key ?? this.getModel(),
  ): number {
    return this.resolveEffectiveContextWindow(
      model,
      this.getConfiguredContextWindow(model),
      modelKey,
    );
  }

  /**
   * Resolve the effective context window for `model` given an explicit
   * configured window, so callers that track their own window state (e.g. the
   * remote-controller proxy) can resolve against it consistently.
   */
  resolveEffectiveContextWindow(
    model: Model | undefined,
    configured: number | undefined = this.getConfiguredContextWindow(model),
    modelKey: string = model?.key ?? this.getModel(),
  ): number {
    const entry = this.getSessionModelCapabilities(modelKey, model);
    const capacity =
      entry?.kind === 'custom' ? entry.maxInputTokens : tokenLimit(model);
    if (!isContextWindowConfigEnabled()) return capacity;
    return resolveContextWindow(entry, configured, capacity);
  }

  /** 0 表示输入尚未应用；首次应用或会话切模后不再重放原始输入。 */
  private modelSelectionRevision = 0;

  async setModel(
    newModel: string,
    isTemporary: boolean = true,
  ): Promise<boolean> {
    const revision = ++this.modelSelectionRevision;
    const identity = this.getModelRequestIdentity();
    const sessionId = this.getSessionId();
    // 锚点写入前先取旧 key：切换事件的门闩按「切换前后是否同一模型」判定。
    const previousKey = this.getModel();
    const [listed, previousModel] = await Promise.all([
      this.modelProviderManager.getModel(newModel),
      this.modelProviderManager.getModel(previousKey),
    ]);
    // Switching from the TUI must not bypass the startup permission decision
    // or persist a model the current account cannot use.
    if (
      this.isConfiguredCustomProviderModelKey(listed?.key ?? newModel, listed)
    ) {
      await this.waitForCustomProviderAccess({ identity });
    }
    if (
      revision !== this.modelSelectionRevision ||
      identity !== this.getModelRequestIdentity() ||
      sessionId !== this.getSessionId()
    )
      return false;
    const previous = previousModel
      ? this.modelProviderManager.getModelConfig(previousModel)
      : undefined;
    if (listed) this.modelProviderManager.setMainModel(listed);
    else this.modelProviderManager.setMainModelKey(newModel);
    if (previousKey !== newModel || this._activeModel !== newModel) {
      // When the user explicitly sets a model, that becomes the active model.
      this._activeModel = newModel;
      coreEvents.emitModelChanged(this.getSessionId(), newModel);
      // 偏好按模型存放在 provider，切换后只通知新旧模型偏好的差异。
      this.emitModelConfigChanges(
        newModel,
        listed ? this.modelProviderManager.getModelConfig(listed) : undefined,
        previous,
      );
    }
    const saved = isTemporary || this.onModelChange?.(newModel) !== false;
    if (!isTemporary && saved) {
      this.lastAppliedSavedModel = this.loadedSettings.merged.model?.name;
    }
    this.modelAvailabilityService.reset();
    return saved;
  }

  /** 第一轮桥接：偏好变化沿用既有会话事件通知 UI / transcript / remote。 */
  private emitModelConfigChanges(
    modelKey: string,
    next: ModelConfig | undefined,
    previous: ModelConfig | undefined,
  ): void {
    const effort = next?.reasoning?.effort;
    if (effort !== previous?.reasoning?.effort) {
      coreEvents.emitReasoningEffortChanged(
        this.getSessionId(),
        effort,
        modelKey,
      );
    }
    const contextWindow = next?.context?.contextWindow;
    if (contextWindow !== previous?.context?.contextWindow) {
      coreEvents.emitContextWindowChanged(
        this.getSessionId(),
        contextWindow,
        modelKey,
      );
    }
  }

  /**
   * Capability view of a session model: local custom-provider models first,
   * then the provider manager's listed snapshot.
   */
  private getSessionModelCapabilities(
    model: string,
    listed?: Model,
  ): SessionModelCapabilities | undefined {
    const direct = this.customProviderRegistry.getModelDescriptor(model);
    if (direct && this.isConfiguredCustomProviderModelKey(model, listed)) {
      const entry = customProviderModelCapabilities(direct);
      // Implicit models have no declared capacity; a larger configured window
      // is the user's own statement of what the endpoint accepts.
      const configured = direct.implicit
        ? this.getConfiguredContextWindow(listed)
        : undefined;
      if (configured !== undefined && configured > entry.maxInputTokens) {
        entry.maxInputTokens = configured;
      }
      return entry;
    }
    return listed ? listedModelCapabilities(listed) : undefined;
  }

  getAvailableContextWindows(model: Model | undefined): number[] {
    if (!isContextWindowConfigEnabled()) return [];
    const entry = this.getSessionModelCapabilities(
      model?.key ?? this.getModel(),
      model,
    );
    return getSupportedContextWindows(
      entry ?? { maxInputTokens: tokenLimit(model) },
    );
  }

  async activateFallbackMode(model: string): Promise<void> {
    await this.setModel(model, true);
  }

  getActiveModel(): string {
    return this._activeModel || this.getModel();
  }

  setActiveModel(model: string): void {
    if (this._activeModel !== model) {
      this._activeModel = model;
    }
  }

  setFallbackModelHandler(handler: FallbackModelHandler): void {
    this.fallbackModelHandler = handler;
  }

  // ── Pull-mode model policy（SDK headless 会话） ──
  // 独立辅助请求仍读取回调；query 通过 manager 内绑定的策略执行。
  private _getModelPolicy?: import('@qwen-code/core').GetModelPolicyCallback;

  setModelPolicyCallbacks(
    getModelPolicy:
      | import('@qwen-code/core').GetModelPolicyCallback
      | undefined,
  ): void {
    this._getModelPolicy = getModelPolicy;
    this.modelProviderManager.setSelectionPolicy(
      getModelPolicy ? createModelSelectionPolicy(getModelPolicy) : undefined,
    );
  }

  get getModelPolicy():
    | import('@qwen-code/core').GetModelPolicyCallback
    | undefined {
    return this._getModelPolicy;
  }

  /**
   * Register a callback that validates settings file content before writes.
   * The callback receives the absolute file path and the proposed content,
   * and returns an error message string if validation fails, or null if OK.
   */
  setSettingsContentValidator(
    validator: (filePath: string, content: string) => string | null,
  ): void {
    this.settingsContentValidator = validator;
  }

  /**
   * Validate proposed content for a settings file.
   * Returns an error message if validation fails, null if OK or no validator set.
   */
  validateSettingsContent(filePath: string, content: string): string | null {
    return this.settingsContentValidator?.(filePath, content) ?? null;
  }

  resetTurn(): void {
    this.modelAvailabilityService.resetTurn();
  }

  setQuotaErrorOccurred(value: boolean): void {
    this.quotaErrorOccurred = value;
  }

  getQuotaErrorOccurred(): boolean {
    return this.quotaErrorOccurred;
  }

  private getQuotaField(
    field: 'remaining' | 'limit' | 'resetTime',
  ): number | string | undefined {
    if (
      this.getContentGeneratorConfig()?.authType === AuthType.QODER_BROWSER ||
      this.getContentGeneratorConfig()?.authType === AuthType.QODER_PAT
    ) {
      return undefined;
    }
    const primaryModel = this.getModel();
    return this.modelQuotas.get(primaryModel)?.[field];
  }

  getQuotaRemaining(): number | undefined {
    return this.getQuotaField('remaining') as number | undefined;
  }

  getQuotaLimit(): number | undefined {
    return this.getQuotaField('limit') as number | undefined;
  }

  getQuotaResetTime(): string | undefined {
    return this.getQuotaField('resetTime') as string | undefined;
  }

  getEmbeddingModel(): string {
    return this.embeddingModel;
  }

  getTargetDir(): string {
    return this.targetDir;
  }

  setTargetDir(dir: string): void {
    this.targetDir = path.resolve(dir);
  }

  getProjectRoot(): string {
    return this.targetDir;
  }

  /**
   * 会话归属的稳定项目目录。进入或退出 Worktree 只切换运行目录，主
   * JSONL、子会话记录和任务元数据始终归属进入前的项目目录，避免同一
   * 会话的持久化状态分散到多个目录。
   */
  getSessionArtifactProjectRoot(): string {
    return this.worktreeSettings?.originalCwd ?? this.targetDir;
  }

  getActiveSessionTranscriptPath(): string {
    return (
      this.sessionRuntimeBinding?.getTranscriptPath?.() ??
      getSessionTranscriptPath(
        this.getSessionArtifactProjectRoot(),
        this.getSessionId(),
      )
    );
  }

  getWorkspaceContext(): WorkspaceContext {
    return this.workspaceContext;
  }

  getAgentRegistry(): AgentRegistry {
    return this.agentRegistry;
  }

  /**
   * The session's user/project resource allowlist derived from
   * `allowedAgentSources`; undefined means no filtering.
   */
  private getAllowedResourceSources(): Array<'user' | 'project'> | undefined {
    return this.allowedAgentSources?.filter(
      (source): source is 'user' | 'project' =>
        source === 'user' || source === 'project',
    );
  }

  /**
   * Full user/project discovery order from the latest committed snapshots.
   * The resource package no longer filters user/project sources, so the
   * session's allowlist is applied here.
   */
  getResourceAgentDefinitions(): AgentResourceDefinition[] {
    const allowed = this.getAllowedResourceSources();
    const candidates =
      this.resourceViews?.agents.getAllDiscoveredAgents() ?? [];
    return allowed
      ? candidates.filter((agent) =>
          allowed.includes(agent.metadata.source as 'user' | 'project'),
        )
      : candidates;
  }

  getResourceAgentLoadErrors(): readonly AgentResourceLoadError[] {
    const allowed = this.getAllowedResourceSources();
    const errors = this.resourceViews?.agents.getLoadErrors() ?? [];
    return allowed
      ? errors.filter((error) =>
          allowed.includes(error.source as 'user' | 'project'),
        )
      : errors;
  }

  /** @deprecated Use toolRegistry getter */
  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getSkillManager(): SkillManager {
    return this.skillManager;
  }

  /**
   * Lazily create the manager; rebuild after a session switch (e.g. /clear)
   * so persistence follows the new session id.
   */
  getGoalManager(): GoalManager {
    if (!this.goalManager || this.goalManager.sessionId !== this._sessionId) {
      this.goalManager = new GoalManager(
        new GoalStorage(Storage.getProjectStateDir(), this._sessionId),
        this._sessionId,
      );
    }
    return this.goalManager;
  }

  getSkillVisibilityOverrides(): Record<
    string,
    'on' | 'name-only' | 'user-invocable-only' | 'off'
  > {
    return this.skillVisibilityOverrides;
  }

  getSkillListingMaxDescChars(): number {
    return (
      this.skillListingMaxDescChars ?? DEFAULT_SKILL_LISTING_MAX_DESC_CHARS
    );
  }

  getSkillListingBudgetFraction(): number {
    return (
      this.skillListingBudgetFraction ?? DEFAULT_SKILL_LISTING_BUDGET_FRACTION
    );
  }

  getDebugMode(): boolean {
    return this.debugMode;
  }
  getQuestion(): string | undefined {
    return this.question;
  }

  /**
   * Returns the effective question with the session agent's initialPrompt
   * prepended (if applicable). Call after config.initialize() so the session
   * agent definition is resolved.
   */
  getEffectiveQuestion(): string | undefined {
    const question = this.question;
    const sessionAgentDef = this.getSessionAgentDefinition();
    if (sessionAgentDef?.kind === 'local' && sessionAgentDef.initialPrompt) {
      return question
        ? `${sessionAgentDef.initialPrompt}\n\n${question}`
        : sessionAgentDef.initialPrompt;
    }
    return question;
  }

  getHasAccessToPreviewModel(): boolean {
    return this.hasAccessToPreviewModel !== false;
  }

  setHasAccessToPreviewModel(hasAccess: boolean | null): void {
    this.hasAccessToPreviewModel = hasAccess;
  }

  getCoreTools(): string[] | undefined {
    return this.coreTools;
  }

  getMainAgentTools(): string[] | undefined {
    return this.mainAgentTools;
  }

  /**
   * All the excluded tools from static configuration, loaded extensions, or
   * other sources (like the Policy Engine).
   *
   * May change over time.
   */
  getExcludeTools(
    _toolMetadata?: Map<string, Record<string, unknown>>,
    allToolNames?: Set<string>,
  ): Set<string> | undefined {
    // Right now this is present for backward compatibility with settings.json exclude
    const excludeToolsSet = new Set([...(this.excludeTools ?? [])]);
    // Tool-wide deny rules hide the tool entirely, whichever source wrote them.
    const denyRules = this.permission?.getRules().deny;
    if (denyRules) {
      for (const ruleList of Object.values(denyRules)) {
        for (const rule of ruleList) {
          // Tool-wide deny rules exclude the tool entirely. The parser treats
          // "Read", "Read()" and "Read(*)" alike, so all three must hide the
          // tool no matter which source (CLI flag or settings) supplied them.
          // Rules with args (e.g. "ShellTool(rm -rf)") are conditional
          // and should NOT exclude the tool entirely.
          // But Agent(name) expressions ARE type-based exclusions that need to
          // flow to _buildExcludedTypesSet() via collectAgentNamesFromToolSpecs().
          const { toolName, ruleContent } = permissionRuleValueFromString(rule);
          if (ruleContent === undefined) {
            excludeToolsSet.add(toolName);
            // MCP deny rules may target a whole namespace ("mcp__*",
            // "mcp__server__*", bare "mcp__server"). Those are tool-level
            // exclusions too, but the registry matches exclude entries by
            // exact qualified name, so expand the rule into the concrete
            // tool names currently registered — with the same matcher the
            // call-time deny path uses, keeping hiding and denial in sync.
            if (allToolNames && isMcpName(toolName)) {
              for (const knownName of allToolNames) {
                if (mcpToolNameMatchesRule(knownName, toolName)) {
                  excludeToolsSet.add(knownName);
                }
              }
            }
          } else if (parseAgentToolExpression(rule)) {
            excludeToolsSet.add(rule);
          }
        }
      }
    }

    return excludeToolsSet;
  }

  getMcpServerCommand(): string | undefined {
    return this.mcpServerCommand;
  }

  /**
   * Effective MCP server map: disk source merged with dynamic source. When
   * the same name exists in both buckets, the dynamic entry overrides the
   * disk entry (CC-aligned overlay semantics — see
   * docs/design/mcp-source-model.md).
   *
   * Returns `undefined` only when neither bucket has been populated (matches
   * legacy behavior so callers gating on `getMcpServers() != null` keep
   * working).
   *
   * Does NOT include MCP servers configured by extensions/plugins (those
   * are merged at a later stage by AppContainer).
   */
  getMcpServers(): Record<string, MCPServerConfig> | undefined {
    const disk = this.diskMcpServers;
    const dyn = this.dynamicMcpServers;
    if (!disk && Object.keys(dyn).length === 0) {
      return undefined;
    }
    return { ...(disk ?? {}), ...dyn };
  }

  /** Disk-backed MCP servers only (settings.json / .mcp.json / flag). */
  getDiskMcpServers(): Record<string, MCPServerConfig> | undefined {
    return this.diskMcpServers;
  }

  /**
   * Runtime-injected MCP servers only (ACP session/new, mcp_set_servers
   * control command). Always returns a (possibly empty) object.
   */
  getDynamicMcpServers(): Record<string, MCPServerConfig> {
    return this.dynamicMcpServers;
  }

  getMcpEnabled(): boolean {
    return this.mcpEnabled;
  }

  /** Whether ambient settings.json / .mcp.json MCP sources are allowed. */
  getMcpSettingsSourcesEnabled(): boolean {
    return this.mcpSettingsSourcesEnabled;
  }

  getPluginMcpServersEnabled(): boolean {
    return this.pluginMcpServersEnabled;
  }

  /**
   * 有效的 MCP lazy 配置。开启时始终使用元工具，不依赖已连接的工具数量。
   * 有 CodeMode 时不论此偏好如何，MCP 工具都完整注册并交由脚本发现，见 resolveMcpRegistration。
   * 管理器在注册表接入和配置变化时同步应用。
   */
  getMcpLazyLoad(): boolean {
    return this.mcpLazyLoad;
  }

  /** Current rollout for settings that take effect after restart, regardless of local mode. */
  isCodeModeFeatureGateEnabled(): boolean {
    return getCodeModeFeatureConfig().enabled;
  }

  /** What an unset `codeMode.mode` resolves to on the next start; reads the live gate like isCodeModeFeatureGateEnabled. */
  getCodeModeDefaultMode(): CodeModeSetting {
    const gate = getCodeModeFeatureConfig();
    return isCodeModeSupported() && gate.enabled ? gate.defaultMode : 'off';
  }

  /**
   * CodeMode exposure when it is enabled and this runtime supports it. MCP
   * registration and tool exposure read this instead of the tool registry.
   */
  getCodeModeExposure(): CodeModeExposure | undefined {
    if (!isCodeModeSupported()) return undefined;
    const gate = this.codeModeFeatureConfig ?? getCodeModeFeatureConfig();
    return gate.enabled
      ? resolveCodeModeExposure(this.getSetting('codeMode'), gate.defaultMode)
      : undefined;
  }

  getMcpLazyLoadSource(): 'default' | 'settings' | 'environment' {
    return this.mcpLazyLoadSource;
  }

  /** Visible for testing / runtime override. */
  setMcpLazyLoad(value: boolean): void {
    this.mcpLazyLoad = value;
    this.mcpClientManager?.setLazyMode(value);
  }

  getMcpEnablementCallbacks(): McpEnablementCallbacks | undefined {
    return this.mcpEnablementCallbacks;
  }

  getMcpClientManager(): SessionMcpManager | undefined {
    return this.mcpClientManager;
  }

  /** Session-level elicitation service; only session-owned servers receive it. */
  getElicitationHost(): McpElicitationHost {
    if (!this.elicitationHost) {
      this.elicitationHost = new McpElicitationHost({
        getHookSystem: () => this.getHookSystem(),
        emitDiagnostic: (severity, message, error, serverName) => {
          if (this.mcpClientManager) {
            this.mcpClientManager.emitDiagnostic(
              severity,
              message,
              error,
              serverName,
            );
          } else {
            coreEvents.emitFeedback(severity, message, error);
          }
        },
      });
    }
    return this.elicitationHost;
  }

  /** Alias for the session MCP manager (new-architecture naming). */
  getSessionMcpManager(): SessionMcpManager | undefined {
    return this.mcpClientManager;
  }

  /** Process-level pool borrowed by nested session configs (ACP). */
  getProcessMcpManager(): McpManager | undefined {
    return this.resolvedMcpManager ?? this.mcpManager;
  }

  /**
   * Builds a session-local pool for embedded/test callers that have no
   * application-level McpManager. Production entries inject the framework pool.
   */
  private createSessionLocalMcpManager(): McpManager {
    return new McpManager(
      this.resourceService,
      createDefaultMcpConnectorMap(),
      this.clientVersion,
      this.getDebugMode(),
      this.sanitizationConfig,
    );
  }

  // ── McpSessionContext (consumed by SessionMcpManager) ────────────────────

  mcpToolListChange(): void {
    this.applyMcpToolRegistration();
    void this.refreshMcpContext();
  }

  registerLazyMetaTools(registry: ToolRegistry): void {
    registerLazyMcpMetaTools(registry, this);
  }

  isServerEnabled(name: string): boolean {
    const callbacks = this.getMcpEnablementCallbacks();
    if (callbacks?.isSessionDisabled?.(name)) return false;
    const config = this.getMcpServers()?.[name];
    if (config?.disabled && config.scope !== 'dynamic') return false;
    return true;
  }

  getMcpServerDenyMessage(serverName: string): string | undefined {
    return this.mcpClientManager?.getMcpServerDenyMessage(serverName);
  }

  /** Registers exactly the set the session manager says is injectable. */
  private applyMcpToolRegistration(): void {
    const plan = this.mcpClientManager?.getInjectedMcpTools();
    if (!plan) return;

    const nextByServer = new Map<string, Set<string>>();
    for (const entry of plan.tools) {
      let set = nextByServer.get(entry.serverName);
      if (!set) {
        set = new Set();
        nextByServer.set(entry.serverName, set);
      }
      set.add(entry.qualifiedName);
      // A rediscovered tool can keep its name but carry a new definition.
      if (this._toolRegistry.getKnownTool(entry.qualifiedName) !== entry.tool) {
        this._toolRegistry.registerTool(entry.tool);
      }
    }
    for (const [serverName, previous] of this.registeredMcpTools) {
      const next = nextByServer.get(serverName) ?? new Set<string>();
      for (const name of previous) {
        if (!next.has(name)) this._toolRegistry.unregisterTool(name);
      }
    }
    this.registeredMcpTools = nextByServer;

    if (plan.includeMetaTools) {
      this.registerLazyMetaTools(this._toolRegistry);
    }
    this._toolRegistry.sortTools();
  }

  getAllowedMcpServers(): string[] | undefined {
    return this.allowedMcpServers;
  }

  getBlockedMcpServers(): string[] | undefined {
    return this.blockedMcpServers;
  }

  get sanitizationConfig(): EnvironmentSanitizationConfig {
    return {
      allowedEnvironmentVariables: this.allowedEnvironmentVariables,
      blockedEnvironmentVariables: this.blockedEnvironmentVariables,
      enableEnvironmentVariableRedaction:
        this.enableEnvironmentVariableRedaction,
    };
  }

  /**
   * Replace the disk-backed MCP server map. Does NOT touch the dynamic
   * bucket. Use this for plugin merges and UI delete operations that
   * rewrite settings on disk.
   */
  setDiskMcpServers(mcpServers: Record<string, MCPServerConfig>): void {
    this.diskMcpServers = mcpServers;
  }

  /**
   * Replace the runtime-injected MCP server map (ACP session/new,
   * `mcp_set_servers` control command). Each entry's `scope` is forced to
   * `'dynamic'`; the disk bucket is unchanged.
   */
  setDynamicMcpServers(mcpServers: Record<string, MCPServerConfig>): void {
    this.dynamicMcpServers = tagScope(mcpServers, 'dynamic');
  }

  getUserMemory(): string | HierarchicalMemory {
    if (this.memoryContextManager) {
      return {
        global: this.memoryContextManager.getGlobalMemory(),
        plugin: this.memoryContextManager.getPluginMemory(),
        project: this.memoryContextManager.getEnvironmentMemory(),
        local: this.memoryContextManager.getLocalMemory(),
        jit: this.memoryContextManager.getJitMemory(),
      };
    }
    return this.userMemory;
  }

  /**
   * Refreshes the MCP context, including memory, tools, and system instructions.
   */
  async refreshMcpContext(): Promise<void> {
    const sessionId = this.getSessionId();
    const startedAt = Date.now();
    emitSessionPhaseStarted({
      sessionId,
      phase: 'mcp_context.refresh',
    });
    try {
      if (this.memoryContextManager) {
        await this.memoryContextManager.refresh('session_start', {
          notifyAgentsMdSizeWarning: false,
        });
      }
      await this.refreshSessionToolsAndPromptIfInitialized();
      emitSessionPhaseFinished({
        sessionId,
        phase: 'mcp_context.refresh',
        durationMs: Date.now() - startedAt,
        success: true,
      });
    } catch (error) {
      emitSessionPhaseFinished({
        sessionId,
        phase: 'mcp_context.refresh',
        durationMs: Date.now() - startedAt,
        success: false,
        error,
      });
      throw error;
    }
  }

  /**
   * Returns memory for the system instruction (Tier 1).
   * Returns Tier 1 (global) memory.
   *
   * Previously injected into the system instruction; now global memory is
   * delivered via prependUserContext() (ephemeral first user message). This method
   * is still used by subagent prompt construction (run-agent.ts).
   */
  getSystemInstructionMemory(): string | HierarchicalMemory {
    if (this.memoryContextManager) {
      return this.memoryContextManager.getGlobalMemory();
    }
    return this.userMemory;
  }

  /**
   * Returns Tier 2 memory (extension + project + local) for injection into
   * the first user message. Extension, project, and local memory are placed
   * here per the tiered context model.
   */
  getSessionMemory(): string {
    if (!this.memoryContextManager) {
      return '';
    }
    const sections: string[] = [];
    const plugin = this.memoryContextManager.getPluginMemory();
    const project = this.memoryContextManager.getEnvironmentMemory();
    const local = this.memoryContextManager.getLocalMemory();
    if (plugin?.trim()) {
      sections.push(`<plugin_context>\n${plugin.trim()}\n</plugin_context>`);
    }
    if (project?.trim()) {
      sections.push(`<project_context>\n${project.trim()}\n</project_context>`);
    }
    if (local?.trim()) {
      sections.push(`<local_context>\n${local.trim()}\n</local_context>`);
    }
    if (sections.length === 0) return '';
    return `\n<loaded_context>\n${sections.join('\n')}\n</loaded_context>`;
  }

  getMemoryContextManager(): MemoryContextManager | undefined {
    return this.memoryContextManager;
  }

  configureSdkMemory(params: {
    active: boolean;
    generationEnabled: boolean;
    consumptionEnabled: boolean;
    projectScope?: boolean;
    userScope?: boolean;
    suppressNativeAutoMemory?: boolean;
  }): void {
    this.sdkMemoryRequestActive = params.active;
    this.sdkMemoryGenerationEnabled = params.generationEnabled;
    this.sdkMemoryConsumptionEnabled = params.consumptionEnabled;
    this.sdkMemoryProjectScopeEnabled = params.projectScope;
    this.sdkMemoryUserScopeEnabled = params.userScope;
    this.sdkMemorySuppressNativeAutoMemory =
      params.suppressNativeAutoMemory ?? false;
  }

  isSdkMemoryRequestActive(): boolean {
    return this.sdkMemoryRequestActive;
  }

  configureSdkSkillEvolution(active: boolean): void {
    this.sdkSkillEvolutionRequestActive = active;
  }

  /** True when the SDK owns any post-turn review pipeline for this session. */
  isSdkManagedReviewActive(): boolean {
    return this.sdkMemoryRequestActive || this.sdkSkillEvolutionRequestActive;
  }

  isAutoMemoryConsumptionEnabled(): boolean {
    if (!this.interactive && this.sdkMemoryRequestActive) {
      return this.sdkMemoryConsumptionEnabled;
    }
    return this.isAutoMemoryEnabled();
  }

  setSdkMemoryContext(context: Record<string, string> | undefined): void {
    this.sdkMemoryContext = context;
  }

  getSdkMemoryContext(): Record<string, string> | undefined {
    return this.sdkMemoryContext;
  }

  shouldSuppressNativeAutoMemoryForSdk(): boolean {
    return this.sdkMemorySuppressNativeAutoMemory;
  }

  setSdkMemoryFileStates(
    states: ReadonlyArray<{
      filePath: string;
      content: string;
      timestamp: number;
      isPartialView?: boolean;
      retainIfMissing?: boolean;
    }>,
  ): void {
    this.sdkMemoryFileStates = states;
  }

  getSdkMemoryFileStates(): typeof this.sdkMemoryFileStates {
    return this.sdkMemoryFileStates;
  }

  isContextManagementEnabled(): boolean {
    return this.contextManagement.enabled;
  }

  getMemoryBoundaryMarkers(): readonly string[] {
    return this.memoryBoundaryMarkers;
  }

  getAgentsMdExcludes(): readonly string[] {
    return this.agentsMdExcludes;
  }

  isAutoMemoryEnabled(): boolean {
    // Single method gating every auto-memory call site (read-file JIT,
    // memoryContextManager, agent-setup, system-prompt assembler, /memory
    // manage, AppContainer hooks, acp/remote propagation, background
    // extraction). Headless sessions use their own independent environment
    // master switch so existing CI and scripted calls remain silent by default.
    if (!this.interactive && this.sdkMemoryRequestActive) {
      return this.sdkMemoryGenerationEnabled;
    }

    if (!this.interactive && !isAutoMemoryHeadlessEnvEnabled()) return false;

    if (!this.interactive) {
      const projectEnabled = getAutoMemoryHeadlessProjectEnvOverride() ?? true;
      const userEnabled = getAutoMemoryHeadlessUserEnvOverride() ?? true;
      return projectEnabled || userEnabled;
    }

    const scopes = this.resolveInteractiveAutoMemoryScopes();
    return scopes.projectEnabled || scopes.userEnabled;
  }

  isAutoMemoryFeatureGateEnabled(): boolean {
    return resolveAutoMemoryFeatureGateEnabled();
  }

  isAutoMemoryManuallyEnabled(): boolean {
    return this.isAutoMemoryEnabled();
  }

  private handleAutoMemoryFeatureGateChange(): void {
    // Headless and SDK sessions do not consume the TUI QCS default. When both
    // local scope settings are explicit, QCS cannot change the effective state.
    if (
      !this.interactive ||
      (this.autoMemoryEnabled !== undefined &&
        this.autoMemoryUserScopeEnabled !== undefined) ||
      !this.initialized
    ) {
      return;
    }

    void (async () => {
      await this.memoryContextManager?.refresh('session_start', {
        notifyAgentsMdSizeWarning: false,
      });
      this._promptAssembler?.clearCache();
      this.updateSystemInstructionIfInitialized();
    })().catch((error: unknown) => {
      runLogger.warn('[Config] Failed to apply auto_memory feature gate:', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private resolveInteractiveAutoMemoryScopes(): {
    projectEnabled: boolean;
    userEnabled: boolean;
  } {
    const remote = getAutoMemoryFeatureGateConfig();
    return {
      projectEnabled: this.autoMemoryEnabled ?? remote.projectEnabled,
      userEnabled: this.autoMemoryUserScopeEnabled ?? remote.userEnabled,
    };
  }

  /**
   * Whether PROJECT-scope auto-memory is active for generation or consumption.
   * SDK may override this scope per Query.
   */
  isAutoMemoryProjectScopeEnabled(): boolean {
    const autoMemoryActive =
      this.isAutoMemoryEnabled() || this.isAutoMemoryConsumptionEnabled();
    if (!autoMemoryActive) return false;
    if (this.sdkMemoryRequestActive) {
      return this.sdkMemoryProjectScopeEnabled ?? true;
    }
    if (!this.interactive) {
      return getAutoMemoryHeadlessProjectEnvOverride() ?? true;
    }
    return this.resolveInteractiveAutoMemoryScopes().projectEnabled;
  }

  /**
   * Whether USER-scope (cross-project) auto-memory is active for generation or
   * consumption. SDK may override this scope per Query.
   */
  isAutoMemoryUserScopeEnabled(): boolean {
    const autoMemoryActive =
      this.isAutoMemoryEnabled() || this.isAutoMemoryConsumptionEnabled();
    if (!autoMemoryActive) return false;
    if (this.sdkMemoryRequestActive) {
      return this.sdkMemoryUserScopeEnabled ?? true;
    }
    if (!this.interactive) {
      return getAutoMemoryHeadlessUserEnvOverride() ?? true;
    }
    return this.resolveInteractiveAutoMemoryScopes().userEnabled;
  }

  getDreamSettings(): DreamSettings {
    return this.dreamSettings;
  }

  /**
   * Creation defaults applied when this session explicitly requests a worktree.
   * Never consulted for sessions that do not ask for one.
   */
  getWorktreeCreationSettings(): WorktreeCreationSettings {
    return this.worktreeCreationSettings;
  }

  isTopicUpdateNarrationEnabled(): boolean {
    return this.topicUpdateNarration;
  }

  isModelSteeringEnabled(): boolean {
    return this.modelSteering;
  }

  async getToolOutputMaskingConfig(): Promise<ToolOutputMaskingConfig> {
    return { ...this.contextManagement.tools.outputMasking };
  }

  getMemoryMdFileCount(): number {
    if (this.memoryContextManager) {
      return this.memoryContextManager.getLoadedPaths().size;
    }
    return this.memoryMdFileCount;
  }

  /**
   * Returns memory file paths grouped by type (global, project, local, extension).
   * Includes JIT-discovered nested memory files so the Memory management UI
   * reflects files that have been injected on-demand.
   */
  getCategorizedMemoryPaths(): {
    global: readonly string[];
    plugin: readonly string[];
    project: readonly string[];
    local: readonly string[];
  } | null {
    return this.memoryContextManager?.getCategorizedPathsWithJit() ?? null;
  }

  /**
   * The primary context filename for this session, e.g. `AGENTS.md`.
   *
   * Callers that only name one file want this one; discovery walks the full
   * list from {@link getAllContextFileNames}.
   */
  getCurrentContextFileName(): string {
    return this.contextFilenames[0];
  }

  /** Every context filename this session treats as project memory. */
  getAllContextFileNames(): readonly string[] {
    return this.contextFilenames;
  }

  /**
   * The private `.local.md` counterparts of {@link getAllContextFileNames},
   * e.g. `AGENTS.md` -> `AGENTS.local.md`.
   */
  getAllLocalContextFileNames(): string[] {
    return deriveLocalContextFilenames(this.contextFilenames);
  }

  getMemoryMdFilePaths(): string[] {
    if (this.memoryContextManager) {
      return Array.from(this.memoryContextManager.getLoadedPaths());
    }
    return this.memoryMdFilePaths;
  }

  getFailedMemoryFiles(): ReadonlyArray<{ path: string; error: string }> {
    return this.memoryContextManager?.getFailedFiles() ?? [];
  }

  /**
   * The current permission mode.
   *
   * The module owns the mode once the CLI has assembled it. The locally requested
   * mode is the answer only before that — during early startup, and in tests that
   * never build one.
   */
  getPermissionMode(): PermissionMode {
    return this.permission?.getPermissionMode() ?? this.permissionMode;
  }

  setHideInteractiveTools(value: boolean): void {
    this.hideInteractiveTools = value;
  }

  shouldHideInteractiveTools(): boolean {
    return this.hideInteractiveTools;
  }

  isPlanMode(): boolean {
    return this.planStateManager.isActive;
  }

  /**
   * Notify the system that plan state has changed (entered or exited).
   *
   * Triggers the same side effects that setPermissionMode('plan') used to:
   * - Rebuilds session tools (plan mode has a different tool set)
   * - Rebuilds system instructions (plan mode uses specialized prompts)
   */
  notifyPlanStateChanged(): void {
    // Persist plan state into the active goal (for resume after restart)
    this.getGoalManager().syncPlanState(this.planStateManager.isActive);
    // Emit event so subscribers (query-engine, TUI) can react
    coreEvents.emitPlanStateChanged(
      this.getSessionId(),
      this.planStateManager.isActive,
    );
    // Trigger rebuilds (same as the deferred timer in setPermissionMode)
    this.refreshSessionToolsIfInitialized({
      resetModelRouting: true,
    }).catch((err) => {
      runLogger.error('Failed to update tools after plan state change', err);
    });
    this.updateSystemInstructionIfInitialized();
  }

  /**
   * Clear pre-approved prompts (called on plan mode entry to reset
   * authorizations from a previous plan session).
   */
  resetPreApprovedPrompts(): void {
    this._preApprovedPrompts = [];
  }

  /**
   * Sets the permission mode using PermissionMode string.
   * This is the canonical setter; it updates the local fallback and, when
   * available, the permission pipeline context.
   */
  /**
   * Whether a classifier model resolves for this session.
   *
   * Auto mode hands every tool decision to that model, so a session without one
   * can only fail closed. This deliberately checks the *model*, not whether the
   * classifier delegate has finished initialising — that happens later in
   * startup, and testing it here would make a healthy session look unsupported.
   */
  private isAutoModeClassifierModelAvailable(): boolean {
    if (!this.permission) return !!this.getModel();
    const settings = this.permission.getAutoJudgmentSettings();
    if (
      settings.classifier === 'jev' &&
      this.permission.isAutoModeJevEnabled()
    ) {
      return !!settings.judgment;
    }
    return !!this.getModel();
  }

  setPermissionMode(
    mode: PermissionMode,
    telemetryContext: PermissionModeChangeTelemetryContext = {},
  ): void {
    const restriction = this.getLocalPermissionModeRestriction(mode);
    if (restriction !== undefined) {
      throw new PermissionModeUnavailableError(restriction);
    }
    const currentMode = this.getPermissionMode();
    if (currentMode !== mode) {
      runLogger.log(
        `[permission-mode] ${currentMode} → ${mode}` +
          (telemetryContext.trigger
            ? ` trigger=${telemetryContext.trigger}`
            : ''),
      );
    }

    // Plan lifecycle is managed by planStateManager + notifyPlanStateChanged().
    // Exception — some modes are mutually exclusive with plan state (see
    // isPlanStateBlockedByMode): switching into one force-exits the active plan
    // session with a user notice. Centralised here so every entry point
    // (Shift+Tab, SDK/RC control_request, goal orchestration) is covered.
    if (isPlanStateBlockedByMode(mode) && this.planStateManager.isActive) {
      this.planStateManager.exit();
      this.notifyPlanStateChanged();
      coreEvents.emitFeedback('warning', PLAN_MODE_FORCE_EXITED_MESSAGE);
    }

    this.permission?.setPermissionMode(mode);
    this.permissionMode = mode;

    // Defer heavy side-effects (tool recalculation, system
    // instruction rebuild) so the keypress handler returns immediately and the
    // UI re-renders without blocking.  These operations are only needed before
    // the next LLM turn, not for the mode indicator to update.
    //
    // Debounce: if the user presses Shift+Tab rapidly, cancel the previous
    // pending side-effect work and only run once for the final mode.
    if (this._modeSwitchSideEffectTimer !== null) {
      clearTimeout(this._modeSwitchSideEffectTimer);
    }
    this._modeSwitchSideEffectTimer = setTimeout(() => {
      this._modeSwitchSideEffectTimer = null;

      // Only rebuild tools/system-instruction on transitions that change
      // the available tool set (bypassPermissions ↔ non-bypassPermissions).
      // Plan transitions are handled by notifyPlanStateChanged().
      const finalMode = this.getPermissionMode();
      const needsToolRebuild = isYoloMode(finalMode) || isYoloMode(currentMode);

      if (needsToolRebuild) {
        this.refreshSessionToolsIfInitialized({
          resetModelRouting: true,
        }).catch((err) => {
          runLogger.error('Failed to update tools', err);
        });
        this.updateSystemInstructionIfInitialized();
      }
    }, 0);

    if (currentMode !== mode) {
      coreEvents.emitPermissionModeChanged(
        this.getSessionId(),
        mode,
        currentMode,
      );
    }
  }

  isYoloModeDisabled(): boolean {
    return this.disableYoloMode || !this.isTrustedFolder();
  }

  getRawOutput(): boolean {
    return this.rawOutput;
  }

  getAcceptRawOutputRisk(): boolean {
    return this.acceptRawOutputRisk;
  }

  getPendingIncludeDirectories(): string[] {
    return this.pendingIncludeDirectories;
  }

  /**
   * Returns additional directories (from --add-dir, trusted permission
   * directories, IDE workspaces, and runtime addDirectory calls) excluding the
   * project root. Used to discover skills from these extra directories.
   */
  private getIncludeDirectories(): string[] {
    return this.getWorkspaceContext()
      .getDirectories()
      .filter((d) => d !== this.targetDir);
  }

  clearPendingIncludeDirectories(): void {
    this.pendingIncludeDirectories = [];
  }

  /**
   * Returns the parsed value for a top-level settings section by delegating
   * to the reader supplied at Config construction. Returns undefined when
   * the CLI omitted the reader or the section is absent. Config does not
   * store a copy of the settings map and does not re-read files here.
   */
  getSetting(section: string): unknown {
    return this.settingsReader(section);
  }

  /**
   * Returns the caller-owned instance for scoped reads, writes and subscriptions.
   */
  getLoadedSettings(): LoadedSettings {
    return this.loadedSettings;
  }

  /** Returns the complete merged settings snapshot of this session. */
  getSettings(): unknown {
    return this.allSettingsReader();
  }

  /** Returns one invocation-only setting without reading persisted config. */
  getLaunchSetting(section: string): unknown {
    return this.launchSettingsReader(section);
  }

  async refreshSessionToolsIfInitialized(
    options: Pick<SessionRuntimeRefreshOptions, 'resetModelRouting'> = {},
  ): Promise<void> {
    if (!this.sessionRuntimeBinding) {
      return;
    }

    await this.sessionRuntimeBinding.refreshRuntimeContext({
      refreshTools: true,
      resetModelRouting: options.resetModelRouting,
    });
  }

  private async refreshSessionSystemPromptIfInitialized(): Promise<void> {
    if (!this.sessionRuntimeBinding) {
      return;
    }

    await this.sessionRuntimeBinding.refreshRuntimeContext({
      refreshSystemPrompt: true,
    });
  }

  /**
   * Batched refresh of both tools and system prompt in a single
   * `refreshRuntimeContext` call. Preferred over calling the two
   * individual methods sequentially.
   */
  private async refreshSessionToolsAndPromptIfInitialized(): Promise<void> {
    if (!this.sessionRuntimeBinding) {
      return;
    }

    await this.sessionRuntimeBinding.refreshRuntimeContext({
      refreshTools: true,
      refreshSystemPrompt: true,
    });
  }

  /**
   * Invalidates cached system prompt sections and triggers a rebuild.
   * Called when runtime state that feeds into the system prompt changes
   * (e.g. skills discovered/removed, user memory updated).
   */
  updateSystemInstructionIfInitialized(): void {
    void this.refreshSessionSystemPromptIfInitialized();
  }

  getModelAvailabilityService(): ModelAvailabilityService {
    return this.modelAvailabilityService;
  }

  getEnableRecursiveFileSearch(): boolean {
    return this.fileFiltering.enableRecursiveFileSearch;
  }

  getFileFilteringEnableFuzzySearch(): boolean {
    return this.fileFiltering.enableFuzzySearch;
  }

  getFileFilteringRespectGitIgnore(): boolean {
    return this.fileFiltering.respectGitIgnore;
  }

  getFileFilteringRespectBrandIgnore(): boolean {
    return this.fileFiltering.respectBrandIgnore;
  }

  getCustomIgnoreFilePaths(): string[] {
    return this.fileFiltering.customIgnoreFilePaths;
  }

  getFileFilteringOptions(): FileFilteringOptions {
    return {
      respectGitIgnore: this.fileFiltering.respectGitIgnore,
      respectBrandIgnore: this.fileFiltering.respectBrandIgnore,
      maxFileCount: this.fileFiltering.maxFileCount,
      searchTimeout: this.fileFiltering.searchTimeout,
      customIgnoreFilePaths: this.fileFiltering.customIgnoreFilePaths,
    };
  }

  /**
   * Gets custom file exclusion patterns from configuration.
   * TODO: This is a placeholder implementation. In the future, this could
   * read from settings files, CLI arguments, or environment variables.
   */
  getCustomExcludes(): string[] {
    // Placeholder implementation - returns empty array for now
    // Future implementation could read from:
    // - User settings file
    // - Project-specific configuration
    // - Environment variables
    // - CLI arguments
    return [];
  }

  getFileCheckpointingEnabled(): boolean {
    return this.fileCheckpointing;
  }

  private businessType?: string;

  setBusinessType(type: string | undefined): void {
    this.businessType = type;
  }

  getBusinessType(): string | undefined {
    return this.businessType;
  }

  getProxy(): string | undefined {
    return this.proxy;
  }

  getAllowedHttpHookUrls(): readonly string[] | undefined {
    return this.allowedHttpHookUrls;
  }

  setProxy(proxy: string | undefined): void {
    this.proxy = normalizeProxyUrlIfSupported(proxy);
    this.proxyRequestIgnored = Boolean(proxy && !this.proxy);
  }

  getWorkingDir(): string {
    return this.cwd;
  }

  /** Session-scoped spill directory for oversized MCP tool output. */
  getToolResultsDir(): string {
    return this.storage.getProjectTempToolResultsDir();
  }

  setWorkingDir(dir: string): void {
    this.cwd = path.resolve(dir);
  }

  /**
   * Re-read local model configuration written by another process and apply it
   * to this running session.
   *
   * The `/model` panel's `r` refresh used to refetch only the server catalog
   * and account data. Local provider definitions were read once at startup,
   * so providers edited by another session or by hand stayed invisible until
   * restart. Re-reading the settings snapshot here also adopts a saved model
   * name that changed on disk, keeping the panel's current model in step with
   * the file.
   */
  async reloadModelConfigFromDisk(): Promise<void> {
    const revision = ++this.modelSelectionRevision;
    const identity = this.getModelRequestIdentity();
    this.onSettingsCacheInvalidate?.();
    this.loadedSettings.reload({ rejectInvalid: true });

    const settings = this.loadedSettings.merged;

    if (
      !this.customProvidersDisposed &&
      this.customProviderAccessMode !== 'disabled'
    ) {
      if (
        settings.providers &&
        Object.keys(settings.providers).length > 0 &&
        !this.canUseCustomProviders()
      ) {
        await this.ensureCustomProvidersAccess();
      }
      if (this.customProvidersDisposed) return;
      await this.replaceCustomProviderSettings(settings.providers);
    }

    if (
      revision !== this.modelSelectionRevision ||
      identity !== this.getModelRequestIdentity()
    )
      return;
    // 模型偏好由 provider 自持；磁盘上偏好的热更新留待第二轮方案。
    await this.adoptSavedModelFromSettings(settings.model?.name);
  }

  /**
   * Switch this session to the saved model when another process changed
   * `model.name` on disk. The switch stays session-scoped: the refresh reads
   * the file, it never writes the session's current model back to it.
   *
   * Models the refreshed catalog cannot resolve are skipped so a refresh never
   * strands the session on a model the router would reject.
   */
  private async adoptSavedModelFromSettings(
    nextSavedModel?: string,
  ): Promise<void> {
    if (!nextSavedModel || nextSavedModel === this.lastAppliedSavedModel)
      return;
    const revision = this.modelSelectionRevision;
    const identity = this.getModelRequestIdentity();
    const entry = await this.modelProviderManager.getModel(nextSavedModel);
    if (
      revision !== this.modelSelectionRevision ||
      identity !== this.getModelRequestIdentity() ||
      this.loadedSettings.merged.model?.name !== nextSavedModel
    )
      return;
    if (!entry) {
      runLogger.warn(
        `[config] Saved model "${nextSavedModel}" is not in the refreshed catalog; keeping "${this.getModel()}".`,
      );
      return;
    }
    if (entry.key !== this.getModel()) {
      if (!(await this.setModel(entry.key, true))) return;
    }
    this.lastAppliedSavedModel = nextSavedModel;
  }

  private getCustomProviderSettingsRecord():
    | Record<string, unknown>
    | undefined {
    const settings = this.customProviderSettings;
    if (
      typeof settings !== 'object' ||
      settings === null ||
      Array.isArray(settings)
    ) {
      return undefined;
    }
    return settings as Record<string, unknown>;
  }

  /** Apply an explicit local TUI settings edit to the live provider projection. */
  async replaceCustomProviderSettings(
    settings: unknown,
  ): Promise<CustomProvidersState> {
    if (this.customProvidersDisposed) {
      throw new Error('Custom Providers runtime has been disposed');
    }
    this.customProviderSettings = settings;
    const state = await this.activateCustomProvidersFromSettings();
    if (
      this.customProvidersDisposed ||
      settings !== this.customProviderSettings ||
      (state.status !== 'active' && state.status !== 'not_configured')
    )
      return state;

    const loaded = this.loadedSettings;
    const projectIds = new Set(
      loaded.isTrusted
        ? [
            ...Object.keys(loaded.project.settings.providers ?? {}),
            ...Object.keys(loaded.local.settings.providers ?? {}),
          ]
        : [],
    );
    const isProject = (id: string) =>
      projectIds.has(id) &&
      !Object.hasOwn(loaded.flag.settings.providers ?? {}, id);
    const entries = Object.entries(
      this.getCustomProviderSettingsRecord() ?? {},
    );
    await withModelRequestRetryConfig(this, () =>
      this.modelProviderManager.replaceCustomProviders(
        Object.fromEntries(entries.filter(([id]) => !isProject(id))),
        Object.fromEntries(entries.filter(([id]) => isProject(id))),
      ),
    );
    return state;
  }

  hasCustomProviderSettings(): boolean {
    const settings = this.getCustomProviderSettingsRecord();
    return (
      settings !== undefined &&
      Object.keys(settings).some((providerId) => !isReservedProviderId(providerId))
    );
  }

  getCustomProviderManager(): CustomProviderManager {
    if (!this.customProviderManager) {
      throw new Error('CustomProviderManager is not provided by the framework');
    }
    return this.customProviderManager;
  }

  getCustomProviderRegistry(): CustomProviderRegistry {
    return this.customProviderRegistry;
  }

  canUseCustomProviders(): boolean {
    return this.customProviderAccess.state === 'allowed';
  }

  getModelRequestIdentity(): string {
    return getModelRequestIdentity(
      this.customProviderAccessMode,
      this.modelProviders,
    );
  }

  private isCustomProviderEntryEnabled(): boolean {
    return (
      !this.customProvidersDisposed &&
      this.customProviderAccessMode !== 'disabled'
    );
  }

  private getCustomProviderInactiveReason(): CustomProvidersInactiveReason {
    return this.customProviderAccessMode === 'disabled'
      ? 'remote_worker'
      : 'feature_disabled';
  }

  getCustomProviderAccessMode(): CustomProviderAccessMode {
    return this.customProviderAccessMode;
  }

  async ensureCustomProvidersAccess(): Promise<boolean> {
    await this.customProviderAccess.refresh();
    return this.canUseCustomProviders();
  }

  waitForCustomProviderAccess(options: {
    identity: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<void> {
    return this.customProviderAccess.waitUntilReady(options);
  }

  assertCustomProviderAccess(identity: string): void {
    this.customProviderAccess.assertReady(identity);
  }

  private onCustomProviderAccessChanged(
    state: CustomProviderAccessState,
  ): void {
    if (!this.customProvidersInitialized || this.customProvidersDisposed)
      return;
    if (state === 'allowed' && this.customProvidersState.status !== 'active') {
      void this.activateCustomProvidersFromSettings().catch((error: unknown) =>
        runLogger.warn('[custom-providers] Activation failed', error),
      );
    } else if (state === 'denied') {
      this.deactivateCustomProviders(this.getCustomProviderInactiveReason());
    }
  }

  async initializeCustomProviders(): Promise<void> {
    if (this.hasCustomProviderSettings()) {
      await this.ensureCustomProvidersAccess();
    }
    if (!this.customProvidersDisposed)
      await this.activateCustomProvidersFromSettings();
  }

  getCustomProvidersState(): CustomProvidersState {
    return this.customProvidersState;
  }

  /**
   * Tear down the custom-provider registry (routes + secrets) so no exit path
   * leaves a partially-active provider behind.
   */
  private clearCustomProviderProjection(): void {
    this.customProviderRegistry.clear();
  }

  /**
   * Parse and activate local provider settings after the server catalog and
   * host-injected direct-connection overlays are ready, so model-key collision checks are stable.
   */
  async activateCustomProvidersFromSettings(): Promise<CustomProvidersState> {
    const settings = this.customProviderSettings;
    const identity = this.getModelRequestIdentity();
    const listed = this.hasCustomProviderSettings()
      ? await this.modelProviderManager.listModels()
      : [];
    if (
      this.customProvidersDisposed ||
      settings !== this.customProviderSettings ||
      identity !== this.getModelRequestIdentity()
    )
      return this.customProvidersState;
    this.customProvidersInitialized = true;
    if (!this.hasCustomProviderSettings()) {
      this.clearCustomProviderProjection();
      this.customProvidersState = { status: 'not_configured' };
      return this.customProvidersState;
    }

    const allowed = this.canUseCustomProviders();
    runLogger.log('[custom-providers] Runtime access checked', {
      source: this.customProviderAccessMode,
      allowed,
    });
    const mainModelKey = this.getModel();
    const parsed = this.customProviderRegistry.replace(
      this.customProviderSettings,
      mainModelKey ? [mainModelKey] : [],
    );
    for (const issue of parsed.issues) {
      runLogger.warn('[custom-providers] Invalid provider configuration', {
        providerId: issue.providerId,
        field: issue.field,
        message: issue.message,
      });
    }

    if (parsed.providers.length === 0) {
      this.clearCustomProviderProjection();
      // Only composer-owned entries (e.g. the Qwen account provider) mean
      // there are no generic Custom Providers, not that configuration failed:
      // reporting `invalid_configuration` would skip the manager refresh that
      // composes those entries.
      return this.publishCustomProvidersState(
        parsed.issues.length === 0
          ? { status: 'not_configured' }
          : { status: 'invalid_configuration', issues: parsed.issues },
      );
    }

    if (!allowed) {
      return this.deactivateCustomProviders(
        this.getCustomProviderInactiveReason(),
      );
    }

    const models = this.customProviderRegistry.getPublicModels();
    // Platform (and direct-connection) models own their keys; a local provider model may
    // not shadow one that the platform provider already lists.
    const platformKeys = new Set(
      listed
        .filter((model) => model.source === 'qoder')
        .map((model) => model.key),
    );
    const rejected = models
      .map((model) => model.key)
      .filter((key) => platformKeys.has(key));
    if (rejected.length > 0) {
      const collisionIssues = rejected.map((key) => ({
        providerId: key.slice(0, key.indexOf('/')) || '*',
        field: 'models',
        message: `model key '${key}' conflicts with an existing catalog model`,
      }));
      this.clearCustomProviderProjection();
      return this.publishCustomProvidersState({
        status: 'invalid_configuration',
        issues: [...parsed.issues, ...collisionIssues],
      });
    }

    return this.publishCustomProvidersState({
      status: 'active',
      providerCount: parsed.providers.length,
      modelCount: models.length,
      ...(parsed.issues.length > 0 ? { issues: parsed.issues } : {}),
    });
  }

  /**
   * Records the new state and surfaces its non-fatal issues, so every exit of
   * activateCustomProvidersFromParsed reports the warnings that go with the
   * state it publishes. States assigned elsewhere either carry no issues
   * (`not_configured`, `inactive`) or are set while an error is already
   * being thrown, where the throw — not a warning — is the report.
   */
  private publishCustomProvidersState(
    state: CustomProvidersState,
  ): CustomProvidersState {
    this.customProvidersState = state;
    for (const warning of this.getCustomProviderConfigurationWarnings()) {
      coreEvents.emitFeedback('warning', warning);
    }
    return state;
  }

  getCustomProviderConfigurationWarnings(): readonly string[] {
    return formatCustomProviderConfigurationWarnings(this.customProvidersState);
  }

  deactivateCustomProviders(
    reason: CustomProvidersInactiveReason,
  ): CustomProvidersState {
    this.customProvidersState = {
      status: 'inactive',
      reason,
    };
    this.customProviderRegistry.clearCredentials();
    return this.customProvidersState;
  }

  /**
   * Recognize a configured provider key even when the current runtime shape
   * does not activate it, so explicit `-m provider/model` requests never leak
   * through to first-party servers.
   */
  isConfiguredCustomProviderModelKey(
    modelKey: string | undefined,
    listed?: Model,
  ): boolean {
    const settings = this.getCustomProviderSettingsRecord();
    if (!modelKey || !settings) {
      return false;
    }
    // Platform BYOK owns its listed key even if local settings use that key.
    if (listed?.key === modelKey && listed.source === 'qoder') return false;
    const separator = modelKey.indexOf('/');
    if (separator <= 0) return false;
    const providerId = modelKey.slice(0, separator);
    if (isReservedProviderId(providerId)) return false;
    return Object.prototype.hasOwnProperty.call(settings, providerId);
  }

  getTaskStore(): TaskStore {
    const sessionId = this.getSessionId();
    const taskListId = resolveTaskListId({
      sessionId: isInProcessTeammateFeatureEnabled()
        ? deriveSessionTeamName(sessionId)
        : sessionId,
    });
    if (!this.taskStore || this.taskStore.taskListId !== taskListId) {
      this.taskStore = new TaskStore(
        path.join(Storage.getGlobalConfigDir(), 'tasks'),
        taskListId,
      );
    }
    return this.taskStore;
  }

  getFileService(): FileDiscoveryService {
    if (!this.fileDiscoveryService) {
      this.fileDiscoveryService = new FileDiscoveryService(this.targetDir, {
        respectGitIgnore: this.fileFiltering.respectGitIgnore,
        respectBrandIgnore: this.fileFiltering.respectBrandIgnore,
        customIgnoreFilePaths: this.fileFiltering.customIgnoreFilePaths,
      });
    }
    return this.fileDiscoveryService;
  }

  getUsageStatisticsEnabled(): boolean {
    return this.usageStatisticsEnabled;
  }

  getAcpMode(): boolean {
    return this.acpMode;
  }

  isParallelReadOnlyShellEnabled(): boolean {
    return this.parallelReadOnlyShell;
  }

  isParallelToolStreamingEnabled(): boolean {
    return this.parallelToolStreaming;
  }

  canRunAsyncRewakeHooks(): boolean {
    return this.interactive || this.canConsumeAsyncRewake;
  }

  getMcpInitializationWaitStrategy(): McpInitializationWaitStrategy {
    return this.mcpInitializationWaitStrategy;
  }

  getCliVersion(): string {
    return this.clientVersion;
  }

  async waitForMcpInit(): Promise<void> {
    if (this.mcpInitializationPromise) {
      await this.mcpInitializationPromise;
    }
  }

  /**
   * Returns all loaded plugins (replacing the extension system).
   * Plugins are pre-loaded and passed via ConfigParameters.
   */
  getPlugins(): LoadedPlugin[] {
    return this._plugins;
  }

  /**
   * Returns only enabled plugins.
   */
  getEnabledPlugins(): LoadedPlugin[] {
    return this._plugins.filter((p) => p.enabled !== false);
  }

  /**
   * Replace the loaded plugins array at runtime (used by reload).
   */
  setPlugins(plugins: LoadedPlugin[]): void {
    this._plugins = plugins;
  }

  getPluginErrors(): PluginError[] {
    return [...this._pluginErrors, ...this._pluginSyncErrors];
  }

  /** Replace errors produced by the local plugin loading pass. */
  setPluginErrors(errors: PluginError[]): void {
    this._pluginErrors = errors;
  }

  /**
   * Replace errors reported by the managed plugin sync without erasing local
   * loader errors. A later successful sync passes an empty array to clear
   * stale failures.
   */
  setPluginSyncErrors(errors: PluginError[]): void {
    this._pluginSyncErrors = errors;
  }

  private _pluginInstallPromise: Promise<unknown> | null = null;

  setPluginInstallPromise(promise: Promise<unknown>): void {
    this._pluginInstallPromise = promise;
  }

  getPluginInstallPromise(): Promise<unknown> | null {
    return this._pluginInstallPromise;
  }

  /**
   * Bin paths from enabled plugins, prepended to the Bash tool's PATH so
   * executables shipped in `<plugin>/bin/` can be invoked as bare commands.
   */
  getPluginBinPaths(): string[] {
    return this.getEnabledPlugins()
      .map((p) => p.binPath)
      .filter((p): p is string => p !== undefined);
  }

  getEnableExtensionReloading(): boolean {
    return this.enableExtensionReloading;
  }

  isPlanEnabled(): boolean {
    return this.planEnabled;
  }

  isTasksEnabled(): boolean {
    return this.tasksEnabled;
  }

  isWorktreeEnabled(): boolean {
    return resolveWorktreeEnabled();
  }

  getApprovedPlanPath(): string | undefined {
    return this.approvedPlanPath;
  }

  setApprovedPlanPath(path: string | undefined): void {
    this.approvedPlanPath = path;
  }

  /**
   * Store allowed prompts declared by exit_plan_mode for the implementation phase.
   * These are semantic Bash command categories pre-authorized by the model during plan approval.
   */
  setAllowedPrompts(prompts: Array<{ tool: 'Bash'; prompt: string }>): void {
    this._preApprovedPrompts = prompts ?? [];
  }

  /**
   * Get the pre-approved Bash prompts for the current implementation phase.
   */
  getPreApprovedPrompts(): ReadonlyArray<{ tool: 'Bash'; prompt: string }> {
    return this._preApprovedPrompts;
  }

  isAgentsEnabled(): boolean {
    return this.enableAgents;
  }

  getAllowedAgentSources(): AgentSource[] | undefined {
    return this.allowedAgentSources;
  }

  isAgentSourceAllowed(source: AgentSource): boolean {
    // Plugin source is always allowed — plugins are gated by enabledPlugins,
    // not by --setting-sources.
    if (source === 'plugin') return true;
    if (!this.allowedAgentSources) return true;
    return this.allowedAgentSources.includes(source);
  }

  /**
   * Checks whether a given setting source is allowed by the --setting-sources
   * flag. Valid CLI values are: user, project, local. Plugin source is always
   * allowed (gated by enabledPlugins, not by this flag). When the flag is not
   * provided, all sources are allowed.
   */
  isSettingSourceAllowed(source: string): boolean {
    if (source === 'plugin') return true;
    if (!this.settingSources) return true;
    return this.settingSources.includes(source);
  }

  getInlineAgentsJson(): string | undefined {
    return this.inlineAgentsJson;
  }

  getSessionAgent(): string | undefined {
    return this.sessionAgent;
  }

  getCustomSystemPrompt(): string | undefined {
    return this.customSystemPrompt;
  }

  getAppendSystemPrompt(): string | undefined {
    return this.appendSystemPrompt;
  }

  /**
   * Returns the resolved session agent definition, or undefined if no session
   * agent is configured or the named agent was not found.
   */
  getSessionAgentDefinition(): AgentDefinition | undefined {
    return this.sessionAgentDefinition;
  }

  /**
   * Returns the session agent definition adapted to the AgentDefinitionLike
   * interface for use by buildEffectiveSystemPrompt (Priority 1 path).
   */
  getSessionAgentDefinitionLike(): AgentDefinitionLike | undefined {
    const def = this.sessionAgentDefinition;
    if (!def) return undefined;
    return toAgentDefinitionLike(def, {
      config: this,
      toolRegistry: this._toolRegistry,
    });
  }

  isEventDrivenSchedulerEnabled(): boolean {
    return this.enableEventDrivenScheduler;
  }

  getNoBrowser(): boolean {
    return this.noBrowser;
  }

  getAgentsSettings(): AgentSettings {
    return this.agents;
  }

  isBrowserLaunchSuppressed(): boolean {
    return this.getNoBrowser() || !shouldAttemptBrowserLaunch();
  }

  getSummarizeToolOutputConfig():
    | Record<string, SummarizeToolOutputSettings>
    | undefined {
    return this.summarizeToolOutput;
  }

  /**
   * Returns 'true' if the folder trust feature is enabled.
   */
  getFolderTrust(): boolean {
    return this.folderTrust;
  }

  /**
   * Returns 'true' if the workspace is considered "trusted".
   * 'false' for untrusted.
   */
  isTrustedFolder(): boolean {
    // Default to untrusted if folder trust is enabled and no explicit value is set.
    return this.folderTrust ? (this.trustedFolder ?? false) : true;
  }

  /**
   * Updates the trusted folder state at runtime without requiring a process restart.
   * This is called when the user makes a trust decision via the folder trust dialog
   * or the /permissions command.
   */
  setTrustedFolder(isTrusted: boolean): void {
    if (this.trustedFolder === isTrusted) return;
    this.trustedFolder = isTrusted;

    if (isTrusted) {
      // Project-level rules were unreadable while the workspace was untrusted,
      // so deny/allow/ask from <project>/.qwen/settings.json had never been
      // applied. Read them now and merge: replacing would drop the rules from
      // the sources that were readable all along. Anything already waiting on a
      // decision gets re-checked by the module against the new set.
      const accessor = createSettingsAccessor({ storage: this.storage });
      const trustGatedRules = loadAllPermissionRulesFromDisk(accessor).filter(
        (rule) =>
          rule.source === 'projectSettings' || rule.source === 'localSettings',
      );

      if (trustGatedRules.length > 0) {
        this.permission?.setRules(rulesToPermissionRules(trustGatedRules), {
          merge: true,
        });
      }

      // 启动期因未信任被降级的请求模式，信任后恢复；仍受限时保持降级。
      if (
        this.requestedPermissionMode !== this.getPermissionMode() &&
        this.getLocalPermissionModeRestriction(this.requestedPermissionMode) ===
          undefined
      ) {
        this.setPermissionMode(this.requestedPermissionMode);
      }
    }

    coreEvents.emitTrustChanged(this.getSessionId(), isTrusted);

    // Reload trust-dependent subsystems. AgentRegistry reloads via
    // its own TrustChanged listener; MCP, hooks, and skills are
    // reloaded directly here since Config owns them.
    if (isTrusted) {
      this.mcpClientManager?.initialize()?.catch((e) => {
        runLogger.error(
          '[Config] Failed to start MCP servers after trust change:',
          e,
        );
      });
      // 普通配置启动不包含插件 MCP；首次信任后重试此前被信任门禁跳过的插件。
      this.startPluginMcpServers().catch((e) => {
        runLogger.error(
          '[Config] Failed to start plugin MCP servers after trust change:',
          e,
        );
      });
      this.reloadHooks().catch((e) => {
        runLogger.error(
          '[Config] Failed to reload hooks after trust change:',
          e,
        );
      });
      this.memoryContextManager?.refresh()?.catch((e) => {
        runLogger.error(
          '[Config] Failed to refresh memory context after trust change:',
          e,
        );
      });
    }
    // SkillResource applies trust in both directions. Reload when trust is
    // revoked as well, otherwise project Skills remain in the resource
    // snapshot.
    this.reloadSkills()?.catch((e) => {
      runLogger.error(
        '[Config] Failed to reload skills after trust change:',
        e,
      );
    });
  }

  /**
   * Get the current FileSystemService
   */
  getFileSystemService(): FileSystemService {
    return this.fileSystemService;
  }

  /**
   * Checks if a given absolute path is allowed for file system operations.
   * A path is allowed if it's within the workspace context or the project's temporary directory.
   *
   * @param absolutePath The absolute path to check.
   * @returns true if the path is allowed, false otherwise.
   */
  isPathAllowed(absolutePath: string): boolean {
    const resolvedPath = resolveToRealPath(absolutePath);

    const workspaceContext = this.getWorkspaceContext();
    if (workspaceContext.isPathWithinWorkspace(resolvedPath)) {
      return true;
    }

    const projectTempDir = this.storage.getProjectTempDir();
    const resolvedTempDir = resolveToRealPath(projectTempDir);

    if (isSubpath(resolvedTempDir, resolvedPath)) {
      return true;
    }

    // Plans directory is always writable.
    // plansDir lives outside the workspace (e.g. ~/${CONFIG_DIR}/plans/) but must be
    // accessible for plan file writes in plan mode.
    const plansDir = this.storage.getPlansDir();
    const resolvedPlansDir = resolveToRealPath(plansDir);

    if (isSubpath(resolvedPlansDir, resolvedPath)) {
      return true;
    }

    // Agent 记忆属于原项目，不随 Worktree 切换；仅放行记忆目录，
    // 不把原 checkout 的其他文件重新加入可写 workspace。
    const projectRoot = resolveToRealPath(this.storage.getProjectRoot());
    if (isAgentMemoryPath(resolvedPath, projectRoot)) {
      return true;
    }

    return false;
  }

  /**
   * Validates if a path is allowed and returns a detailed error message if not.
   *
   * @param absolutePath The absolute path to validate.
   * @param checkType The type of access to check ('read' or 'write'). Defaults to 'write' for safety.
   * @returns An error message string if the path is disallowed, null otherwise.
   */
  validatePathAccess(
    absolutePath: string,
    checkType: 'read' | 'write' = 'write',
  ): string | null {
    // For read operations, check read-only paths first
    if (checkType === 'read') {
      if (this.getWorkspaceContext().isPathReadable(absolutePath)) {
        return null;
      }
    }

    // Then check standard allowed paths (Workspace + Temp)
    // This covers 'write' checks and acts as a fallback/temp-dir check for 'read'
    if (this.isPathAllowed(absolutePath)) {
      return null;
    }

    const workspaceDirs = this.getWorkspaceContext().getDirectories();
    const projectTempDir = this.storage.getProjectTempDir();
    return `Path not in workspace: Attempted path "${absolutePath}" resolves outside the allowed workspace directories: ${workspaceDirs.join(', ')} or the project temp directory: ${projectTempDir}`;
  }

  /**
   * Set a custom FileSystemService
   */
  setFileSystemService(fileSystemService: FileSystemService): void {
    this.fileSystemService = fileSystemService;
  }

  getCompressionConfig(): CompressionConfig {
    return this.compressionConfig;
  }

  /**
   * Returns whether the user has access to Pro models.
   */
  async getProModelNoAccess(): Promise<boolean> {
    return this.getProModelNoAccessSync();
  }

  /**
   * Returns whether the user has access to Pro models synchronously.
   */
  getProModelNoAccessSync(): boolean {
    // First-party auth always has access to Pro models
    return false;
  }

  /**
   * Returns whether Gen 3.1 Pro has been launched.
   */
  async getGen31Launched(): Promise<boolean> {
    return this.getGen31LaunchedSync();
  }

  /**
   * Returns whether Gen 3.1 Flash Lite has been launched.
   */
  async getGen31FlashLiteLaunched(): Promise<boolean> {
    return this.getGen31FlashLiteLaunchedSync();
  }

  /**
   * Returns whether the custom tool model should be used.
   */
  async getUseCustomToolModel(): Promise<boolean> {
    // First-party auth uses the custom tool model
    return true;
  }

  /**
   * Returns whether the custom tool model should be used.
   */
  getUseCustomToolModelSync(): boolean {
    // First-party auth uses the custom tool model
    return true;
  }

  /**
   * Returns whether Gen 3.1 has been launched.
   */
  getGen31LaunchedSync(): boolean {
    return true;
  }

  /**
   * Returns whether Gen 3.1 Flash Lite has been launched.
   */
  getGen31FlashLiteLaunchedSync(): boolean {
    return true;
  }

  isSkillsSupportEnabled(): boolean {
    return this.skillsSupport;
  }

  /** Whether this workspace loads project and nested `.agents/skills`. */
  shouldLoadSkillsFromAgentsDirectory(): boolean {
    return this.loadSkillsFromAgentsDirectory;
  }

  /** Whether this session consumes the shared user compatibility skills. */
  shouldLoadUserSkillsFromAgentsDirectory(): boolean {
    return this.loadSkillsFromAgentsDirectory;
  }

  /**
   * Subscribe to changes in the CLI's applied Skill runtime view. Returns
   * an unsubscribe function. Once initial Skill discovery has completed, late
   * subscribers are replayed once so consumers can repair startup races
   * without knowing the scoped resource internals.
   */
  onSkillChange(
    listener: () => void,
    options: { replay?: boolean } = {},
  ): () => void {
    this.skillChangeListeners.add(listener);
    if (options.replay !== false && this.skillChangeVersion > 0) {
      const replayVersion = this.skillChangeVersion;
      queueMicrotask(() => {
        if (!this.skillChangeListeners.has(listener)) return;
        this.deliverSkillChange(listener, replayVersion);
      });
    }
    return () => {
      this.skillChangeListeners.delete(listener);
      this.deliveredSkillChangeVersions.delete(listener);
    };
  }

  /**
   * Notifies runtime consumers after in-memory skill availability changes.
   * Use this when skills have already been updated without a filesystem reload,
   * such as JIT discovery in a workspace subdirectory. This invalidates cached
   * skill-dependent prompt sections and refreshes the slash-command catalog.
   */
  notifySkillsChanged(): void {
    this._promptAssembler?.clearCache();
    this.updateSystemInstructionIfInitialized();
    this.emitSkillChange();
  }

  private emitSkillChange(): void {
    this.skillChangeVersion++;
    // 'skills' is the channel slashCommandProcessor subscribes to for
    // debounced command-catalog reloads. Do not also subscribe to 'commands'
    // below — both fire here, so that would rebuild the catalog twice.
    this.startupRuntime.emitChange('skills');
    this.startupRuntime.emitChange('commands');
    if (this.skillChangeDispatchQueued) {
      return;
    }
    this.skillChangeDispatchQueued = true;
    queueMicrotask(() => {
      this.skillChangeDispatchQueued = false;
      const dispatchVersion = this.skillChangeVersion;
      for (const listener of [...this.skillChangeListeners]) {
        this.deliverSkillChange(listener, dispatchVersion);
      }
    });
  }

  private deliverSkillChange(listener: () => void, version: number): void {
    if ((this.deliveredSkillChangeVersions.get(listener) ?? 0) >= version) {
      return;
    }
    this.deliveredSkillChangeVersions.set(listener, version);
    try {
      listener();
    } catch {
      // Don't let one skill-change consumer break the others.
    }
  }

  /** Connect this session's Settings manager to shared SettingsService sources. */
  private initializeSettingsWatcher(): void {
    if (this.settingsWatchStarted || !this.sessionSettingsManager) return;
    this.settingsWatchStarted = true;
    void this.sessionSettingsManager
      .watchChanges({
        acceptChange: async (source, filePath) => {
          try {
            const result = await this.getHookSystem()?.fireConfigChangeEvent(
              source,
              filePath,
            );
            return {
              accepted: !result || !hasBlockingResult(result),
              // A hook can edit settings before this session adopts the change.
              refreshSource: !!result && result.hooksSkipped !== true,
            };
          } catch (error) {
            runLogger.error(
              `[Config] ConfigChange hook failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return true;
          }
        },
        onChange: (source) => {
          if (this.settingsWatchDisposed) return;
          void this.reloadAfterExternalSettingsChange(source);
        },
      })
      .then((unwatch) => {
        this.settingsWatchRetryAttempt = 0;
        if (this.settingsWatchDisposed) unwatch();
        else this.settingsUnwatch = unwatch;
      })
      .catch((err) => {
        this.settingsWatchStarted = false;
        runLogger.error(
          `[Config] Failed to initialize settings watcher: ${err instanceof Error ? err.message : String(err)}`,
        );
        const retryDelayMs =
          SETTINGS_WATCH_RETRY_DELAYS_MS[this.settingsWatchRetryAttempt];
        if (
          retryDelayMs !== undefined &&
          !this.settingsWatchDisposed &&
          !this.settingsWatchRetryTimer
        ) {
          this.settingsWatchRetryAttempt += 1;
          this.settingsWatchRetryTimer = setTimeout(() => {
            this.settingsWatchRetryTimer = undefined;
            if (!this.settingsWatchDisposed) this.initializeSettingsWatcher();
          }, retryDelayMs);
          this.settingsWatchRetryTimer.unref?.();
        }
      });
  }

  private async reloadAfterExternalSettingsChange(
    source: string,
  ): Promise<void> {
    try {
      await this.onExternalSettingsChange?.();
    } catch (err) {
      runLogger.error(
        `[Config] Failed to refresh settings after external change (${source}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const results = await Promise.allSettled([
      this.reloadHooks('settings-event'),
      this.reloadSkills(),
    ]);
    const labels = ['hooks', 'skills'];
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        runLogger.error(
          `[Config] Failed to reload ${labels[index]} after settings change (${source}): ${
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
          }`,
        );
      }
    }
  }

  /**
   * Reloads skills by re-discovering them from extensions and local directories.
   * Uses a coalescing guard: at most one reload runs at a time, and concurrent
   * requests are coalesced into a single follow-up reload.
   */
  async reloadSkills(): Promise<void> {
    if (!this.skillsSupport) {
      return;
    }

    if (this.resourceProject) {
      const views = this.getOrCreateResourceViews();
      await views.ready;
      // Refresh the project scope silently first, then reload user with
      // notify: the user resource is process-shared, so its notification
      // reaches every workspace's session exactly once and each listener
      // already reads the freshest project view.
      await views.project.project.reloadSkills({ notify: false });
      await views.user.reloadSkills({ notify: true });
      // Notify every sharing session; a subscriber failure rejects this reload.
      return;
    }

    await this.reloadSkillsFromResourceSnapshot();
  }

  /**
   * Rebuilds the CLI's existing builtin/plugin/session view from the latest
   * resource Skill snapshot. Resource-owned file changes enter here after the
   * scoped resources have already refreshed their snapshots.
   */
  private async reloadSkillsFromResourceSnapshot(): Promise<void> {
    if (!this.skillsSupport) {
      return;
    }

    // If a reload is already in flight, mark that we need another round and wait
    if (this.reloadSkillsInFlight) {
      this.reloadSkillsPendingAfter = true;
      await this.reloadSkillsInFlight;
      return;
    }

    do {
      this.reloadSkillsPendingAfter = false;
      this.reloadSkillsInFlight = this.doReloadSkills();
      try {
        await this.reloadSkillsInFlight;
      } finally {
        this.reloadSkillsInFlight = null;
      }
    } while (this.reloadSkillsPendingAfter);
  }

  /**
   * Actual reload implementation, extracted for the coalescing guard.
   */
  private async doReloadSkills(): Promise<void> {
    if (this.onReload) {
      const refreshed = await this.onReload();
      this.disabledSkills = refreshed.disabledSkills ?? [];
      this.getSkillManager().setAdminSettings(
        refreshed.adminSkillsEnabled ?? this.adminSkillsEnabled,
      );
    }

    this.getSkillManager().setDisableBuiltinSkills(this.disableBuiltinSkills);
    this.getSkillManager().setEnabledBuiltinSkills(this.enableBuiltinSkills);

    if (this.getSkillManager().isAdminEnabled()) {
      await this.getSkillManager().discoverSkills({
        allowedSources: this.allowedAgentSources,
        plugins: this.getEnabledPlugins(),
        emitToFeed: false,
        resourceSkills: this.skillResourceSnapshot?.skills ?? [],
        resourceSkillLoadErrors: this.skillResourceSnapshot?.loadErrors ?? [],
        config: this,
      });
      this.getSkillManager().setDisabledSkills(this.disabledSkills);
      this.getSkillManager().setSkillVisibilityOverrides(
        this.skillVisibilityOverrides,
      );

      // ActivateSkillTool is intentionally kept registered with its static
      // schema. Skill availability is refreshed through SkillManager and the
      // skill-list attachment, without mutating the request tool table.
    } else {
      this.getSkillManager().clearSkills();
    }

    this.notifySkillsChanged();
  }

  /**
   * Reloads agent settings with a coalescing guard so that concurrent callers
   * collapse into at most one follow-up round instead of racing.
   * Fires a ConfigChange hook before reloading — if blocked, the reload is skipped.
   */
  async reloadAgents(): Promise<void> {
    // If a reload is already in flight, mark that we need another round and wait
    if (this.reloadAgentsInFlight) {
      this.reloadAgentsPendingAfter = true;
      await this.reloadAgentsInFlight;
      return;
    }

    do {
      this.reloadAgentsPendingAfter = false;
      this.reloadAgentsInFlight = this.doReloadAgents();
      try {
        await this.reloadAgentsInFlight;
      } finally {
        this.reloadAgentsInFlight = null;
      }
    } while (this.reloadAgentsPendingAfter);
  }

  /**
   * Actual agent reload implementation, extracted for the coalescing guard.
   */
  private async doReloadAgents(): Promise<void> {
    // Fire ConfigChange hook before applying the reload
    try {
      const hookResult =
        await this.getHookSystem()?.fireConfigChangeEvent('agents');
      if (hookResult && hasBlockingResult(hookResult)) {
        const reason =
          hookResult.finalOutput?.getEffectiveReason?.() ||
          hookResult.allOutputs
            .map((o) => o.reason)
            .filter(Boolean)
            .join('; ') ||
          'unknown reason';
        runLogger.debug(
          `[Config] ConfigChange hook blocked agents reload: ${reason}`,
        );
        return;
      }
    } catch {
      // Don't let hook errors prevent legitimate agent reloads
    }

    if (this.onReload) {
      const refreshed = await this.onReload();
      if (refreshed.agents) {
        this.agents = refreshed.agents;
      }
    }

    if (this.resourceProject) {
      const views = this.getOrCreateResourceViews();
      await views.ready;
      await Promise.all([
        views.user.reloadAgents(),
        views.project.project.reloadAgents(),
      ]);
    }
  }

  /**
   * Reloads hook definitions from disk via the onReload callback,
   * then re-initializes the hook registry so changes take effect
   * without restarting the session.
   * Uses a coalescing guard: at most one reload runs at a time, and
   * concurrent requests are coalesced into a single follow-up reload.
   */
  async reloadHooks(
    source: 'manual' | 'settings-event' = 'manual',
  ): Promise<void> {
    if (!this.onReload) return;
    if (source === 'manual') this.reloadHooksNeedsManualSettingsRefresh = true;

    if (this.reloadHooksInFlight) {
      this.reloadHooksPendingAfter = true;
      await this.reloadHooksInFlight;
      return;
    }

    do {
      this.reloadHooksPendingAfter = false;
      this.reloadHooksInFlight = this.doReloadHooks();
      try {
        await this.reloadHooksInFlight;
      } catch (error) {
        coreEvents.emit(CoreEvent.HookDiagnosticsChanged, {
          sessionId: this.getSessionId(),
          failed: true,
        });
        throw error;
      } finally {
        this.reloadHooksInFlight = null;
      }
    } while (this.reloadHooksPendingAfter);
  }

  /**
   * Actual hook reload implementation, extracted for the coalescing guard.
   */
  private async doReloadHooks(): Promise<void> {
    if (!this.onReload) return;

    const needsManualRefresh = this.reloadHooksNeedsManualSettingsRefresh;
    this.reloadHooksNeedsManualSettingsRefresh = false;
    if (needsManualRefresh) {
      this.onSettingsCacheInvalidate?.();
      this.onManualSettingsReload?.();
    }

    const refreshed = await this.onReload();
    this.updateHookDefinitions({
      hooks: refreshed.hooks,
      projectHooks: refreshed.projectHooks,
      localHooks: refreshed.localHooks,
      userHooks: refreshed.userHooks,
      flagHooks: refreshed.flagHooks,
    });

    // Re-initialize hook registry with the updated definitions.
    // Same pattern used by setTrustedFolder() — initialize() preserves
    // Runtime-sourced entries and re-processes config-sourced hooks.
    await this.hookSystem?.initialize({ emitToFeed: false });

    runLogger.debug('[Config] Hooks reloaded from settings');
  }

  isInteractive(): boolean {
    return this.interactive;
  }

  getUseRipgrep(): boolean {
    return this.useRipgrep;
  }

  getUseBackgroundColor(): boolean {
    return this.useBackgroundColor;
  }

  getUseAlternateBuffer(): boolean {
    return this.useAlternateBuffer;
  }

  getUseTerminalBuffer(): boolean {
    return this.useTerminalBuffer;
  }

  getUseRenderProcess(): boolean {
    return this.useRenderProcess;
  }

  getLanguage(): string | undefined {
    return this.language;
  }

  /**
   * Returns the resolved output style for this session, or `undefined`
   * when the default style is active. Selection changes take effect only at
   * the next conversation reset; `'default'` maps to `undefined` so the
   * assembler never emits `# Output Style: default`.
   */
  getOutputStyle(): ResolvedOutputStyle | undefined {
    return this.outputStyleManager.getOutputStyle();
  }

  /**
   * Resolves the session output style from built-in, plugin, user, and project
   * sources. Called once during Config initialization, after additional workspace
   * directories and resource snapshots are ready. Repeated calls share the first
   * initialization. A forced plugin style overrides the requested name.
   *
   * @internal Embedders can pass a pre-resolved style
   * through ConfigParameters instead.
   */
  initializeOutputStyle(name?: string): Promise<void> {
    return this.outputStyleManager.initialize(async () => ({
      name,
      plugins: this.getEnabledPlugins(),
      resourceOutputStyles: await this.getResourceOutputStyles(),
      productOutputStyles: this.getProductOutputStyles(),
    }));
  }

  private reloadOutputStyleResource(): Promise<void> {
    const views = this.getOrCreateResourceViews();
    this.outputStyleResourceWorkingDir = this.getSessionArtifactProjectRoot();
    const projectConfigDir = path.join(
      this.outputStyleResourceWorkingDir,
      CONFIG_DIR,
    );
    if (
      path.resolve(projectConfigDir) !==
      path.resolve(this.storage.getConfigDir())
    ) {
      // An attached worktree can use a session-specific original project.
      // Keep that Output Style snapshot out of the shared workspace resource.
      const refresh = this.outputStyleResourceInitialization !== undefined;
      this.outputStyleResourceInitialization = (async () => {
        await views.ready;
        if (refresh) {
          await views.user.reloadOutputStyles();
        }
        const projectStyles = await loadOutputStylesFromDir(
          path.join(projectConfigDir, 'output-styles'),
          'projectSettings',
        );
        this.sessionOutputStyles = [
          ...views.user.outputStyles.getAllDiscoveredOutputStyles(),
          ...projectStyles,
        ];
      })();
    } else {
      this.sessionOutputStyles = undefined;
      this.outputStyleResourceInitialization = (async () => {
        await Promise.all([
          views.user.reloadOutputStyles(),
          views.project.project.reloadOutputStyles({
            projectConfigDirOverride: projectConfigDir,
          }),
        ]);
      })();
    }
    return this.outputStyleResourceInitialization;
  }

  private async getResourceOutputStyles(): Promise<OutputStyleConfig[]> {
    this.getOrCreateResourceViews();
    if (
      !this.outputStyleResourceInitialization ||
      this.outputStyleResourceWorkingDir !==
        this.getSessionArtifactProjectRoot()
    ) {
      // Stores the shared initialization promise synchronously; awaited below.
      this.reloadOutputStyleResource();
    }
    await this.outputStyleResourceInitialization;
    if (this.sessionOutputStyles) return this.sessionOutputStyles;
    for (const error of this.resourceViews?.outputStyles.getLoadErrors() ??
      []) {
      runLogger.debug(`[output-styles] ${error.filePath}: ${error.message}`);
    }
    // User candidates precede project candidates, matching the previous
    // discovery order and the host's project-over-user selection.
    return (
      this.resourceViews?.outputStyles.getAllDiscoveredOutputStyles() ?? []
    );
  }

  /**
   * Selects a name for the next conversation without changing the current
   * session's resolved style or prompt caches. Persistence belongs to CLI.
   */
  setRequestedOutputStyleName(name: string): void {
    this.outputStyleManager.setRequestedName(name);
  }

  /**
   * @internal Called only by the local TUI conversation reset (/clear, /new).
   * Resolve against the current plugin/filesystem state, then let the reset
   * lifecycle rebuild the prompt. Never refresh the outgoing runtime here.
   * Plugin reload and compaction must not call this method.
   */
  async resetOutputStyleForNewSession(): Promise<void> {
    await this.reloadOutputStyleResource();
    await this.outputStyleManager.resetForNewSession(async () => ({
      plugins: this.getEnabledPlugins(),
      resourceOutputStyles: await this.getResourceOutputStyles(),
      productOutputStyles: this.getProductOutputStyles(),
    }));
  }

  /**
   * Returns the merged set of available output styles for this session:
   * built-in + (active) plugin + user + project, keyed by name.
   * Used by the `/output-style` picker and by SDK init responses that
   * report `available_output_styles`.
   */
  async getAvailableOutputStyles(): Promise<
    Record<string, OutputStyleConfig | null>
  > {
    return this.outputStyleManager.getAvailableStyles({
      plugins: this.getEnabledPlugins(),
      resourceOutputStyles: await this.getResourceOutputStyles(),
      productOutputStyles: this.getProductOutputStyles(),
    });
  }

  /**
   * Returns user-visible definitions before same-name precedence is applied.
   * The TUI uses this to show shadowed definitions alongside the effective
   * map returned by `getAvailableOutputStyles()`.
   */
  async getAvailableOutputStyleDefinitions(): Promise<OutputStyleConfig[]> {
    return this.outputStyleManager.getAvailableDefinitions({
      plugins: this.getEnabledPlugins(),
      resourceOutputStyles: await this.getResourceOutputStyles(),
      productOutputStyles: this.getProductOutputStyles(),
    });
  }

  getContinueOnFailedApiCall(): boolean {
    return this.continueOnFailedApiCall;
  }

  getRetryFetchErrors(): boolean {
    return this.retryFetchErrors;
  }

  getMaxAttempts(): number {
    return this.maxAttempts;
  }

  getShellToolInactivityTimeout(): number {
    return this.shellToolInactivityTimeout;
  }

  private shellProgressEnabled = false;

  setShellProgressEnabled(enabled: boolean): void {
    this.shellProgressEnabled = enabled;
  }

  getShellExecutionConfig(): ShellExecutionConfig {
    // 会话级 Shell 输入随 Config 一起下发：ShellProvider 按 shellType 全局缓存
    // 并被所有会话复用，插件 bin 目录这类会话事实只能在每条命令上现取。
    return {
      ...this.shellExecutionConfig,
      ...(this.shellProgressEnabled ? { exactOutputLineCount: true } : {}),
      sessionContext: this,
      // Non-tool launches reuse only the registered shell's common environment.
      environmentPreparation: async (config) => {
        const tool = this._toolRegistry?.getKnownTool(
          this.getDefaultShellToolName(),
        );
        return tool instanceof ShellTool || tool instanceof PowerShellTool
          ? tool.prepareEnvironment(config)
          : undefined;
      },
    };
  }

  /**
   * 本会话 hook 写出的环境脚本（`session-env/<sessionId>/*.sh` 拼接结果），
   * bashProvider 在每条命令前 source。作为 ShellSessionContext 的一员随命令
   * 下发，避免多会话共用一个进程级 provider 时互相串环境。
   */
  getSessionEnvScript(): Promise<string | null> {
    return resolveSessionEnvScript(this.getSessionId());
  }

  /**
   * Returns true if skill shell execution (!`cmd` and ```! ```) is disabled
   * by the `skills.disableShellExecution` setting.
   */
  isSkillShellExecutionDisabled(): boolean {
    return this.disableSkillShellExecution;
  }

  setShellExecutionConfig(config: ShellExecutionConfig): void {
    this.shellExecutionConfig = {
      pager: config.pager ?? this.shellExecutionConfig.pager,
      sanitizationConfig:
        config.sanitizationConfig ??
        this.shellExecutionConfig.sanitizationConfig,
    };
  }
  getScreenReader(): boolean {
    return this.accessibility.screenReader ?? false;
  }

  getTruncateToolOutputThreshold(
    listed: Model | undefined,
    contextWindow: number = this.getEffectiveContextWindow(listed),
  ): number {
    return Math.min(
      // Estimate remaining context window in characters (1 token ~= 4 chars).
      4 * (contextWindow - uiTelemetryService.getLastPromptTokenCount()),
      this.truncateToolOutputThreshold,
    );
  }

  getNextCompressionTruncationId(): number {
    return ++this.compressionTruncationCounter;
  }

  getOutputFormat(): OutputFormat {
    return this.outputSettings?.format
      ? this.outputSettings.format
      : OutputFormat.TEXT;
  }

  getFileExclusions(): FileExclusions {
    return this.fileExclusions;
  }

  getEnableHooks(): boolean {
    return this.enableHooks;
  }

  getAgentSessionNoninteractiveEnabled(): boolean {
    return this.agentSessionNoninteractiveEnabled;
  }

  private resolveShellCapabilities(): Promise<ShellCapabilitySnapshot> {
    return (this.shellCapabilities ??= resolveShellCapabilitySnapshot().then(
      async (snapshot) => {
        this.powerShellRuntime = snapshot.exposePowerShell
          ? await getPowerShellRuntime()
          : null;
        if (snapshot.exposePowerShell && !this.powerShellRuntime) {
          snapshot.exposePowerShell = false;
          snapshot.exposeBash = true;
          snapshot.defaultShell = 'bash';
          runLogger.warn(
            '[PowerShellTool] PowerShell runtime unavailable; keeping the existing Bash preparation and execution path.',
          );
        }
        this.shellCapabilitySnapshot = snapshot;
        return snapshot;
      },
    ));
  }

  getDefaultShellToolName(): 'Bash' | 'PowerShell' {
    return this.shellCapabilitySnapshot?.defaultShell === 'powershell'
      ? 'PowerShell'
      : 'Bash';
  }

  async createToolRegistry(): Promise<ToolRegistry> {
    const registry = new ToolRegistry(this, /* isMainRegistry= */ true);
    const shellCapabilities = await this.resolveShellCapabilities();
    const powerShellRuntime = this.powerShellRuntime;

    // Register all tools unconditionally — the previous `maybeRegister`
    // filtered by coreTools class-name matching, which duplicated the
    // permission layer and broke on minified names. Deny enforcement is
    // now handled solely by toolPermissionContext.alwaysDenyRules.
    registry.registerTool(new UpdateTopicTool(this));
    registry.registerTool(new ReadFileTool(this));
    registry.registerTool(new RipGrepTool(this));
    registry.registerTool(new GlobTool(this));
    registry.registerTool(new ActivateSkillTool(this));
    registry.registerTool(new EditTool(this));
    registry.registerTool(new NotebookEditTool(this));
    registry.registerTool(new WriteFileTool(this));
    const codeModeSettings = this.getSetting('codeMode');
    if (!isCodeModeSupported()) {
      if (resolveCodeModeExposure(codeModeSettings))
        runLogger.warn(
          `CodeMode is unsupported on this runtime (${process.platform}-${process.arch}); registration skipped`,
        );
    } else {
      if (this.codeModeFeatureConfig === undefined) {
        this.codeModeFeatureConfig = { enabled: false, defaultMode: 'off' };
        // An omitted local mode may be enabled by the remote default. Only an
        // explicit local off (or invalid mode) can skip waiting for that default.
        if (resolveCodeModeExposure(codeModeSettings, 'on')) {
          try {
            // Interactive startup prewarms QCS without awaiting it. Resolve the
            // current identity's initial configuration before fixing tool exposure.
            await ensureConfigReadyForRequest();
            this.codeModeFeatureConfig = getCodeModeFeatureConfig();
          } catch (error) {
            runLogger.warn(
              '[CodeMode] Failed to load feature gate; registration skipped',
              { error: getErrorMessage(error) },
            );
          }
        }
      }
      if (this.getCodeModeExposure()) {
        // oxlint-disable-next-line no-restricted-imports -- the one lazy entry point to CodeMode
        const { CodeModeTool, CodeModeWaitTool } = await import(
          '../tools/code-mode.js'
        );
        registry.registerTool(new CodeModeTool(this));
        registry.registerTool(new CodeModeWaitTool(this));
      }
    }
    registry.registerTool(new WebFetchTool(this));
    if (shellCapabilities.exposeBash) {
      registry.registerTool(new ShellTool(this));
      registry.registerTool(new MonitorTool(this));
    }
    if (shellCapabilities.exposePowerShell) {
      registry.registerTool(
        new PowerShellTool(this, powerShellRuntime!.edition),
      );
    }
    registry.registerTool(new TaskStopTool(this));
    if (shellCapabilities.exposeBash && isBashPtyToolsEnabled()) {
      registry.registerTool(new BashInputTool(this));
      registry.registerTool(new BashOutputTool(this));
      registry.registerTool(new BashResizeTool(this));
    }
    registry.registerTool(new CronCreateTool(this));
    registry.registerTool(new CronDeleteTool(this));
    registry.registerTool(new CronListTool(this));
    registry.registerTool(new ScheduleWakeupTool(this));
    registry.registerTool(new AskUserTool());
    if (this.isPlanEnabled()) {
      registry.registerTool(new ExitPlanModeTool(this));
      registry.registerTool(new EnterPlanModeTool(this));
    }

    // Worktree isolation tools — gated by worktree feature flag
    if (this.isWorktreeEnabled()) {
      registry.registerTool(new EnterWorktreeTool(this));
      registry.registerTool(new ExitWorktreeTool(this));
    }

    // Persistent task tools and the in-context TodoWrite fallback are
    // mutually exclusive.
    if (this.isTasksEnabled()) {
      registry.registerTool(new TaskCreateTool(this));
      registry.registerTool(new TaskGetTool(this));
      registry.registerTool(new TaskUpdateTool(this));
      registry.registerTool(new TaskListTool(this));
    } else {
      registry.registerTool(new WriteTodosTool());
    }

    // SendMessage backs both in-process teammates and cross-session peers, so
    // either feature being on is enough to need it registered.
    if (
      isInProcessTeammateFeatureEnabled() ||
      isCrossSessionMessagingEnabled()
    ) {
      for (const tool of createAgentTeamTools({ config: this })) {
        registry.registerTool(tool);
      }
    }

    if (isListAgentsToolEnabled()) {
      registry.registerTool(new ListAgentsTool(this));
    }

    // Goal tools
    registry.registerTool(new GetGoalTool(this));
    registry.registerTool(new CreateGoalTool(this));
    registry.registerTool(new UpdateGoalTool(this));

    registry.registerTool(new WorkflowTool(this));
    // Register Subagents as Tools
    this.registerSubAgentTools(registry);

    registry.sortTools();
    if (this.builtinPluginsEnabled && this.builtinPlugins?.isReady())
      syncBuiltinPluginTools(
        registry,
        this.builtinToolNames,
        this.builtinPlugins,
      );
    return registry;
  }

  /**
   * Registers the unified AgentTool for all available agents.
   * On hot-reload, re-uses the existing tool instance — updating its description
   * and re-applying disabled agent types — instead of destroying and recreating it.
   */
  private registerSubAgentTools(registry: ToolRegistry): void {
    if (!this.isAgentsEnabled()) {
      return;
    }

    const discoveredNames = this.agentRegistry.getAllDiscoveredAgentNames();

    // TODO 这段逻辑是无法触发的
    if (discoveredNames.length === 0) {
      return;
    }

    const existingTool = registry.getTool(AGENT_TOOL_NAME);

    /**
     * 已存在 Agent Tool 热刷新
     * 场景：
     * 1. /agents reload
     * 2. plugin 热加载，
     * 3. Trust 状态变化
     * 4. SDK 动态注册
     * 5. 模型信息刷新 —— TODO 为什么会出现 Agent Registry 更新
     *
     */
    if (existingTool instanceof AgentTool) {
      // Hot-reload path: update existing tool in-place
      existingTool.refreshDescription(); // 刷新 Tool description
      existingTool.clearDisabledAgentTypes(); // 清空禁用的 Agent 类型
      registry.invalidateSchemaCache(); // 使 Schema 缓存失效

      // Re-apply per-agent disabling from settings
      const agentsOverrides = this.getAgentsSettings().overrides ?? {};
      for (const agentName of discoveredNames) {
        if (agentsOverrides[agentName]?.enabled === false) {
          existingTool.disableAgentType(agentName); // settings.json 里 agents.overrides.<agentName>.enable
        }
      }

      // Re-apply session agent disallowedTools (lost after hot-reload)
      if (this.sessionAgentDefinition?.kind === 'local') {
        const disallowed = this.sessionAgentDefinition.disallowedTools; // 当前主会话禁用的工具
        if (disallowed && disallowed.length > 0) {
          applyDisallowedTools(
            disallowed,
            () => {},
            (name) => existingTool.disableAgentType(name),
          );
        }
      }

      return;
    }

    try {
      const agentTool = new AgentTool(this.agentRegistry, this);

      // Apply per-agent disabling from settings
      const agentsOverrides = this.getAgentsSettings().overrides ?? {};
      for (const agentName of discoveredNames) {
        if (agentsOverrides[agentName]?.enabled === false) {
          agentTool.disableAgentType(agentName);
        }
      }

      registry.registerTool(agentTool);
    } catch (e: unknown) {
      runLogger.warn(`Failed to register Agent tool: ${getErrorMessage(e)}`);
    }
  }

  /**
   * Get the hook system instance
   */
  getHookSystem(): HookSystem | undefined {
    return this.hookSystem;
  }

  // ── Permission ──

  /** 进程级权限管理器；会话权限从它派生，供重建会话等场景复用。 */
  getProcessPermissionManager(): PermissionManager | undefined {
    return this.permissionManager;
  }

  /**
   * The session's permission object, assembled at initialize.
   *
   * Config carries it so that background services holding nothing but a Config
   * — memory extraction, autoDream, the work-memory sink — reach the same object
   * the interactive session uses rather than inventing a policy of their own. It
   * is that object, not a copy: a mode switch is visible everywhere at once.
   *
   * Undefined before {@link _initializeUnchecked} has run; callers that can
   * observe that window must guard instead of asking Config to build one.
   */
  get permission():
    | import('../permissions/manager/session-permission-manager.js').SessionPermissionManager
    | undefined {
    return this.sessionPermissionManager;
  }

  /**
   * 新会话重建会话权限：保留当前模式，规则与目录重新取自当前设置，
   * 旧会话授予的会话级规则随之丢弃。
   */
  resetPermissionSession(): void {
    const mode = this.getPermissionMode();
    const previous = this.sessionPermissionManager;
    this.sessionPermissionManager = undefined;
    if (previous) void previous.dispose();
    this.initPermission(mode);
  }

  /**
   * 会话权限对象在会话装配提供 manager 时存在。启动规则、目录、模式全部来自
   * 本对象自己的状态；initialize 时创建一次，重建会话时再创建。
   */
  /** 会话权限可能尚未创建；先保存，创建/重建时统一安装。 */
  setPermissionAskHandler(
    handler: Parameters<SessionPermissionAPI['setAskHandler']>[0],
  ): void {
    this.permissionAskHandler = handler;
    this.sessionPermissionManager?.setAskHandler(handler);
  }

  private warnIgnoredWorkspaceAutoMode(): void {
    if (this.autoModeWorkspaceWarningIssued) return;
    const paths = [
      this.storage.getWorkspaceSettingsPath?.(),
      this.storage.getWorkspaceLocalSettingsPath?.(),
    ].filter((p): p is string => typeof p === 'string' && p.length > 0);
    for (const path of paths) {
      if (!hasAutoModeBlock(path)) continue;
      this.autoModeWorkspaceWarningIssued = true;
      runLogger.warn(
        `[auto-mode] autoMode classifier rules in ${path} are ignored — only the user settings file may set them.`,
      );
      return;
    }
  }

  initPermission(
    initialMode?: PermissionMode,
  ):
    | import('../permissions/manager/session-permission-manager.js').SessionPermissionManager
    | undefined {
    if (this.sessionPermissionManager) return this.sessionPermissionManager;
    const manager = this.permissionManager;
    if (!manager) return undefined;
    const mcpServerAlwaysAllow: Record<string, string[]> = {};
    for (const [serverName, serverConfig] of Object.entries(
      this.diskMcpServers ?? {},
    )) {
      if (serverConfig.alwaysAllow && serverConfig.alwaysAllow.length > 0) {
        mcpServerAlwaysAllow[serverName] = serverConfig.alwaysAllow;
      }
    }
    this.sessionPermissionManager = manager.createSessionPermissionManager({
      getSessionId: () => this.getSessionId(),
      getWorkingDir: () => this.getWorkingDir(),
      flagSettings: {
        initialMode: initialMode ?? this.permissionMode,
        rules: permissionRulesFromStartup({
          allowedTools: this.allowedTools,
          disallowedTools: this.disallowedTools,
          coreTools: this.coreTools,
          mcpServerAlwaysAllow,
          rulesFromSettings: loadPermissionRulesFromLoadedSettings(
            this.loadedSettings,
          ),
        }),
        additionalDirectories: [
          ...new Set([
            ...this.pendingIncludeDirectories,
            ...(this.loadedSettings.merged.permissions?.additionalDirectories ??
              []),
          ]),
        ],
      },
      skill: this.getSkillManager(),
      permissionSettings: {
        getSettingsForSource: (source) => {
          const file = this.loadedSettings.forScope(
            PERMISSION_SETTING_SCOPE[source],
          );
          return file ? (file.settings as PermissionsSettingsJson) : null;
        },
        mutateSettingsForSource: (source, mutation) => {
          const scope = PERMISSION_SETTING_SCOPE[source];
          const target = this.loadedSettings.forScope(scope);
          if (target.readOnly || !target.path) {
            return {
              error: new Error(`Settings source is not writable: ${source}`),
            };
          }
          const success = this.loadedSettings.mutateScope(scope, (editor) => {
            const root = editor.get([]) as PermissionsSettingsJson;
            if (!mutation(root)) return;
            if (root.permissions === undefined) {
              editor.delete('permissions');
            } else {
              editor.set('permissions', root.permissions);
            }
          });
          return success ? {} : { error: new Error('Settings write failed') };
        },
      },
      createSessionJudges: () =>
        manager.getAutoClassifier().createSessionJudges(this),
      autoModeUserConfig: () => {
        this.warnIgnoredWorkspaceAutoMode();
        return readGlobalAutoModeUserConfig();
      },
      reportAutoShadowComparison: (comparison) => {
        this.permissionManager
          ?.getAutoClassifier()
          .reportShadow(this, comparison);
      },
      isAutoShadowReportingEnabled: () =>
        this.permissionManager
          ?.getAutoClassifier()
          .isShadowReportingEnabled(this) ?? false,
      autoModeUserInstructions: () => {
        const memory = this.getSystemInstructionMemory();
        const text = typeof memory === 'string' ? memory : memory.global;
        return text?.trim() ? text : undefined;
      },
      createMcpToolChecker: (entry) =>
        createEagerMcpToolChecker({
          serverName: entry.serverName,
          toolName: entry.toolName,
        }),
      getSessionModeRestriction: (mode) =>
        this.getLocalPermissionModeRestriction(mode, false),
      classifierInputs: createClassifierInputsForConfig(this),
    });
    this.sessionPermissionManager.setAskHandler(this.permissionAskHandler);
    const restriction = this.getLocalPermissionModeRestriction(
      initialMode ?? this.permissionMode,
      false,
    );
    if (restriction !== undefined) {
      const session = this.sessionPermissionManager;
      this.sessionPermissionManager = undefined;
      void session.dispose();
      throw new PermissionModeUnavailableError(restriction);
    }
    return this.sessionPermissionManager;
  }

  /**
   * The host prompt for confirmations that are not permission questions.
   *
   * Separate from `permission` on purpose: the doom-loop guard asks about the
   * shape of the conversation, not about whether a tool may act, so no rule or
   * mode should get a vote on it. The CLI implements both with the same dialog.
   */
  confirmContinuation?: import('../core/doom-loop-guard.js').ConfirmContinuation;

  /**
   * The current turn's interrupt, installed by whichever host drives the turn.
   *
   * A PermissionRequest hook that denies with `interrupt` must stop the turn, but
   * the hook bridge is built before any turn exists — on the TUI before the React
   * tree renders, in headless before the first prompt — so it cannot capture the
   * per-turn AbortController. Config is the one object both sides already hold,
   * and it lives exactly as long as the session, so an installed interrupt dies
   * with the session instead of outliving it.
   *
   * Per-session rather than process-wide because a process hosts several sessions:
   * a module-level slot is last-installer-wins, so one session's hook deny would
   * abort another session's turn. The TUI has the same hazard across a project
   * rebuild, where the outgoing tree's cleanup would otherwise disarm the incoming
   * tree's bridge.
   *
   * Channels that build their bridge where the controller is already in scope —
   * ACP, the remote worker — override `PermissionRequestHookBridge.onInterrupt`
   * directly and never install here.
   */
  private currentTurnInterrupt: (() => void) | undefined;

  /** Install, or with `undefined` clear, the current turn's interrupt. */
  setTurnInterrupt(fn: (() => void) | undefined): void {
    this.currentTurnInterrupt = fn;
  }

  /** Stop the current turn, when the host has installed a way to. */
  invokeTurnInterrupt(): void {
    this.currentTurnInterrupt?.();
  }

  /**
   * Last rendered screen per PTY pid, owned by the session that spawned the
   * PTY. `PtySessionService` already scopes sessions by owner key; keeping
   * this cache process-wide would let one session's background-execution
   * closures read (or overwrite) another session's terminal output when pids
   * are passed around. Dies with the Config.
   */
  private readonly ptyLastOutputs = new Map<number, string>();

  getPtyLastOutputs(): Map<number, string> {
    return this.ptyLastOutputs;
  }

  private readonly sessionDisposeListeners = new Set<() => void>();
  private sessionDisposed = false;
  private builtinSessionContext?: BuiltinSessionContext;
  private resumeArtifactStates?: {
    sessionId: string;
    states: readonly TranscriptWorktreeSession[];
  };

  /** Preserve sidecar and runtime restore information before resume data is released. */
  setSessionArtifactWorktreeStates(
    states: readonly TranscriptWorktreeSession[] | undefined,
  ): void {
    this.resumeArtifactStates = states
      ? { sessionId: this.getSessionId(), states }
      : undefined;
  }

  getBuiltinSessionContext(): BuiltinSessionContext {
    // oxlint-disable-next-line typescript/no-this-alias -- Accessor this is the public handle, not its owning Config.
    const config = this;
    return (this.builtinSessionContext ??= {
      get sessionId() {
        return config.getSessionId();
      },
      get projectRoot() {
        return config.getSessionArtifactProjectRoot();
      },
      get workingDir() {
        return config.getWorkingDir();
      },
      get transcriptPath() {
        return config.getActiveSessionTranscriptPath();
      },
      get taskRegistry() {
        return config.taskRegistry;
      },
      get disposed() {
        return config.sessionDisposed;
      },
      onDispose: (callback) => {
        if (config.sessionDisposed) {
          callback();
          return () => {};
        }
        config.sessionDisposeListeners.add(callback);
        return () => {
          config.sessionDisposeListeners.delete(callback);
        };
      },
      getArtifactProjectRoots: () =>
        getSessionArtifactProjectRoots(
          config.getSessionArtifactProjectRoot(),
          config.getSessionId(),
          config.getActiveSessionTranscriptPath(),
          config.resumeArtifactStates?.sessionId === config.getSessionId()
            ? config.resumeArtifactStates.states
            : undefined,
        ),
    });
  }

  /**
   * Get hooks configuration
   */
  getHooks(): HookDefinitionsByEvent | undefined {
    return this.hooks;
  }

  /**
   * Get project-specific hooks configuration
   */
  getProjectHooks(): HookDefinitionsByEvent | undefined {
    return this.projectHooks;
  }

  /**
   * Get local hooks configuration (from settings.local.json)
   */
  getLocalHooks(): HookDefinitionsByEvent | undefined {
    return this.localHooks;
  }

  /**
   * Get user-level hooks configuration (from user settings)
   */
  getUserHooks(): HookDefinitionsByEvent | undefined {
    return this.userHooks;
  }

  /**
   * Get flag hooks configuration (from --settings CLI flag)
   */
  getFlagHooks(): HookDefinitionsByEvent | undefined {
    return this.flagHooks;
  }

  /**
   * Update hook definitions at runtime from freshly-loaded settings.
   * Called when settings files change on disk so that hook changes take
   * effect without restarting the session.
   */
  updateHookDefinitions(defs: {
    hooks?: HookDefinitionsByEvent;
    projectHooks?: HookDefinitionsByEvent;
    localHooks?: HookDefinitionsByEvent;
    userHooks?: HookDefinitionsByEvent;
    flagHooks?: HookDefinitionsByEvent;
  }): void {
    if (defs.hooks !== undefined) this.hooks = defs.hooks;
    if (defs.projectHooks !== undefined) this.projectHooks = defs.projectHooks;
    if (defs.localHooks !== undefined) this.localHooks = defs.localHooks;
    if (defs.userHooks !== undefined) this.userHooks = defs.userHooks;
    if (defs.flagHooks !== undefined) this.flagHooks = defs.flagHooks;
  }

  /**
   * Check whether all hooks are currently disabled at runtime.
   * Unlike the readonly `enableHooks`, this field can be toggled dynamically
   * in response to `CoreEvent.SettingsChanged` so that flipping
   * `disableAllHooks` back to `false` takes immediate effect.
   */
  isAllHooksDisabled(): boolean {
    return this._allHooksDisabled;
  }

  /**
   * Dynamically update the "all hooks disabled" flag.
   * Called from the SettingsChanged listener when `disableAllHooks` changes.
   */
  setAllHooksDisabled(disabled: boolean): void {
    this._allHooksDisabled = disabled;
  }

  private onAgentsRefreshed = async () => {
    if (this._toolRegistry) {
      this.registerSubAgentTools(this._toolRegistry);
    }
    if (this.sessionRuntimeBinding) {
      await this.refreshSessionToolsAndPromptIfInitialized();
    } else {
      runLogger.debug(
        '[Config] No active session runtime; skipping live prompt/tool refresh.',
      );
    }
  };

  /**
   * Disposes of resources and removes event listeners.
   */
  async dispose(): Promise<void> {
    this.disposeToolExecution();
    try {
      await releaseConfigWorktreeOwnership(this);
    } catch (error) {
      runLogger.warn(
        'Failed to release worktree process ownership during session disposal.',
        error,
      );
    }
    await resetCodeModeSession(this);
    this.unsubscribeBuiltinPlugins?.();
    this.unsubscribeBuiltinPlugins = undefined;
    if (this.builtinPlugins) {
      this.builtinPluginsDisposed = true;
      for (const name of this.builtinToolNames)
        this._toolRegistry?.unregisterTool(name);
      this.builtinToolNames.clear();
    }
    this.releaseCwdChangedCallback?.();
    // 定时器要在会话结束时彻底停掉：调度器的文件 watcher 与 1s interval 会一直
    // 跑，ScheduleWakeup 的 setTimeout 还持有本 Config 的闭包——不取消的话它会
    // 在一个已经结束的会话上触发，把 prompt 塞进别人（或空无一人）的队列。
    this.cronManager.cancelWakeup();
    this.cronManager.stop();
    // Notify this runtime's subscribers; plugins own their resource cleanup.
    this.sessionDisposed = true;
    const listeners = [...this.sessionDisposeListeners];
    this.sessionDisposeListeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        runLogger.warn('[Config] session disposal listener failed', error);
      }
    }
    await this.permission?.dispose();
    this.memoryContextManager?.dispose?.();
    this.hookSystem?.dispose();
    this.customProvidersDisposed = true;
    this.customProviderAccess.invalidate();
    // 只释放 manager 自建的项目实例与锚点，外部 provider 的生命周期由 framework 管理。
    await this.modelProviderManager.stop();
    // Provider API keys live only in the per-Config in-memory registry. Clear
    // them, and remove their catalog projection, as soon as this session ends.
    this.clearCustomProviderProjection();
    this.agentsRefreshedUnsubscribe?.();
    this.agentsRefreshedUnsubscribe = undefined;
    this.agentRegistry?.dispose();
    await this.cleanupAgentTeamSessions();
    for (const unsubscribe of this.skillResourceUnsubscribes.splice(0)) {
      unsubscribe();
    }
    const resourceViews = this.resourceViews;
    this.resourceViews = undefined;
    if (resourceViews) await resourceViews.release();
    this.skillResourceSnapshot = undefined;
    this.skillChangeListeners.clear();
    this.deliveredSkillChangeVersions.clear();
    this.startupRuntime.dispose();
    this.settingsWatchDisposed = true;
    if (this.settingsWatchRetryTimer) {
      clearTimeout(this.settingsWatchRetryTimer);
      this.settingsWatchRetryTimer = undefined;
    }
    this.settingsUnwatch?.();
    this.settingsUnwatch = undefined;
    if (this.mcpClientManager) {
      await this.mcpClientManager.dispose();
    }
    await this.transcriptStore.close();
    // Release per-session section cache to prevent long-running process memory leaks.
    this._promptAssembler?.clearCache();
  }
}
