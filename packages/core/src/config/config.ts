/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Node built-ins
import type { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';

// External dependencies
import { ProxyAgent, setGlobalDispatcher } from 'undici';

// Types
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import type { ContentGeneratorConfigSources } from '../core/contentGenerator.js';
import type { MCPOAuthConfig } from '../mcp/oauth-provider.js';
import type { ShellExecutionConfig } from '../services/shellExecutionService.js';
import type { AnyToolInvocation } from '../tools/tools.js';
import type { ArenaManager } from '../agents/arena/ArenaManager.js';
import { ArenaAgentClient } from '../agents/arena/ArenaAgentClient.js';
import type { TeamManager } from '../agents/team/TeamManager.js';
import type { TeamContext } from '../agents/team/types.js';

// Core
import { BaseLlmClient } from '../core/baseLlmClient.js';
import { GeminiClient } from '../core/client.js';
import {
  AuthType,
  createContentGenerator,
  resolveContentGeneratorConfigWithSources,
} from '../core/contentGenerator.js';
import { getRuntimeContentGenerator } from '../agents/runtime/agent-context.js';

// Services
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import { FileHistoryService } from '../services/fileHistoryService.js';
import {
  type FileSystemService,
  StandardFileSystemService,
  type FileEncodingType,
} from '../services/fileSystemService.js';
import { GitWorktreeService } from '../services/gitWorktreeService.js';
import { cleanupStaleAgentWorktrees } from '../services/worktreeCleanup.js';
import { CronScheduler } from '../services/cronScheduler.js';
import {
  MemoryPressureMonitor,
  DEFAULT_PRESSURE_CONFIG,
  validateMemoryPressureConfig,
  type MemoryPressureConfig,
} from '../services/memoryPressureMonitor.js';

// Tools — only lightweight imports; tool classes are lazy-loaded via dynamic import
import {
  MCPServerStatus,
  getMCPServerStatus,
  type SendSdkMcpMessage,
} from '../tools/mcp-client.js';
import { setGeminiMdFilename } from '../memory/const.js';
import { canUseRipgrep } from '../utils/ripgrepUtils.js';
import { recordStartupEvent } from '../utils/startupEventSink.js';
import { ToolRegistry, type ToolFactory } from '../tools/tool-registry.js';
import type { McpBudgetEvent } from '../tools/mcp-client-manager.js';
import { ToolNames } from '../tools/tool-names.js';
import type { LspClient, LspStatusSnapshot } from '../lsp/types.js';
import type { InstructionLoadReason } from '../hooks/types.js';

// Other modules
import { ideContextStore } from '../ide/ideContext.js';
import { InputFormat, OutputFormat } from '../output/types.js';
import { PromptRegistry } from '../prompts/prompt-registry.js';
import { SkillManager } from '../skills/skill-manager.js';
import { PermissionManager } from '../permissions/permission-manager.js';
import {
  type AutoModeDenialState,
  createDenialState,
  resetDenialState,
} from '../permissions/denialTracking.js';
import { type PlanGateState, createPlanGateState } from '../plan-gate/state.js';
import { SubagentManager } from '../subagents/subagent-manager.js';
import type { SubagentConfig } from '../subagents/types.js';
import { BackgroundTaskRegistry } from '../agents/background-tasks.js';
import { MonitorRegistry } from '../services/monitorRegistry.js';
import { BackgroundAgentResumeService } from '../agents/background-agent-resume.js';
import { BackgroundShellRegistry } from '../services/backgroundShellRegistry.js';
import { FileReadCache } from '../services/fileReadCache.js';
import { resolveStopHookBlockingCap } from '../hooks/stopHookCap.js';
import {
  DEFAULT_OTLP_ENDPOINT,
  DEFAULT_TELEMETRY_TARGET,
  isTelemetrySdkInitialized,
  initializeTelemetry,
  shutdownTelemetry,
  refreshSessionContext,
  logStartSession,
  logRipgrepFallback,
  RipgrepFallbackEvent,
  StartSessionEvent,
  type TelemetryTarget,
} from '../telemetry/index.js';
import {
  ExtensionManager,
  type Extension,
} from '../extension/extensionManager.js';
import {
  HookSystem,
  createHookOutput,
  createInstructionsLoadedCallback,
} from '../hooks/index.js';
import { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  MessageBusType,
  type HookExecutionRequest,
  type HookExecutionResponse,
} from '../confirmation-bus/types.js';
import {
  PermissionMode,
  NotificationType,
  type PermissionDeniedReason,
  type PermissionSuggestion,
  type HookEventName,
  type HookDefinition,
  type PostToolBatchToolCall,
} from '../hooks/types.js';
import { fireNotificationHook } from '../core/toolHookTriggers.js';

// Utils
import { shouldAttemptBrowserLaunch } from '../utils/browser.js';
import { FileExclusions } from '../utils/ignorePatterns.js';
import { shouldDefaultToNodePty } from '../utils/shell-utils.js';
import { WorkspaceContext } from '../utils/workspaceContext.js';
import { type ToolName } from '../utils/tool-utils.js';
import { getErrorMessage } from '../utils/errors.js';
import { normalizeProxyUrl } from '../utils/proxyUtils.js';

// Local config modules
import type { FileFilteringOptions } from './constants.js';
import {
  DEFAULT_FILE_FILTERING_OPTIONS,
  DEFAULT_MEMORY_FILE_FILTERING_OPTIONS,
} from './constants.js';
import { DEFAULT_QWEN_EMBEDDING_MODEL } from './models.js';
import { Storage } from './storage.js';
import { ChatRecordingService } from '../services/chatRecordingService.js';
import {
  clearRuntimeStatus,
  writeRuntimeStatus,
} from '../utils/runtimeStatus.js';
import {
  SessionService,
  type ResumedSessionData,
} from '../services/sessionService.js';
import { randomUUID } from 'node:crypto';
import { loadServerHierarchicalMemory } from '../utils/memoryDiscovery.js';
import { ConditionalRulesRegistry } from '../utils/rulesDiscovery.js';
import {
  createDebugLogger,
  setDebugLogSession,
  type DebugLogger,
} from '../utils/debugLogger.js';
import { getAutoMemoryRoot, getUserAutoMemoryRoot } from '../memory/paths.js';
import {
  readAutoMemoryIndex,
  readUserAutoMemoryIndex,
} from '../memory/store.js';
import { MemoryManager } from '../memory/manager.js';
import { CommitAttributionService } from '../services/commitAttribution.js';

const gitCoAuthorLogger = createDebugLogger('GIT_CO_AUTHOR');
const memoryPressureConfigLogger = createDebugLogger('MEMORY_PRESSURE');

import {
  ModelsConfig,
  type ModelProvidersConfig,
  type AvailableModel,
  type RuntimeModelSnapshot,
} from '../models/index.js';
import { resolveModelId } from '../utils/modelId.js';
import type { ClaudeMarketplaceConfig } from '../extension/claude-converter.js';

// Re-export types
export type { AnyToolInvocation, FileFilteringOptions, MCPOAuthConfig };
export {
  DEFAULT_FILE_FILTERING_OPTIONS,
  DEFAULT_MEMORY_FILE_FILTERING_OPTIONS,
};

export type ModelInvocableCommandExecutorResult = string | { error: string };

export enum ApprovalMode {
  PLAN = 'plan',
  DEFAULT = 'default',
  AUTO_EDIT = 'auto-edit',
  AUTO = 'auto',
  YOLO = 'yolo',
}

export const APPROVAL_MODES = Object.values(ApprovalMode);

/**
 * Thrown by `Config.setApprovalMode` when the requested mode would grant
 * privileged tool autonomy in a folder the user has not marked as trusted.
 *
 * Why: the daemon mutation route at `POST /session/:id/approval-mode` needs
 * to recognize this specific class of rejection and translate it into a
 * structured `errorKind: 'auth_env_error'` rather than a generic 500.
 * Using a named subclass lets the bridge match by `err.name` without
 * depending on the message text (which would drift across i18n).
 */
export class TrustGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustGateError';
  }
}

/**
 * Information about an approval mode including display name and description.
 */
export interface ApprovalModeInfo {
  id: ApprovalMode;
  name: string;
  description: string;
}

/**
 * Detailed information about each approval mode.
 * Used for UI display and protocol responses.
 */
export const APPROVAL_MODE_INFO: Record<ApprovalMode, ApprovalModeInfo> = {
  [ApprovalMode.PLAN]: {
    id: ApprovalMode.PLAN,
    name: 'Plan',
    description: 'Analyze only, do not modify files or execute commands',
  },
  [ApprovalMode.DEFAULT]: {
    id: ApprovalMode.DEFAULT,
    name: 'Default',
    description: 'Require approval for file edits or shell commands',
  },
  [ApprovalMode.AUTO_EDIT]: {
    id: ApprovalMode.AUTO_EDIT,
    name: 'Auto Edit',
    description: 'Automatically approve file edits',
  },
  [ApprovalMode.AUTO]: {
    id: ApprovalMode.AUTO,
    name: 'Auto',
    description: 'LLM classifier auto-approves safe actions, blocks risky ones',
  },
  [ApprovalMode.YOLO]: {
    id: ApprovalMode.YOLO,
    name: 'YOLO',
    description: 'Automatically approve all tools',
  },
};

/**
 * Settings for the AUTO approval mode classifier.
 *
 * `hints` and `environment` are natural-language strings injected additively
 * into the classifier's system prompt; they do NOT use rule-matching syntax.
 * Use `permissions.allow / ask / deny` for hard rules.
 */
export interface AutoModeSettings {
  classifier?: {
    timeouts?: {
      /** Stage-1 fast classifier timeout in milliseconds. */
      stage1Ms?: number;
      /** Stage-2 review classifier timeout in milliseconds. */
      stage2Ms?: number;
    };
    thinking?: {
      /** Whether stage 2 may use provider/API-level thinking. */
      stage2Enabled?: boolean;
    };
  };
  hints?: {
    /** Natural-language descriptions of actions the user wants AUTO mode to allow. */
    allow?: string[];
    /**
     * Natural-language descriptions of destructive / irreversible actions the
     * user wants AUTO mode to soft-block. Soft-block means the classifier
     * blocks the action unless the user's most recent explicit request
     * authorised that exact action and scope.
     */
    softDeny?: string[];
    /**
     * Natural-language descriptions of security-boundary actions the user
     * wants the AUTO classifier to hard-block. Hard-block applies inside the
     * classifier even when an autoMode allow hint or recent user request would
     * normally authorise the action. This does not override
     * `permissions.allow`; use `permissions.deny` for deterministic hard
     * permission rules.
     */
    hardDeny?: string[];
    /**
     * @deprecated Use `softDeny`. Kept as a backward-compatible alias —
     * entries here are merged into the SOFT BLOCK user section.
     */
    deny?: string[];
  };
  /** Environment / context lines injected into the classifier's system prompt. */
  environment?: string[];
}

export interface AccessibilitySettings {
  enableLoadingPhrases?: boolean;
  screenReader?: boolean;
}

export interface BugCommandSettings {
  urlTemplate: string;
}

export interface ChatCompressionSettings {
  /**
   * Estimated tokens for a single inline image / document part when
   * apportioning chars across history during compression size estimation.
   * Also used as the placeholder budget when stripping inline media
   * out of the side-query compaction prompt. Default 1600.
   * Env override: `QWEN_IMAGE_TOKEN_ESTIMATE`.
   */
  imageTokenEstimate?: number;
  /**
   * Number of most-recently-touched files whose current content is
   * restored (embedded or referenced) after auto-compaction. Default 5.
   * Env override: `QWEN_COMPACT_MAX_RECENT_FILES`.
   */
  maxRecentFilesToRetain?: number;
  /**
   * Number of most-recent images (tool screenshots / user pastes)
   * restored after auto-compaction. Default 3.
   * Env override: `QWEN_COMPACT_MAX_RECENT_IMAGES`.
   */
  maxRecentImagesToRetain?: number;
  /**
   * When true, auto-compaction also fires once the number of
   * tool-returned images accumulated in history reaches
   * `screenshotTriggerThreshold`, independent of token usage. Aimed at
   * computer-use sessions where frequent screenshots dilute model
   * attention without necessarily exceeding the token budget. Default true.
   * Env override: `QWEN_COMPACT_SCREENSHOT_TRIGGER` (`1`/`true`/`0`/`false`).
   */
  enableScreenshotTrigger?: boolean;
  /**
   * Tool-returned image count at or above which the screenshot trigger
   * fires (only when `enableScreenshotTrigger`). Default 50.
   * Env override: `QWEN_COMPACT_SCREENSHOT_THRESHOLD`.
   */
  screenshotTriggerThreshold?: number;
}

/**
 * Settings for clearing stale context after idle periods.
 * Threshold values of -1 mean "never clear" (disabled).
 */
export interface ClearContextOnIdleSettings {
  /** Minutes idle before clearing old tool results. Default 60. Use -1 to disable. */
  toolResultsThresholdMinutes?: number;
  /** Number of most-recent tool results to preserve. Default 5. */
  toolResultsNumToKeep?: number;
}

export interface TelemetrySettings {
  enabled?: boolean;
  target?: TelemetryTarget;
  otlpEndpoint?: string;
  otlpProtocol?: 'grpc' | 'http';
  /** Per-signal endpoint override for traces (HTTP only). Used as-is without path appending. */
  otlpTracesEndpoint?: string;
  /** Per-signal endpoint override for logs (HTTP only). Used as-is without path appending. */
  otlpLogsEndpoint?: string;
  /** Per-signal endpoint override for metrics (HTTP only). Used as-is without path appending. */
  otlpMetricsEndpoint?: string;
  logPrompts?: boolean;
  includeSensitiveSpanAttributes?: boolean;
  outfile?: string;
  /**
   * Static resource attributes attached to every span/log/metric the SDK
   * exports (OTLP or file outfile — they share the same Resource).
   * Merged with `OTEL_RESOURCE_ATTRIBUTES`; settings win on key conflict.
   * Reserved keys (`service.version`, `session.id`) are dropped with a
   * `diag.warn`.
   */
  resourceAttributes?: Record<string, string>;
  /** Per-signal cardinality controls. */
  metrics?: TelemetryMetricsSettings;
  /**
   * Human-readable diagnostics produced while resolving
   * `resourceAttributes` (drops, coercions, reserved-key strips).
   * Populated by `resolveTelemetrySettings()`; the SDK emits a one-time
   * console summary at startup when this is non-empty so users notice
   * silent drops without scanning the OTel debug log.
   *
   * Not a user-settable field — operators should leave it unset.
   */
  resourceAttributeWarnings?: string[];
}

export interface TelemetryMetricsSettings {
  /**
   * Include `session.id` on every metric data point. Default: false.
   *
   * WARNING: each CLI session creates a new value, causing unbounded
   * metric time-series fan-out at the backend. Only enable for
   * short-term debugging — spans and logs still carry session.id.
   */
  includeSessionId?: boolean;
}

/**
 * Security-relevant settings controlling what client-side correlation
 * data qwen-code writes into outbound LLM API requests.
 *
 * **Why this is a separate namespace from `telemetry.*`:** telemetry
 * controls data flow into the user's OWN observability backend (OTLP
 * collector / file outfile). The settings here control data flow OUT of
 * the qwen-code process and INTO third-party LLM provider request
 * streams (DashScope, OpenAI, Anthropic, etc.). Different recipients =
 * different consent decision, so a different settings tree.
 *
 * All values default to off / no propagation. Operators who want to
 * propagate trace context for server-side trace stitching (e.g. ARMS
 * Tracing + DashScope) opt in explicitly.
 */
export interface OutboundCorrelationSettings {
  /**
   * Inject W3C `traceparent` header on outbound HTTP requests
   * originated by undici / global `fetch` (LLM SDK calls, MCP
   * StreamableHTTP clients, WebFetch tool, etc.). Default: `false`.
   *
   * When `false`, the SDK is configured with a no-op
   * `TextMapPropagator` so trace context stays internal to the user's
   * OTLP collector (operator still gets client HTTP spans, but the
   * trace id is not written onto third-party request streams).
   *
   * When `true`, the OTel default W3C composite propagator
   * (`tracecontext` + `baggage`) is installed and `traceparent` is
   * written on every outbound `fetch`. Useful when the LLM provider
   * also reports into the operator's OTel collector — e.g. ARMS
   * Tracing + DashScope — for cross-process trace stitching.
   */
  propagateTraceContext?: boolean;
}

export interface OutputSettings {
  format?: OutputFormat;
}

export interface GitCoAuthorSettings {
  commit: boolean;
  pr: boolean;
  name?: string;
  email?: string;
}

/**
 * Shape accepted by the Config constructor for the `gitCoAuthor` param.
 *
 * A plain `boolean` is accepted for backward compatibility: older settings
 * (shipped before commit and PR attribution were split) stored this field as
 * a single boolean, and we treat that as applying to both sub-toggles so
 * nobody's stored preference silently flips.
 */
export type GitCoAuthorParam = boolean | { commit?: boolean; pr?: boolean };

function normalizeGitCoAuthor(value: GitCoAuthorParam | undefined): {
  commit: boolean;
  pr: boolean;
} {
  if (typeof value === 'boolean') {
    return { commit: value, pr: value };
  }
  // Default to `true` (the schema default) ONLY when the sub-field
  // is genuinely absent. For PRESENT-but-non-boolean values, honor
  // common string forms (`"true"`/`"yes"`/`"on"`/`"1"` → true,
  // `"false"`/`"no"`/`"off"`/`"0"`/`""` → false) and treat anything
  // else as opt-out. settings.json is user-editable, and the previous
  // "default-to-true on mismatch" policy meant a hand-edited
  // `{ "commit": "false" }` silently activated attribution against
  // the user's clear intent. Safer-by-default: ambiguous values
  // disable rather than enable.
  const pickBool = (v: unknown, fieldName: string): boolean => {
    if (v === undefined) return true;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      const lowered = v.trim().toLowerCase();
      if (
        lowered === 'true' ||
        lowered === 'yes' ||
        lowered === 'on' ||
        lowered === '1'
      ) {
        return true;
      }
      // Known disable-intent forms — silent (matches user intent).
      const knownDisable = ['false', 'no', 'off', '0', 'disabled', ''];
      if (!knownDisable.includes(lowered)) {
        // Unrecognised string — disable (safer-by-default) but log
        // so a user wondering "why is my setting being ignored?"
        // can see the actual coercion in QWEN_DEBUG_LOG_FILE.
        gitCoAuthorLogger.warn(
          `Unrecognized string value for general.gitCoAuthor.${fieldName}: ${JSON.stringify(v)}; treating as false. Accepted forms: true/yes/on/1, false/no/off/0/empty.`,
        );
      }
      return false;
    }
    if (typeof v === 'number') return v === 1;
    return false;
  };
  return {
    commit: pickBool(value?.commit, 'commit'),
    pr: pickBool(value?.pr, 'pr'),
  };
}

export type ExtensionOriginSource = 'QwenCode' | 'Claude' | 'Gemini';

export interface ExtensionInstallMetadata {
  source: string;
  type: 'git' | 'local' | 'link' | 'github-release' | 'npm';
  originSource?: ExtensionOriginSource;
  releaseTag?: string; // Only present for github-release and npm installs.
  registryUrl?: string; // Only present for npm installs.
  ref?: string;
  autoUpdate?: boolean;
  allowPreRelease?: boolean;
  marketplaceConfig?: ClaudeMarketplaceConfig;
  pluginName?: string;
}

export const DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD = 25_000;
export const DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES = 1000;
/**
 * Per-message budget (chars) for the combined model-facing output of one
 * batch of tool calls. When a batch's total output exceeds this, the largest
 * results are offloaded to disk (with a recoverable pointer). `<= 0` disables.
 */
export const DEFAULT_TOOL_OUTPUT_BATCH_BUDGET = 200_000;

/**
 * Provenance of an MCP server config. Two purposes (see issue #4615):
 *
 * - **Approval gating**: `'project'` (a workspace `.mcp.json`) and `'workspace'`
 *   (a workspace `.qwen/settings.json`) are checked-in / shareable and therefore
 *   untrusted — both are held behind the pending-approval gate. See
 *   {@link isGatedMcpScope}.
 * - **Precedence**: `'workspace'` and `'system'` rank ABOVE a `.mcp.json`
 *   server, while user/default-scoped servers (left `scope` unset) rank below it
 *   — so `.mcp.json` overrides user settings but never enterprise-enforced
 *   `'system'` settings.
 *
 * Configs from user/default settings, extensions, and `--mcp-config` leave
 * `scope` unset.
 */
export type McpServerScope = 'project' | 'workspace' | 'system';

/**
 * Scopes whose servers are checked-in / shareable and therefore untrusted: they
 * must be approved before the discovery layer connects them. `'system'`
 * (enterprise-enforced) and unset (user/default/CLI/extension) scopes are
 * trusted and never gated. See issue #4615.
 */
export function isGatedMcpScope(scope: McpServerScope | undefined): boolean {
  return scope === 'project' || scope === 'workspace';
}

export class MCPServerConfig {
  constructor(
    // For stdio transport
    readonly command?: string,
    readonly args?: string[],
    readonly env?: Record<string, string>,
    readonly cwd?: string,
    // For sse transport
    readonly url?: string,
    // For streamable http transport
    readonly httpUrl?: string,
    readonly headers?: Record<string, string>,
    // For websocket transport
    readonly tcp?: string,
    // Common
    readonly timeout?: number,
    readonly trust?: boolean,
    // Metadata
    readonly description?: string,
    readonly includeTools?: string[],
    readonly excludeTools?: string[],
    readonly extensionName?: string,
    // OAuth configuration
    readonly oauth?: MCPOAuthConfig,
    readonly authProviderType?: AuthProviderType,
    // Service Account Configuration
    /* targetAudience format: CLIENT_ID.apps.googleusercontent.com */
    readonly targetAudience?: string,
    /* targetServiceAccount format: <service-account-name>@<project-num>.iam.gserviceaccount.com */
    readonly targetServiceAccount?: string,
    // SDK MCP server type - 'sdk' indicates server runs in SDK process
    readonly type?: 'sdk',
    /**
     * Per-server cap on the discovery handshake (`connect` + `tools/list` +
     * `prompts/list` + `resources/list`). Defaults: 30s for stdio servers,
     * 5s for remote HTTP/SSE. Tool-call timeout (`timeout` above) is
     * unaffected — a long-running tool invocation is not a startup
     * pathology. Appended at the end of the parameter list to avoid
     * shifting positional arguments at the many `new MCPServerConfig(...)`
     * call sites.
     */
    readonly discoveryTimeoutMs?: number,
    /**
     * Provenance of this server config (see {@link McpServerScope}). Gated
     * scopes (`'project'`, `'workspace'`) are held behind the pending-approval
     * gate; `'system'` and unset scopes connect as before. Also drives
     * precedence in `assembleMcpServers`. Appended at the end of the parameter
     * list to avoid shifting positional arguments at the many
     * `new MCPServerConfig(...)` call sites. See issue #4615.
     */
    readonly scope?: McpServerScope,
  ) {}
}

/**
 * Check if an MCP server config represents an SDK server
 */
export function isSdkMcpServerConfig(config: MCPServerConfig): boolean {
  return config.type === 'sdk';
}

export enum AuthProviderType {
  DYNAMIC_DISCOVERY = 'dynamic_discovery',
  GOOGLE_CREDENTIALS = 'google_credentials',
  SERVICE_ACCOUNT_IMPERSONATION = 'service_account_impersonation',
}

export interface SandboxConfig {
  command: 'docker' | 'podman' | 'sandbox-exec';
  image: string;
}

/**
 * Settings shared across multi-agent collaboration features
 * (Arena, Team, Swarm).
 */
/**
 * General-purpose worktree settings (Phase D-2). Distinct from
 * {@link AgentsCollabSettings.arena.worktreeBaseDir}, which only governs
 * Arena multi-model worktrees.
 */
export interface WorktreeSettings {
  /**
   * Directories under the main repository to symlink into every
   * general-purpose worktree on creation (the `enter_worktree` tool,
   * `agent isolation: "worktree"`, and the `--worktree` startup flag).
   *
   * Paths must be relative to the repo root; absolute paths and any
   * entry containing `..` are rejected by the service. Entries that
   * resolve to git-internal paths (`.git`, `.qwen`) are also rejected
   * — symlinking those would either break git inside the worktree or
   * create a worktrees-inside-worktrees loop. Missing source dirs and
   * pre-existing destinations are silently skipped.
   */
  symlinkDirectories?: readonly string[];
}

export interface AgentsCollabSettings {
  /** Display mode for multi-agent sessions ('in-process' | 'tmux' | 'iterm2') */
  displayMode?: string;
  /** Arena-specific settings */
  arena?: {
    /** Custom base directory for Arena worktrees (default: ~/.qwen/arena) */
    worktreeBaseDir?: string;
    /** Preserve worktrees and state files after session ends */
    preserveArtifacts?: boolean;
    /** Maximum rounds (turns) per agent. No limit if unset. */
    maxRoundsPerAgent?: number;
    /** Total timeout in seconds for the Arena session. No limit if unset. */
    timeoutSeconds?: number;
  };
  /** Team-specific settings */
  team?: {
    /** Maximum number of teammates (default: 10). */
    maxTeammates?: number;
  };
}

export interface ConfigParameters {
  sessionId?: string;
  sessionData?: ResumedSessionData;
  embeddingModel?: string;
  sandbox?: SandboxConfig;
  targetDir: string;
  debugMode: boolean;
  includePartialMessages?: boolean;
  question?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  coreTools?: string[];
  allowedTools?: string[];
  excludeTools?: string[];
  /**
   * Pre-merged list of slash command names that should be hidden from the
   * CLI surface. Matched case-insensitively on the final (post-rename)
   * command name. Sourced from settings (`slashCommands.disabled`, UNION
   * merged across scopes), the `--disabled-slash-commands` CLI flag, and
   * the `QWEN_DISABLED_SLASH_COMMANDS` environment variable.
   */
  disabledSlashCommands?: string[];
  /**
   * Live-read provider for the set of skill names that should be hidden
   * from `<available_skills>` and the `/<skill-name>` slash-command
   * surface. Unlike `disabledSlashCommands` (which is a frozen snapshot),
   * this is a function so the CLI layer can close over `LoadedSettings`
   * and have post-`setValue` toggles take effect without restart.
   *
   * Must be attached at construction time — `Config.initialize()` calls
   * `toolRegistry.warmAll()` which instantiates `SkillTool`, and that
   * tool's constructor immediately calls `refreshSkills()`. A late-attach
   * provider would let persisted disabled skills leak into the first
   * `<available_skills>` build.
   *
   * Names returned must be lower-cased; consumers compare case-insensitively.
   */
  disabledSkillNamesProvider?: () => ReadonlySet<string>;
  /**
   * Tool names hidden from the registry at construction time. Unlike
   * `permissions.deny` (which keeps the tool registered and rejects
   * invocation), tools listed here are not registered at all and never
   * appear in `/tools`, `getAllTools()`, or function-call discovery.
   * Sourced from `settings.tools.disabled` and the daemon mutation route
   * `POST /workspace/tools/:name/enable {enabled:false}`. Active sessions retain already-registered tools — the disabled
   * set is consulted at register time, so toggling takes effect on the
   * next ACP child spawn or `ToolRegistry.refresh()`.
   */
  disabledTools?: string[];
  /** Merged permission rules from all sources (settings + CLI args). */
  permissions?: {
    allow?: string[];
    ask?: string[];
    deny?: string[];
    /** Settings consumed by the AUTO approval mode classifier. */
    autoMode?: AutoModeSettings;
  };
  toolDiscoveryCommand?: string;
  toolCallCommand?: string;
  mcpServerCommand?: string;
  mcpServers?: Record<string, MCPServerConfig>;
  lsp?: {
    enabled?: boolean;
  };
  lspClient?: LspClient;
  userMemory?: string;
  geminiMdFileCount?: number;
  approvalMode?: ApprovalMode;
  contextFileName?: string | string[];
  accessibility?: AccessibilitySettings;
  telemetry?: TelemetrySettings;
  outboundCorrelation?: OutboundCorrelationSettings;
  gitCoAuthor?: GitCoAuthorParam;
  usageStatisticsEnabled?: boolean;
  /**
   * If true, disables the per-session FileReadCache short-circuit
   * (file_unchanged placeholder). Useful for sessions that may undergo
   * context compaction or transcript transformation, where the model
   * cannot reliably retrieve a previously-emitted full file content
   * from prior tool results. Defaults to false (cache active).
   */
  fileReadCacheDisabled?: boolean;
  fileFiltering?: {
    respectGitIgnore?: boolean;
    respectQwenIgnore?: boolean;
    enableRecursiveFileSearch?: boolean;
    enableFuzzySearch?: boolean;
  };
  fileCheckpointingEnabled?: boolean;
  /** Directory where approved plan files are stored. Must resolve inside targetDir. */
  plansDirectory?: string;
  proxy?: string;
  cwd: string;
  fileDiscoveryService?: FileDiscoveryService;
  includeDirectories?: string[];
  bugCommand?: BugCommandSettings;
  model?: string;
  outputLanguageFilePath?: string;
  maxSessionTurns?: number;
  /**
   * Wall-clock budget for an unattended run, in seconds. `-1` (default)
   * means no limit. Enforced by the CLI's non-interactive run loop
   * see `RunBudgetEnforcer` in `packages/cli/src/utils/runBudget.ts`.
   * Issue: QwenLM/qwen-code#4103.
   */
  maxWallTimeSeconds?: number;
  /**
   * Cumulative tool-call budget across the entire run. `-1` means no
   * limit. Counts every `executeToolCall` invocation (incl. failed
   * tools, since the model is still consuming tokens reading the error).
   */
  maxToolCalls?: number;
  clearContextOnIdle?: ClearContextOnIdleSettings;
  sessionTokenLimit?: number;
  experimentalZedIntegration?: boolean;
  cronEnabled?: boolean;
  agentTeamEnabled?: boolean;
  workflowsEnabled?: boolean;
  computerUseEnabled?: boolean;
  emitToolUseSummaries?: boolean;
  listExtensions?: boolean;
  overrideExtensions?: string[];
  allowedMcpServers?: string[];
  excludedMcpServers?: string[];
  /**
   * Names of project-scoped (`.mcp.json`) servers that are NOT yet approved
   * (pending or rejected). These are loaded so they can be listed, but the
   * discovery layer must not connect them. See issue #4615.
   */
  pendingMcpServers?: string[];
  noBrowser?: boolean;
  folderTrustFeature?: boolean;
  folderTrust?: boolean;
  ideMode?: boolean;
  authType?: AuthType;
  generationConfig?: Partial<ContentGeneratorConfig>;
  /**
   * Optional source map for generationConfig fields (e.g. CLI/env/settings attribution).
   * This is used to produce per-field source badges in the UI.
   */
  generationConfigSources?: ContentGeneratorConfigSources;
  cliVersion?: string;
  loadMemoryFromIncludeDirectories?: boolean;
  importFormat?: 'tree' | 'flat';
  chatRecording?: boolean;
  chatCompression?: ChatCompressionSettings;
  interactive?: boolean;
  trustedFolder?: boolean;
  defaultFileEncoding?: FileEncodingType;
  useRipgrep?: boolean;
  useBuiltinRipgrep?: boolean;
  shouldUseNodePtyShell?: boolean;
  /** Prevent the system from sleeping while model or tool work is in flight. */
  preventSystemSleep?: boolean;
  skipNextSpeakerCheck?: boolean;
  shellExecutionConfig?: ShellExecutionConfig;
  skipLoopDetection?: boolean;
  truncateToolOutputThreshold?: number;
  truncateToolOutputLines?: number;
  toolOutputBatchBudget?: number;
  eventEmitter?: EventEmitter;
  output?: OutputSettings;
  inputFormat?: InputFormat;
  outputFormat?: OutputFormat;
  skipStartupContext?: boolean;
  bareMode?: boolean;
  sdkMode?: boolean;
  sessionSubagents?: SubagentConfig[];
  channel?: string;
  /**
   * File descriptor number for structured JSON event output (dual output mode).
   * When set, Qwen Code outputs structured JSON events to this fd while
   * continuing to render the TUI on stdout. The caller must provide this fd
   * via spawn stdio configuration.
   * Mutually exclusive with jsonFile.
   */
  jsonFd?: number;
  /**
   * File path for structured JSON event output (dual output mode).
   * Can be a regular file, FIFO (named pipe), or /dev/fd/N.
   * Mutually exclusive with jsonFd.
   */
  jsonFile?: string;
  /**
   * JSON Schema that the model's final output must conform to. When set, a
   * synthetic `structured_output` tool is registered and the non-interactive
   * CLI ends the session the first time the model calls it with valid args.
   * Only meaningful in headless mode (`qwen -p`).
   */
  jsonSchema?: Record<string, unknown>;
  /**
   * File path for receiving remote input commands (bidirectional sync mode).
   * An external process writes JSONL commands to this file, and the TUI
   * watches it to process messages as if the user typed them.
   */
  inputFile?: string;
  /** Model providers configuration grouped by authType */
  modelProvidersConfig?: ModelProvidersConfig;
  /** Multi-agent collaboration settings (Arena, Team, Swarm) */
  agents?: AgentsCollabSettings;
  /** General-purpose worktree settings (Phase D-2). */
  worktree?: WorktreeSettings;
  /** Enable managed auto-memory background extraction and dream. Defaults to true. */
  enableManagedAutoMemory?: boolean;
  /** Enable managed auto-dream consolidation separately from extraction. Defaults to true. */
  enableManagedAutoDream?: boolean;
  /** Enable automatic project skill review after tool-heavy sessions. Defaults to false. */
  enableAutoSkill?: boolean;
  /**
   * Lightweight model for background tasks (memory extraction, dream, /btw side questions).
   * When set and valid for the current auth type, forked agents use this model instead of
   * the main session model, reducing latency and cost.
   * Corresponds to the `fastModel` setting (configurable via `/model --fast`).
   */
  fastModel?: string;
  /**
   * Disable all hooks (default: false, hooks enabled).
   * Migration note: This replaces the deprecated hooksConfig.enabled setting.
   * Users with old settings.json containing hooksConfig.enabled should migrate
   * to use disableAllHooks instead (note: inverted logic - enabled:true → disableAllHooks:false).
   */
  disableAllHooks?: boolean;
  /**
   * Maximum consecutive blocking Stop/SubagentStop hook decisions before the
   * runtime overrides the hook loop and allows the turn to end.
   */
  stopHookBlockingCap?: number;
  /**
   * User-level hooks configuration (from user settings).
   * These hooks are always loaded regardless of folder trust status.
   */
  userHooks?: Record<string, unknown>;
  /**
   * Project-level hooks configuration (from workspace settings).
   * These hooks are only loaded in trusted folders.
   * When undefined or the folder is untrusted, project hooks are skipped.
   */
  projectHooks?: Record<string, unknown>;

  hooks?: Record<string, unknown>;
  /** Glob patterns to exclude from .qwen/rules/ loading. */
  contextRuleExcludes?: string[];
  /** Warnings generated during configuration resolution */
  warnings?: string[];
  /** Allowed HTTP hook URLs whitelist (from security.allowedHttpHookUrls) */
  allowedHttpHookUrls?: string[];
  /**
   * Callback for persisting a permission rule to settings.
   * Injected by the CLI layer; core uses this to write allow/ask/deny rules
   * to project or user settings when the user clicks "Always Allow".
   *
   * @param scope - 'project' for workspace settings, 'user' for user settings.
   * @param ruleType - 'allow' | 'ask' | 'deny'.
   * @param rule - The raw rule string, e.g. "Bash(git *)" or "Edit".
   */
  onPersistPermissionRule?: (
    scope: 'project' | 'user',
    ruleType: 'allow' | 'ask' | 'deny',
    rule: string,
  ) => Promise<void>;
}

function normalizeConfigOutputFormat(
  format: OutputFormat | undefined,
): OutputFormat | undefined {
  if (!format) {
    return undefined;
  }
  switch (format) {
    case 'stream-json':
      return OutputFormat.STREAM_JSON;
    case 'json':
    case OutputFormat.JSON:
      return OutputFormat.JSON;
    case 'text':
    case OutputFormat.TEXT:
    default:
      return OutputFormat.TEXT;
  }
}

function loadMemoryPressureConfig(): MemoryPressureConfig {
  const config: MemoryPressureConfig = { ...DEFAULT_PRESSURE_CONFIG };

  try {
    config.softPressureRatio = readMemoryPressureRatioEnv(
      'QWEN_MEMORY_PRESSURE_SOFT',
      config.softPressureRatio,
    );
    config.hardPressureRatio = readMemoryPressureRatioEnv(
      'QWEN_MEMORY_PRESSURE_HARD',
      config.hardPressureRatio,
    );
    config.criticalRatio = readMemoryPressureRatioEnv(
      'QWEN_MEMORY_PRESSURE_CRITICAL',
      config.criticalRatio,
    );

    const enableGC = process.env['QWEN_MEMORY_ENABLE_GC'];
    if (
      enableGC &&
      ['0', 'false', 'off', 'no'].includes(enableGC.trim().toLowerCase())
    ) {
      config.enableExplicitGC = false;
    }

    validateMemoryPressureConfig(config);
  } catch (err) {
    const fallbackMsg =
      '[QWEN] WARNING: Invalid memory pressure config; using defaults. ' +
      `Error: ${getErrorMessage(err)}`;
    process.stderr.write(`${fallbackMsg}\n`);
    memoryPressureConfigLogger.warn(fallbackMsg);
    return { ...DEFAULT_PRESSURE_CONFIG };
  }

  return config;
}

function readMemoryPressureRatioEnv(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${envName} must be a finite number`);
  }
  return parsed;
}

/**
 * Options for Config.initialize()
 */
export interface ConfigInitializeOptions {
  /**
   * Callback for sending MCP messages to SDK servers via control plane.
   * Required for SDK MCP server support in SDK mode.
   */
  sendSdkMcpMessage?: SendSdkMcpMessage;
  /**
   * Skip Gemini client chat initialization. Useful for bootstrap paths that
   * need config services (hooks, tools, MCP) before a real session exists.
   */
  skipGeminiInitialization?: boolean;
  /**
   * skip MCP
   * discovery entirely (both inline tool-registry-time discovery AND
   * the post-`createToolRegistry` background `startMcpDiscoveryInBackground`).
   * The bootstrap config in ACP daemon mode uses this to AVOID spawning
   * MCP servers under the bootstrap's pool-less McpClientManager.
   * Pre-fix every stdio MCP server was spawned twice — once by the
   * bootstrap (legacy per-server path, invisible to pool / budget /
   * drainAll / pid-sweep) and once by each session's pool-routed
   * discovery — silently violating the workspace budget contract.
   * The bootstrap's MCP clients were never actually used to serve a
   * session (each session builds its own per-session Config and runs
   * its own discovery), so skipping at the bootstrap layer is safe
   * AND closes the 2N subprocess leak.
   */
  skipMcpDiscovery?: boolean;
}

const DEFAULT_BARE_CORE_TOOLS = [
  ToolNames.READ_FILE,
  ToolNames.EDIT,
  ToolNames.NOTEBOOK_EDIT,
  ToolNames.SHELL,
];

// Shared empty set returned by `Config.getDisabledSkillNames()` when no
// provider was attached. Frozen so callers cannot accidentally mutate the
// shared instance and leak state across Config instances.
const EMPTY_DISABLED_SKILL_NAMES: ReadonlySet<string> = Object.freeze(
  new Set<string>(),
);

// Tracks whether the first Config in this process has claimed the global
// QWEN_CODE_SESSION_ID env var. Prevents throwaway Config instances from
// overwriting the real session's ID while still allowing nested qwen-code
// processes to claim their own (they start with a fresh module scope).
let sessionEnvClaimed = false;

export class Config {
  private sessionId: string;
  private sessionData?: ResumedSessionData;
  /**
   * One-shot notice produced by `setupStartupWorktree` (Phase D-1) when the
   * CLI was launched with `--worktree`. The active entry point (TUI XOR
   * headless) reads it via {@link consumePendingStartupWorktreeNotice} on
   * the model's first prompt and skips Phase C's `restoreWorktreeContext`
   * for that turn — startup wins over the resumed-session sidecar. ACP is
   * gated out earlier in `gemini.tsx` (mutex with `--worktree`) so it
   * never reaches this slot.
   *
   * @invariant At most one consumer per process. If a future entry path
   * sets this slot without ever consuming, the string persists until
   * process exit (which dies with the process — no leak).
   */
  private pendingStartupWorktreeNotice: string | null = null;
  private debugLogger: DebugLogger;
  private toolRegistry!: ToolRegistry;
  /**
   * callback stashed BEFORE
   * `initialize()` runs and applied as soon as `toolRegistry` is up,
   * so the manager's `setOnBudgetEvent` is wired before
   * `startMcpDiscoveryInBackground` (or legacy blocking discovery)
   * fires the first pass. Pre-fix the acpAgent registered after
   * `initialize()` returned, missing the first pass entirely under
   * `QWEN_CODE_LEGACY_MCP_BLOCKING=1` and racing against background
   * discovery completion under the default mode.
   */
  private pendingMcpBudgetCallback?: (event: McpBudgetEvent) => void;
  private promptRegistry!: PromptRegistry;
  private subagentManager!: SubagentManager;
  private memoryPressureConfig?: MemoryPressureConfig;
  private memoryPressureMonitor?: MemoryPressureMonitor;
  private readonly backgroundTaskRegistry = new BackgroundTaskRegistry();
  private readonly monitorRegistry = new MonitorRegistry();
  private backgroundAgentResumeService?: BackgroundAgentResumeService;
  private readonly backgroundShellRegistry = new BackgroundShellRegistry();
  // Field initializer runs once on the parent Config; child Configs
  // built via Object.create(parent) intentionally do NOT pick this up
  // — see getFileReadCache() for the per-instance lazy initialization
  // that keeps subagent caches isolated from the parent's.
  private fileReadCache: FileReadCache = new FileReadCache();
  private extensionManager!: ExtensionManager;
  private skillManager: SkillManager | null = null;
  private permissionManager: PermissionManager | null = null;
  private modelInvocableCommandsProvider:
    | (() => ReadonlyArray<{ name: string; description: string }>)
    | null = null;
  private modelInvocableCommandsExecutor:
    | ((
        name: string,
        args?: string,
      ) => Promise<ModelInvocableCommandExecutorResult | null>)
    | null = null;
  // Skill keys (e.g. "skill:foo") that coreToolScheduler announced inline on a
  // tool result. The client's drain consumes this set so it can mark them as
  // announced and avoid double-announcing in the same turn's tail reminder.
  private pendingInlineAnnouncedSkillKeys = new Set<string>();
  private fileSystemService: FileSystemService;
  private contentGeneratorConfig!: ContentGeneratorConfig;
  private contentGeneratorConfigSources: ContentGeneratorConfigSources = {};
  private contentGenerator!: ContentGenerator;
  private readonly embeddingModel: string;

  private modelsConfig!: ModelsConfig;
  private readonly modelProvidersConfig?: ModelProvidersConfig;
  private readonly sandbox: SandboxConfig | undefined;
  private targetDir: string;
  private workspaceContext: WorkspaceContext;
  private readonly debugMode: boolean;
  private readonly inputFormat: InputFormat;
  private readonly outputFormat: OutputFormat;
  private readonly includePartialMessages: boolean;
  private readonly question: string | undefined;
  private readonly systemPrompt: string | undefined;
  private readonly appendSystemPrompt: string | undefined;
  private readonly coreTools: string[] | undefined;
  private readonly allowedTools: string[] | undefined;
  private readonly excludeTools: string[] | undefined;
  private readonly disabledSlashCommands: readonly string[];
  private readonly disabledSkillNamesProvider:
    | (() => ReadonlySet<string>)
    | null;
  //   `disabledTools` is set at construction
  // time but can be re-synced by the daemon mutation surface
  // (`setWorkspaceToolEnabled` propagates through ACP) so a subsequent
  // `discoverMcpToolsForServer` sees the latest disabled set instead
  // of the bootstrap snapshot. Stays `ReadonlySet` for callers; the
  // setter swaps the reference rather than mutating in place so any
  // captured reference (e.g. by ToolRegistry mid-iteration) remains
  // self-consistent.
  private disabledTools: ReadonlySet<string>;
  private readonly permissionsAllow: string[];
  private readonly permissionsAsk: string[];
  private readonly permissionsDeny: string[];
  private readonly permissionsAutoMode: AutoModeSettings;
  private readonly toolDiscoveryCommand: string | undefined;
  private readonly toolCallCommand: string | undefined;
  private readonly mcpServerCommand: string | undefined;
  private mcpServers: Record<string, MCPServerConfig> | undefined;
  private readonly runtimeMcpServers = new Map<string, MCPServerConfig>();
  private readonly lspEnabled: boolean;
  private lspClient?: LspClient;
  private lspInitializationError?: string;
  private readonly allowedMcpServers?: string[];
  private excludedMcpServers?: string[];
  private pendingMcpServers?: string[];
  private sessionSubagents: SubagentConfig[];
  private userMemory: string;
  private sdkMode: boolean;
  private geminiMdFileCount: number;
  private conditionalRulesRegistry: ConditionalRulesRegistry | undefined;
  private readonly contextRuleExcludes: string[];
  private approvalMode: ApprovalMode;
  private prePlanMode?: ApprovalMode;
  private planGateState?: PlanGateState;
  private planGateEntryCounter = 0;
  private autoModeDenialState: AutoModeDenialState = createDenialState();
  private readonly accessibility: AccessibilitySettings;
  private readonly telemetrySettings: TelemetrySettings;
  private readonly outboundCorrelationSettings: OutboundCorrelationSettings;
  private readonly gitCoAuthor: GitCoAuthorSettings;
  private readonly usageStatisticsEnabled: boolean;
  private readonly fileReadCacheDisabled: boolean;
  private geminiClient!: GeminiClient;
  private baseLlmClient!: BaseLlmClient;
  private cronScheduler: CronScheduler | null = null;
  private readonly fileFiltering: {
    respectGitIgnore: boolean;
    respectQwenIgnore: boolean;
    enableRecursiveFileSearch: boolean;
    enableFuzzySearch: boolean;
  };
  private fileDiscoveryService: FileDiscoveryService | null = null;
  private sessionService: SessionService | undefined = undefined;
  private chatRecordingService: ChatRecordingService | undefined = undefined;
  private fileCheckpointingEnabled: boolean;
  // Object (not primitive) so sub-agents via Object.create(parentConfig)
  // share the same budget instance through prototype lookup.
  private readonly toolResultBudget = { bytesWritten: 0 };
  private fileHistoryService: FileHistoryService | undefined;
  private readonly proxy: string | undefined;
  private cwd: string;
  private readonly explicitIncludeDirectories: string[];
  private readonly bugCommand: BugCommandSettings | undefined;
  private outputLanguageFilePath?: string;
  private readonly noBrowser: boolean;
  private readonly folderTrustFeature: boolean;
  private readonly folderTrust: boolean;
  private ideMode: boolean;

  private readonly maxSessionTurns: number;
  private readonly maxWallTimeSeconds: number;
  private readonly maxToolCalls: number;
  private readonly clearContextOnIdle: ClearContextOnIdleSettings;
  private readonly sessionTokenLimit: number;
  private readonly listExtensions: boolean;
  private readonly overrideExtensions?: string[];

  private readonly cliVersion?: string;
  private runtimeStatusEnabled = false;
  private readonly experimentalZedIntegration: boolean = false;
  private readonly cronEnabled: boolean = true;
  private readonly agentTeamEnabled: boolean = false;
  private workflowsEnabled = false;
  private readonly computerUseEnabled: boolean = true;
  private readonly emitToolUseSummaries: boolean = true;
  private readonly chatRecordingEnabled: boolean;
  private readonly loadMemoryFromIncludeDirectories: boolean = false;
  private readonly importFormat: 'tree' | 'flat';
  private readonly chatCompression: ChatCompressionSettings | undefined;
  private readonly interactive: boolean;
  private readonly trustedFolder: boolean | undefined;
  private readonly useRipgrep: boolean;
  private readonly useBuiltinRipgrep: boolean;
  private readonly shouldUseNodePtyShell: boolean;
  private readonly preventSystemSleep: boolean;
  private readonly skipNextSpeakerCheck: boolean;
  private shellExecutionConfig: ShellExecutionConfig;
  private arenaManager: ArenaManager | null = null;
  private arenaManagerChangeCallback:
    | ((manager: ArenaManager | null) => void)
    | null = null;
  private readonly arenaAgentClient: ArenaAgentClient | null;
  private teamManager: TeamManager | null = null;
  private teamManagerChangeCallbacks = new Set<
    (manager: TeamManager | null) => void
  >();
  private teamContext: TeamContext | null = null;
  private readonly agentsSettings: AgentsCollabSettings;
  private readonly worktreeSettings: WorktreeSettings;
  private readonly skipLoopDetection: boolean;
  private readonly skipStartupContext: boolean;
  private readonly bareMode: boolean;
  private readonly warnings: string[];
  private readonly allowedHttpHookUrls: string[];
  private readonly onPersistPermissionRuleCallback?: (
    scope: 'project' | 'user',
    ruleType: 'allow' | 'ask' | 'deny',
    rule: string,
  ) => Promise<void>;
  private initialized: boolean = false;
  storage: Storage;
  private runtimeStatusWrite: Promise<void> = Promise.resolve();
  private readonly fileExclusions: FileExclusions;
  private readonly truncateToolOutputThreshold: number;
  private readonly truncateToolOutputLines: number;
  private readonly toolOutputBatchBudget: number;
  private readonly eventEmitter?: EventEmitter;
  private readonly channel: string | undefined;
  private readonly jsonFd: number | undefined;
  private readonly jsonFile: string | undefined;
  private readonly jsonSchema: Record<string, unknown> | undefined;
  private readonly inputFile: string | undefined;
  private readonly plansDir: string;
  private readonly plansDirectoryConfigured: boolean;
  private readonly defaultFileEncoding: FileEncodingType | undefined;
  private readonly enableManagedAutoMemory: boolean;
  private readonly enableManagedAutoDream: boolean;
  private readonly enableAutoSkill: boolean;
  private fastModel?: string;
  private readonly disableAllHooks: boolean;
  private readonly stopHookBlockingCap: number;
  /** User-level hooks (always loaded regardless of trust) */
  private readonly userHooks?: Record<string, unknown>;
  /** Project-level hooks (only loaded in trusted folders) */
  private readonly projectHooks?: Record<string, unknown>;
  /** @deprecated Legacy merged hooks field - use userHooks/projectHooks instead */
  private readonly hooks?: Record<string, unknown>;
  private hookSystem?: HookSystem;
  private messageBus?: MessageBus;
  private readonly memoryManager: MemoryManager;
  private readonly modelChangeListeners = new Set<(model: string) => void>();

  constructor(params: ConfigParameters) {
    this.sessionId = params.sessionId ?? randomUUID();
    // Only set the global env marker once per process lifetime, so
    // throwaway Config instances (e.g. telemetry-only) don't clobber
    // the real interactive session's ID. Uses a module-level flag
    // rather than checking env existence — otherwise a nested qwen-code
    // launched from within a session would inherit the parent's ID and
    // never claim its own.
    if (!sessionEnvClaimed && process.env) {
      process.env['QWEN_CODE_SESSION_ID'] = this.sessionId;
      sessionEnvClaimed = true;
    }
    this.sessionData = params.sessionData;
    setDebugLogSession(this);
    this.debugLogger = createDebugLogger();
    this.embeddingModel = params.embeddingModel ?? DEFAULT_QWEN_EMBEDDING_MODEL;
    this.fileSystemService = new StandardFileSystemService();
    this.sandbox = params.sandbox;
    this.targetDir = path.resolve(params.targetDir);
    this.plansDirectoryConfigured = Boolean(params.plansDirectory?.trim());
    this.plansDir = Storage.getPlansDir(this.targetDir, params.plansDirectory);
    this.explicitIncludeDirectories = Array.from(
      new Set(params.includeDirectories ?? []),
    );
    this.workspaceContext = new WorkspaceContext(
      this.targetDir,
      this.explicitIncludeDirectories,
    );
    this.debugMode = params.debugMode;
    this.inputFormat = params.inputFormat ?? InputFormat.TEXT;
    const normalizedOutputFormat = normalizeConfigOutputFormat(
      params.outputFormat ?? params.output?.format,
    );
    this.outputFormat = normalizedOutputFormat ?? OutputFormat.TEXT;
    this.includePartialMessages = params.includePartialMessages ?? false;
    this.question = params.question;
    this.systemPrompt = params.systemPrompt;
    this.appendSystemPrompt = params.appendSystemPrompt;
    this.coreTools = params.coreTools;
    this.allowedTools = params.allowedTools;
    this.excludeTools = params.excludeTools;
    this.disabledSlashCommands = Object.freeze([
      ...(params.disabledSlashCommands ?? []),
    ]);
    this.disabledSkillNamesProvider = params.disabledSkillNamesProvider ?? null;
    this.disabledTools = new Set(params.disabledTools ?? []);
    this.permissionsAllow = params.permissions?.allow || [];
    this.permissionsAsk = params.permissions?.ask || [];
    this.permissionsDeny = params.permissions?.deny || [];
    this.permissionsAutoMode = params.permissions?.autoMode ?? {};
    this.toolDiscoveryCommand = params.toolDiscoveryCommand;
    this.toolCallCommand = params.toolCallCommand;
    this.mcpServerCommand = params.mcpServerCommand;
    this.mcpServers = params.mcpServers;
    this.lspEnabled = params.lsp?.enabled ?? false;
    this.lspClient = params.lspClient;
    this.allowedMcpServers = params.allowedMcpServers;
    this.excludedMcpServers = params.excludedMcpServers;
    this.pendingMcpServers = params.pendingMcpServers;
    this.sessionSubagents = params.sessionSubagents ?? [];
    this.sdkMode = params.sdkMode ?? false;
    this.userMemory = params.userMemory ?? '';
    this.geminiMdFileCount = params.geminiMdFileCount ?? 0;
    this.contextRuleExcludes = params.contextRuleExcludes ?? [];
    this.approvalMode = params.approvalMode ?? ApprovalMode.DEFAULT;
    this.accessibility = params.accessibility ?? {};
    this.telemetrySettings = {
      enabled: params.telemetry?.enabled ?? false,
      target: params.telemetry?.target ?? DEFAULT_TELEMETRY_TARGET,
      otlpEndpoint: params.telemetry?.otlpEndpoint,
      otlpProtocol: params.telemetry?.otlpProtocol,
      otlpTracesEndpoint: params.telemetry?.otlpTracesEndpoint,
      otlpLogsEndpoint: params.telemetry?.otlpLogsEndpoint,
      otlpMetricsEndpoint: params.telemetry?.otlpMetricsEndpoint,
      logPrompts: params.telemetry?.logPrompts ?? true,
      includeSensitiveSpanAttributes:
        params.telemetry?.includeSensitiveSpanAttributes ?? false,
      outfile: params.telemetry?.outfile,
      resourceAttributes: params.telemetry?.resourceAttributes,
      metrics: params.telemetry?.metrics,
      resourceAttributeWarnings: params.telemetry?.resourceAttributeWarnings,
    };
    this.outboundCorrelationSettings = {
      propagateTraceContext:
        params.outboundCorrelation?.propagateTraceContext ?? false,
    };
    this.gitCoAuthor = {
      ...normalizeGitCoAuthor(params.gitCoAuthor),
      name: 'Qwen-Coder',
      email: 'qwen-coder@alibabacloud.com',
    };
    this.usageStatisticsEnabled = params.usageStatisticsEnabled ?? true;
    this.fileReadCacheDisabled = params.fileReadCacheDisabled ?? false;
    this.outputLanguageFilePath = params.outputLanguageFilePath;

    this.fileFiltering = {
      respectGitIgnore: params.fileFiltering?.respectGitIgnore ?? true,
      respectQwenIgnore: params.fileFiltering?.respectQwenIgnore ?? true,
      enableRecursiveFileSearch:
        params.fileFiltering?.enableRecursiveFileSearch ?? true,
      enableFuzzySearch: params.fileFiltering?.enableFuzzySearch ?? true,
    };
    this.fileCheckpointingEnabled =
      params.fileCheckpointingEnabled ??
      (!params.sdkMode && (params.interactive ?? false));
    this.proxy = params.proxy;
    this.cwd = params.cwd ?? process.cwd();
    this.fileDiscoveryService = params.fileDiscoveryService ?? null;
    this.bugCommand = params.bugCommand;
    this.maxSessionTurns = params.maxSessionTurns ?? -1;
    this.maxWallTimeSeconds = params.maxWallTimeSeconds ?? -1;
    this.maxToolCalls = params.maxToolCalls ?? -1;
    this.clearContextOnIdle = {
      toolResultsThresholdMinutes:
        params.clearContextOnIdle?.toolResultsThresholdMinutes ?? 60,
      toolResultsNumToKeep:
        params.clearContextOnIdle?.toolResultsNumToKeep ?? 5,
    };
    this.sessionTokenLimit = params.sessionTokenLimit ?? -1;
    this.experimentalZedIntegration =
      params.experimentalZedIntegration ?? false;
    this.cronEnabled = params.cronEnabled ?? true;
    this.agentTeamEnabled = params.agentTeamEnabled ?? false;
    this.workflowsEnabled = params.workflowsEnabled ?? false;
    this.computerUseEnabled = params.computerUseEnabled ?? true;
    this.emitToolUseSummaries = params.emitToolUseSummaries ?? true;
    this.listExtensions = params.listExtensions ?? false;
    this.overrideExtensions = params.overrideExtensions;
    this.noBrowser = params.noBrowser ?? false;
    this.folderTrustFeature = params.folderTrustFeature ?? false;
    this.folderTrust = params.folderTrust ?? false;
    this.ideMode = params.ideMode ?? false;
    this.modelProvidersConfig = params.modelProvidersConfig;
    this.cliVersion = params.cliVersion;

    this.chatRecordingEnabled = params.chatRecording ?? true;

    this.loadMemoryFromIncludeDirectories =
      params.loadMemoryFromIncludeDirectories ?? false;
    this.importFormat = params.importFormat ?? 'tree';
    this.chatCompression = params.chatCompression;
    this.interactive = params.interactive ?? false;
    this.trustedFolder = params.trustedFolder;
    this.skipLoopDetection = params.skipLoopDetection ?? false;
    this.skipStartupContext = params.skipStartupContext ?? false;
    this.bareMode = params.bareMode ?? false;
    this.warnings = params.warnings ?? [];
    this.addLegacyPlanLocationWarning();
    this.allowedHttpHookUrls = params.allowedHttpHookUrls ?? [];
    this.onPersistPermissionRuleCallback = params.onPersistPermissionRule;

    // (web search removed)
    this.useRipgrep = params.useRipgrep ?? true;
    this.useBuiltinRipgrep = params.useBuiltinRipgrep ?? true;
    this.shouldUseNodePtyShell =
      params.shouldUseNodePtyShell ?? shouldDefaultToNodePty();
    this.preventSystemSleep = params.preventSystemSleep ?? true;
    this.skipNextSpeakerCheck = params.skipNextSpeakerCheck ?? true;
    this.shellExecutionConfig = {
      terminalWidth: params.shellExecutionConfig?.terminalWidth ?? 80,
      terminalHeight: params.shellExecutionConfig?.terminalHeight ?? 24,
      showColor: params.shellExecutionConfig?.showColor ?? false,
      pager: params.shellExecutionConfig?.pager ?? 'cat',
    };
    this.truncateToolOutputThreshold =
      params.truncateToolOutputThreshold ??
      DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD;
    this.truncateToolOutputLines =
      params.truncateToolOutputLines ?? DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES;
    this.toolOutputBatchBudget =
      params.toolOutputBatchBudget ?? DEFAULT_TOOL_OUTPUT_BATCH_BUDGET;
    this.channel = params.channel;
    this.jsonFd = params.jsonFd;
    this.jsonFile = params.jsonFile;
    this.jsonSchema = params.jsonSchema;
    this.inputFile = params.inputFile;
    this.defaultFileEncoding = params.defaultFileEncoding;
    this.storage = new Storage(this.targetDir);
    this.inputFormat = params.inputFormat ?? InputFormat.TEXT;
    this.fileExclusions = new FileExclusions(this);
    this.eventEmitter = params.eventEmitter;
    this.arenaAgentClient = ArenaAgentClient.create();
    this.agentsSettings = params.agents ?? {};
    this.worktreeSettings = params.worktree ?? {};
    if (params.contextFileName) {
      setGeminiMdFilename(params.contextFileName);
    }

    // Create ModelsConfig for centralized model management
    // Prefer params.authType over generationConfig.authType because:
    // - params.authType preserves undefined (user hasn't selected yet)
    // - generationConfig.authType may have a default value from resolvers
    this.modelsConfig = new ModelsConfig({
      initialAuthType: params.authType ?? params.generationConfig?.authType,
      modelProvidersConfig: this.modelProvidersConfig,
      generationConfig: {
        model: params.model,
        ...(params.generationConfig || {}),
        baseUrl: params.generationConfig?.baseUrl,
      },
      generationConfigSources: params.generationConfigSources,
      onModelChange: this.handleModelChange.bind(this),
    });

    if (this.telemetrySettings.enabled) {
      initializeTelemetry(this);
    }

    const proxyUrl = this.getProxy();
    if (proxyUrl) {
      setGlobalDispatcher(new ProxyAgent(proxyUrl));
    }
    this.geminiClient = new GeminiClient(this);
    this.chatRecordingService = this.chatRecordingEnabled
      ? new ChatRecordingService(this)
      : undefined;
    this.extensionManager = new ExtensionManager({
      workspaceDir: this.targetDir,
      enabledExtensionOverrides: this.overrideExtensions,
      isWorkspaceTrusted: this.isTrustedFolder(),
    });
    this.enableManagedAutoMemory = params.enableManagedAutoMemory ?? true;
    this.enableManagedAutoDream = params.enableManagedAutoDream ?? true;
    this.enableAutoSkill = params.enableAutoSkill ?? true;
    this.fastModel = params.fastModel || undefined;
    this.disableAllHooks = params.disableAllHooks ?? false;
    this.stopHookBlockingCap = resolveStopHookBlockingCap(
      params.stopHookBlockingCap,
    );
    // Store user and project hooks separately for proper source attribution
    this.userHooks = params.userHooks;
    this.projectHooks = params.projectHooks;
    // Legacy: fall back to merged hooks if new fields are not provided
    this.hooks = params.hooks;
    this.memoryManager = new MemoryManager();
  }

  /**
   * Must only be called once, throws if called again.
   * @param options Optional initialization options including sendSdkMcpMessage callback
   */
  async initialize(options?: ConfigInitializeOptions): Promise<void> {
    if (this.initialized) {
      throw Error('Config was already initialized');
    }
    this.initialized = true;
    this.debugLogger.info('Config initialization started');

    // Initialize centralized FileDiscoveryService
    this.getFileService();
    this.promptRegistry = new PromptRegistry();
    this.extensionManager.setConfig(this);
    const explicitExtensionNames = this.getExplicitExtensionNames();
    if (!this.getBareMode()) {
      await this.extensionManager.refreshCache();
    } else if (explicitExtensionNames.length > 0) {
      await this.extensionManager.refreshCache({
        names: explicitExtensionNames,
      });
    }
    this.debugLogger.debug('Extension manager initialized');

    // Bare mode skips all hook loading and execution.
    if (!this.getDisableAllHooks()) {
      this.hookSystem = new HookSystem(this);
      await this.hookSystem.initialize();
      this.debugLogger.debug('Hook system initialized');

      // Initialize MessageBus for hook execution
      this.messageBus = new MessageBus();

      // Subscribe to HOOK_EXECUTION_REQUEST to execute hooks
      this.messageBus.subscribe<HookExecutionRequest>(
        MessageBusType.HOOK_EXECUTION_REQUEST,
        async (request: HookExecutionRequest) => {
          try {
            const hookSystem = this.hookSystem;
            if (!hookSystem) {
              this.messageBus?.publish({
                type: MessageBusType.HOOK_EXECUTION_RESPONSE,
                correlationId: request.correlationId,
                success: false,
                error: new Error('Hook system not initialized'),
              } as HookExecutionResponse);
              return;
            }

            // Check if request was aborted
            if (request.signal?.aborted) {
              this.messageBus?.publish({
                type: MessageBusType.HOOK_EXECUTION_RESPONSE,
                correlationId: request.correlationId,
                success: false,
                error: new Error('Hook execution cancelled (aborted)'),
              } as HookExecutionResponse);
              return;
            }

            // Execute the appropriate hook based on eventName
            let result;
            let stopHookCount: number | undefined;
            const input = request.input || {};
            const signal = request.signal;
            switch (request.eventName) {
              case 'UserPromptSubmit':
                result = await hookSystem.fireUserPromptSubmitEvent(
                  (input['prompt'] as string) || '',
                  signal,
                );
                break;
              case 'UserPromptExpansion':
                result = await hookSystem.fireUserPromptExpansionEvent(
                  (input['command_name'] as string) || '',
                  (input['command_args'] as string) || '',
                  (input['prompt'] as string) || '',
                  signal,
                );
                break;
              case 'Stop': {
                const stopResult = await hookSystem.fireStopEvent(
                  (input['stop_hook_active'] as boolean) || false,
                  (input['last_assistant_message'] as string) || '',
                  signal,
                );
                result = stopResult.finalOutput
                  ? createHookOutput('Stop', stopResult.finalOutput)
                  : undefined;
                stopHookCount = stopResult.allOutputs.length;
                break;
              }
              case 'PreToolUse': {
                result = await hookSystem.firePreToolUseEvent(
                  (input['tool_name'] as string) || '',
                  (input['tool_input'] as Record<string, unknown>) || {},
                  (input['tool_use_id'] as string) || '',
                  (input['permission_mode'] as PermissionMode | undefined) ??
                    PermissionMode.Default,
                  signal,
                );
                break;
              }
              case 'PostToolUse':
                result = await hookSystem.firePostToolUseEvent(
                  (input['tool_name'] as string) || '',
                  (input['tool_input'] as Record<string, unknown>) || {},
                  (input['tool_response'] as Record<string, unknown>) || {},
                  (input['tool_use_id'] as string) || '',
                  (input['permission_mode'] as PermissionMode) || 'default',
                  signal,
                );
                break;
              case 'PostToolUseFailure':
                result = await hookSystem.firePostToolUseFailureEvent(
                  (input['tool_use_id'] as string) || '',
                  (input['tool_name'] as string) || '',
                  (input['tool_input'] as Record<string, unknown>) || {},
                  (input['error'] as string) || '',
                  input['is_interrupt'] as boolean | undefined,
                  (input['permission_mode'] as PermissionMode) || 'default',
                  signal,
                );
                break;
              case 'PostToolBatch':
                result = await hookSystem.firePostToolBatchEvent(
                  (input['tool_calls'] as PostToolBatchToolCall[]) || [],
                  (input['permission_mode'] as PermissionMode) || 'default',
                  signal,
                );
                break;
              case 'Notification':
                result = await hookSystem.fireNotificationEvent(
                  (input['message'] as string) || '',
                  (input['notification_type'] as NotificationType) ||
                    'permission_prompt',
                  (input['title'] as string) || undefined,
                  signal,
                );
                break;
              case 'PermissionRequest':
                result = await hookSystem.firePermissionRequestEvent(
                  (input['tool_name'] as string) || '',
                  (input['tool_input'] as Record<string, unknown>) || {},
                  (input['permission_mode'] as PermissionMode) ||
                    PermissionMode.Default,
                  (input['permission_suggestions'] as
                    | PermissionSuggestion[]
                    | undefined) || undefined,
                  signal,
                );
                break;
              case 'PermissionDenied':
                result = await hookSystem.firePermissionDeniedEvent(
                  (input['tool_name'] as string) || '',
                  (input['tool_input'] as Record<string, unknown>) || {},
                  (input['tool_use_id'] as string) || '',
                  (input['reason'] as PermissionDeniedReason) ||
                    'classifier_blocked',
                  signal,
                );
                break;
              case 'SubagentStart':
                result = await hookSystem.fireSubagentStartEvent(
                  (input['agent_id'] as string) || '',
                  (input['agent_type'] as string) || '',
                  (input['permission_mode'] as PermissionMode) ||
                    PermissionMode.Default,
                  signal,
                );
                break;
              case 'SubagentStop':
                result = await hookSystem.fireSubagentStopEvent(
                  (input['agent_id'] as string) || '',
                  (input['agent_type'] as string) || '',
                  (input['agent_transcript_path'] as string) || '',
                  (input['last_assistant_message'] as string) || '',
                  (input['stop_hook_active'] as boolean) || false,
                  (input['permission_mode'] as PermissionMode) ||
                    PermissionMode.Default,
                  signal,
                );
                break;
              default:
                this.debugLogger.warn(
                  `Unknown hook event: ${request.eventName}`,
                );
                result = undefined;
            }

            // Send response
            this.messageBus?.publish({
              type: MessageBusType.HOOK_EXECUTION_RESPONSE,
              correlationId: request.correlationId,
              success: true,
              output: result,
              // Include stop hook count for Stop events
              stopHookCount,
            } as HookExecutionResponse);
          } catch (error) {
            this.debugLogger.warn(`Hook execution failed: ${error}`);
            this.messageBus?.publish({
              type: MessageBusType.HOOK_EXECUTION_RESPONSE,
              correlationId: request.correlationId,
              success: false,
              error: error instanceof Error ? error : new Error(String(error)),
            } as HookExecutionResponse);
          }
        },
      );

      this.debugLogger.debug('MessageBus initialized with hook subscription');
    } else {
      this.debugLogger.debug('Hook system disabled, skipping initialization');
    }

    this.subagentManager = new SubagentManager(this);
    this.skillManager = new SkillManager(this);
    if (this.getBareMode()) {
      await this.skillManager.refreshCache();
    } else {
      await this.skillManager.startWatching();
    }
    this.debugLogger.debug('Skill manager initialized');

    this.memoryPressureConfig = loadMemoryPressureConfig();
    this.memoryPressureMonitor = new MemoryPressureMonitor(
      this,
      this.memoryPressureConfig,
    );

    this.permissionManager = new PermissionManager(this);
    this.permissionManager.initialize();
    this.debugLogger.debug('Permission manager initialized');

    // Load session subagents if they were provided before initialization
    if (this.sessionSubagents.length > 0) {
      this.subagentManager.loadSessionSubagents(this.sessionSubagents);
    }

    if (!this.getBareMode()) {
      await this.extensionManager.refreshCache();
    }

    await this.refreshHierarchicalMemory('session_start');
    this.debugLogger.debug('Hierarchical memory loaded');

    // Progressive MCP availability: skip MCP discovery in the synchronous
    // tool-registry construction path and kick it off in the background
    // after the registry exists. This lets `Config.initialize()` (and the
    // cli's `input_enabled` checkpoint) resolve without waiting on MCP
    // server response time. Users can opt back into the legacy synchronous
    // behavior with `QWEN_CODE_LEGACY_MCP_BLOCKING=1` — kept ≥ 1 release as
    // an escape hatch.
    const legacyBlockingMcp =
      process.env['QWEN_CODE_LEGACY_MCP_BLOCKING'] === '1';
    // Also force the inline-discovery skip when the caller opts
    // out of MCP entirely (ACP bootstrap path) — otherwise the legacy
    // blocking mode would still spawn MCP servers via the tool-registry
    // construction path.
    const skipInlineMcpDiscovery =
      this.getBareMode() ||
      !legacyBlockingMcp ||
      options?.skipMcpDiscovery === true;

    this.toolRegistry = await this.createToolRegistry(
      options?.sendSdkMcpMessage,
      skipInlineMcpDiscovery ? { skipDiscovery: true } : undefined,
    );
    recordStartupEvent('tool_registry_created', {
      toolCount: this.toolRegistry.getAllToolNames().length,
      mcpInline: !skipInlineMcpDiscovery,
    });
    this.debugLogger.info(
      `Tool registry initialized with ${this.toolRegistry.getAllToolNames().length} tools`,
    );

    if (!options?.skipGeminiInitialization) {
      await this.geminiClient.initialize();
      this.debugLogger.info('Gemini client initialized');
    } else {
      this.debugLogger.info('Gemini client initialization skipped');
    }

    // Detect and capture runtime model snapshot (from CLI/ENV/credentials)
    this.modelsConfig.detectAndCaptureRuntimeModel();

    // Warm all lazy tool factories so telemetry can access tool metadata synchronously.
    // Use strict mode so a broken built-in tool surfaces immediately at startup.
    await this.toolRegistry.warmAll({ strict: true });

    // Fire-and-forget MCP discovery. Each server's tools land in the
    // registry as it becomes ready; the cli's AppContainer debounces
    // `setTools()` (~16ms / one frame) so the model sees the new tools
    // shortly after each server settles. See `AppContainer.tsx`'s
    // `mcp-client-update` subscriber.
    //
    // Also gated on `!options?.skipMcpDiscovery` — the ACP
    // bootstrap path passes `skipMcpDiscovery: true` so the bootstrap
    // config doesn't run discovery under its pool-less manager.
    if (
      skipInlineMcpDiscovery &&
      !this.getBareMode() &&
      !options?.skipMcpDiscovery
    ) {
      this.startMcpDiscoveryInBackground();
    }

    logStartSession(this, new StartSessionEvent(this));
    this.debugLogger.info('Config initialization completed');

    // Fire-and-forget sweep of stale ephemeral worktrees left behind by
    // earlier `agent` runs that exited before their cleanup helper ran
    // (Ctrl-C, process crash, abrupt shutdown). The sweep only touches
    // `agent-<7hex>` slugs, skips anything newer than 30 days, and
    // is fail-closed against tracked changes or unpushed commits — so
    // running it on every startup cannot destroy user work. We do not
    // await this: it is a hygiene task that must never delay the
    // first model turn.
    //
    // Anchor the sweep at the repo top-level so it scans the same
    // directory the worktree creators (`enter_worktree` and
    // `agent isolation:'worktree'`) write to. Using `this.targetDir`
    // directly would cause launches from a monorepo subdirectory to
    // scan `<subdir>/.qwen/worktrees/` — which never exists — and the
    // sweep would silently be a no-op forever.
    if (!this.getBareMode()) {
      void (async () => {
        try {
          // Resolve the repo top-level FIRST. The previous code bailed
          // on `fs.access(<targetDir>/.qwen/worktrees)` before resolving,
          // so a monorepo subdir launch (where `targetDir` is the
          // subdir, not the repo root) always early-returned and the
          // sweep was permanently a no-op. Fast-bail still happens, just
          // against the *correct* directory.
          const probe = new GitWorktreeService(this.targetDir);
          const root = (await probe.getRepoTopLevel()) ?? this.targetDir;
          const worktreesDir = path.join(root, '.qwen', 'worktrees');
          try {
            await fsPromises.access(worktreesDir);
          } catch {
            // Skipped (no worktrees dir) is the common-case happy
            // path on every CLI start for ~99% of users. `debug` so
            // operators can opt in via `--debug` when they actually
            // want to confirm the sweep is wired up — `info` would
            // be log noise.
            this.debugLogger.debug(
              `Stale worktree sweep skipped: ${worktreesDir} does not exist`,
            );
            return;
          }
          const removed = await cleanupStaleAgentWorktrees(root);
          if (removed > 0) {
            // Only the "actually removed something" path warrants
            // `info` — that's the signal an operator chasing a leak
            // would grep for. The "ran, found nothing" path is
            // reconstructable at `debug` and is otherwise noise:
            // every CLI start that has any worktree dir would emit
            // it, drowning the actually-actionable message.
            this.debugLogger.info(
              `Stale worktree sweep removed ${removed} ephemeral worktree(s) under ${root}`,
            );
          } else {
            this.debugLogger.debug(
              `Stale worktree sweep ran under ${root}: nothing to remove`,
            );
          }
        } catch (error: unknown) {
          // Promote sweep errors to `warn` for the same reason: a
          // permission failure / disk full / repo-corruption case
          // should leave a visible breadcrumb instead of being
          // invisible at the default log level.
          this.debugLogger.warn(
            `Stale worktree sweep failed (non-fatal): ${error}`,
          );
        }
      })();
    }
  }

  /**
   * In-flight background MCP discovery promise. Captured so non-interactive
   * code paths can await it before invoking the model (see
   * {@link waitForMcpReady}). Undefined when MCP discovery was skipped
   * entirely (bare mode, legacy blocking mode, or no MCP servers).
   */
  private mcpDiscoveryPromise?: Promise<void>;

  /**
   * Kicks off MCP server discovery in the background after the synchronous
   * portion of {@link initialize} returns. Errors are logged, never thrown:
   * a broken MCP server must not bring down the cli, and per-server
   * connect/discover failures are already surfaced through the
   * `mcp-client-update` event stream the UI subscribes to.
   *
   * Defensive against partially-stubbed `ToolRegistry` in some tests, where
   * the manager getter is unavailable — we'd rather log-and-skip than crash
   * the init path in tests that don't exercise MCP at all.
   */
  private startMcpDiscoveryInBackground(): void {
    // `getMcpClientManager` is a public method on `ToolRegistry`. The
    // cast below is NOT defensive against the production type — it
    // exists only because some tests (e.g. those using
    // `createMockToolRegistry`) stub `ToolRegistry` as a plain object
    // that doesn't implement the method. The optional-chaining call
    // (`?.()`) means the stubbed path resolves to `undefined` instead
    // of crashing `initialize()` for tests that never exercise MCP.
    //
    // Crucially, the inner shape is `ReturnType<ToolRegistry['getMcpClientManager']>`
    // — not a hand-rolled `{ discoverAllMcpToolsIncremental: ... }` — so
    // a future rename of `getMcpClientManager` on `ToolRegistry` still
    // surfaces here as a type error rather than silently falling
    // through to the `if (!manager) return` branch.
    const manager = (
      this.toolRegistry as ToolRegistry & {
        getMcpClientManager?: () => ReturnType<
          ToolRegistry['getMcpClientManager']
        >;
      }
    ).getMcpClientManager?.();
    if (!manager) {
      this.debugLogger.debug(
        'Skipping background MCP discovery: ToolRegistry has no MCP client manager',
      );
      return;
    }
    this.mcpDiscoveryPromise = manager
      .discoverAllMcpToolsIncremental(this)
      .then(async () => {
        // After background discovery completes, push the newly-registered
        // MCP tools into the active GeminiChat so the next model request
        // sees both the updated declarations and added-tool reminder deltas.
        // Interactive mode also calls setTools() via AppContainer's
        // batch-flush effect — this trailing call is idempotent there, but
        // it's the ONLY path that updates `chat.tools` for non-interactive
        // runs (no AppContainer).
        // Without this, `chat.tools` would be frozen at the built-in-only
        // snapshot taken inside `geminiClient.initialize()` → `startChat()`,
        // and `runNonInteractive` / stream-json / ACP would silently lose
        // progressive MCP tools — a regression vs the legacy synchronous path.
        try {
          await this.geminiClient?.setTools();
        } catch (err) {
          this.debugLogger.error(
            `setTools() after background MCP discovery failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })
      .catch((err: unknown) => {
        this.debugLogger.error(
          `Background MCP discovery failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /**
   * Resolves when background MCP discovery has settled (all servers ready,
   * failed, or timed out). Non-interactive code paths (`runNonInteractive`,
   * stream-json, ACP) MUST await this before invoking the model so the
   * first model request sees the same tool surface the legacy
   * synchronous-MCP path produced.
   *
   * Interactive code paths should NOT call this — `AppContainer`'s
   * `mcp-client-update` subscriber handles `setTools()` refreshes
   * progressively without blocking the UI.
   *
   * Resolves immediately when:
   * - bare mode is on (no MCP discovery is started),
   * - `QWEN_CODE_LEGACY_MCP_BLOCKING=1` is set (MCP already discovered
   *   synchronously inside {@link initialize}), or
   * - no MCP servers are configured.
   */
  async waitForMcpReady(): Promise<void> {
    if (this.mcpDiscoveryPromise) {
      await this.mcpDiscoveryPromise;
    }
  }

  /**
   * Returns the names of configured (non-disabled) MCP servers whose
   * discovery did NOT end in a CONNECTED state. Intended to be called by
   * non-interactive entry points AFTER {@link waitForMcpReady} resolves,
   * so they can surface a single user-visible warning summarizing which
   * servers failed.
   *
   * The legacy synchronous MCP path surfaced these failures visibly
   * during `config.initialize()` (because they happened on the main
   * thread and per-server errors logged to stderr). Under PR-A's
   * progressive discovery, per-server errors are caught inside
   * `McpClientManager.discoverAllMcpToolsIncremental` and routed to
   * profiler events + `mcp-client-update` notifications — both of which
   * are invisible to a non-interactive run with only built-in stderr.
   * This helper closes that gap WITHOUT re-introducing the blocking
   * behavior.
   *
   * Returns an empty array when MCP discovery was skipped (bare mode /
   * legacy blocking / no servers configured) or when every configured
   * server settled successfully.
   */
  getFailedMcpServerNames(): string[] {
    const servers = this.getMcpServers();
    if (!servers) {
      return [];
    }
    const failed: string[] = [];
    for (const name of Object.keys(servers)) {
      if (this.isMcpServerDisabled(name)) {
        continue;
      }
      if (this.isMcpServerPendingApproval(name)) {
        continue;
      }
      if (getMCPServerStatus(name) !== MCPServerStatus.CONNECTED) {
        failed.push(name);
      }
    }
    return failed;
  }

  async refreshHierarchicalMemory(
    loadReason: Exclude<InstructionLoadReason, 'include'> = 'refresh',
  ): Promise<void> {
    const { memoryContent, fileCount, conditionalRules, projectRoot } =
      await loadServerHierarchicalMemory(
        this.getWorkingDir(),
        this.getMemoryDiscoveryDirectories(),
        this.getFileService(),
        this.getExtensionContextFilePaths(),
        this.isTrustedFolder(),
        this.getImportFormat(),
        this.contextRuleExcludes,
        {
          explicitOnly: this.getBareMode(),
          loadReason,
          onInstructionsLoaded: createInstructionsLoadedCallback(
            () => this.hookSystem,
          ),
        },
      );
    if (this.getManagedAutoMemoryEnabled()) {
      // User-level read is best-effort — an EACCES on
      // `~/.qwen/memories/MEMORY.md` must not strip the whole managed-memory
      // section out of the system prompt. Project-level read still bubbles
      // (its failure is a real config-load problem).
      const [managedAutoMemoryIndex, userAutoMemoryIndex] = await Promise.all([
        readAutoMemoryIndex(this.getProjectRoot()),
        readUserAutoMemoryIndex().catch(() => null),
      ]);
      // Always surface the user-level section so the main assistant knows the
      // dir exists and can route ad-hoc "remember this cross-project" saves
      // there. When empty the prompt builder emits a "MEMORY.md is currently
      // empty" placeholder — the same shape the per-project layer has used
      // since day one — so the cost is one extra index header.
      this.setUserMemory(
        this.memoryManager.appendToUserMemory(
          memoryContent,
          getAutoMemoryRoot(this.getProjectRoot()),
          managedAutoMemoryIndex,
          {
            memoryDir: getUserAutoMemoryRoot(),
            indexContent: userAutoMemoryIndex,
          },
        ),
      );
    } else {
      this.setUserMemory(memoryContent);
    }
    this.setGeminiMdFileCount(fileCount);
    this.conditionalRulesRegistry = new ConditionalRulesRegistry(
      conditionalRules,
      projectRoot,
    );
  }

  private getMemoryDiscoveryDirectories(): string[] {
    if (!this.shouldLoadMemoryFromIncludeDirectories()) {
      return [];
    }

    if (this.getBareMode()) {
      return this.explicitIncludeDirectories;
    }

    return [...this.getWorkspaceContext().getDirectories()];
  }

  getConditionalRulesRegistry(): ConditionalRulesRegistry | undefined {
    return this.conditionalRulesRegistry;
  }

  /**
   * Update the conditional rules registry. Called after external refresh
   * paths (e.g. /memory refresh or /directory add) that bypass
   * refreshHierarchicalMemory().
   */
  setConditionalRulesRegistry(
    registry: ConditionalRulesRegistry | undefined,
  ): void {
    this.conditionalRulesRegistry = registry;
  }

  getContextRuleExcludes(): string[] {
    return this.contextRuleExcludes;
  }

  getContentGenerator(): ContentGenerator {
    return (
      getRuntimeContentGenerator()?.contentGenerator ?? this.contentGenerator
    );
  }

  /**
   * Get the ModelsConfig instance for model-related operations.
   * External code (e.g., CLI) can use this to access model configuration.
   */
  getModelsConfig(): ModelsConfig {
    return this.modelsConfig;
  }

  /**
   * Updates the credentials in the generation config.
   * Exclusive for `OpenAIKeyPrompt` to update credentials via `/auth`
   * Delegates to ModelsConfig.
   */
  updateCredentials(
    credentials: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
    },
    settingsGenerationConfig?: Partial<ContentGeneratorConfig>,
  ): void {
    this.modelsConfig.updateCredentials(credentials, settingsGenerationConfig);
  }

  /**
   * Reload model providers configuration at runtime.
   * This enables hot-reloading of modelProviders settings without restarting the CLI.
   * Should be called before refreshAuth when settings.json has been updated.
   *
   * @param modelProvidersConfig - The updated model providers configuration
   */
  reloadModelProvidersConfig(
    modelProvidersConfig?: ModelProvidersConfig,
  ): void {
    this.modelsConfig.reloadModelProvidersConfig(modelProvidersConfig);
  }

  /**
   * Refresh authentication and rebuild ContentGenerator.
   */
  async refreshAuth(authMethod: AuthType, isInitialAuth?: boolean) {
    // Sync modelsConfig state for this auth refresh
    const modelId = this.modelsConfig.getModel();
    this.modelsConfig.syncAfterAuthRefresh(authMethod, modelId);

    // Check and consume cached credentials flag
    const requireCached =
      this.modelsConfig.consumeRequireCachedCredentialsFlag();

    const { config, sources } = resolveContentGeneratorConfigWithSources(
      this,
      authMethod,
      this.modelsConfig.getGenerationConfig(),
      this.modelsConfig.getGenerationConfigSources(),
      {
        strictModelProvider: this.modelsConfig.isStrictModelProviderSelection(),
      },
    );
    const newContentGeneratorConfig = config;
    this.contentGenerator = await createContentGenerator(
      newContentGeneratorConfig,
      this,
      requireCached ? true : isInitialAuth,
    );
    // Only assign to instance properties after successful initialization
    this.contentGeneratorConfig = newContentGeneratorConfig;
    this.contentGeneratorConfigSources = sources;

    // Initialize BaseLlmClient now that the ContentGenerator is available
    this.baseLlmClient = new BaseLlmClient(this.contentGenerator, this);

    // Fire auth_success notification hook (supports both interactive & non-interactive)
    const messageBus = this.getMessageBus();
    const hooksEnabled = !this.getDisableAllHooks();
    if (hooksEnabled && messageBus) {
      fireNotificationHook(
        messageBus,
        `Successfully authenticated with ${authMethod}`,
        NotificationType.AuthSuccess,
        'Authentication successful',
      ).catch(() => {
        // Silently ignore errors - fireNotificationHook has internal error handling
        // and notification hooks should not block the auth flow
      });
    }
  }

  /**
   * Provides access to the BaseLlmClient for stateless LLM operations.
   */
  getBaseLlmClient(): BaseLlmClient {
    if (!this.baseLlmClient) {
      // Handle cases where initialization might be deferred or authentication failed
      if (this.contentGenerator) {
        this.baseLlmClient = new BaseLlmClient(
          this.getContentGenerator(),
          this,
        );
      } else {
        throw new Error(
          'BaseLlmClient not initialized. Ensure authentication has occurred and ContentGenerator is ready.',
        );
      }
    }
    return this.baseLlmClient;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Returns warnings generated during configuration resolution.
   * These warnings are collected from model configuration resolution
   * and should be displayed to the user during startup.
   */
  getWarnings(): string[] {
    return this.warnings;
  }

  getDebugLogger(): DebugLogger {
    return this.debugLogger;
  }

  /**
   * Starts a new session and resets session-scoped services.
   */
  startNewSession(
    sessionId?: string,
    sessionData?: ResumedSessionData,
  ): string {
    // Finalize the outgoing session before switching.
    const outgoingChatRecordingService = this.chatRecordingService;
    try {
      outgoingChatRecordingService?.finalize();
    } catch {
      // Best-effort — don't block session switch
    }
    void outgoingChatRecordingService?.flush().catch(() => {
      // Best-effort — don't block session switch
    });

    const previousSessionId = this.sessionId;
    this.sessionId = sessionId ?? randomUUID();
    // Unconditional: startNewSession is only called on the canonical Config
    // instance (the one that already claimed via sessionEnvClaimed), so this
    // correctly updates the env var to reflect the new active session.
    if (process.env) {
      process.env['QWEN_CODE_SESSION_ID'] = this.sessionId;
    }
    this.sessionData = sessionData;
    setDebugLogSession(this);
    this.debugLogger = createDebugLogger();
    this.chatRecordingService = this.chatRecordingEnabled
      ? new ChatRecordingService(this)
      : undefined;
    // The file-read cache is session-scoped: its `file_unchanged`
    // placeholder relies on the model having seen the prior full read
    // earlier in the *current* conversation. Carrying entries across
    // /clear or session resume would let a follow-up Read return the
    // placeholder despite the new session never having received the
    // file contents. Use the getter so the lazy own-property
    // initialization in getFileReadCache() applies even for Configs
    // constructed via Object.create — those should clear their own
    // cache, not the parent's.
    this.getFileReadCache().clear();
    this.toolResultBudget.bytesWritten = 0;
    this.getMemoryPressureMonitor()?.resetForNewSession();
    this.fileHistoryService = undefined;
    refreshSessionContext(this.sessionId);
    // The commit-attribution singleton accumulates per-file AI edits
    // and a session-scoped prompt counter — both stop being meaningful
    // when the session resets. Without this, pending attributions
    // from the previous session could attach to a commit in the new
    // one, and the "N-shotted" PR label would span sessions.
    CommitAttributionService.resetInstance();
    if (this.initialized) {
      logStartSession(this, new StartSessionEvent(this));
    }

    // Refresh the runtime.json sidecar so external observers (terminal
    // multiplexers, IDE integrations, status daemons) see the new
    // session id rather than a stale claim against a still-live PID.
    // /clear, /reset, /new, and /resume all flow through this method,
    // so handling the swap centrally covers every same-PID session
    // transition. Best-effort: must never block /clear or /resume.
    //
    // Only refresh when THIS process established its own sidecar at
    // startup (interactive UI). A non-interactive `/clear` (e.g.
    // qwen --prompt-interactive) must not delete a sibling shell's
    // sidecar that happens to share the outgoing session id
    // mirrors the kimi-cli "write only when a session is
    // established for this process" rule.
    if (this.runtimeStatusEnabled && previousSessionId !== this.sessionId) {
      const oldPath = this.storage.getRuntimeStatusPath(previousSessionId);
      const newPath = this.storage.getRuntimeStatusPath(this.sessionId);
      const cliVersion = this.cliVersion ?? null;
      const workDir = this.targetDir;
      const newSessionId = this.sessionId;
      this.queueRuntimeStatusWrite(async () => {
        await clearRuntimeStatus(oldPath);
        await writeRuntimeStatus(newPath, {
          sessionId: newSessionId,
          workDir,
          qwenVersion: cliVersion,
        });
      });
    }

    return this.sessionId;
  }

  /**
   * Marks this Config as the owner of a runtime.json sidecar for the
   * current PID. Call once after the initial sidecar write succeeds
   * (typically from the interactive UI bootstrap). When set, subsequent
   * startNewSession() calls will refresh the sidecar on session swap;
   * when unset, startNewSession() leaves sibling sidecars alone so a
   * short-lived non-interactive process can't trample a concurrent
   * shell's sidecar that happens to share the outgoing session id.
   */
  markRuntimeStatusEnabled(): void {
    this.runtimeStatusEnabled = true;
  }

  private queueRuntimeStatusWrite(write: () => Promise<void>): void {
    this.runtimeStatusWrite = this.runtimeStatusWrite
      .catch(() => {
        // Keep later writes alive after a best-effort sidecar failure.
      })
      .then(write)
      .catch(() => {
        // ignored: runtime status must not disrupt session control flow.
      });
  }

  private async flushRuntimeStatusWrites(): Promise<void> {
    await this.runtimeStatusWrite.catch(() => {
      // ignored: runtime status is best-effort.
    });
  }

  private async refreshCurrentRuntimeStatus(workDir: string): Promise<void> {
    if (!this.runtimeStatusEnabled) {
      return;
    }
    this.queueRuntimeStatusWrite(async () => {
      await writeRuntimeStatus(
        this.storage.getRuntimeStatusPath(this.sessionId),
        {
          sessionId: this.sessionId,
          workDir,
          qwenVersion: this.cliVersion ?? null,
        },
      );
    });
    await this.flushRuntimeStatusWrites();
  }

  /**
   * Returns the resumed session data if this session was resumed from a previous one.
   */
  getResumedSessionData(): ResumedSessionData | undefined {
    return this.sessionData;
  }

  shouldLoadMemoryFromIncludeDirectories(): boolean {
    return this.loadMemoryFromIncludeDirectories;
  }

  getImportFormat(): 'tree' | 'flat' {
    return this.importFormat;
  }

  getContentGeneratorConfig(): ContentGeneratorConfig {
    return (
      getRuntimeContentGenerator()?.contentGeneratorConfig ??
      this.contentGeneratorConfig
    );
  }

  getContentGeneratorConfigSources(): ContentGeneratorConfigSources {
    // If contentGeneratorConfigSources is empty (before initializeAuth),
    // get sources from ModelsConfig
    if (
      Object.keys(this.contentGeneratorConfigSources).length === 0 &&
      this.modelsConfig
    ) {
      return this.modelsConfig.getGenerationConfigSources();
    }
    return this.contentGeneratorConfigSources;
  }

  getModel(): string {
    return (
      this.getContentGeneratorConfig()?.model || this.modelsConfig.getModel()
    );
  }

  /**
   * Get the human-readable display name for the currently selected model.
   * Resolves the model id to its name from the model registry.
   * Falls back to the raw model id when the model is not found.
   */
  getModelDisplayName(): string {
    return this.modelsConfig.getModelDisplayName(this.getModel());
  }

  onModelChange(listener: (model: string) => void): () => void {
    this.modelChangeListeners.add(listener);
    return () => {
      this.modelChangeListeners.delete(listener);
    };
  }

  private notifyModelChangeListeners(): void {
    const model = this.getModel();
    for (const listener of this.modelChangeListeners) {
      listener(model);
    }
  }

  /**
   * Returns the configured fast model selector when it resolves to an available
   * model. Bare selectors stay bare and authType-qualified selectors keep their
   * authType prefix so selector-aware runtime paths can route cross-auth calls.
   */
  getFastModel(): string | undefined {
    const selector = this.resolveFastModelSelector();
    if (!selector) return undefined;

    const available = selector.authType
      ? this.getAllConfiguredModels([selector.authType])
      : this.getAllConfiguredModels();
    if (!available.some((m) => m.id === selector.modelId)) {
      return undefined;
    }

    const rawSelector = resolveModelId(this.fastModel);
    return rawSelector?.authType
      ? `${rawSelector.authType}:${selector.modelId}`
      : selector.modelId;
  }

  private resolveFastModelSelector() {
    if (!this.fastModel) return undefined;
    try {
      return resolveModelId(this.fastModel, {
        currentAuthType: this.getContentGeneratorConfig()?.authType,
        getAvailableModels: (authTypes) =>
          this.getAllConfiguredModels(authTypes),
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Update the fast model at runtime (e.g., when the user runs `/model --fast <model>`).
   * Pass undefined or an empty string to clear the fast model override.
   */
  setFastModel(model: string | undefined): void {
    this.fastModel = model || undefined;
  }

  /**
   * Set model programmatically (e.g., VLM auto-switch, fallback).
   * Delegates to ModelsConfig.
   */
  async setModel(
    newModel: string,
    metadata?: { reason?: string; context?: string },
  ): Promise<void> {
    await this.modelsConfig.setModel(newModel, metadata);
    // Also update contentGeneratorConfig for hot-update compatibility
    if (this.contentGeneratorConfig) {
      this.contentGeneratorConfig.model = newModel;
    }
    this.notifyModelChangeListeners();
  }

  /**
   * Handle model change from ModelsConfig.
   * This updates the content generator config with the new model settings.
   */
  private async handleModelChange(
    authType: AuthType,
    requiresRefresh: boolean,
  ): Promise<void> {
    if (!this.contentGeneratorConfig) {
      return;
    }

    // Keep full history (including thought parts) on model switch.
    // Some OpenAI-compatible reasoning models (e.g. DeepSeek) require
    // reasoning_content to be preserved across turns.

    // Hot update path: only supported for qwen-oauth.
    // For other auth types we always refresh to recreate the ContentGenerator.
    //
    // Rationale:
    // - Non-qwen providers may need to re-validate credentials / baseUrl / envKey.
    // - ModelsConfig.applyResolvedModelDefaults can clear or change credentials sources.
    // - Refresh keeps runtime behavior consistent and centralized.
    if (authType === AuthType.QWEN_OAUTH && !requiresRefresh) {
      const { config, sources } = resolveContentGeneratorConfigWithSources(
        this,
        authType,
        this.modelsConfig.getGenerationConfig(),
        this.modelsConfig.getGenerationConfigSources(),
        {
          strictModelProvider:
            this.modelsConfig.isStrictModelProviderSelection(),
        },
      );

      // Hot-update fields (qwen-oauth models share the same auth + client).
      this.contentGeneratorConfig.model = config.model;
      this.contentGeneratorConfig.samplingParams = config.samplingParams;
      this.contentGeneratorConfig.contextWindowSize = config.contextWindowSize;
      this.contentGeneratorConfig.enableCacheControl =
        config.enableCacheControl;
      this.contentGeneratorConfig.splitToolMedia = config.splitToolMedia;

      if ('model' in sources) {
        this.contentGeneratorConfigSources['model'] = sources['model'];
      }
      if ('samplingParams' in sources) {
        this.contentGeneratorConfigSources['samplingParams'] =
          sources['samplingParams'];
      }
      if ('enableCacheControl' in sources) {
        this.contentGeneratorConfigSources['enableCacheControl'] =
          sources['enableCacheControl'];
      }
      if ('contextWindowSize' in sources) {
        this.contentGeneratorConfigSources['contextWindowSize'] =
          sources['contextWindowSize'];
      }
      if ('splitToolMedia' in sources) {
        this.contentGeneratorConfigSources['splitToolMedia'] =
          sources['splitToolMedia'];
      }
      return;
    }

    // Full refresh path
    await this.refreshAuth(authType);
  }

  /**
   * Get available models for the current authType.
   * Delegates to ModelsConfig.
   */
  getAvailableModels(): AvailableModel[] {
    return this.modelsConfig.getAvailableModels();
  }

  /**
   * Get available models for a specific authType.
   * Delegates to ModelsConfig.
   */
  getAvailableModelsForAuthType(authType: AuthType): AvailableModel[] {
    return this.modelsConfig.getAvailableModelsForAuthType(authType);
  }

  /**
   * Get all configured models across authTypes.
   * Delegates to ModelsConfig.
   */
  getAllConfiguredModels(authTypes?: AuthType[]): AvailableModel[] {
    return this.modelsConfig.getAllConfiguredModels(authTypes);
  }

  /**
   * Get the currently active runtime model snapshot.
   * Delegates to ModelsConfig.
   */
  getActiveRuntimeModelSnapshot(): RuntimeModelSnapshot | undefined {
    return this.modelsConfig.getActiveRuntimeModelSnapshot();
  }

  /**
   * Switch authType+model.
   * Supports both registry-backed models and runtime model snapshots.
   *
   * For runtime models, the modelId should be in format `$runtime|${authType}|${modelId}`.
   * This triggers a refresh of the ContentGenerator when required (always on authType changes).
   * For qwen-oauth model switches that are hot-update safe, this may update in place.
   *
   * @param authType - Target authentication type
   * @param modelId - Target model ID (or `$runtime|${authType}|${modelId}` for runtime models)
   * @param options - Additional options like requireCachedCredentials
   */
  async switchModel(
    authType: AuthType,
    modelId: string,
    options?: { requireCachedCredentials?: boolean; baseUrl?: string },
  ): Promise<void> {
    await this.modelsConfig.switchModel(authType, modelId, options);
    this.notifyModelChangeListeners();
  }

  getMaxSessionTurns(): number {
    return this.maxSessionTurns;
  }

  getMaxWallTimeSeconds(): number {
    return this.maxWallTimeSeconds;
  }

  getMaxToolCalls(): number {
    return this.maxToolCalls;
  }

  getClearContextOnIdle(): ClearContextOnIdleSettings {
    return this.clearContextOnIdle;
  }

  getSessionTokenLimit(): number {
    return this.sessionTokenLimit;
  }

  getEmbeddingModel(): string {
    return this.embeddingModel;
  }

  getSandbox(): SandboxConfig | undefined {
    return this.sandbox;
  }

  isRestrictiveSandbox(): boolean {
    const sandboxConfig = this.getSandbox();
    const seatbeltProfile = process.env['SEATBELT_PROFILE'];
    return (
      !!sandboxConfig &&
      sandboxConfig.command === 'sandbox-exec' &&
      !!seatbeltProfile &&
      seatbeltProfile.startsWith('restrictive-')
    );
  }

  getTargetDir(): string {
    return this.targetDir;
  }

  private getCurrentSessionArtifactMoves(
    oldStorage: Storage,
    newStorage: Storage,
  ): Array<{ from: string; to: string }> {
    const oldChatsDir = path.join(oldStorage.getProjectDir(), 'chats');
    const newChatsDir = path.join(newStorage.getProjectDir(), 'chats');
    return [
      `${this.sessionId}.jsonl`,
      `${this.sessionId}.runtime.json`,
      `${this.sessionId}.worktree.json`,
    ].map((fileName) => ({
      from: path.join(oldChatsDir, fileName),
      to: path.join(newChatsDir, fileName),
    }));
  }

  private moveFile(from: string, to: string): void {
    try {
      fs.renameSync(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
        throw error;
      }
      let copied = false;
      try {
        fs.copyFileSync(from, to);
        copied = true;
        fs.unlinkSync(from);
      } catch (fallbackError) {
        if (copied) {
          try {
            fs.unlinkSync(to);
          } catch {
            // Best-effort cleanup; surface the original fallback failure.
          }
        }
        throw fallbackError;
      }
    }
  }

  private moveCurrentSessionArtifacts(
    oldStorage: Storage,
    newStorage: Storage,
  ): void {
    const moved: Array<{ from: string; to: string }> = [];
    for (const { from, to } of this.getCurrentSessionArtifactMoves(
      oldStorage,
      newStorage,
    )) {
      if (!fs.existsSync(from)) {
        continue;
      }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      try {
        this.moveFile(from, to);
        moved.push({ from, to });
      } catch (error) {
        for (const movedArtifact of moved.reverse()) {
          try {
            fs.mkdirSync(path.dirname(movedArtifact.from), {
              recursive: true,
            });
            this.moveFile(movedArtifact.to, movedArtifact.from);
          } catch (rollbackError) {
            this.debugLogger.warn(
              'Failed to roll back moved session artifact',
              rollbackError,
            );
          }
        }
        throw error;
      }
    }
  }

  private async prepareSessionArtifactMigration(
    oldStorage: Storage,
    newStorage: Storage,
    oldDir: string,
  ): Promise<void> {
    this.chatRecordingService?.finalize();
    await this.chatRecordingService?.flush();
    await this.flushRuntimeStatusWrites();
    try {
      this.moveCurrentSessionArtifacts(oldStorage, newStorage);
    } catch (error) {
      try {
        process.chdir(oldDir);
      } catch (rollbackError) {
        this.debugLogger.warn(
          'Failed to roll back working directory after session artifact migration failed',
          rollbackError,
        );
      }
      throw error;
    }
  }

  async relocateWorkingDirectory(
    newDir: string,
    expectedCanonicalDir?: string,
  ): Promise<{ memoryRefreshError?: unknown }> {
    const oldDir = fs.realpathSync(process.cwd());
    const targetPath = path.resolve(newDir);
    const expected = expectedCanonicalDir ?? fs.realpathSync(targetPath);
    if (!fs.statSync(targetPath).isDirectory()) {
      throw new Error(`Path is not a directory: ${targetPath}`);
    }
    const workspaceDirectories = WorkspaceContext.resolveRootDirectories(
      expected,
      this.explicitIncludeDirectories,
    );

    process.chdir(targetPath);
    const actualCwd = fs.realpathSync(process.cwd());
    if (actualCwd !== expected) {
      process.chdir(oldDir);
      throw new Error(
        `Changed directory to ${actualCwd}, expected ${expected}.`,
      );
    }

    const oldStorage = this.storage;
    const newStorage = new Storage(expected);
    await this.prepareSessionArtifactMigration(oldStorage, newStorage, oldDir);

    this.targetDir = expected;
    this.cwd = expected;
    this.storage = newStorage;
    this.chatRecordingService?.resetStoragePaths();
    await this.refreshCurrentRuntimeStatus(expected);
    this.workspaceContext.applyRootDirectories(workspaceDirectories);
    this.fileDiscoveryService = null;
    this.sessionService = undefined;
    this.fileHistoryService = undefined;
    this.getFileReadCache().clear();

    try {
      await this.refreshHierarchicalMemory();
      return {};
    } catch (error) {
      return { memoryRefreshError: error };
    }
  }

  /**
   * Stashes a one-shot context message that the next user prompt will
   * inject into the model (see {@link pendingStartupWorktreeNotice}). Called
   * from `gemini.tsx` right after `loadCliConfig` when `--worktree` produced
   * a valid worktree. Pass `null` to clear (rarely needed).
   */
  setPendingStartupWorktreeNotice(notice: string | null): void {
    this.pendingStartupWorktreeNotice = notice;
  }

  /**
   * Reads and clears the pending startup-worktree notice. Returns `null`
   * when nothing is stashed (the common case). Each entry point (TUI /
   * headless / ACP) calls this on the model's first prompt; a non-null
   * return means the entry point should NOT additionally call
   * `restoreWorktreeContext()` for that prompt — startup overrides resume.
   */
  consumePendingStartupWorktreeNotice(): string | null {
    const v = this.pendingStartupWorktreeNotice;
    this.pendingStartupWorktreeNotice = null;
    return v;
  }

  getProjectRoot(): string {
    return this.targetDir;
  }

  getCwd(): string {
    return this.targetDir;
  }

  getWorkspaceContext(): WorkspaceContext {
    return this.workspaceContext;
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  /**
   * Shuts down the Config and releases all resources.
   * This method is idempotent and safe to call multiple times.
   * It handles the case where initialization was not completed.
   */
  async shutdown(): Promise<void> {
    try {
      if (!this.initialized) {
        // Nothing else to clean up if not initialized.
        return;
      }

      // Finalize the current session's metadata before cleanup, then drain
      // the async write queue so no records are lost on exit.
      try {
        this.chatRecordingService?.finalize();
        await this.chatRecordingService?.flush();
      } catch {
        // Best-effort — don't block shutdown
      }

      this.skillManager?.stopWatching();

      if (this.toolRegistry) {
        await this.toolRegistry.stop();
      }

      this.backgroundTaskRegistry.abortAll();
      this.monitorRegistry.abortAll({ notify: false });
      this.backgroundShellRegistry.abortAll();

      await this.cleanupArenaRuntime();
      await this.cleanupTeamRuntime();
    } catch (error) {
      // Log but don't throw - cleanup should be best-effort
      this.debugLogger.error('Error during Config shutdown:', error);
    } finally {
      if (isTelemetrySdkInitialized()) {
        await shutdownTelemetry();
      }
    }
  }

  getPromptRegistry(): PromptRegistry {
    return this.promptRegistry;
  }

  getDebugMode(): boolean {
    return this.debugMode;
  }

  getQuestion(): string | undefined {
    return this.question;
  }

  getSystemPrompt(): string | undefined {
    return this.systemPrompt;
  }

  getAppendSystemPrompt(): string | undefined {
    return this.appendSystemPrompt;
  }

  /** @deprecated Use getPermissionsAllow() instead. */
  getCoreTools(): string[] | undefined {
    if (this.getBareMode()) {
      return DEFAULT_BARE_CORE_TOOLS;
    }
    return this.coreTools;
  }

  /**
   * Returns the merged allow-rules for PermissionManager.
   *
   * This merges all sources so that PermissionManager receives a single,
   * authoritative list:
   *   - settings.permissions.allow (persistent rules from all scopes)
   *   - allowedTools param (SDK / argv auto-approve list)
   *
   * Note: coreTools is intentionally excluded here — it has whitelist semantics
   * (only listed tools are registered), not auto-approve semantics. It is
   * handled separately via PermissionManager.coreToolsAllowList.
   *
   * CLI callers (loadCliConfig) already pre-merge argv into permissionsAllow
   * before constructing Config, so those fields will be empty for CLI usage.
   * SDK callers construct Config directly and rely on allowedTools.
   */
  getPermissionsAllow(): string[] {
    const base = this.permissionsAllow ?? [];
    const sdkAllow = [...(this.allowedTools ?? [])];
    if (sdkAllow.length === 0) return base.length > 0 ? base : [];
    const merged = [...base];
    for (const t of sdkAllow) {
      if (t && !merged.includes(t)) merged.push(t);
    }
    return merged;
  }

  getPermissionsAsk(): string[] {
    return this.permissionsAsk;
  }

  /**
   * Returns the merged deny-rules for PermissionManager.
   *
   * Merges:
   *   - settings.permissions.deny (persistent rules from all scopes)
   *   - excludeTools param (SDK / argv blocklist)
   *
   * CLI callers pre-merge argv.excludeTools into permissionsDeny.
   */
  getPermissionsDeny(): string[] {
    const base = this.permissionsDeny ?? [];
    const sdkDeny = this.excludeTools ?? [];
    if (sdkDeny.length === 0) return base.length > 0 ? base : [];
    const merged = [...base];
    for (const t of sdkDeny) {
      if (t && !merged.includes(t)) merged.push(t);
    }
    return merged;
  }

  getToolDiscoveryCommand(): string | undefined {
    return this.toolDiscoveryCommand;
  }

  /**
   * Returns the pre-merged list of slash command names that should be hidden
   * from the CLI surface. Callers should treat this as a case-insensitive
   * denylist; `CommandService.create` handles the normalization.
   */
  getDisabledSlashCommands(): readonly string[] {
    return this.disabledSlashCommands;
  }

  /**
   * Returns the live set of skill names that are currently disabled.
   * Unlike `getDisabledSlashCommands()` (frozen snapshot), this delegates
   * to the provider supplied at construction so the CLI's `LoadedSettings`
   * mutations are visible without restarting the process.
   *
   * Names are lower-cased. Empty set when no provider was supplied.
   */
  getDisabledSkillNames(): ReadonlySet<string> {
    return this.disabledSkillNamesProvider?.() ?? EMPTY_DISABLED_SKILL_NAMES;
  }

  /**
   * Returns the read-only set of tool names hidden from this Config's
   * ToolRegistry. Consulted by `ToolRegistry.registerTool` and
   * `ToolRegistry.registerFactory` to skip registration.
   *
   * Mutability semantics: the snapshot is
   * mutable via `setDisabledTools()` so the daemon's
   * `setWorkspaceToolEnabled` route can re-sync the set after a
   * `tools.disabled` settings write — without that sync, the
   * documented "toggle + restart" workflow would re-register the
   * just-disabled MCP tool against the bootstrap snapshot.
   *
   * Already-registered tools are NOT retroactively unregistered:
   * `ToolRegistry` consults the set at registration time only, so a
   * mid-session disable only takes effect on the next `registerTool`
   * call (next ACP child spawn, MCP rediscover, etc.). This matches
   * the documented "toggling does not unregister live tools"
   * contract.
   *
   * See `disabledTools` in ConfigParameters and `setDisabledTools`
   * for the runtime sync entry point.
   */
  getDisabledTools(): ReadonlySet<string> {
    return this.disabledTools;
  }

  /**
   * Replace the in-process `disabledTools`
   * snapshot with a fresh set sourced from the workspace settings.
   * Intended for the `qwen serve` mutation surface
   * (`setWorkspaceToolEnabled` → ACP `qwen/control/...` → here): the
   * settings file is the source of truth, and this setter keeps the
   * in-memory Config in sync so a subsequent MCP rediscovery / next
   * tool registration honors the just-toggled value.
   *
   * Already-registered tools are NOT retroactively unregistered
   * `ToolRegistry` consults the set at registration time only, which
   * matches the documented "toggling does not unregister live tools"
   * contract.
   */
  setDisabledTools(disabled: ReadonlySet<string>): void {
    this.disabledTools = new Set(disabled);
  }

  getToolCallCommand(): string | undefined {
    return this.toolCallCommand;
  }

  getMcpServerCommand(): string | undefined {
    return this.mcpServerCommand;
  }

  /**
   * optional workspace-shared MCP transport pool
   * injected by the daemon-mode `QwenAgent`. When set, the wrapping
   * `ToolRegistry` threads it into `McpClientManager`, which delegates
   * non-SDK MCP server discovery to the pool instead of spawning its
   * own per-session `McpClient`. Standalone `qwen` (non-daemon) leaves
   * this `undefined` and the manager keeps its previous behavior.
   *
   * Eagerly instantiated by `QwenAgent` (per Q6 resolved); the
   * pool itself is lazy w.r.t. actual MCP work — it spawns nothing
   * until the first `acquire()` from a session.
   */
  private mcpTransportPool?: import('../tools/mcp-transport-pool.js').McpTransportPool;

  setMcpTransportPool(
    pool: import('../tools/mcp-transport-pool.js').McpTransportPool | undefined,
  ): void {
    this.mcpTransportPool = pool;
  }

  getMcpTransportPool():
    | import('../tools/mcp-transport-pool.js').McpTransportPool
    | undefined {
    return this.mcpTransportPool;
  }

  /**
   * T2.8: return the raw settings-layer MCP servers map (without the
   * runtime overlay or extension contributions). Used by
   * `McpClientManager.addRuntimeMcpServer` to detect shadow-over-
   * settings (a runtime entry whose name collides with a pre-existing
   * settings entry).
   */
  getSettingsMcpServers(): Record<string, MCPServerConfig> | undefined {
    return this.mcpServers;
  }

  getMcpServers(): Record<string, MCPServerConfig> | undefined {
    let mcpServers = { ...(this.mcpServers || {}) };
    const extensions = this.getActiveExtensions();
    for (const extension of extensions) {
      Object.entries(extension.config.mcpServers || {}).forEach(
        ([key, server]) => {
          if (mcpServers[key]) return;
          mcpServers[key] = {
            ...server,
            extensionName: extension.config.name,
          };
        },
      );
    }

    // T2.8 — runtime layer wins over settings + extensions (shadow semantics)
    for (const [name, cfg] of this.runtimeMcpServers) {
      mcpServers[name] = cfg;
    }

    if (this.allowedMcpServers) {
      mcpServers = Object.fromEntries(
        Object.entries(mcpServers).filter(([key]) =>
          this.allowedMcpServers?.includes(key),
        ),
      );
    }

    // Note: We no longer filter out excluded servers here.
    // The UI layer should check isMcpServerDisabled() to determine
    // whether to show a server as disabled.

    return mcpServers;
  }

  getExcludedMcpServers(): string[] | undefined {
    return this.excludedMcpServers;
  }

  setExcludedMcpServers(excluded: string[]): void {
    this.excludedMcpServers = excluded;
  }

  isMcpServerDisabled(serverName: string): boolean {
    return this.excludedMcpServers?.includes(serverName) ?? false;
  }

  /**
   * True for a project-scoped (`.mcp.json`) server that the user has not
   * approved (pending or rejected). The discovery layer skips these BEFORE any
   * stdio spawn / transport / health check, so inspecting an untrusted
   * `.mcp.json` has no side effects. See issue #4615.
   */
  isMcpServerPendingApproval(serverName: string): boolean {
    return this.pendingMcpServers?.includes(serverName) ?? false;
  }

  /**
   * Drop a project server from the pending-approval set after the user approves
   * it mid-session (via the startup dialog), so a subsequent
   * `discoverToolsForServer` connects it instead of skipping it. See issue
   * #4615. No-op for servers that were never pending.
   */
  approveMcpServerForSession(serverName: string): void {
    if (!this.pendingMcpServers) {
      return;
    }
    this.pendingMcpServers = this.pendingMcpServers.filter(
      (name) => name !== serverName,
    );
  }

  addMcpServers(servers: Record<string, MCPServerConfig>): void {
    if (this.initialized) {
      throw new Error('Cannot modify mcpServers after initialization');
    }
    this.mcpServers = { ...this.mcpServers, ...servers };
  }

  /**
   * Add a runtime-only MCP server. Unlike `addMcpServers`, this does NOT
   * touch `this.mcpServers` (settings layer) and does not enforce the
   * `initialized` guard — the whole point is post-init mutation from the
   * daemon surface. `getMcpServers()` will overlay these entries on top
   * of the settings layer (Task 5).
   */
  addRuntimeMcpServer(name: string, config: MCPServerConfig): void {
    this.runtimeMcpServers.set(name, config);
  }

  /**
   * Remove a runtime-only MCP server previously added via
   * `addRuntimeMcpServer`. Returns `true` if the entry existed and was
   * removed, `false` otherwise.
   */
  removeRuntimeMcpServer(name: string): boolean {
    return this.runtimeMcpServers.delete(name);
  }

  isLspEnabled(): boolean {
    return this.lspEnabled && !this.getBareMode();
  }

  getLspClient(): LspClient | undefined {
    return this.lspClient;
  }

  getLspStatusSnapshot(): LspStatusSnapshot {
    if (!this.isLspEnabled()) {
      return this.createLspStatusSnapshot(false);
    }

    const clientSnapshot = this.lspClient?.getStatusSnapshot?.();
    if (clientSnapshot) {
      return {
        ...clientSnapshot,
        enabled: true,
        initializationError:
          this.lspInitializationError ?? clientSnapshot.initializationError,
      };
    }

    if (this.lspClient) {
      return {
        ...this.createLspStatusSnapshot(true),
        statusUnavailable: true,
      };
    }

    return this.createLspStatusSnapshot(
      true,
      this.lspInitializationError ?? 'LSP client is not initialized',
    );
  }

  private createLspStatusSnapshot(
    enabled: boolean,
    initializationError?: string,
  ): LspStatusSnapshot {
    return {
      enabled,
      configuredServers: 0,
      readyServers: 0,
      failedServers: 0,
      inProgressServers: 0,
      notStartedServers: 0,
      servers: [],
      ...(initializationError ? { initializationError } : {}),
    };
  }

  /**
   * Allows wiring an LSP client after Config construction but before initialize().
   */
  setLspClient(client: LspClient | undefined): void {
    if (this.initialized) {
      throw new Error('Cannot set LSP client after initialization');
    }
    this.lspClient = client;
  }

  setLspInitializationError(error: Error | string | undefined): void {
    if (this.initialized) {
      throw new Error('Cannot set LSP status after initialization');
    }
    this.lspInitializationError =
      error instanceof Error ? error.message : error;
  }

  getSessionSubagents(): SubagentConfig[] {
    return this.sessionSubagents;
  }

  setSessionSubagents(subagents: SubagentConfig[]): void {
    if (this.initialized) {
      throw new Error('Cannot modify sessionSubagents after initialization');
    }
    this.sessionSubagents = subagents;
  }

  getSdkMode(): boolean {
    return this.sdkMode;
  }

  setSdkMode(value: boolean): void {
    this.sdkMode = value;
  }

  getUserMemory(): string {
    return this.userMemory;
  }

  getOutputLanguageFilePath(): string | undefined {
    return this.outputLanguageFilePath;
  }

  setOutputLanguageFilePath(filePath: string): void {
    this.outputLanguageFilePath = filePath;
  }

  setUserMemory(newUserMemory: string): void {
    this.userMemory = newUserMemory;
  }

  getGeminiMdFileCount(): number {
    return this.geminiMdFileCount;
  }

  setGeminiMdFileCount(count: number): void {
    this.geminiMdFileCount = count;
  }

  getArenaManager(): ArenaManager | null {
    return this.arenaManager;
  }

  setArenaManager(manager: ArenaManager | null): void {
    this.arenaManager = manager;
    this.arenaManagerChangeCallback?.(manager);
  }

  /**
   * Register a callback invoked whenever the arena manager changes.
   * Pass `null` to unsubscribe. Only one subscriber is supported.
   */
  onArenaManagerChange(
    cb: ((manager: ArenaManager | null) => void) | null,
  ): void {
    this.arenaManagerChangeCallback = cb;
  }

  getArenaAgentClient(): ArenaAgentClient | null {
    return this.arenaAgentClient;
  }

  getAgentsSettings(): AgentsCollabSettings {
    return this.agentsSettings;
  }

  // ─── Team Manager ──────────────────────────────────────────

  getTeamManager(): TeamManager | null {
    return this.teamManager;
  }

  setTeamManager(manager: TeamManager | null): void {
    this.teamManager = manager;
    for (const cb of this.teamManagerChangeCallbacks) {
      cb(manager);
    }
  }

  /**
   * Register a callback invoked whenever the team manager changes.
   * Pass `null` to unsubscribe a previously registered callback.
   * Multiple subscribers are supported.
   */
  onTeamManagerChange(
    cb: ((manager: TeamManager | null) => void) | null,
    previous?: (manager: TeamManager | null) => void,
  ): void {
    if (previous) {
      this.teamManagerChangeCallbacks.delete(previous);
    }
    if (cb) {
      this.teamManagerChangeCallbacks.add(cb);
    }
  }

  getTeamContext(): TeamContext | null {
    return this.teamContext;
  }

  setTeamContext(ctx: TeamContext | null): void {
    this.teamContext = ctx;
  }

  /**
   * Clean up Team runtime — stops all teammates and clears state.
   */
  async cleanupTeamRuntime(): Promise<void> {
    const manager = this.teamManager;
    if (!manager) {
      return;
    }
    await manager.cleanup();
    this.setTeamManager(null);
    this.setTeamContext(null);
  }

  /**
   * Convenience accessor for `worktree.symlinkDirectories` — returns an
   * empty array when the setting is unset, so callers can pass the
   * result directly into the GitWorktreeService loop without nullchecks.
   *
   * (No general `getWorktreeSettings()` getter yet — add one when a
   * second field on `WorktreeSettings` justifies the broader API.)
   */
  getWorktreeSymlinkDirectories(): readonly string[] {
    return this.worktreeSettings.symlinkDirectories ?? [];
  }

  /**
   * Clean up Arena runtime. When `force` is true (e.g., /arena select --discard),
   * always removes worktrees regardless of preserveArtifacts.
   */
  async cleanupArenaRuntime(force?: boolean): Promise<void> {
    const manager = this.arenaManager;
    if (!manager) {
      return;
    }
    if (!force && this.agentsSettings.arena?.preserveArtifacts) {
      await manager.cleanupRuntime();
    } else {
      await manager.cleanup();
    }
    this.setArenaManager(null);
  }

  getApprovalMode(): ApprovalMode {
    return this.approvalMode;
  }

  /**
   * Returns the AUTO approval mode classifier settings (hints + environment).
   * Returns an empty object when no settings are configured.
   */
  getAutoModeSettings(): AutoModeSettings {
    return this.permissionsAutoMode;
  }

  /**
   * Returns the AUTO mode denialTracking state for the current session.
   * Used by the scheduler to decide whether to fall back from classifier
   * evaluation to manual approval. Session-scoped, never persisted.
   */
  getAutoModeDenialState(): AutoModeDenialState {
    return this.autoModeDenialState;
  }

  /**
   * Replace the AUTO mode denialTracking state. Caller produces the new
   * state via one of the pure transitions in `permissions/denialTracking.ts`
   * (recordAllow / recordBlock / recordUnavailable / recordFallback*).
   */
  setAutoModeDenialState(state: AutoModeDenialState): void {
    this.autoModeDenialState = state;
  }

  /**
   * Returns the approval mode that was active before entering plan mode.
   * Falls back to DEFAULT if no pre-plan mode was recorded.
   */
  getPrePlanMode(): ApprovalMode {
    return this.prePlanMode ?? ApprovalMode.DEFAULT;
  }

  /**
   * Returns the Plan Approval Gate state for the current Plan Mode Entry, or
   * undefined when not in plan mode. The returned object is mutable; callers
   * may update its fields directly (e.g. review count, gate mode).
   */
  getPlanGateState(): PlanGateState | undefined {
    return this.planGateState;
  }

  setApprovalMode(mode: ApprovalMode): void {
    if (
      !this.isTrustedFolder() &&
      mode !== ApprovalMode.DEFAULT &&
      mode !== ApprovalMode.PLAN
    ) {
      throw new TrustGateError(
        'Cannot enable privileged approval modes in an untrusted folder.',
      );
    }
    // Track the mode before entering plan mode so it can be restored later
    if (mode === ApprovalMode.PLAN && this.approvalMode !== ApprovalMode.PLAN) {
      this.prePlanMode = this.approvalMode;
      // Begin a fresh Plan Mode Entry for the Plan Approval Gate.
      this.planGateState = createPlanGateState(++this.planGateEntryCounter);
    } else if (
      mode !== ApprovalMode.PLAN &&
      this.approvalMode === ApprovalMode.PLAN
    ) {
      this.prePlanMode = undefined;
      // Successfully leaving PLAN clears all gate state (including any
      // user_takeover marker, which only lives for the duration of PLAN).
      this.planGateState = undefined;
    }
    // Strip over-broad allow rules (Bash interpreter wildcards, any Agent /
    // Skill allow) on AUTO entry; restore them on AUTO exit. Settings on
    // disk are NEVER touched — this is a runtime-only adjustment of the
    // active PermissionManager rule set. The PermissionManager is `null`
    // until initialize() is called, so skip the hook on early-startup
    // mode changes (the strip will happen via initialize for AUTO-default
    // sessions).
    const fromMode = this.approvalMode;
    if (this.permissionManager) {
      if (mode === ApprovalMode.AUTO && fromMode !== ApprovalMode.AUTO) {
        this.permissionManager.stripDangerousRulesForAutoMode();
      } else if (fromMode === ApprovalMode.AUTO && mode !== ApprovalMode.AUTO) {
        this.permissionManager.restoreDangerousRules();
      }
    }
    // Any deliberate mode change invalidates the AUTO denialTracking signal.
    if (fromMode !== mode) {
      this.autoModeDenialState = resetDenialState();
    }
    this.approvalMode = mode;
  }

  /**
   * Returns the directory where this session's plan file is stored.
   */
  getPlansDir(): string {
    return this.plansDir;
  }

  private assertPlansDirWithinTargetDir(): void {
    if (!this.plansDirectoryConfigured) {
      return;
    }

    Storage.assertPathWithinDirectory(
      this.plansDir,
      this.targetDir,
      `plansDirectory must resolve within the project root.`,
    );
  }

  private assertPlanFilePathWithinTargetDir(filePath: string): void {
    if (!this.plansDirectoryConfigured) {
      return;
    }

    Storage.assertPathWithinDirectory(
      filePath,
      this.targetDir,
      `plansDirectory must resolve within the project root.`,
    );
  }

  private addLegacyPlanLocationWarning(): void {
    try {
      if (!this.plansDirectoryConfigured) {
        return;
      }

      const legacyPlansDir = Storage.getPlansDir();
      const legacyPlanFiles = this.getPlanFileNames(legacyPlansDir);
      if (legacyPlanFiles.length === 0) {
        return;
      }

      const configuredPlanFiles = new Set(this.getPlanFileNames(this.plansDir));
      const hiddenLegacyPlanFiles = legacyPlanFiles.filter(
        (fileName) => !configuredPlanFiles.has(fileName),
      );
      if (hiddenLegacyPlanFiles.length === 0) {
        return;
      }

      this.warnings.push(
        `Warning: Saved plan files exist at ${legacyPlansDir}, but ` +
          `plansDirectory is configured to use ${this.plansDir}. Move ` +
          `existing plan files to ${this.plansDir} if you want to keep ` +
          `using them.`,
      );
    } catch (err: unknown) {
      const message = `Failed to check legacy plan directory migration warning: ${
        err instanceof Error ? err.message : String(err)
      }`;
      this.warnings.push(message);
      this.debugLogger.warn(message, err);
    }
  }

  private getPlanFileNames(plansDir: string): string[] {
    try {
      return fs.readdirSync(plansDir).filter((entry) => entry.endsWith('.md'));
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return [];
      }
      if (code === 'EACCES' || code === 'EPERM') {
        const message = `Failed to read plan directory ${plansDir}: ${
          err instanceof Error ? err.message : String(err)
        }`;
        this.warnings.push(message);
        this.debugLogger.warn(message, err);
        return [];
      }
      throw err;
    }
  }

  /**
   * Returns the file path for this session's plan file.
   */
  getPlanFilePath(): string {
    return path.join(
      this.plansDir,
      `${Storage.sanitizePlanSessionId(this.sessionId)}.md`,
    );
  }

  /**
   * Saves a plan to disk for the current session.
   */
  savePlan(plan: string): void {
    this.assertPlansDirWithinTargetDir();
    const filePath = this.getPlanFilePath();
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    // Write to a temp file first, then atomically rename to avoid
    // leaving a corrupted file if the process crashes mid-write.
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, plan, 'utf-8');
    try {
      fs.renameSync(tmpPath, filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') {
        throw err;
      }

      fs.copyFileSync(tmpPath, filePath);
      fs.unlinkSync(tmpPath);
    }
    try {
      this.assertPlanFilePathWithinTargetDir(filePath);
    } catch (err) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Ignore rollback errors; the containment check already failed.
      }
      throw err;
    }
  }

  /**
   * Loads the plan for the current session, or returns undefined if none exists.
   */
  loadPlan(): string | undefined {
    this.assertPlansDirWithinTargetDir();
    const filePath = this.getPlanFilePath();
    this.assertPlanFilePathWithinTargetDir(filePath);
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return undefined;
      }
      throw error;
    }
  }

  getInputFormat(): 'text' | 'stream-json' {
    return this.inputFormat;
  }

  getIncludePartialMessages(): boolean {
    return this.includePartialMessages;
  }

  getAccessibility(): AccessibilitySettings {
    return this.accessibility;
  }

  getTelemetryEnabled(): boolean {
    return this.telemetrySettings.enabled ?? false;
  }

  getTelemetryLogPromptsEnabled(): boolean {
    return this.telemetrySettings.logPrompts ?? true;
  }

  getTelemetryIncludeSensitiveSpanAttributes(): boolean {
    return this.telemetrySettings.includeSensitiveSpanAttributes ?? false;
  }

  getTelemetryOtlpEndpoint(): string | undefined {
    return this.telemetrySettings.otlpEndpoint ?? DEFAULT_OTLP_ENDPOINT;
  }

  getTelemetryOtlpProtocol(): 'grpc' | 'http' {
    return this.telemetrySettings.otlpProtocol ?? 'grpc';
  }

  getTelemetryOtlpTracesEndpoint(): string | undefined {
    return this.telemetrySettings.otlpTracesEndpoint;
  }

  getTelemetryOtlpLogsEndpoint(): string | undefined {
    return this.telemetrySettings.otlpLogsEndpoint;
  }

  getTelemetryOtlpMetricsEndpoint(): string | undefined {
    return this.telemetrySettings.otlpMetricsEndpoint;
  }

  getTelemetryTarget(): TelemetryTarget {
    return this.telemetrySettings.target ?? DEFAULT_TELEMETRY_TARGET;
  }

  getTelemetryResourceAttributes(): Record<string, string> {
    return this.telemetrySettings.resourceAttributes ?? {};
  }

  getTelemetryMetricsIncludeSessionId(): boolean {
    return this.telemetrySettings.metrics?.includeSessionId ?? false;
  }

  getTelemetryResourceAttributeWarnings(): readonly string[] {
    return this.telemetrySettings.resourceAttributeWarnings ?? [];
  }

  /**
   * Whether to inject W3C `traceparent` on outbound `fetch` requests
   * (LLM SDKs, MCP, WebFetch, etc.). Default false — see
   * `OutboundCorrelationSettings` for rationale.
   */
  getOutboundCorrelationPropagateTraceContext(): boolean {
    return this.outboundCorrelationSettings.propagateTraceContext ?? false;
  }

  getTelemetryOutfile(): string | undefined {
    return this.telemetrySettings.outfile;
  }

  getGitCoAuthor(): GitCoAuthorSettings {
    return this.gitCoAuthor;
  }

  getGeminiClient(): GeminiClient {
    return this.geminiClient;
  }

  /**
   * Session-scoped memory pressure monitor. Child Configs created with
   * `Object.create(parent)` inherit the parent's monitor through the prototype
   * chain until this getter installs an own monitor backed by the inherited
   * pressure config snapshot. This mirrors getFileReadCache()'s isolation
   * contract while keeping type-safe direct field assignment inside the class.
   */
  getMemoryPressureMonitor(): MemoryPressureMonitor | undefined {
    if (!Object.prototype.hasOwnProperty.call(this, 'memoryPressureMonitor')) {
      const inheritedMonitor = this.memoryPressureMonitor;
      if (inheritedMonitor) {
        const inheritedConfig = this.memoryPressureConfig;
        if (!inheritedConfig) {
          throw new Error(
            'Inherited memory pressure monitor is missing config',
          );
        }
        this.memoryPressureConfig = { ...inheritedConfig };
        this.memoryPressureMonitor = new MemoryPressureMonitor(
          this,
          this.memoryPressureConfig,
        );
      }
    }
    return this.memoryPressureMonitor;
  }

  getCronScheduler(): CronScheduler {
    if (!this.cronScheduler) {
      this.cronScheduler = new CronScheduler(this.getProjectRoot());
    }
    return this.cronScheduler;
  }

  isCronEnabled(): boolean {
    if (process.env['QWEN_CODE_DISABLE_CRON'] === '1') return false;
    return this.cronEnabled;
  }

  isAgentTeamEnabled(): boolean {
    // Agent team is experimental and opt-in: enabled via settings or env var
    if (process.env['QWEN_CODE_ENABLE_AGENT_TEAM'] === '1') return true;
    return this.agentTeamEnabled;
  }

  isWorkflowsEnabled(): boolean {
    // Workflows are experimental and opt-in: enabled via settings or env var
    // P1 also honors a kill switch: QWEN_CODE_DISABLE_WORKFLOWS=1 forces off
    if (process.env['QWEN_CODE_DISABLE_WORKFLOWS'] === '1') return false;
    if (process.env['QWEN_CODE_ENABLE_WORKFLOWS'] === '1') return true;
    return this.workflowsEnabled;
  }

  setWorkflowsEnabled(enabled: boolean): void {
    this.workflowsEnabled = enabled;
  }

  isComputerUseEnabled(): boolean {
    return this.computerUseEnabled;
  }

  /**
   * Whether the turn loop should fire a fast-model call after each tool batch
   * to emit a `tool_use_summary` message. Mirrors Claude Code's
   * `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES` gate, but defaults to on so the
   * compact-mode UI benefits without configuration.
   *
   * Env overrides (either direction): `QWEN_CODE_EMIT_TOOL_USE_SUMMARIES=0`
   * to force off, `=1` to force on.
   */
  getEmitToolUseSummaries(): boolean {
    const env = process.env['QWEN_CODE_EMIT_TOOL_USE_SUMMARIES'];
    if (env === '0' || env === 'false') return false;
    if (env === '1' || env === 'true') return true;
    return this.emitToolUseSummaries;
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
  getFileFilteringRespectQwenIgnore(): boolean {
    return this.fileFiltering.respectQwenIgnore;
  }

  getFileFilteringOptions(): FileFilteringOptions {
    return {
      respectGitIgnore: this.fileFiltering.respectGitIgnore,
      respectQwenIgnore: this.fileFiltering.respectQwenIgnore,
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
    return this.fileCheckpointingEnabled;
  }

  enableFileCheckpointing(): void {
    this.fileCheckpointingEnabled = true;
    this.fileHistoryService = undefined;
  }

  getFileHistoryService(): FileHistoryService {
    if (!this.fileHistoryService) {
      const service = new FileHistoryService(
        this.sessionId,
        this.fileCheckpointingEnabled,
        this.cwd,
        (snapshot) => {
          if (this.fileHistoryService !== service) return;
          this.getChatRecordingService()?.recordFileHistorySnapshot(snapshot);
        },
      );
      this.fileHistoryService = service;
      const snapshots = this.sessionData?.fileHistorySnapshots;
      if (snapshots?.length && service.isEnabled()) {
        service.restoreFromSnapshots(snapshots);
        void service.validateRestoredSnapshots().catch((e) => {
          this.debugLogger.error(
            `FileHistory: validateRestoredSnapshots failed: ${e}`,
          );
        });
      }
    }
    return this.fileHistoryService;
  }

  getProxy(): string | undefined {
    return normalizeProxyUrl(this.proxy);
  }

  getWorkingDir(): string {
    return this.cwd;
  }

  getBugCommand(): BugCommandSettings | undefined {
    return this.bugCommand;
  }

  getFileService(): FileDiscoveryService {
    if (!this.fileDiscoveryService) {
      this.fileDiscoveryService = new FileDiscoveryService(this.targetDir);
    }
    return this.fileDiscoveryService;
  }

  getUsageStatisticsEnabled(): boolean {
    return this.usageStatisticsEnabled;
  }

  getExtensionContextFilePaths(): string[] {
    const extensionContextFilePaths = this.getActiveExtensions().flatMap(
      (e) => e.contextFiles,
    );
    return [
      ...extensionContextFilePaths,
      ...(this.outputLanguageFilePath ? [this.outputLanguageFilePath] : []),
    ];
  }

  getExperimentalZedIntegration(): boolean {
    return this.experimentalZedIntegration;
  }

  getListExtensions(): boolean {
    return this.listExtensions;
  }

  getExtensionManager(): ExtensionManager {
    return this.extensionManager;
  }

  /**
   * Get the hook system instance if hooks are enabled.
   * Returns undefined if hooks are not enabled.
   */
  getHookSystem(): HookSystem | undefined {
    return this.hookSystem;
  }

  /**
   * Fast-path check: returns true only when hooks are enabled AND there are
   * registered hooks for the given event name. Callers can use this to skip
   * expensive MessageBus round-trips when no hooks are configured.
   */
  hasHooksForEvent(eventName: string, sessionId?: string): boolean {
    return (
      this.hookSystem?.hasHooksForEvent(
        eventName,
        sessionId ?? this.getSessionId(),
      ) ?? false
    );
  }

  /**
   * Check if all hooks are disabled.
   */
  getDisableAllHooks(): boolean {
    return this.disableAllHooks || this.getBareMode();
  }

  getStopHookBlockingCap(): number {
    return this.stopHookBlockingCap;
  }

  getManagedAutoMemoryEnabled(): boolean {
    return this.enableManagedAutoMemory && !this.getBareMode();
  }

  getManagedAutoDreamEnabled(): boolean {
    return this.enableManagedAutoDream && !this.getBareMode();
  }

  getAutoSkillEnabled(): boolean {
    return this.enableAutoSkill && !this.getBareMode();
  }

  getPreventSystemSleepEnabled(): boolean {
    return this.preventSystemSleep;
  }

  /**
   * Return the MemoryManager instance created for this Config.
   * Use this to share background-task state (registry, drainer) with memory
   * module runtimes (extract, dream) instead of relying on module-level
   * globals.
   */
  getMemoryManager(): MemoryManager {
    return this.memoryManager;
  }

  /**
   * Get the message bus instance.
   * Returns undefined if not set.
   */
  getMessageBus(): MessageBus | undefined {
    return this.messageBus;
  }

  /**
   * Set the message bus instance.
   * This is called by the CLI layer to inject the MessageBus.
   */
  setMessageBus(messageBus: MessageBus): void {
    this.messageBus = messageBus;
  }

  /**
   * Get project-level hooks configuration.
   * Returns hooks from workspace settings, only in trusted folders.
   * Used by HookRegistry to load project-specific hooks with proper source attribution.
   */
  getProjectHooks(): { [K in HookEventName]?: HookDefinition[] } | undefined {
    if (this.getBareMode()) {
      return undefined;
    }
    // Only return project hooks if workspace is trusted
    if (!this.isTrustedFolder()) {
      return undefined;
    }
    // Prefer new projectHooks field, fall back to hooks for backward compatibility
    const hooks = this.projectHooks ?? this.hooks;
    return hooks as { [K in HookEventName]?: HookDefinition[] } | undefined;
  }

  /**
   * Get user-level hooks configuration.
   * Returns hooks from user settings, always available regardless of folder trust.
   * Used by HookRegistry to load user-specific hooks with proper source attribution.
   */
  getUserHooks(): { [K in HookEventName]?: HookDefinition[] } | undefined {
    if (this.getBareMode()) {
      return undefined;
    }
    // Prefer new userHooks field, fall back to hooks for backward compatibility
    const hooks = this.userHooks ?? this.hooks;
    return hooks as { [K in HookEventName]?: HookDefinition[] } | undefined;
  }

  getExtensions(): Extension[] {
    const extensions = this.extensionManager.getLoadedExtensions();
    if (this.overrideExtensions) {
      const overrideExtensionNames = new Set(
        this.overrideExtensions.map((name) => name.toLowerCase()),
      );
      return extensions.filter((e) =>
        overrideExtensionNames.has(e.name.toLowerCase()),
      );
    } else {
      return extensions;
    }
  }

  private getExplicitExtensionNames(): string[] {
    return (this.overrideExtensions ?? []).filter(
      (name) => name.trim() !== '' && name.toLowerCase() !== 'none',
    );
  }

  getActiveExtensions(): Extension[] {
    return this.getExtensions().filter((e) => e.isActive);
  }

  getBlockedMcpServers(): Array<{ name: string; extensionName: string }> {
    const mcpServers = { ...(this.mcpServers || {}) };
    const extensions = this.getActiveExtensions();
    for (const extension of extensions) {
      Object.entries(extension.config.mcpServers || {}).forEach(
        ([key, server]) => {
          if (mcpServers[key]) return;
          mcpServers[key] = {
            ...server,
            extensionName: extension.config.name,
          };
        },
      );
    }
    const blockedMcpServers: Array<{ name: string; extensionName: string }> =
      [];

    if (this.allowedMcpServers) {
      Object.entries(mcpServers).forEach(([key, server]) => {
        const isAllowed = this.allowedMcpServers?.includes(key);
        if (!isAllowed) {
          blockedMcpServers.push({
            name: key,
            extensionName: server.extensionName || '',
          });
        }
      });
    }
    return blockedMcpServers;
  }

  getNoBrowser(): boolean {
    return this.noBrowser;
  }

  isBrowserLaunchSuppressed(): boolean {
    return this.getNoBrowser() || !shouldAttemptBrowserLaunch();
  }

  getIdeMode(): boolean {
    return this.ideMode;
  }

  getFolderTrustFeature(): boolean {
    return this.folderTrustFeature;
  }

  /**
   * Returns 'true' if the workspace is considered "trusted".
   * 'false' for untrusted.
   */
  getFolderTrust(): boolean {
    return this.folderTrust;
  }

  /**
   * Returns the whitelist of allowed HTTP hook URL patterns.
   * If empty, all URLs are allowed (subject to SSRF protection).
   */
  getAllowedHttpHookUrls(): string[] {
    return this.getBareMode() ? [] : this.allowedHttpHookUrls;
  }

  isTrustedFolder(): boolean {
    // isWorkspaceTrusted in cli/src/config/trustedFolder.js returns undefined
    // when the file based trust value is unavailable, since it is mainly used
    // in the initialization for trust dialogs, etc. Here we return true since
    // config.isTrustedFolder() is used for the main business logic of blocking
    // tool calls etc in the rest of the application.
    //
    // Default value is true since we load with trusted settings to avoid
    // restarts in the more common path. If the user chooses to mark the folder
    // as untrusted, the CLI will restart and we will have the trust value
    // reloaded.
    const context = ideContextStore.get();
    if (context?.workspaceState?.isTrusted !== undefined) {
      return context.workspaceState.isTrusted;
    }

    return this.trustedFolder ?? true;
  }

  setIdeMode(value: boolean): void {
    this.ideMode = value;
  }

  getAuthType(): AuthType | undefined {
    return this.getContentGeneratorConfig()?.authType;
  }

  getCliVersion(): string | undefined {
    return this.cliVersion;
  }

  getChannel(): string | undefined {
    return this.channel;
  }

  /**
   * Get the file descriptor for dual output JSON event stream.
   * When set, the TUI mode will also emit structured JSON events to this fd.
   */
  getJsonFd(): number | undefined {
    return this.jsonFd;
  }

  /**
   * Get the file path for dual output JSON event stream.
   * When set, the TUI mode will also emit structured JSON events to this file.
   */
  getJsonFile(): string | undefined {
    return this.jsonFile;
  }

  /**
   * Get the JSON Schema the model's final output must conform to.
   * When set, the non-interactive CLI registers a synthetic
   * `structured_output` tool and ends the session on a valid call.
   */
  getJsonSchema(): Record<string, unknown> | undefined {
    return this.jsonSchema;
  }

  /**
   * Get the file path for remote input commands (bidirectional sync).
   * When set, the TUI mode will watch this file for JSONL commands written
   * by an external process and submit them as user messages.
   */
  getInputFile(): string | undefined {
    return this.inputFile;
  }

  /**
   * Get the default file encoding for new files.
   * @returns FileEncodingType
   */
  getDefaultFileEncoding(): FileEncodingType | undefined {
    return this.defaultFileEncoding;
  }

  /**
   * Get the current FileSystemService
   */
  getFileSystemService(): FileSystemService {
    return this.fileSystemService;
  }

  /**
   * Set a custom FileSystemService
   */
  setFileSystemService(fileSystemService: FileSystemService): void {
    this.fileSystemService = fileSystemService;
  }

  getChatCompression(): ChatCompressionSettings | undefined {
    return this.chatCompression;
  }

  isInteractive(): boolean {
    return this.interactive;
  }

  getUseRipgrep(): boolean {
    return this.useRipgrep;
  }

  getUseBuiltinRipgrep(): boolean {
    return this.useBuiltinRipgrep;
  }

  getShouldUseNodePtyShell(): boolean {
    return this.shouldUseNodePtyShell;
  }

  getSkipNextSpeakerCheck(): boolean {
    return this.skipNextSpeakerCheck;
  }

  getShellExecutionConfig(): ShellExecutionConfig {
    return this.shellExecutionConfig;
  }

  setShellExecutionConfig(config: ShellExecutionConfig): void {
    this.shellExecutionConfig = {
      terminalWidth:
        config.terminalWidth ?? this.shellExecutionConfig.terminalWidth,
      terminalHeight:
        config.terminalHeight ?? this.shellExecutionConfig.terminalHeight,
      showColor: config.showColor ?? this.shellExecutionConfig.showColor,
      pager: config.pager ?? this.shellExecutionConfig.pager,
    };
  }
  getScreenReader(): boolean {
    return this.accessibility.screenReader ?? false;
  }

  getSkipLoopDetection(): boolean {
    return this.skipLoopDetection;
  }

  getSkipStartupContext(): boolean {
    return this.skipStartupContext;
  }

  getBareMode(): boolean {
    return this.bareMode;
  }

  getTruncateToolOutputThreshold(): number {
    if (this.truncateToolOutputThreshold <= 0) {
      return Number.POSITIVE_INFINITY;
    }

    return this.truncateToolOutputThreshold;
  }

  getTruncateToolOutputLines(): number {
    if (this.truncateToolOutputLines <= 0) {
      return Number.POSITIVE_INFINITY;
    }

    return this.truncateToolOutputLines;
  }

  getToolOutputBatchBudget(): number {
    if (this.toolOutputBatchBudget <= 0) {
      return Number.POSITIVE_INFINITY;
    }

    return this.toolOutputBatchBudget;
  }

  trackToolResultBytes(n: number): void {
    this.toolResultBudget.bytesWritten += n;
  }

  getToolResultBytesWritten(): number {
    return this.toolResultBudget.bytesWritten;
  }

  getOutputFormat(): OutputFormat {
    return this.outputFormat;
  }

  /**
   * Returns the chat recording service.
   */
  getChatRecordingService(): ChatRecordingService | undefined {
    if (!this.chatRecordingEnabled) {
      return undefined;
    }
    if (!this.chatRecordingService) {
      this.chatRecordingService = new ChatRecordingService(this);
    }
    return this.chatRecordingService;
  }

  /**
   * Returns the transcript file path for the current session.
   * This is the path to the JSONL file where the conversation is recorded.
   * Returns empty string if chat recording is disabled.
   */
  getTranscriptPath(): string {
    if (!this.chatRecordingEnabled) {
      return '';
    }
    const projectDir = this.storage.getProjectDir();
    const sessionId = this.getSessionId();
    const safeFilename = `${sessionId}.jsonl`;
    return path.join(projectDir, 'chats', safeFilename);
  }

  /**
   * Gets or creates a SessionService for managing chat sessions.
   */
  getSessionService(): SessionService {
    if (!this.sessionService) {
      this.sessionService = new SessionService(this.targetDir);
    }
    return this.sessionService;
  }

  getFileExclusions(): FileExclusions {
    return this.fileExclusions;
  }

  getSubagentManager(): SubagentManager {
    return this.subagentManager;
  }

  getBackgroundTaskRegistry(): BackgroundTaskRegistry {
    return this.backgroundTaskRegistry;
  }

  getMonitorRegistry(): MonitorRegistry {
    return this.monitorRegistry;
  }

  getBackgroundAgentResumeService(): BackgroundAgentResumeService {
    if (!this.backgroundAgentResumeService) {
      this.backgroundAgentResumeService = new BackgroundAgentResumeService(
        this,
      );
    }
    return this.backgroundAgentResumeService;
  }

  async loadPausedBackgroundAgents(
    sessionId: string = this.getSessionId(),
  ): Promise<ReadonlyArray<import('../agents/background-tasks.js').AgentTask>> {
    return this.getBackgroundAgentResumeService().loadPausedBackgroundAgents(
      sessionId,
    );
  }

  async resumeBackgroundAgent(
    agentId: string,
    initialMessage?: string,
  ): Promise<import('../agents/background-tasks.js').AgentTask | undefined> {
    return this.getBackgroundAgentResumeService().resumeBackgroundAgent(
      agentId,
      initialMessage,
    );
  }

  abandonBackgroundAgent(agentId: string): boolean {
    return this.getBackgroundAgentResumeService().abandonBackgroundAgent(
      agentId,
    );
  }

  getBackgroundShellRegistry(): BackgroundShellRegistry {
    return this.backgroundShellRegistry;
  }

  /**
   * Session-scoped cache that tracks Read / Edit / WriteFile operations
   * on files. The cache must be **per-Config-instance** so that each
   * subagent (which gets its own Config) does not inherit the parent's
   * recorded reads via the prototype chain.
   *
   * The wrinkle: every subagent / scoped-agent / fork path in this
   * codebase constructs its Config via `Object.create(parent)`. That
   * does **not** run instance field initializers, so the parent's
   * `fileReadCache` field is reachable on the child only by prototype
   * lookup — i.e. child and parent end up sharing the same cache. The
   * own-property check below detects "this instance was made by
   * Object.create" and lazily attaches a fresh cache, ensuring
   * isolation without requiring every Object.create site to remember
   * to override the field.
   */
  getFileReadCache(): FileReadCache {
    if (!Object.prototype.hasOwnProperty.call(this, 'fileReadCache')) {
      // The own-property write needs to bypass `private`'s structural
      // check — the field is conceptually still private to the class,
      // we just need TS to let us install an own copy on a child
      // instance produced by `Object.create(parent)`.
      (this as unknown as { fileReadCache: FileReadCache }).fileReadCache =
        new FileReadCache();
    }
    return this.fileReadCache;
  }

  /**
   * When true, ReadFile / Edit / WriteFile must bypass the session
   * FileReadCache entirely and behave as if it did not exist (no
   * `file_unchanged` placeholder, no future prior-read enforcement).
   * Intended as an escape hatch for sessions where the cache's "model
   * has already seen this content earlier in the conversation"
   * assumption is unreliable — e.g. after context compaction or
   * transcript transformation.
   */
  getFileReadCacheDisabled(): boolean {
    return this.fileReadCacheDisabled;
  }

  /**
   * Whether interactive permission prompts should be auto-denied.
   * True for background agents that have no UI to show prompts.
   * PermissionRequest hooks still run and can override the denial.
   */
  getShouldAvoidPermissionPrompts(): boolean {
    return false;
  }

  getSkillManager(): SkillManager | null {
    return this.skillManager;
  }

  /**
   * Registers a provider that returns model-invocable commands (e.g., bundled
   * skills, user/project file commands, MCP prompts). Called by the CLI's
   * CommandService after initialisation so that the startup snapshot and
   * per-turn drain can include these in the `<available_skills>` listing.
   */
  setModelInvocableCommandsProvider(
    provider: () => ReadonlyArray<{ name: string; description: string }>,
  ): void {
    this.modelInvocableCommandsProvider = provider;
  }

  /**
   * Returns the registered model-invocable commands provider, or null if none
   * has been registered (e.g., in SDK mode).
   */
  getModelInvocableCommandsProvider():
    | (() => ReadonlyArray<{ name: string; description: string }>)
    | null {
    return this.modelInvocableCommandsProvider;
  }

  /**
   * Registers an executor that can invoke a model-invocable command by name
   * (e.g., MCP prompts). Returns the prompt content as a string, or null if
   * the command cannot be found or executed. Called by the CLI layer.
   */
  setModelInvocableCommandsExecutor(
    executor: (
      name: string,
      args?: string,
    ) => Promise<ModelInvocableCommandExecutorResult | null>,
  ): void {
    this.modelInvocableCommandsExecutor = executor;
  }

  /**
   * Returns the registered model-invocable commands executor, or null if none
   * has been registered (e.g., in SDK mode).
   */
  getModelInvocableCommandsExecutor():
    | ((
        name: string,
        args?: string,
      ) => Promise<ModelInvocableCommandExecutorResult | null>)
    | null {
    return this.modelInvocableCommandsExecutor;
  }

  /**
   * Records skill keys that were announced inline on a tool result by
   * `coreToolScheduler` (e.g. path-activated conditional skills). The
   * client's `drainSkillAndCommandReminders` consumes these to mark them as
   * announced and avoid a duplicate announcement in the same turn's tail
   * reminder. Keys use the `"skill:<name>"` format matching
   * `GeminiClient.skillEntryKey`.
   */
  addInlineAnnouncedSkillKeys(keys: Iterable<string>): void {
    for (const k of keys) {
      this.pendingInlineAnnouncedSkillKeys.add(k);
    }
  }

  /**
   * Returns and clears the set of skill keys announced inline since the last
   * consumption. Idempotent — a second call returns an empty set until new
   * keys are added.
   */
  consumeInlineAnnouncedSkillKeys(): Set<string> {
    const result = this.pendingInlineAnnouncedSkillKeys;
    this.pendingInlineAnnouncedSkillKeys = new Set();
    return result;
  }

  getPermissionManager(): PermissionManager | null {
    return this.permissionManager;
  }

  /**
   * Returns the callback for persisting permission rules to settings files.
   * Returns undefined if no callback was provided (e.g. SDK mode).
   */
  getOnPersistPermissionRule():
    | ((
        scope: 'project' | 'user',
        ruleType: 'allow' | 'ask' | 'deny',
        rule: string,
      ) => Promise<void>)
    | undefined {
    return this.onPersistPermissionRuleCallback;
  }

  async createToolRegistry(
    sendSdkMcpMessage?: SendSdkMcpMessage,
    options?: { skipDiscovery?: boolean; forSubAgent?: boolean },
  ): Promise<ToolRegistry> {
    const registry = new ToolRegistry(
      this,
      this.eventEmitter,
      sendSdkMcpMessage,
    );

    // Helper: check permission then register a lazy factory (no module import
    // happens here — the dynamic import() only runs when the tool is first used).
    const registerLazy = async (
      toolName: ToolName,
      factory: ToolFactory,
    ): Promise<void> => {
      // PermissionManager handles both the coreTools allowlist (registry-level)
      // and deny rules (runtime-level) in a single check.
      let pmEnabled = true;
      try {
        pmEnabled = this.permissionManager
          ? await this.permissionManager.isToolEnabled(toolName)
          : true; // Should never reach here after initialize(), but safe default.
      } catch (error) {
        this.debugLogger.warn(
          `Failed to check permissions for tool "${toolName}", skipping registration:`,
          error,
        );
        return;
      }

      if (pmEnabled) {
        registry.registerFactory(toolName, factory);
      }
    };

    // The synthetic structured_output tool is the terminal contract for
    // --json-schema runs. It must be registered in BOTH the bare-mode
    // branch and the regular branch — without it the model can't finish
    // a structured run, so omitting either branch causes
    // `qwen [--bare] --json-schema X -p "..."` to loop until
    // maxSessionTurns and exit via the "plain text" failure path. Hoisted
    // out of the two branches so the dynamic-import factory shape stays
    // in sync between them.
    //
    // Skipped when building a subagent-context registry. `this.jsonSchema`
    // propagates to subagent overrides via prototype delegation
    // (`Object.create(base)` in `createApprovalModeOverride` /
    // `buildSubagentContextOverride`), but only `runNonInteractive`'s main
    // and drain loops detect a successful structured_output call as
    // terminal. A subagent that called the tool would receive the
    // "Session will end now" llmContent, then keep running because its
    // own loop has no termination handler — wasted tokens with no
    // structured payload surfacing on stdout. Strip the registration in
    // those contexts.
    const registerStructuredOutputIfRequested = async (): Promise<void> => {
      if (!this.jsonSchema) return;
      if (options?.forSubAgent) return;
      const schema = this.jsonSchema;
      await registerLazy(ToolNames.STRUCTURED_OUTPUT, async () => {
        const { SyntheticOutputTool } = await import(
          '../tools/syntheticOutput.js'
        );
        return new SyntheticOutputTool(schema);
      });
    };

    if (this.getBareMode()) {
      await registerLazy(ToolNames.READ_FILE, async () => {
        const { ReadFileTool } = await import('../tools/read-file.js');
        return new ReadFileTool(this);
      });
      await registerLazy(ToolNames.EDIT, async () => {
        const { EditTool } = await import('../tools/edit.js');
        return new EditTool(this);
      });
      await registerLazy(ToolNames.NOTEBOOK_EDIT, async () => {
        const { NotebookEditTool } = await import('../tools/notebook-edit.js');
        return new NotebookEditTool(this);
      });
      await registerLazy(ToolNames.SHELL, async () => {
        const { ShellTool } = await import('../tools/shell.js');
        return new ShellTool(this);
      });
      await registerStructuredOutputIfRequested();
      this.debugLogger.debug(
        `ToolRegistry created: ${JSON.stringify(registry.getAllToolNames())} (${registry.getAllToolNames().length} tools)`,
      );
      return registry;
    }

    // --- Core tools (always registered) ---
    await registerLazy(ToolNames.TOOL_SEARCH, async () => {
      const { ToolSearchTool } = await import('../tools/tool-search.js');
      return new ToolSearchTool(this);
    });
    await registerLazy(ToolNames.AGENT, async () => {
      const { AgentTool } = await import('../tools/agent/agent.js');
      return new AgentTool(this);
    });
    await registerLazy(ToolNames.TASK_STOP, async () => {
      const { TaskStopTool } = await import('../tools/task-stop.js');
      return new TaskStopTool(this);
    });
    await registerLazy(ToolNames.SEND_MESSAGE, async () => {
      const { SendMessageTool } = await import('../tools/send-message.js');
      return new SendMessageTool(this);
    });
    await registerLazy(ToolNames.SKILL, async () => {
      const { SkillTool } = await import('../tools/skill.js');
      return new SkillTool(this);
    });
    await registerLazy(ToolNames.LS, async () => {
      const { LSTool } = await import('../tools/ls.js');
      return new LSTool(this);
    });
    await registerLazy(ToolNames.READ_FILE, async () => {
      const { ReadFileTool } = await import('../tools/read-file.js');
      return new ReadFileTool(this);
    });

    // --- Grep / RipGrep (conditional) ---
    if (this.getUseRipgrep()) {
      let useRipgrep = false;
      let errorString: undefined | string = undefined;
      try {
        useRipgrep = await canUseRipgrep(this.getUseBuiltinRipgrep());
      } catch (error: unknown) {
        errorString = getErrorMessage(error);
      }
      if (useRipgrep) {
        await registerLazy(ToolNames.GREP, async () => {
          const { RipGrepTool } = await import('../tools/ripGrep.js');
          return new RipGrepTool(this);
        });
      } else {
        logRipgrepFallback(
          this,
          new RipgrepFallbackEvent(
            this.getUseRipgrep(),
            this.getUseBuiltinRipgrep(),
            errorString || 'ripgrep is not available',
          ),
        );
        await registerLazy(ToolNames.GREP, async () => {
          const { GrepTool } = await import('../tools/grep.js');
          return new GrepTool(this);
        });
      }
    } else {
      await registerLazy(ToolNames.GREP, async () => {
        const { GrepTool } = await import('../tools/grep.js');
        return new GrepTool(this);
      });
    }

    await registerLazy(ToolNames.GLOB, async () => {
      const { GlobTool } = await import('../tools/glob.js');
      return new GlobTool(this);
    });
    await registerLazy(ToolNames.EDIT, async () => {
      const { EditTool } = await import('../tools/edit.js');
      return new EditTool(this);
    });
    await registerLazy(ToolNames.NOTEBOOK_EDIT, async () => {
      const { NotebookEditTool } = await import('../tools/notebook-edit.js');
      return new NotebookEditTool(this);
    });
    await registerLazy(ToolNames.WRITE_FILE, async () => {
      const { WriteFileTool } = await import('../tools/write-file.js');
      return new WriteFileTool(this);
    });
    await registerLazy(ToolNames.SHELL, async () => {
      const { ShellTool } = await import('../tools/shell.js');
      return new ShellTool(this);
    });
    await registerLazy(ToolNames.TODO_WRITE, async () => {
      const { TodoWriteTool } = await import('../tools/todoWrite.js');
      return new TodoWriteTool(this);
    });
    await registerLazy(ToolNames.ASK_USER_QUESTION, async () => {
      const { AskUserQuestionTool } = await import(
        '../tools/askUserQuestion.js'
      );
      return new AskUserQuestionTool(this);
    });
    if (!this.sdkMode) {
      await registerLazy(ToolNames.EXIT_PLAN_MODE, async () => {
        const { ExitPlanModeTool } = await import('../tools/exitPlanMode.js');
        return new ExitPlanModeTool(this);
      });
      await registerLazy(ToolNames.ENTER_PLAN_MODE, async () => {
        const { EnterPlanModeTool } = await import('../tools/enterPlanMode.js');
        return new EnterPlanModeTool(this);
      });
    }
    await registerLazy(ToolNames.ENTER_WORKTREE, async () => {
      const { EnterWorktreeTool } = await import('../tools/enter-worktree.js');
      return new EnterWorktreeTool(this);
    });
    await registerLazy(ToolNames.EXIT_WORKTREE, async () => {
      const { ExitWorktreeTool } = await import('../tools/exit-worktree.js');
      return new ExitWorktreeTool(this);
    });
    await registerLazy(ToolNames.WEB_FETCH, async () => {
      const { WebFetchTool } = await import('../tools/web-fetch.js');
      return new WebFetchTool(this);
    });
    if (this.isLspEnabled() && this.getLspClient()) {
      await registerLazy(ToolNames.LSP, async () => {
        const { LspTool } = await import('../tools/lsp.js');
        return new LspTool(this);
      });
    }

    // Register synthetic structured-output tool when --json-schema is set.
    // The tool's parameter schema IS the user-supplied JSON Schema, so the
    // model's arguments must match it (Ajv-validated in BaseDeclarativeTool).
    // Same helper as the bare-mode branch above to keep the registration
    // shape and permission gating in sync between the two paths.
    await registerStructuredOutputIfRequested();

    // Register cron tools unless disabled
    if (this.isCronEnabled()) {
      await registerLazy(ToolNames.CRON_CREATE, async () => {
        const { CronCreateTool } = await import('../tools/cron-create.js');
        return new CronCreateTool(this);
      });
      await registerLazy(ToolNames.CRON_LIST, async () => {
        const { CronListTool } = await import('../tools/cron-list.js');
        return new CronListTool(this);
      });
      await registerLazy(ToolNames.CRON_DELETE, async () => {
        const { CronDeleteTool } = await import('../tools/cron-delete.js');
        return new CronDeleteTool(this);
      });
    }

    // Register team collaboration tools (experimental). The team-specific
    // tools (team_create/team_delete/task_create/task_update/task_list)
    // are gated on this flag.
    if (this.isAgentTeamEnabled()) {
      await registerLazy(ToolNames.TEAM_CREATE, async () => {
        const { TeamCreateTool } = await import('../tools/team-create.js');
        return new TeamCreateTool(this);
      });
      await registerLazy(ToolNames.TEAM_DELETE, async () => {
        const { TeamDeleteTool } = await import('../tools/team-delete.js');
        return new TeamDeleteTool(this);
      });
      await registerLazy(ToolNames.TASK_CREATE, async () => {
        const { TaskCreateTool } = await import('../tools/task-create.js');
        return new TaskCreateTool(this);
      });
      await registerLazy(ToolNames.TASK_UPDATE, async () => {
        const { TaskUpdateTool } = await import('../tools/task-update.js');
        return new TaskUpdateTool(this);
      });
      await registerLazy(ToolNames.TASK_LIST, async () => {
        const { TaskListTool } = await import('../tools/task-list.js');
        return new TaskListTool(this);
      });
    }

    // Register workflow tool when enabled
    if (this.isWorkflowsEnabled()) {
      await registerLazy(ToolNames.WORKFLOW, async () => {
        const { WorkflowTool } = await import('../tools/workflow/workflow.js');
        return new WorkflowTool(this);
      });
    }

    // Register computer-use tools unless disabled. All 9 are deferred —
    // they surface only via ToolSearch keyword match
    // (see packages/core/src/tools/computer-use/).
    //
    // Pass `registerLazy` (not the bare `registry`) so the same
    // PermissionManager.isToolEnabled() check that gates every other
    // built-in also gates these. Direct registry.registerFactory() would
    // bypass coreTools allowlist + whole-tool deny rules.
    if (this.isComputerUseEnabled()) {
      const { registerComputerUseTools } = await import(
        '../tools/computer-use/index.js'
      );
      await registerComputerUseTools(registerLazy, this);
    }

    // Register monitor tool
    await registerLazy(ToolNames.MONITOR, async () => {
      const { MonitorTool } = await import('../tools/monitor.js');
      return new MonitorTool(this);
    });

    // apply any pending MCP
    // budget-event callback BEFORE `discoverAllTools` (legacy blocking
    // mode runs MCP discovery synchronously in there) and BEFORE the
    // post-`createToolRegistry` `startMcpDiscoveryInBackground` (default
    // mode). Either way the manager has its callback wired at the
    // moment the first discovery pass fires, so end-of-pass events
    // for that pass are routed through the SDK push channel.
    if (this.pendingMcpBudgetCallback) {
      const mgr = registry.getMcpClientManager();
      if (mgr && typeof mgr.setOnBudgetEvent === 'function') {
        mgr.setOnBudgetEvent(this.pendingMcpBudgetCallback);
      }
      // clear after consumption so a
      // subsequent `createToolRegistry` call (e.g. subagent override
      // via `createApprovalModeOverride` /
      // `buildSubagentContextOverride`) doesn't re-apply the parent
      // session's callback to a fresh manager. Subagent contexts run
      // their own MCP clients but should NOT push budget events
      // through the parent's ACP session — that would route subagent
      // telemetry to the wrong subscriber.
      //
      // Late-call setter (`setMcpBudgetEventCallback` after
      // `initialize()`) is unaffected: it dispatches directly to the
      // existing manager via the `if (this.toolRegistry)` branch,
      // not through `pendingMcpBudgetCallback`.
      this.pendingMcpBudgetCallback = undefined;
    }

    if (!options?.skipDiscovery) {
      await registry.discoverAllTools();
    }
    this.debugLogger.debug(
      `ToolRegistry created: ${JSON.stringify(registry.getAllToolNames())} (${registry.getAllToolNames().length} tools)`,
    );
    return registry;
  }

  /**
   * register the MCP guardrail
   * push-event callback. Acceptable to call at any point in the
   * Config lifecycle — before, during, or after `initialize()`.
   *
   * Two paths:
   * - **Pre-init** (no `toolRegistry` yet): stash on
   *   `pendingMcpBudgetCallback`. `createToolRegistry` will apply it
   *   to the freshly-constructed manager and clear the stash (round
   *   6 fix). The stash is the ONLY way to reach a manager that
   *   doesn't exist yet.
   * - **Late** (`toolRegistry` already exists): dispatch directly to
   *   the existing manager. **DO NOT** also stash — that's the
   *   round-7 fix. Pre-fix, both paths assigned to
   *   `pendingMcpBudgetCallback` regardless, so a subsequent
   *   `createToolRegistry` (subagent override via
   *   `createApprovalModeOverride` /
   *   `buildSubagentContextOverride`) would re-apply the parent
   *   session's callback to the subagent's fresh manager — routing
   *   subagent telemetry through the wrong ACP session.
   *
   * `cb: undefined` clears the registration. `off`-mode managers
   * silently drop the callback (their state machine never runs).
   */
  setMcpBudgetEventCallback(
    cb: ((event: McpBudgetEvent) => void) | undefined,
  ): void {
    if (this.toolRegistry) {
      // Late-call path: apply directly. Do NOT stash — see comment
      // above for the subagent isolation rationale.
      const mgr = this.toolRegistry.getMcpClientManager?.();
      if (mgr && typeof mgr.setOnBudgetEvent === 'function') {
        mgr.setOnBudgetEvent(cb);
      }
      this.pendingMcpBudgetCallback = undefined;
      return;
    }
    // Pre-init path: stash for `createToolRegistry` to consume.
    this.pendingMcpBudgetCallback = cb;
  }
}
