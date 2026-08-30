/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  APPROVAL_MODE_INFO,
  APPROVAL_MODES,
  AuthType,
  hasVertexProjectConfigured,
  BTW_MAX_INPUT_LENGTH,
  buildBtwCacheSafeParams,
  buildBtwPrompt,
  ALL_PROVIDERS,
  applyProviderInstallPlan,
  buildInstallPlan,
  clearCachedCredentialFile,
  createDebugLogger,
  generateSessionRecap,
  findProviderById,
  getAllMemoryFilenames,
  getAutoMemoryRoot,
  getUserAutoMemoryRoot,
  getDefaultBaseUrlForProtocol,
  getDefaultModelIds,
  getScopedEnvContents,
  QwenOAuth2Event,
  qwenOAuth2Events,
  resolveBaseUrl,
  MCP_BUDGET_WARN_FRACTION,
  MCPServerConfig,
  runForkedAgent,
  SessionIdCaseConflictError,
  SessionService,
  SESSION_WRITER_RPC_CODES,
  SessionWriterUnavailableError,
  SESSION_TITLE_MAX_LENGTH,
  Storage,
  tokenLimit,
  getMCPDiscoveryState,
  getMCPServerStatus,
  initializeTelemetry,
  preloadContentGenerator,
  MCPDiscoveryState,
  MCPServerStatus,
  McpTransportPool,
  POOLED_TRANSPORTS_DEFAULT,
  INVOCATION_CONTEXT_META_KEY,
  PRIVATE_ACP_CAPABILITY_ENV,
  PRIVATE_PARENT_CAPABILITY_META_KEY,
  parseInvocationContext,
  findExistingProviderModels,
  ExtensionManager,
  ExtensionSettingScope,
  HookEventName,
  updateSetting,
  SessionEndReason,
  WorkspaceMcpBudget,
  DiscoveredMCPTool,
  restoreWorktreeContext,
  uiTelemetryService,
  McpBudgetWouldExceedError,
  McpServerSpawnFailedError,
  InvalidMcpConfigError,
  isGatedMcpScope,
  MCPOAuthProvider,
  MCPOAuthTokenStorage,
  InvalidSessionTranscriptCursorError,
  SESSION_TRANSCRIPT_MAX_LIMIT,
  SESSION_TRANSCRIPT_MAX_PAGE_BYTES,
  SessionTranscriptReader,
  SessionTranscriptPageTooLargeError,
  SessionTranscriptSnapshotUnavailableError,
  SessionTranscriptTooLargeError,
  encodeSessionTranscriptCursor,
  isTurnResultRecordPayload,
  subagentGenerator,
  redactUrlCredentials,
  computeUniqueBranchTitle,
  normalizeDerivedBranchTitle,
  BranchPointInvalidError,
  parseGoalSnapshotV2,
  parseGoalStateCause,
  ToolNames,
  FORK_SUBAGENT_TYPE,
  runManagedAutoMemoryDream,
  runManagedRememberByAgent,
  matchesAnyServerPattern,
  mcpServerRequiresOAuth,
  IMAGE_CAPABILITY,
  registerAcpEventLoopLagGauge,
  SESSION_ARTIFACT_PERSISTENCE_VERSION,
  normalizeEventPayload,
  normalizeSnapshotPayload,
  startEventLoopLagMonitor,
  refreshMemoryInstruction,
  applyReasoningEffort,
  REASONING_EFFORT_TIERS,
  addDaemonRequestAttribute,
  extractDaemonTraceContext,
  withDaemonSpan,
  emptyGoalSnapshot,
  GoalConflictError,
  GoalInvalidTransitionError,
  GoalPersistenceUnavailableError,
  parseGoalControlRequest,
  type GoalControlRequest,
  type GoalRuntime,
  type GoalSnapshotV2,
  type GoalStateResponse,
  type AgentParams,
  ApprovalMode,
  type Config,
  type ConfigInitializeOptions,
  type DeviceAuthorizationData,
  type DiscoveredMCPPrompt,
  type DiscoveredMCPResource,
  type HookConfig,
  type McpBudgetEvent,
  type McpBudgetMode,
  type McpClientManager,
  type McpTransportKind,
  type ProviderConfig,
  type ProviderModelConfig,
  type ProviderSetupInputs,
  type ResumedSessionData,
  type SelectiveSessionRestoreOptions,
  type SendSdkMcpMessage,
  type SessionLiveRestoreProjection,
  type SessionRestoreProjection,
  type SessionArtifactEventRecordPayload,
  type SessionArtifactSnapshotRecordPayload,
  type WorkspaceRememberContextMode,
  type ChatRecord,
  type ToolInvocationGuard,
  type TurnResultRecordPayload,
  sessionIdContext,
} from '@qwen-code/qwen-code-core';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
  AgentSideConnection,
  RequestError,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import { isNotCurrentlyGeneratingCancelError } from '@qwen-code/acp-bridge/bridgeErrors';
import type { Content } from '@google/genai';
import type {
  Agent,
  AuthenticateRequest,
  CancelNotification,
  ClientCapabilities,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  McpServer,
  McpServerHttp,
  McpServerSse,
  McpServerStdio,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionInfo,
  SessionUpdate,
  SessionModeState,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
} from '@agentclientprotocol/sdk';
import {
  buildAuthMethods,
  pickAuthMethodsForAuthRequired,
} from './authMethods.js';
import { AcpFileSystemService } from './service/filesystem.js';
import { ndJsonStream } from '@qwen-code/acp-bridge/ndJsonStream';
import {
  ACP_EVENT_LOOP_STALL_RESTART_MS,
  CHANNEL_PROMPT_META_KEY,
} from '@qwen-code/channel-base';
import { observeAcpToolResultWire } from '../nonInteractive/tool-result-boundary-diagnostics.js';
import { Readable, Writable } from 'node:stream';
import { normalizeDisabledToolList } from '../config/normalizeDisabledTools.js';
import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LoadedSettings } from '../config/settings.js';
import {
  loadSettings,
  reloadEnvironment,
  SettingScope,
} from '../config/settings.js';
import { loadSettingsCached } from '../config/settings-cache.js';
import {
  normalizeSessionIdForLookup,
  parseCallerSuppliedSessionId,
} from '../config/session-id.js';
import { loadMcpApprovals } from '../config/mcpApprovals.js';
import { assembleMcpServers } from '../config/mcpServers.js';
import { recomputeMcpGating } from '../config/hot-reload.js';
import {
  REDACTED_MCP_SECRET,
  redactMcpServerSecrets,
  restoreRedactedMcpSecrets,
} from '../config/mcp-server-secrets.js';
import {
  buildPermissionSettings,
  normalizePermissionRules,
  PermissionRulesValidationError,
  PERMISSION_RULE_TYPES,
  readPermissionRuleSet,
  type PermissionRuleSet,
} from '../config/permission-settings.js';
import { createLoadedSettingsAdapter } from '../config/loadedSettingsAdapter.js';
import { isCompatibleLiveSessionSource } from '../runtime/live-session-source.js';
import {
  getConversationDirectoryName,
  hasVerifiableInode,
  isSameConversationPath,
  isSameDirectoryIdentity,
} from '../utils/conversation-directory-identity.js';
import type { ApprovalModeValue } from './session/types.js';
import { z } from 'zod';
import type { CliArgs } from '../config/config.js';
import {
  buildDisabledSkillNamesProvider,
  loadCliConfig,
  parseApprovalModeValue,
  SessionIdConflictError,
} from '../config/config.js';
import { resolveSkillSettings } from '../config/skill-settings.js';
import {
  createWorkspaceMemoryExtractionErrorLogger,
  shouldSuppressRememberErrorDetails,
  workspaceMemoryFailureCode,
  workspaceMemoryFailureDiagnostics,
} from '../runtime/workspace-remember-errors.js';
import { formatWorkspaceMemoryForgetSummary } from '../runtime/workspace-memory-summaries.js';
import { mapSkillConfigToStatus } from '../runtime/workspace-skills-mapping.js';
import {
  inactiveExtensionSkillRefs,
  isInactiveExtensionSkill,
} from './extension-skills.js';
import { Session, registerCreateSubSessionTool } from './session/Session.js';
import { restoreSessionModelThenAuthenticate } from './session-model-persistence.js';
import { HistoryReplayer } from './session/history-replayer.js';
import { renderPreparedGoalUpdate } from './session/recovered-goal-update.js';
import { ActiveWorkReporter } from './active-work-reporter.js';
import {
  shouldProbeChildHeap,
  startChildHeapProbe,
  type ChildHeapProbe,
} from './child-heap-probe.js';
import {
  buildModelReasoningConfigOption,
  buildModelReasoningConfigPreview,
  getModelConfiguration,
  REASONING_EFFORT_DEFAULT,
  REASONING_EFFORT_NAMES,
  REASONING_EFFORT_NONE,
  type ModelReasoningConfiguration,
} from './model-configuration.js';
import {
  deleteManagedSkill,
  installManagedSkill,
  setManagedSkillEnabled,
} from './skill-management.js';
import { buildSessionTasksStatus } from './session/tasksSnapshot.js';
import {
  collectHistoryReplayUpdates,
  copyCumulativeUsage,
  createReplayCumulativeUsage,
  HistoryReplayLimitError,
  replayTranscriptRecordPage,
} from './session/history-replay-page.js';
import {
  ACP_ROUTE_ID_PREFIX,
  buildAcpModelOptions,
  getCurrentAcpModelId,
  parseAcpBaseModelId,
  sanitizeProviderBaseUrl,
} from '../utils/acpModelUtils.js';
import {
  updateOutputLanguageFile,
  resolveOutputLanguageOrPreserveAuto,
  getOutputLanguageFilePath,
  writeOutputLanguageAndRegisterPath,
} from '../i18n/languageUtils.js';
import { runWithAcpRuntimeOutputDir } from './runtimeOutputDirContext.js';
import { ACP_ERROR_CODES } from './errorCodes.js';
import { runExitCleanup } from '../utils/cleanup.js';
import { startNonInteractiveOpenAILogHousekeeping } from '../services/housekeeping/scheduler.js';
import { appEvents, AppEvent } from '../utils/events.js';
import {
  setLanguageAsync,
  getCurrentLanguage,
  SUPPORTED_LANGUAGES,
} from '../i18n/index.js';
import {
  isWorkspaceTrusted,
  isFolderTrustEnabled,
  loadTrustedFolders,
} from '../config/trustedFolders.js';
import {
  ACP_PREFLIGHT_KINDS,
  STATUS_SCHEMA_VERSION,
  SERVE_CONTROL_EXT_METHODS,
  SERVE_STATUS_EXT_METHODS,
  mapDomainErrorToErrorKind,
  type AcpPreflightKind,
  type ServeErrorKind,
  type ServeMcpBudgetMode,
  type ServeMcpBudgetStatusCell,
  type ServeMcpDiscoveryState,
  type ServeMcpServerRuntimeStatus,
  type ServeMcpTransport,
  type ServeWorkspaceMcpToolStatus,
  type ServeWorkspaceMcpToolsStatus,
  type ServeWorkspaceMcpResourceStatus,
  type ServeWorkspaceMcpResourcesStatus,
  type ServePreflightCell,
  type ServePreflightKind,
  type ServeSessionContextStatus,
  type ServeSessionSupportedCommandsStatus,
  type ServeSessionLspStatus,
  type ServeSessionTasksStatus,
  type ServeStatus,
  type ServeStatusCell,
  type ServeWorkspaceMcpServerStatus,
  type ServeWorkspaceMcpStatus,
  type ServeWorkspaceProviderModel,
  type ServeWorkspaceProviderStatus,
  type ServeWorkspaceProvidersStatus,
  type ServeWorkspaceSkillsStatus,
  type ServeWorkspaceToolStatus,
  type ServeWorkspaceToolsStatus,
  type ServeSessionContextUsageStatus,
  type ServeSessionStatsStatus,
  type ServeHookConfig,
  type ServeHookEntry,
  type ServeHookSource,
  type ServeSessionHooksStatus,
  type ServeWorkspaceHooksStatus,
  type ServeExtensionEntry,
  type ServeExtensionCapabilities,
  type ServeWorkspaceExtensionsStatus,
  IDLE_HOOK_EVENTS,
} from '@qwen-code/acp-bridge/status';
import {
  EXTERNAL_TOOL_GUARD_READY_META_KEY,
  EXTERNAL_TOOL_GUARD_REQUIRED_VALUE,
  EXTERNAL_TOOL_GUARD_TOKEN_ENV,
  isValidExternalToolGuardDenialReason,
  PRIVATE_EXTERNAL_TOOL_GUARD_ENV,
  PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER_ENV,
  SHELL_EXECUTING_TOOL_NAMES,
} from '@qwen-code/acp-bridge/externalToolGuard';
import {
  DAEMON_OWNED_STANDALONE_CREATION_KEY,
  isReservedStandaloneSessionSourceType,
  parseSessionSource,
  SESSION_SOURCE_META_KEY,
} from '@qwen-code/acp-bridge/sessionSource';
import {
  ACTIVE_WORK_CLOSE_IF_UNHELD_PARAM,
  ACTIVE_WORK_HEARTBEAT_META_KEY,
  ACTIVE_WORK_HEARTBEAT_VERSION,
  ACTIVE_WORK_HOLD_CATEGORIES,
  ACTIVE_WORK_LEGACY_HOLD_CATEGORIES,
  CHANNEL_LIVENESS_META_KEY,
  CHANNEL_LIVENESS_VERSION,
  clampActiveWorkIntervalMs,
  type ActiveWorkHoldV1,
  CHANNEL_STARTUP_PROFILE_META_KEY,
  CHANNEL_STARTUP_PROFILE_VERSION,
  CLIENT_MCP_OVER_WS_CONFIG_FLAG,
  DAEMON_CHANNEL_DELIVERY_META_KEY,
  DAEMON_MODEL_PROMPT_META_KEY,
  DAEMON_PROMPT_DISPLAY_TEXT_META_KEY,
  DAEMON_RESTORE_ASK_USER_QUESTION_META_KEY,
  DAEMON_SUPPRESS_RESTORE_ASK_USER_QUESTION_META_KEY,
  LOAD_REPLAY_BULK_MODE,
  LOAD_REPLAY_HIDE_INHERITED_META_KEY,
  LOAD_REPLAY_MAX_BYTES,
  LOAD_REPLAY_MAX_UPDATES,
  LOAD_REPLAY_META_KEY,
  LOAD_REPLAY_MODE_META_KEY,
  LOAD_REPLAY_PAGE_SIZE_META_KEY,
  LOAD_REPLAY_VERSION,
  PROMPT_CANCEL_METHOD,
  REQUESTED_SESSION_ID_META_KEY,
  SESSION_INITIALIZATION_DEADLINE_META_KEY,
  SESSION_INITIALIZATION_TIMEOUT_ERROR_KIND,
  TODO_STOP_GUARD_QUEUE_RELEASE_METHOD,
  isValidTrustedModelPrompt,
  WORKTREE_MCP_DEFER_META_KEY,
  type ClientMcpOverWsRuntimeConfig,
  type BridgeConversationDirectoryExpectation,
  type BridgeLoadReplayEnvelope,
} from '@qwen-code/acp-bridge/bridgeTypes';
import {
  beginAcpBootstrapConfigProfiling,
  buildAndFreezeAcpStartupProfile,
  endAcpBootstrapConfigProfiling,
  markAcpStartup,
} from '../utils/acp-startup-profiler.js';
import { isValidServerName } from '../runtime/validate-server-name.js';
import { MAX_REMEMBER_CONTENT_BYTES } from '../runtime/workspace-memory-remember-constants.js';
import { computeCpuPercent } from '../runtime/cpu-percent.js';
import {
  collectContextData,
  formatContextUsageText,
} from '../ui/commands/contextCommand.js';
import type { HistoryItemContextUsage } from '../ui/types.js';
import { fireSessionDeleteHook } from '../hooks/session-delete-hook.js';
import {
  collectGoalStatusItemsFromRecords,
  findGoalToRestore,
} from '../ui/utils/restoreGoal.js';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';
import {
  executeGeneration,
  GENERATION_MAX_PROMPT_BYTES,
  GENERATION_TIMEOUT_MS,
  type GenerationEvent,
} from './generation.js';

const debugLogger = createDebugLogger('ACP_AGENT');
const QWEN_ACP_LOCAL_READ_ROOTS_ENV = 'QWEN_ACP_LOCAL_READ_ROOTS';
const POSIX_TMP_LOCAL_READ_ROOT = '/tmp';
// Must be less than SESSION_BTW_TIMEOUT_MS (60s) in bridge.ts so the child
// aborts before the bridge's backstop timer fires.
const BTW_CHILD_TIMEOUT_MS = 55_000;
const MCP_OAUTH_START_TIMEOUT_MS = 30_000;
const SESSION_DRAIN_TIMEOUT_MS = 30_000;
const SESSION_ID_RE = /^[0-9a-fA-F-]{32,36}$/;
// Must be less than WORKSPACE_MEMORY_REMEMBER_TIMEOUT_MS (300s) in bridge.ts.
const WORKSPACE_MEMORY_REMEMBER_CHILD_TIMEOUT_MS = 295_000;

function currentGoalSnapshot(
  config: Config,
  runtime?: GoalRuntime,
): GoalSnapshotV2 {
  try {
    return (runtime ?? config.getGoalRuntime()).getSnapshot();
  } catch {
    return emptyGoalSnapshot();
  }
}

function mapGoalControlError(
  error: unknown,
  config: Config,
  runtime?: GoalRuntime,
): RequestError {
  if (error instanceof GoalConflictError) {
    return new RequestError(-32009, error.message, {
      errorKind: 'goal_conflict',
      current: error.current,
    });
  }
  if (error instanceof GoalInvalidTransitionError) {
    return new RequestError(-32009, error.message, {
      errorKind: 'goal_invalid_transition',
      current: error.current,
    });
  }
  return new RequestError(
    -32603,
    error instanceof Error ? error.message : 'Goal persistence failed',
    {
      errorKind: 'goal_persist_failed',
      current: currentGoalSnapshot(config, runtime),
    },
  );
}

async function dispatchGoalControl(
  config: Config,
  request: GoalControlRequest,
): Promise<GoalStateResponse> {
  const requiresTrustedWorkspace =
    request.action === 'create' ||
    request.action === 'replace' ||
    request.action === 'edit' ||
    request.action === 'resume';
  if (requiresTrustedWorkspace && !config.isTrustedFolder()) {
    throw new RequestError(-32003, 'Workspace is not trusted.', {
      errorKind: 'untrusted_workspace',
      httpStatus: 403,
    });
  }
  let runtime: GoalRuntime | undefined;
  try {
    runtime = await config.getGoalRuntimeReady();
    return await runtime.dispatch(request);
  } catch (error) {
    throw mapGoalControlError(error, config, runtime);
  }
}

const TURN_STATUS_SCAN_PAGE_LIMIT = 500;
const TURN_STATUS_SCAN_MAX_PAGES = 10;

async function findSettledTurnResult(
  reader: SessionTranscriptReader,
  sessionId: string,
  promptId: string | undefined,
  workspaceCwd: string,
): Promise<TurnResultRecordPayload | undefined> {
  let cursor: string | undefined;
  for (let page = 0; page < TURN_STATUS_SCAN_MAX_PAGES; page++) {
    const result = await reader.readPage(sessionId, {
      ...(cursor !== undefined
        ? { cursor }
        : { direction: 'backward' as const }),
      limit: TURN_STATUS_SCAN_PAGE_LIMIT,
      maxBytes: SESSION_TRANSCRIPT_MAX_PAGE_BYTES,
    });
    for (let i = result.records.length - 1; i >= 0; i--) {
      const record = result.records[i]!;
      if (record.type !== 'system' || record.subtype !== 'turn_result') {
        continue;
      }
      const payload = record.systemPayload;
      if (!isTurnResultRecordPayload(payload)) continue;
      if (promptId === undefined || payload.promptId === promptId) {
        return payload;
      }
    }
    if (!result.hasMore || result.nextCursorState === undefined) {
      return undefined;
    }
    cursor = encodeSessionTranscriptCursor(
      result.nextCursorState,
      workspaceCwd,
    );
  }
  return undefined;
}

type AcpSessionProfileStage =
  | 'settings_load'
  | 'live_restore'
  | 'existence_check'
  | 'config_setup'
  | 'restore_session_model'
  | 'auth'
  | 'file_system_setup'
  | 'session_register'
  | 'runtime_initialize'
  | 'response_build'
  | 'history_replay'
  | 'post_replay_services';

interface AcpSessionProfileSpan {
  setAttribute(name: string, value: string | number | boolean): unknown;
}

function createAcpSessionProfiler(
  span: AcpSessionProfileSpan | undefined,
  attributePrefix: 'session_start' | 'session_restore',
) {
  let failedStage: AcpSessionProfileStage | undefined;
  const setAttribute = (
    name: string,
    value: string | number | boolean,
  ): void => {
    try {
      span?.setAttribute(name, value);
    } catch {
      // Telemetry must not affect session creation or restore.
    }
  };
  const recordStage = (stage: AcpSessionProfileStage, start: number): void => {
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      setAttribute(
        `qwen-code.daemon.${attributePrefix}.${stage}_ms`,
        durationMs,
      );
    }
  };
  const recordFailure = (stage: AcpSessionProfileStage): void => {
    if (failedStage !== undefined) return;
    failedStage = stage;
    setAttribute(`qwen-code.daemon.${attributePrefix}.failed_stage`, stage);
  };

  return {
    fail(stage: AcpSessionProfileStage): void {
      recordFailure(stage);
    },
    async time<T>(
      stage: AcpSessionProfileStage,
      fn: () => T | Promise<T>,
    ): Promise<T> {
      if (!span) return await fn();
      const start = performance.now();
      try {
        return await fn();
      } catch (error) {
        recordFailure(stage);
        throw error;
      } finally {
        recordStage(stage, start);
      }
    },
    timeSync<T>(stage: AcpSessionProfileStage, fn: () => T): T {
      if (!span) return fn();
      const start = performance.now();
      try {
        return fn();
      } catch (error) {
        recordFailure(stage);
        throw error;
      } finally {
        recordStage(stage, start);
      }
    },
    setSessionId(sessionId: string): void {
      setAttribute('session.id', sessionId);
    },
  };
}

function createAcpSessionStartProfiler(
  span: AcpSessionProfileSpan | undefined,
) {
  return createAcpSessionProfiler(span, 'session_start');
}

function createAcpSessionRestoreProfiler(
  span: AcpSessionProfileSpan | undefined,
) {
  return createAcpSessionProfiler(span, 'session_restore');
}

type AcpSessionRestoreProfiler = ReturnType<
  typeof createAcpSessionRestoreProfiler
>;

function workspaceMemoryErrorData(
  code: string,
  diagnostics: { details?: string },
): { errorKind: string; details?: string } {
  return {
    errorKind: code,
    ...(diagnostics.details ? { details: diagnostics.details } : {}),
  };
}

const SESSION_WRITER_MESSAGES = {
  session_writer_conflict:
    'This session is already open in another Qwen process.',
  session_writer_lost: 'Write ownership for this session was lost.',
  session_transcript_changed:
    'The session transcript changed outside its active writer.',
  session_writer_unavailable: 'Session write ownership could not be verified.',
} as const;

function getSessionWriterError(error: unknown):
  | {
      rpcCode: number;
      errorKind: keyof typeof SESSION_WRITER_RPC_CODES;
      message: string;
    }
  | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as Record<string, unknown>;
  const errorKind = candidate['errorKind'];
  if (
    typeof errorKind !== 'string' ||
    !(errorKind in SESSION_WRITER_RPC_CODES)
  ) {
    return undefined;
  }
  const typedKind = errorKind as keyof typeof SESSION_WRITER_RPC_CODES;
  if (candidate['rpcCode'] !== SESSION_WRITER_RPC_CODES[typedKind]) {
    return undefined;
  }
  return {
    rpcCode: SESSION_WRITER_RPC_CODES[typedKind],
    errorKind: typedKind,
    message: SESSION_WRITER_MESSAGES[typedKind],
  };
}

function mapSessionWriterRequestError(error: unknown): unknown {
  const writerError = getSessionWriterError(error);
  return writerError
    ? new RequestError(writerError.rpcCode, writerError.message, {
        errorKind: writerError.errorKind,
      })
    : error;
}

async function shutdownSessionConfig(config: Config): Promise<void> {
  await config.shutdown({ shutdownTelemetry: false });
  if (config.hasSessionWriteOwnership()) {
    throw new SessionWriterUnavailableError();
  }
}

async function waitForSessionDrain(
  operation: Promise<void>,
  timeoutMs: number,
  kind: 'close' | 'restore',
  displayTimeoutMs?: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Session ${kind} timed out after ${displayTimeoutMs ?? timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );
    timer.unref();
  });
  try {
    await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function beginSessionCloseAfterCurrentGate(
  session: Session,
  timeoutMs: number,
): Promise<() => void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const releaseGate = session.beginCloseIfAvailable();
    if (releaseGate) return releaseGate;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Session close timed out after ${timeoutMs}ms`);
    }
    await waitForSessionDrain(
      session.waitForCloseGateToRelease(),
      remainingMs,
      'close',
    );
  }
}

const logWorkspaceMemoryExtractionError =
  createWorkspaceMemoryExtractionErrorLogger(debugLogger);

function parseAcpLocalReadRootsEnv(
  raw = process.env[QWEN_ACP_LOCAL_READ_ROOTS_ENV],
): string[] {
  if (!raw) return [];

  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry));
}

function defaultAcpOnlyLocalReadRoots(): string[] {
  return process.platform === 'win32' ? [] : [POSIX_TMP_LOCAL_READ_ROOT];
}

function buildAcpLocalReadRoots(config: Config): string[] {
  return [
    // SYNC: The first group mirrors ReadFileTool's default allowed local roots,
    // including auto-memory roots. The ACP-only additions below expand only
    // local read fallback, not read_file's default permission.
    config.storage.getProjectTempDir(),
    path.join(config.storage.getProjectDir(), 'subagents'),
    path.join(config.getSessionRuntimeBaseDir(), 'tmp'),
    getAutoMemoryRoot(config.getTargetDir()),
    getUserAutoMemoryRoot(),
    ...config.storage.getUserSkillsDirs(),
    Storage.getUserExtensionsDir(),
    // Saved plan files (see ReadFileTool.getDefaultPermission for why the
    // plans dir must be readable without a confirmation prompt).
    config.getPlansDir(),
    ...defaultAcpOnlyLocalReadRoots(),
    ...parseAcpLocalReadRootsEnv(),
  ];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSessionArtifactEventPayload(
  payload: unknown,
  expectedSessionId: string,
): SessionArtifactEventRecordPayload {
  const record = parseSessionArtifactBasePayload(payload, expectedSessionId);
  const warnings: string[] = [];
  const normalized = normalizeEventPayload(record, warnings);
  if (
    !normalized ||
    warnings.length > 0 ||
    normalized.changes.length !== (record['changes'] as unknown[]).length
  ) {
    throw invalidArtifactPersistPayload();
  }
  return normalized;
}

function parseSessionArtifactSnapshotPayload(
  payload: unknown,
  expectedSessionId: string,
): SessionArtifactSnapshotRecordPayload {
  const record = parseSessionArtifactBasePayload(payload, expectedSessionId);
  const warnings: string[] = [];
  const normalized = normalizeSnapshotPayload(record, warnings);
  if (
    !normalized ||
    warnings.length > 0 ||
    normalized.artifacts.length !== (record['artifacts'] as unknown[]).length
  ) {
    throw invalidArtifactPersistPayload();
  }
  return normalized;
}

function parseSessionArtifactBasePayload(
  payload: unknown,
  expectedSessionId: string,
): Record<string, unknown> {
  if (!isObjectRecord(payload)) {
    throw invalidArtifactPersistPayload();
  }
  if (
    payload['v'] !== SESSION_ARTIFACT_PERSISTENCE_VERSION ||
    payload['sessionId'] !== expectedSessionId ||
    !Number.isSafeInteger(payload['sequence']) ||
    (payload['sequence'] as number) < 0 ||
    typeof payload['recordedAt'] !== 'string' ||
    payload['recordedAt'].length === 0
  ) {
    throw invalidArtifactPersistPayload();
  }
  return payload;
}

function invalidArtifactPersistPayload(): Error {
  return RequestError.invalidParams(
    undefined,
    'Invalid or missing artifact persist payload',
  );
}

function isBulkLoadReplayRequest(params: LoadSessionRequest): boolean {
  const meta = isObjectRecord(params._meta) ? params._meta : undefined;
  return meta?.[LOAD_REPLAY_MODE_META_KEY] === LOAD_REPLAY_BULK_MODE;
}

function shouldHideInheritedHistory(params: LoadSessionRequest): boolean {
  const meta = isObjectRecord(params._meta) ? params._meta : undefined;
  return meta?.[LOAD_REPLAY_HIDE_INHERITED_META_KEY] === true;
}

function loadRestoreOptions(
  params: LoadSessionRequest,
): SelectiveSessionRestoreOptions {
  const hideInheritedHistory = shouldHideInheritedHistory(params);
  if (!isBulkLoadReplayRequest(params)) {
    return { replay: { kind: 'all', hideInheritedHistory } };
  }
  const limit = getLoadReplayPageSize(params);
  return limit === undefined
    ? { replay: { kind: 'all', hideInheritedHistory } }
    : { replay: { kind: 'recent', limit, hideInheritedHistory } };
}

const RESUME_RESTORE_OPTIONS: SelectiveSessionRestoreOptions = {
  replay: { kind: 'none' },
};

async function resolvePersistedSessionIdForRestore(
  sessionService: SessionService,
  sessionId: string,
): Promise<string | undefined> {
  try {
    return await sessionService.findSessionIdIgnoringCase(sessionId);
  } catch (error) {
    if (
      error instanceof SessionIdCaseConflictError &&
      error.reason === 'case_conflict' &&
      error.candidateSessionId === sessionId
    ) {
      return sessionId;
    }
    if (error instanceof SessionIdCaseConflictError) {
      throw RequestError.internalError(
        { errorKind: 'session_conflict', sessionId },
        error.message,
      );
    }
    throw error;
  }
}

function mapSessionRestoreRequestError(
  error: unknown,
  sessionId: string,
): unknown {
  const mappedWriterError = mapSessionWriterRequestError(error);
  if (mappedWriterError !== error) return mappedWriterError;
  if (error instanceof SessionTranscriptSnapshotUnavailableError) {
    return new RequestError(-32010, error.message, {
      errorKind: 'transcript_snapshot_unavailable',
      sessionId,
    });
  }
  if (error instanceof SessionTranscriptTooLargeError) {
    return new RequestError(-32011, error.message, {
      errorKind: 'transcript_too_large',
      sessionId,
      snapshotSize: error.snapshotSize,
      maxBytes: error.maxBytes,
    });
  }
  if (error instanceof SessionTranscriptPageTooLargeError) {
    addDaemonRequestAttribute(
      'qwen-code.daemon.session_restore.envelope_limit_reason',
      'bytes',
    );
    return new RequestError(-32012, error.message, {
      errorKind: 'transcript_page_too_large',
      sessionId,
      pageBytes: error.pageBytes,
      maxBytes: error.maxBytes,
    });
  }
  if (error instanceof HistoryReplayLimitError) {
    addDaemonRequestAttribute(
      'qwen-code.daemon.session_restore.envelope_limit_reason',
      error.reason,
    );
    return new RequestError(-32012, error.message, {
      errorKind: 'transcript_page_too_large',
      sessionId,
      reason: error.reason,
      observed: error.observed,
      limit: error.limit,
    });
  }
  return error;
}

function validateLoadReplayEnvelope(
  sessionId: string,
  envelope: BridgeLoadReplayEnvelope,
  enforceLimits: boolean,
): void {
  if (!enforceLimits) return;
  if (envelope.updates.length > LOAD_REPLAY_MAX_UPDATES) {
    throw new HistoryReplayLimitError(
      sessionId,
      'updates',
      envelope.updates.length,
      LOAD_REPLAY_MAX_UPDATES,
    );
  }
  const pageBytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
  if (pageBytes > LOAD_REPLAY_MAX_BYTES) {
    throw new HistoryReplayLimitError(
      sessionId,
      'bytes',
      pageBytes,
      LOAD_REPLAY_MAX_BYTES,
    );
  }
}

function replayGoalBootstrap(
  projection:
    | SessionRestoreProjection
    | SessionLiveRestoreProjection
    | undefined,
): ReturnType<typeof HistoryReplayer.v2GoalBootstrap> {
  if (projection && !('runtime' in projection)) {
    const sourceUuid = projection.goalRecoverySourceUuid;
    if (!sourceUuid) return undefined;
    if (
      projection.replay?.records.some((record) => record.uuid === sourceUuid)
    ) {
      return undefined;
    }
    const replay = projection.replay?.replay;
    if (isObjectRecord(replay)) {
      const bootstrap = HistoryReplayer.v2GoalBootstrap(
        replay['goalState'],
        replay['goalCause'],
      );
      if (bootstrap) return bootstrap;
    }
    const sourceRecord = projection.goalRecords?.find(
      (record) => record.uuid === sourceUuid,
    );
    if (sourceRecord?.subtype === 'goal_state') {
      const payload = isObjectRecord(sourceRecord.systemPayload)
        ? sourceRecord.systemPayload
        : undefined;
      return HistoryReplayer.v2GoalBootstrap(
        payload?.['snapshot'],
        payload?.['cause'],
      );
    }
    const active = findGoalToRestore(
      collectGoalStatusItemsFromRecords(projection.goalRecords ?? []),
    );
    return active
      ? {
          goalStatus: {
            kind: active.iterations > 0 ? 'checking' : 'set',
            condition: active.condition,
            iterations: active.iterations,
            ...(active.setAt !== undefined ? { setAt: active.setAt } : {}),
          },
        }
      : undefined;
  }
  const sourceUuid = projection?.replay?.goalRecoverySourceUuid;
  if (!projection?.replay || !sourceUuid) return undefined;
  if (projection.replay.records.some((record) => record.uuid === sourceUuid)) {
    return undefined;
  }
  const goalBootstrapRecords = projection.replay.goalBootstrapRecords ?? [];
  const sourceRecord = goalBootstrapRecords.find(
    (record) => record.uuid === sourceUuid,
  );
  if (sourceRecord?.subtype === 'goal_state') {
    const payload = isObjectRecord(sourceRecord.systemPayload)
      ? sourceRecord.systemPayload
      : undefined;
    return HistoryReplayer.v2GoalBootstrap(
      payload?.['snapshot'],
      payload?.['cause'],
    );
  }
  const active = findGoalToRestore(
    collectGoalStatusItemsFromRecords(goalBootstrapRecords),
  );
  if (!active) return undefined;
  return {
    goalStatus: {
      kind: active.iterations > 0 ? 'checking' : 'set',
      condition: active.condition,
      iterations: active.iterations,
      ...(active.setAt !== undefined ? { setAt: active.setAt } : {}),
    },
  };
}

function replayInitialGoalState(
  projection: SessionRestoreProjection | undefined,
): {
  initialGoalState?: NonNullable<
    Parameters<HistoryReplayer['replay']>[2]
  >['initialGoalState'];
  initialGoalCause?: NonNullable<
    Parameters<HistoryReplayer['replay']>[2]
  >['initialGoalCause'];
} {
  const replay = projection?.replay?.replay;
  if (!isObjectRecord(replay)) return {};
  const initialGoalState = parseGoalSnapshotV2(replay['goalState']);
  const initialGoalCause = parseGoalStateCause(replay['goalCause']);
  return {
    ...(initialGoalState ? { initialGoalState } : {}),
    ...(initialGoalCause ? { initialGoalCause } : {}),
  };
}

export function selectVisibleHistoryRecords(
  records: ChatRecord[],
  hideInheritedHistory: boolean,
): ChatRecord[] {
  const sourceBoundary = records.findIndex(
    (record) =>
      record.type === 'system' &&
      record.subtype === 'session_source' &&
      isObjectRecord(record.systemPayload) &&
      record.systemPayload['sourceType'] === 'side_task',
  );
  // A persisted side-task source boundary is authoritative for every replay;
  // callers cannot opt inherited parent history back into that child session.
  if (sourceBoundary >= 0) {
    return records
      .slice(sourceBoundary)
      .filter((record) => record.forkedFrom === undefined);
  }
  return hideInheritedHistory
    ? records.filter((record) => record.forkedFrom === undefined)
    : records;
}

interface SessionSource {
  sourceType: string;
  sourceId?: string;
  daemonOwnedStandaloneCreation?: true;
}

function getSessionSource(params: {
  _meta?: unknown;
}): SessionSource | undefined {
  const meta = isObjectRecord(params._meta) ? params._meta : undefined;
  const value = meta?.[SESSION_SOURCE_META_KEY];
  if (!isObjectRecord(value) || typeof value['sourceType'] !== 'string') {
    return undefined;
  }
  return {
    sourceType: value['sourceType'],
    ...(typeof value['sourceId'] === 'string'
      ? { sourceId: value['sourceId'] }
      : {}),
    ...(value[DAEMON_OWNED_STANDALONE_CREATION_KEY] === true
      ? { daemonOwnedStandaloneCreation: true }
      : {}),
  };
}

function shouldDeferMcpDiscovery(params: { _meta?: unknown }): boolean {
  const meta = isObjectRecord(params._meta) ? params._meta : undefined;
  return meta?.[WORKTREE_MCP_DEFER_META_KEY] === true;
}

function getLoadReplayPageSize(params: LoadSessionRequest): number | undefined {
  const meta = isObjectRecord(params._meta) ? params._meta : undefined;
  const value = meta?.[LOAD_REPLAY_PAGE_SIZE_META_KEY];
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > SESSION_TRANSCRIPT_MAX_LIMIT
  ) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid load replay page size; expected 1..${SESSION_TRANSCRIPT_MAX_LIMIT}`,
    );
  }
  return value as number;
}

function normalizeRequestedBranchName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}
function createHiddenWorkspaceMemoryConfig(config: Config): Config {
  return new Proxy(config, {
    get(target, prop) {
      if (prop === 'getChatRecordingService') {
        return () => undefined;
      }
      if (prop === 'getTranscriptPath') {
        return () => '';
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function collapseForkDirective(directive: string, maxLength: number): string {
  const oneLine = directive.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLength
    ? `${oneLine.slice(0, maxLength - 3)}…`
    : oneLine;
}

function deriveForkDescription(directive: string): string {
  return collapseForkDirective(directive, 60);
}

function truncateForkDirectiveForHistory(directive: string): string {
  return collapseForkDirective(directive, 200);
}

function hasFailedDisplayStatus(
  display: unknown,
): display is { status: 'failed' } {
  return (
    display !== null &&
    typeof display === 'object' &&
    'status' in display &&
    (display as { status?: unknown }).status === 'failed'
  );
}
/**
 * Env-var candidates per auth method, used by `buildAuthPreflightCell` for
 * a side-effect-free presence check. Mirrors `AUTH_ENV_MAPPINGS` from
 * `core/src/models/constants.ts` (which isn't on the public package
 * surface). Keep in sync if a new provider is added there. Any auth method
 * not listed here surfaces as `status: 'unknown'` on the cell rather than
 * a false `auth_env_error` — full validation happens at session start.
 *
 * Drift detection: `AUTH_PREFLIGHT_AUDITED_AUTH_TYPES` below lists every
 * `AuthType` enum value that has been triaged for this map (either keyed
 * here, or explicitly waived for non-env-based auth like qwen-oauth). The
 * paired test `AUTH_PREFLIGHT_AUDITED_AUTH_TYPES covers every AuthType`
 * walks the public enum and fails CI when core adds a new auth method
 * without a deliberate decision here.
 */
export const AUTH_PREFLIGHT_ENV_KEYS: Readonly<
  Record<string, readonly string[]>
> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY'],
  'vertex-ai': ['GOOGLE_API_KEY'],
};

/**
 * Auth methods deliberately not env-keyed (e.g. OAuth-based, credential
 * file). Listed here so the drift test recognizes them as triaged-but-
 * waived rather than a missing entry.
 */
export const AUTH_PREFLIGHT_WAIVED_AUTH_TYPES: ReadonlySet<string> = new Set([
  'qwen-oauth',
]);

type QwenMemorySettings = {
  enableManagedAutoMemory: boolean;
  enableManagedAutoDream: boolean;
  enableAutoSkill: boolean;
  autoSkillConfirm: boolean;
  enableTeamMemory: boolean;
  enableTeamMemorySync: boolean;
};

type QwenMemoryPaths = {
  userMemoryFile: string;
  projectMemoryFile: string;
  autoMemoryDir: string;
};

type QwenSettingsScope = 'user' | 'workspace';
type QwenSettingValue = string | number | boolean | string[] | undefined;
type QwenMcpTransport = 'stdio' | 'http' | 'sse';
type QwenHookEvent = HookEventName;

type QwenCoreSettingKey =
  | 'model.name'
  | 'fastModel'
  | 'general.outputLanguage'
  | 'general.language'
  | 'tools.approvalMode'
  | 'general.vimMode'
  | 'general.enableAutoUpdate'
  | 'general.showSessionRecap'
  | 'general.sessionRecapAwayThresholdMinutes'
  | 'general.terminalBell'
  | 'general.notificationMode'
  | 'general.gitCoAuthor.commit'
  | 'general.gitCoAuthor.pr'
  | 'general.defaultFileEncoding'
  | 'context.fileFiltering.respectGitIgnore'
  | 'context.fileFiltering.respectQwenIgnore'
  | 'context.fileFiltering.enableFuzzySearch'
  | 'memory.enableManagedAutoMemory'
  | 'memory.enableManagedAutoDream'
  | 'memory.enableAutoSkill'
  | 'memory.autoSkillConfirm'
  | 'memory.enableTeamMemory'
  | 'memory.enableTeamMemorySync'
  | 'disableAllHooks';

type QwenMcpServerConfig = {
  transport: QwenMcpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  httpUrl?: string;
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
  versionNegotiation?: 'auto' | 'legacy';
  trust?: boolean;
  description?: string;
  includeTools?: string[];
  excludeTools?: string[];
  extensionName?: string;
};

type QwenHookConfig = {
  type: 'command' | 'http';
  command?: string;
  url?: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  name?: string;
  description?: string;
  timeout?: number;
  env?: Record<string, string>;
  async?: boolean;
  once?: boolean;
  statusMessage?: string;
  shell?: 'bash' | 'powershell';
};

type QwenHookDefinition = {
  matcher?: string;
  sequential?: boolean;
  hooks: QwenHookConfig[];
};

const QWEN_CORE_SETTING_DEFINITIONS = {
  'model.name': { type: 'string' },
  fastModel: { type: 'string' },
  'general.outputLanguage': { type: 'string' },
  'general.language': { type: 'string' },
  'tools.approvalMode': {
    type: 'enum',
    values: APPROVAL_MODES,
  },
  'general.vimMode': { type: 'boolean' },
  'general.enableAutoUpdate': { type: 'boolean' },
  'general.showSessionRecap': { type: 'boolean' },
  'general.sessionRecapAwayThresholdMinutes': { type: 'number', min: 1 },
  'general.terminalBell': { type: 'boolean' },
  'general.notificationMode': {
    type: 'enum',
    values: ['all', 'task-complete'],
  },
  'general.gitCoAuthor.commit': { type: 'boolean' },
  'general.gitCoAuthor.pr': { type: 'boolean' },
  'general.defaultFileEncoding': {
    type: 'enum',
    values: ['utf-8', 'utf-8-bom'],
  },
  'context.fileFiltering.respectGitIgnore': { type: 'boolean' },
  'context.fileFiltering.respectQwenIgnore': { type: 'boolean' },
  'context.fileFiltering.enableFuzzySearch': { type: 'boolean' },
  'memory.enableManagedAutoMemory': { type: 'boolean' },
  'memory.enableManagedAutoDream': { type: 'boolean' },
  'memory.enableAutoSkill': { type: 'boolean' },
  'memory.autoSkillConfirm': { type: 'boolean' },
  'memory.enableTeamMemory': { type: 'boolean' },
  'memory.enableTeamMemorySync': { type: 'boolean' },
  disableAllHooks: { type: 'boolean' },
} as const satisfies Record<
  QwenCoreSettingKey,
  {
    type: 'string' | 'number' | 'boolean' | 'enum';
    min?: number;
    values?: readonly string[];
  }
>;

const QWEN_CORE_SETTING_KEYS = Object.keys(
  QWEN_CORE_SETTING_DEFINITIONS,
) as QwenCoreSettingKey[];

const QWEN_HOOK_EVENTS = Object.values(HookEventName) as QwenHookEvent[];

const DEFAULT_QWEN_MEMORY_SETTINGS: QwenMemorySettings = {
  enableManagedAutoMemory: true,
  enableManagedAutoDream: true,
  enableAutoSkill: false,
  autoSkillConfirm: true,
  enableTeamMemory: false,
  enableTeamMemorySync: false,
};

const QWEN_MEMORY_SETTING_KEYS = [
  'enableManagedAutoMemory',
  'enableManagedAutoDream',
  'enableAutoSkill',
  'autoSkillConfirm',
  'enableTeamMemory',
  'enableTeamMemorySync',
] as const satisfies ReadonlyArray<keyof QwenMemorySettings>;

function normalizeQwenMemorySettings(value: unknown): QwenMemorySettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_QWEN_MEMORY_SETTINGS };
  }

  const record = value as Record<string, unknown>;
  return {
    enableManagedAutoMemory:
      typeof record['enableManagedAutoMemory'] === 'boolean'
        ? record['enableManagedAutoMemory']
        : DEFAULT_QWEN_MEMORY_SETTINGS.enableManagedAutoMemory,
    enableManagedAutoDream:
      typeof record['enableManagedAutoDream'] === 'boolean'
        ? record['enableManagedAutoDream']
        : DEFAULT_QWEN_MEMORY_SETTINGS.enableManagedAutoDream,
    enableAutoSkill:
      typeof record['enableAutoSkill'] === 'boolean'
        ? record['enableAutoSkill']
        : DEFAULT_QWEN_MEMORY_SETTINGS.enableAutoSkill,
    autoSkillConfirm:
      typeof record['autoSkillConfirm'] === 'boolean'
        ? record['autoSkillConfirm']
        : DEFAULT_QWEN_MEMORY_SETTINGS.autoSkillConfirm,
    enableTeamMemory:
      typeof record['enableTeamMemory'] === 'boolean'
        ? record['enableTeamMemory']
        : DEFAULT_QWEN_MEMORY_SETTINGS.enableTeamMemory,
    enableTeamMemorySync:
      typeof record['enableTeamMemorySync'] === 'boolean'
        ? record['enableTeamMemorySync']
        : DEFAULT_QWEN_MEMORY_SETTINGS.enableTeamMemorySync,
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readOptionalString(
  value: unknown,
  fieldName: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw RequestError.invalidParams(
      undefined,
      `Invalid ${fieldName}: expected string`,
    );
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRequiredString(value: unknown, fieldName: string): string {
  const stringValue = readOptionalString(value, fieldName);
  if (!stringValue) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid or missing ${fieldName}`,
    );
  }
  return stringValue;
}

function readStringArray(value: unknown, fieldName: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid ${fieldName}: expected string[]`,
    );
  }
  return Array.from(
    new Set(
      value
        .map((item) => {
          if (typeof item !== 'string') {
            throw RequestError.invalidParams(
              undefined,
              `Invalid ${fieldName}: expected string[]`,
            );
          }
          return item.trim();
        })
        .filter(Boolean),
    ),
  );
}

function readPositiveNumber(
  value: unknown,
  fieldName: string,
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid ${fieldName}: expected positive number`,
    );
  }
  return value;
}

function readProviderAdvancedConfig(
  value: unknown,
): ProviderSetupInputs['advancedConfig'] | undefined {
  if (value === undefined || value === null) return undefined;
  const record = toRecord(value);
  if (
    record['enableThinking'] !== undefined &&
    typeof record['enableThinking'] !== 'boolean'
  ) {
    throw RequestError.invalidParams(
      undefined,
      'Invalid advancedConfig.enableThinking: expected boolean',
    );
  }
  const multimodalRecord = toRecord(record['multimodal']);
  const multimodal: NonNullable<
    ProviderSetupInputs['advancedConfig']
  >['multimodal'] = {};
  for (const key of ['image', 'video', 'audio', 'pdf'] as const) {
    const flag = multimodalRecord[key];
    if (flag !== undefined) {
      if (typeof flag !== 'boolean') {
        throw RequestError.invalidParams(
          undefined,
          `Invalid advancedConfig.multimodal.${key}: expected boolean`,
        );
      }
      multimodal[key] = flag;
    }
  }
  const contextWindowSize = readPositiveNumber(
    record['contextWindowSize'],
    'advancedConfig.contextWindowSize',
  );
  const maxTokens = readPositiveNumber(
    record['maxTokens'],
    'advancedConfig.maxTokens',
  );

  const advancedConfig: NonNullable<ProviderSetupInputs['advancedConfig']> = {
    ...(typeof record['enableThinking'] === 'boolean'
      ? { enableThinking: record['enableThinking'] }
      : {}),
    ...(Object.keys(multimodal).length > 0 ? { multimodal } : {}),
    ...(contextWindowSize ? { contextWindowSize } : {}),
    ...(maxTokens ? { maxTokens } : {}),
  };

  return Object.keys(advancedConfig).length > 0 ? advancedConfig : undefined;
}

function resolveProviderDocumentationUrl(
  config: ProviderConfig,
  baseUrl: string,
): string | undefined {
  if (typeof config.documentationUrl === 'string') {
    return config.documentationUrl;
  }
  if (typeof config.documentationUrl === 'function') {
    try {
      return config.documentationUrl(baseUrl);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function readSettingsEnv(
  settings: LoadedSettings,
  envKey: string | undefined,
): string | undefined {
  if (!envKey) return undefined;
  const env = toRecord((settings.merged as Record<string, unknown>)['env']);
  const value = env[envKey];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function resolveProviderEnvKey(
  config: ProviderConfig,
  protocol: ProviderConfig['protocol'],
  baseUrl: string,
): string | undefined {
  try {
    return typeof config.envKey === 'function'
      ? config.envKey(protocol, baseUrl)
      : config.envKey;
  } catch {
    return undefined;
  }
}

function readExistingAdvancedConfig(
  model: ProviderModelConfig | undefined,
): Record<string, unknown> | undefined {
  const generationConfig = toRecord(model?.generationConfig);
  const extraBody = toRecord(generationConfig['extra_body']);
  const advancedConfig: Record<string, unknown> = {};
  if (typeof extraBody['enable_thinking'] === 'boolean') {
    advancedConfig['enableThinking'] = extraBody['enable_thinking'];
  }
  if (typeof generationConfig['contextWindowSize'] === 'number') {
    advancedConfig['contextWindowSize'] = generationConfig['contextWindowSize'];
  }
  return Object.keys(advancedConfig).length > 0 ? advancedConfig : undefined;
}

function readExistingProviderConfig(
  config: ProviderConfig,
  settings: LoadedSettings,
): Record<string, unknown> | undefined {
  const existing = findExistingProviderModels(
    config,
    (settings.merged as Record<string, unknown>)['modelProviders'] as
      | Record<string, unknown>
      | undefined,
  );
  const firstModel = existing?.models[0];
  const protocol = existing?.protocol ?? config.protocol;
  const baseUrl =
    typeof firstModel?.baseUrl === 'string'
      ? firstModel.baseUrl
      : resolveBaseUrl(config);
  const envKey =
    typeof firstModel?.envKey === 'string'
      ? firstModel.envKey
      : resolveProviderEnvKey(config, protocol, baseUrl);
  const apiKey = readSettingsEnv(settings, envKey);
  const hasExistingConfig = !!apiKey || !!existing;

  if (!hasExistingConfig) return undefined;

  const advancedConfig = readExistingAdvancedConfig(firstModel);

  return {
    protocol,
    baseUrl: sanitizeProviderBaseUrl(baseUrl),
    // Never serialize the raw secret over the ACP wire. Expose only whether a
    // key is stored; the client can omit `apiKey` on connect to keep it.
    ...(apiKey ? { hasApiKey: true } : {}),
    ...(existing ? { modelIds: existing.models.map((model) => model.id) } : {}),
    ...(advancedConfig ? { advancedConfig } : {}),
  };
}

// Resolves the raw, stored API key for a provider for server-side use only
// (never serialized to the client). Used so `qwen/providers/connect` can keep
// the existing key when the client updates other fields without resubmitting it.
function resolveExistingProviderApiKey(
  config: ProviderConfig,
  settings: LoadedSettings,
  protocol: ProviderConfig['protocol'],
  baseUrl: string,
): string | undefined {
  const envKey = resolveProviderEnvKey(config, protocol, baseUrl);
  return readSettingsEnv(settings, envKey);
}

function serializeProviderConfig(
  config: ProviderConfig,
  settings: LoadedSettings,
): Record<string, unknown> {
  const defaultProtocol = config.protocolOptions?.[0] ?? config.protocol;
  const defaultBaseUrl =
    config.baseUrl === undefined
      ? getDefaultBaseUrlForProtocol(defaultProtocol)
      : resolveBaseUrl(config);
  const existingConfig = readExistingProviderConfig(config, settings);

  return {
    id: config.id,
    label: config.label,
    description: config.description,
    protocol: config.protocol,
    protocolOptions: config.protocolOptions ?? [],
    baseUrl: config.baseUrl,
    baseUrlPlaceholder:
      config.baseUrl === undefined ? defaultBaseUrl : undefined,
    defaultModelIds: getDefaultModelIds(config),
    models: config.models ?? [],
    modelsEditable: config.modelsEditable === true || !config.models,
    showAdvancedConfig: config.showAdvancedConfig === true,
    apiKeyPlaceholder: config.apiKeyPlaceholder,
    documentationUrl: resolveProviderDocumentationUrl(config, defaultBaseUrl),
    uiGroup: config.uiGroup ?? 'third-party',
    uiLabels: config.uiLabels,
    ...(existingConfig ? { existingConfig } : {}),
  };
}

function readProviderSetupInputs(
  config: ProviderConfig,
  params: Record<string, unknown>,
  resolveExistingApiKey?: (
    protocol: ProviderConfig['protocol'],
    baseUrl: string,
  ) => string | undefined,
): ProviderSetupInputs {
  const protocol = readOptionalString(params['protocol'], 'protocol') as
    | AuthType
    | undefined;
  if (
    protocol &&
    protocol !== config.protocol &&
    !config.protocolOptions?.includes(protocol)
  ) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid protocol for provider "${config.id}"`,
    );
  }

  let baseUrl = resolveBaseUrl(
    config,
    readOptionalString(params['baseUrl'], 'baseUrl'),
  ).trim();
  if (!baseUrl && config.baseUrl === undefined) {
    baseUrl = getDefaultBaseUrlForProtocol(protocol ?? config.protocol);
  }
  if (!baseUrl) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid or missing baseUrl for provider "${config.id}"`,
    );
  }

  // `apiKey` is optional on update: when the client omits it (e.g. it only
  // received `hasApiKey` from the list response), fall back to the stored key.
  const apiKey =
    readOptionalString(params['apiKey'], 'apiKey') ??
    resolveExistingApiKey?.(protocol ?? config.protocol, baseUrl);
  if (!apiKey) {
    throw RequestError.invalidParams(undefined, 'Invalid or missing apiKey');
  }
  const apiKeyError = config.validateApiKey?.(apiKey, baseUrl);
  if (apiKeyError) {
    throw RequestError.invalidParams(undefined, apiKeyError);
  }

  const defaultModelIds = getDefaultModelIds(config);
  const modelIds = readStringArray(params['modelIds'], 'modelIds');
  const resolvedModelIds = modelIds.length > 0 ? modelIds : defaultModelIds;
  if (resolvedModelIds.length === 0) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid or missing modelIds for provider "${config.id}"`,
    );
  }

  const advancedConfig = readProviderAdvancedConfig(params['advancedConfig']);

  return {
    ...(protocol ? { protocol } : {}),
    baseUrl,
    apiKey,
    modelIds: resolvedModelIds,
    ...(advancedConfig ? { advancedConfig } : {}),
  };
}

function readProviderConnectScope(value: unknown): SettingScope | undefined {
  if (value === undefined) return undefined;
  if (value === 'user') return SettingScope.User;
  if (value === 'workspace') return SettingScope.Workspace;
  throw RequestError.invalidParams(
    undefined,
    'Invalid scope for provider connect',
  );
}

function getNestedSettingValue(
  source: Record<string, unknown>,
  key: QwenCoreSettingKey,
): QwenSettingValue {
  let current: unknown = source;
  for (const segment of key.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (
    typeof current === 'string' ||
    typeof current === 'number' ||
    typeof current === 'boolean' ||
    Array.isArray(current)
  ) {
    return current as QwenSettingValue;
  }
  return undefined;
}

function readCoreSettingValues(
  source: Record<string, unknown>,
): Partial<Record<QwenCoreSettingKey, QwenSettingValue>> {
  const values: Partial<Record<QwenCoreSettingKey, QwenSettingValue>> = {};
  for (const key of QWEN_CORE_SETTING_KEYS) {
    const value = getNestedSettingValue(source, key);
    if (value !== undefined) {
      values[key] = value;
    }
  }
  return values;
}

/**
 * Folds a raw `tools.approvalMode` settings value into the mode
 * unrestricted live sessions must converge on. Parseable values are
 * normalized exactly the way boot accepts them (parseApprovalModeValue
 * trims, lowercases, and maps the legacy `auto_edit`/`autoedit` aliases), so
 * reload convergence agrees with the settings file for every boot-accepted
 * spelling. A MISSING key folds to AUTO — the same default loadCliConfig
 * derives when the key is absent — so a key deletion reaches live sessions
 * on reload instead of pinning a stale privileged mode until daemon restart.
 * A PRESENT but unparseable value returns undefined: boot rejects that file
 * outright (loadCliConfig has no catch around parseApprovalModeValue), so
 * folding it to AUTO would silently escalate the approval gate for every
 * live session; the reload loop keeps sessions on their current modes until
 * the file is corrected. Restricted (safe/bare) sessions ignore the file at
 * boot entirely; the reload loop converges them on DEFAULT separately.
 */
function foldReloadApprovalMode(raw: unknown): ApprovalMode | undefined {
  if (raw === undefined) {
    return ApprovalMode.AUTO;
  }
  if (typeof raw === 'string') {
    try {
      return parseApprovalModeValue(raw);
    } catch {
      // Present but unparseable: boot would reject the file (see above).
    }
  }
  return undefined;
}

/**
 * True when a session's config derives from a restricted mode: safe/bare
 * sessions ignore `tools.approvalMode` at boot (loadCliConfig pins them to
 * DEFAULT), so reload must never converge them on a file-derived mode.
 */
function isRestrictedApprovalModeConfig(config: Config): boolean {
  return config.isSafeMode?.() === true || config.getBareMode?.() === true;
}

export function normalizeCoreSettingValue(
  key: QwenCoreSettingKey,
  value: unknown,
): QwenSettingValue {
  const definition = QWEN_CORE_SETTING_DEFINITIONS[key];
  switch (definition.type) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw RequestError.invalidParams(undefined, `${key} must be a boolean`);
      }
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw RequestError.invalidParams(undefined, `${key} must be a number`);
      }
      if (definition.min !== undefined && value < definition.min) {
        throw RequestError.invalidParams(
          undefined,
          `${key} must be at least ${definition.min}`,
        );
      }
      return value;
    case 'enum': {
      const values = definition.values as readonly string[] | undefined;
      if (typeof value !== 'string' || !values?.includes(value)) {
        throw RequestError.invalidParams(
          undefined,
          `${key} must be one of ${values?.join(', ')}`,
        );
      }
      return value;
    }
    case 'string': {
      if (value === undefined) return undefined;
      if (typeof value !== 'string') {
        throw RequestError.invalidParams(undefined, `${key} must be a string`);
      }
      // Strip control characters (incl. newlines) from string settings. Some
      // are embedded verbatim into instruction files / prompts — e.g.
      // general.outputLanguage is written into output-language.md, loaded as a
      // system instruction — where an embedded newline could forge a new
      // instruction line (persistent prompt injection).
      // eslint-disable-next-line no-control-regex
      const controlChars = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
      const sanitized = value.replace(controlChars, ' ').trim();
      // An input that is entirely control/whitespace chars (e.g. '\n') trims to
      // ''. For settings like model.name an empty string has different
      // semantics from undefined (a literal empty value vs. falling back to the
      // default), so collapse the empty result to undefined.
      return sanitized || undefined;
    }
    default:
      throw RequestError.invalidParams(
        undefined,
        `${key} has an unsupported setting type`,
      );
  }
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw RequestError.invalidParams(undefined, 'Expected an array of strings');
  }
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
}

function normalizeStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = toRecord(value);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string' && key.trim()) {
      result[key.trim()] = item;
    }
  }
  return result;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  let numberValue: number;
  if (typeof value === 'number') {
    numberValue = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    numberValue = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  } else {
    numberValue = Number.NaN;
  }
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw RequestError.invalidParams(undefined, 'Expected a positive integer');
  }
  return numberValue;
}

function normalizeMcpServerConfig(value: unknown): QwenMcpServerConfig {
  const input = toRecord(value);
  const transport = input['transport'];
  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') {
    throw RequestError.invalidParams(
      undefined,
      'MCP transport must be stdio, http, or sse',
    );
  }

  const server: QwenMcpServerConfig = { transport };
  const description = input['description'];
  if (typeof description === 'string' && description.trim()) {
    server.description = description.trim();
  }
  const cwd = input['cwd'];
  if (typeof cwd === 'string' && cwd.trim()) server.cwd = cwd.trim();
  const timeout = normalizeOptionalNumber(input['timeout']);
  if (timeout !== undefined) server.timeout = timeout;
  const versionNegotiation = toMcpVersionNegotiation(
    input['versionNegotiation'],
  );
  if (
    input['versionNegotiation'] !== undefined &&
    versionNegotiation === undefined
  ) {
    throw RequestError.invalidParams(
      undefined,
      'MCP versionNegotiation must be auto or legacy',
    );
  }
  server.versionNegotiation = versionNegotiation;
  if (typeof input['trust'] === 'boolean') server.trust = input['trust'];
  server.includeTools = normalizeStringArray(input['includeTools']);
  server.excludeTools = normalizeStringArray(input['excludeTools']);

  if (transport === 'stdio') {
    const command = input['command'];
    if (typeof command !== 'string' || !command.trim()) {
      throw RequestError.invalidParams(
        undefined,
        'Stdio MCP servers require a command',
      );
    }
    server.command = command.trim();
    server.args = normalizeStringArray(input['args']);
    server.env = normalizeStringRecord(input['env']);
    return server;
  }

  const urlKey = transport === 'http' ? 'httpUrl' : 'url';
  const url = input[urlKey];
  if (typeof url !== 'string' || !url.trim()) {
    throw RequestError.invalidParams(
      undefined,
      `${transport.toUpperCase()} MCP servers require a URL`,
    );
  }
  if (transport === 'http') server.httpUrl = url.trim();
  else server.url = url.trim();
  server.headers = normalizeStringRecord(input['headers']);
  return server;
}

function toStoredMcpServerConfig(
  server: QwenMcpServerConfig,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of [
    'timeout',
    'versionNegotiation',
    'trust',
    'description',
    'includeTools',
    'excludeTools',
  ] as const) {
    if (server[key] !== undefined) result[key] = server[key];
  }
  if (server.transport === 'stdio') {
    result['command'] = server.command;
    if (server.args !== undefined) result['args'] = server.args;
    if (server.cwd !== undefined) result['cwd'] = server.cwd;
    if (server.env !== undefined) result['env'] = server.env;
  } else if (server.transport === 'http') {
    result['httpUrl'] = server.httpUrl;
    if (server.headers !== undefined) result['headers'] = server.headers;
  } else {
    result['url'] = server.url;
    if (server.headers !== undefined) result['headers'] = server.headers;
  }
  return result;
}

function toMcpServerConfig(value: unknown): QwenMcpServerConfig | undefined {
  const server = toRecord(value);
  if (typeof server['httpUrl'] === 'string') {
    return {
      transport: 'http',
      httpUrl: server['httpUrl'],
      headers: normalizeStringRecord(server['headers']),
      timeout: normalizeOptionalNumber(server['timeout']),
      versionNegotiation: toMcpVersionNegotiation(server['versionNegotiation']),
      trust: typeof server['trust'] === 'boolean' ? server['trust'] : undefined,
      description:
        typeof server['description'] === 'string'
          ? server['description']
          : undefined,
      includeTools: normalizeStringArray(server['includeTools']),
      excludeTools: normalizeStringArray(server['excludeTools']),
      extensionName:
        typeof server['extensionName'] === 'string'
          ? server['extensionName']
          : undefined,
    };
  }
  if (typeof server['url'] === 'string') {
    return {
      transport: 'sse',
      url: server['url'],
      headers: normalizeStringRecord(server['headers']),
      timeout: normalizeOptionalNumber(server['timeout']),
      versionNegotiation: toMcpVersionNegotiation(server['versionNegotiation']),
      trust: typeof server['trust'] === 'boolean' ? server['trust'] : undefined,
      description:
        typeof server['description'] === 'string'
          ? server['description']
          : undefined,
      includeTools: normalizeStringArray(server['includeTools']),
      excludeTools: normalizeStringArray(server['excludeTools']),
      extensionName:
        typeof server['extensionName'] === 'string'
          ? server['extensionName']
          : undefined,
    };
  }
  if (typeof server['command'] === 'string') {
    return {
      transport: 'stdio',
      command: server['command'],
      args: normalizeStringArray(server['args']),
      cwd: typeof server['cwd'] === 'string' ? server['cwd'] : undefined,
      env: normalizeStringRecord(server['env']),
      timeout: normalizeOptionalNumber(server['timeout']),
      versionNegotiation: toMcpVersionNegotiation(server['versionNegotiation']),
      trust: typeof server['trust'] === 'boolean' ? server['trust'] : undefined,
      description:
        typeof server['description'] === 'string'
          ? server['description']
          : undefined,
      includeTools: normalizeStringArray(server['includeTools']),
      excludeTools: normalizeStringArray(server['excludeTools']),
      extensionName:
        typeof server['extensionName'] === 'string'
          ? server['extensionName']
          : undefined,
    };
  }
  return undefined;
}

function toMcpVersionNegotiation(
  value: unknown,
): 'auto' | 'legacy' | undefined {
  return value === 'auto' || value === 'legacy' ? value : undefined;
}

function redactSecretRecord(
  record: Record<string, string> | undefined,
): Record<string, string> | undefined {
  return record
    ? Object.fromEntries(
        Object.keys(record).map((key) => [key, REDACTED_MCP_SECRET]),
      )
    : record;
}

function restoreSecretRecord(
  incoming: Record<string, string> | undefined,
  prior: unknown,
): Record<string, string> | undefined {
  if (!incoming) return incoming;
  const priorRecord = toRecord(prior);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== REDACTED_MCP_SECRET) {
      result[key] = value;
      continue;
    }
    const priorValue = priorRecord[key];
    if (typeof priorValue === 'string') result[key] = priorValue;
  }
  return result;
}

// Hooks carry the same secret classes as MCP servers — command-hook `env`
// (tokens passed to scripts) and http-hook `headers` (auth). Mask them in the
// settings response and restore them on write, mirroring the MCP scheme.
function redactHookSecrets(hook: QwenHookDefinition): QwenHookDefinition {
  return {
    ...hook,
    hooks: hook.hooks.map((config) => ({
      ...config,
      ...(config.env ? { env: redactSecretRecord(config.env) } : {}),
      ...(config.headers
        ? { headers: redactSecretRecord(config.headers) }
        : {}),
    })),
  };
}

function restoreRedactedHookSecrets(
  hook: QwenHookDefinition,
  prior: Record<string, unknown>,
): QwenHookDefinition {
  const priorHooks = Array.isArray(prior['hooks'])
    ? (prior['hooks'] as unknown[])
    : [];
  return {
    ...hook,
    hooks: hook.hooks.map((config, i) => {
      const priorConfig = toRecord(priorHooks[i]);
      return {
        ...config,
        ...(config.env
          ? { env: restoreSecretRecord(config.env, priorConfig['env']) }
          : {}),
        ...(config.headers
          ? {
              headers: restoreSecretRecord(
                config.headers,
                priorConfig['headers'],
              ),
            }
          : {}),
      };
    }),
  };
}

function readMcpServers(
  source: Record<string, unknown>,
  scope: QwenSettingsScope | 'extension',
): Array<{
  name: string;
  scope: QwenSettingsScope | 'extension';
  server: QwenMcpServerConfig;
}> {
  const servers = toRecord(source['mcpServers']);
  return Object.entries(servers)
    .map(([name, value]) => {
      try {
        const server = toMcpServerConfig(value);
        // Never expose stdio env or http/sse auth headers in plaintext in the
        // settings response — they routinely hold API keys / tokens.
        return server
          ? { name, scope, server: redactMcpServerSecrets(server) }
          : undefined;
      } catch (error) {
        debugLogger.warn(
          `Skipping malformed MCP server config [${scope}:${name}]:`,
          error,
        );
        return undefined;
      }
    })
    .filter(
      (
        entry,
      ): entry is {
        name: string;
        scope: QwenSettingsScope | 'extension';
        server: QwenMcpServerConfig;
      } => !!entry,
    );
}

function isHookEvent(value: unknown): value is QwenHookEvent {
  return (
    typeof value === 'string' &&
    QWEN_HOOK_EVENTS.includes(value as QwenHookEvent)
  );
}

function normalizeHookConfig(value: unknown): QwenHookConfig {
  const input = toRecord(value);
  const type = input['type'];
  if (type !== 'command' && type !== 'http') {
    throw RequestError.invalidParams(
      undefined,
      'Hook type must be command or http',
    );
  }
  const config: QwenHookConfig = { type };
  if (type === 'command') {
    const command = input['command'];
    if (typeof command !== 'string' || !command.trim()) {
      throw RequestError.invalidParams(
        undefined,
        'Command hooks require a command',
      );
    }
    config.command = command.trim();
    config.env = normalizeStringRecord(input['env']);
    if (typeof input['async'] === 'boolean') config.async = input['async'];
    const shell = input['shell'];
    if (shell === 'bash' || shell === 'powershell') config.shell = shell;
  } else {
    const url = input['url'];
    if (typeof url !== 'string' || !url.trim()) {
      throw RequestError.invalidParams(undefined, 'HTTP hooks require a URL');
    }
    config.url = url.trim();
    config.headers = normalizeStringRecord(input['headers']);
    config.allowedEnvVars = normalizeStringArray(input['allowedEnvVars']);
    if (typeof input['once'] === 'boolean') config.once = input['once'];
  }
  const timeout = normalizeOptionalNumber(input['timeout']);
  if (timeout !== undefined) config.timeout = timeout;
  for (const key of ['name', 'description', 'statusMessage'] as const) {
    const item = input[key];
    if (typeof item === 'string' && item.trim()) {
      config[key] = item.trim();
    }
  }
  return config;
}

function normalizeHookDefinition(value: unknown): QwenHookDefinition {
  const input = toRecord(value);
  const hooks = input['hooks'];
  if (!Array.isArray(hooks) || hooks.length === 0) {
    throw RequestError.invalidParams(
      undefined,
      'Hook definition requires at least one hook',
    );
  }
  const definition: QwenHookDefinition = {
    hooks: hooks.map(normalizeHookConfig),
  };
  if (typeof input['matcher'] === 'string') {
    definition.matcher = input['matcher'];
  }
  if (typeof input['sequential'] === 'boolean') {
    definition.sequential = input['sequential'];
  }
  return definition;
}

function readHooks(
  source: Record<string, unknown>,
  scope: QwenSettingsScope | 'extension',
  extensionName?: string,
): Array<{
  event: QwenHookEvent;
  scope: QwenSettingsScope | 'extension';
  index: number;
  hook: QwenHookDefinition;
  extensionName?: string;
}> {
  const hooksRoot = toRecord(source['hooks']);
  const entries: Array<{
    event: QwenHookEvent;
    scope: QwenSettingsScope | 'extension';
    index: number;
    hook: QwenHookDefinition;
    extensionName?: string;
  }> = [];
  for (const event of QWEN_HOOK_EVENTS) {
    const eventHooks = hooksRoot[event];
    if (!Array.isArray(eventHooks)) continue;
    eventHooks.forEach((hookValue, index) => {
      try {
        entries.push({
          event,
          scope,
          index,
          hook: redactHookSecrets(normalizeHookDefinition(hookValue)),
          extensionName,
        });
      } catch (error) {
        debugLogger.warn(
          `Skipping malformed hook entry [${scope}:${event}:${index}]:`,
          error,
        );
      }
    });
  }
  return entries;
}

function toSettingsScope(scope: unknown): SettingScope {
  if (scope === 'workspace') return SettingScope.Workspace;
  if (scope === 'user') return SettingScope.User;
  throw RequestError.invalidParams(
    undefined,
    'scope must be user or workspace',
  );
}

function readScopeSettings(
  settings: LoadedSettings,
  scope: QwenSettingsScope,
): Record<string, unknown> {
  return settings.forScope(toSettingsScope(scope)).settings as Record<
    string,
    unknown
  >;
}

async function resolvePreferredMemoryFile(
  dir: string,
  fallbackFilename: string,
): Promise<string> {
  for (const filename of getAllMemoryFilenames()) {
    const filePath = path.join(dir, filename);
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      // Try the next configured file name.
    }
  }

  return path.join(dir, fallbackFilename);
}

async function resolveQwenMemoryPaths(params: {
  cwd: string;
  projectRoot: string;
}): Promise<QwenMemoryPaths> {
  const fallbackFilename = getAllMemoryFilenames()[0] ?? 'QWEN.md';
  const userMemoryFile = await resolvePreferredMemoryFile(
    Storage.getGlobalQwenDir(),
    fallbackFilename,
  );
  const projectMemoryFile = await resolvePreferredMemoryFile(
    params.cwd,
    fallbackFilename,
  );
  const autoMemoryDir = getAutoMemoryRoot(params.projectRoot);

  // Resolve-only: `getMemoryPaths` is a read query, so it must not create
  // files or directories as a side effect (the old code ran ensureMemoryFile
  // + fs.mkdir on every call, including against a client-controlled
  // projectRoot). Callers that write memory are responsible for ensuring the
  // target exists.
  return {
    userMemoryFile,
    projectMemoryFile,
    autoMemoryDir,
  };
}

/**
 * Reverse tool channel (issue #5626, Phase 2). Deliver one JSON-RPC MCP frame
 * for a client-hosted (extension) MCP server UP to the parent serve process
 * over the `qwen/control/client_mcp/message` ext-method, returning the
 * client-hosted server's correlated reply. Shared by the bootstrap
 * (workspace-level) sender in `runAcpAgent` and the per-session sender
 * (`buildClientMcpSender`).
 *
 * The parent's `BridgeClient.extMethod` wraps the reply in `{ payload }`
 * (notifications resolve with a synthetic ack in the same envelope). A missing
 * `connection` (frame arrived before the ACP connection was wired) or a missing
 * `payload` (contract break / older parent) surfaces as a transport error so
 * the agent's MCP client fails fast instead of hanging.
 */
// Exported for unit tests (error branches); not part of the public agent API.
export async function deliverClientMcpMessage(
  connection: AgentSideConnection | undefined,
  serverName: string,
  message: JSONRPCMessage,
  sessionId?: string,
): Promise<JSONRPCMessage> {
  if (!connection) {
    throw new Error(
      `client MCP server '${serverName}' has no ACP connection yet`,
    );
  }
  const response = await connection.extMethod(
    SERVE_CONTROL_EXT_METHODS.clientMcpMessage,
    {
      server: serverName,
      payload: message,
      ...(sessionId ? { sessionId } : {}),
    },
  );
  const payload = (response as { payload?: unknown })['payload'];
  if (payload === undefined || payload === null) {
    throw new Error(
      `client_mcp/message returned no payload for server '${serverName}'`,
    );
  }
  return payload as JSONRPCMessage;
}

/**
 * Build the ACP child's side of the managed guard. It carries no provider
 * endpoint or credential; those remain in the daemon. The private parent
 * validates the session and active prompt before calling its provider.
 */
export function createManagedExternalToolGuard(
  connection: AgentSideConnection,
  options: { externalProviderAttached: boolean } = {
    externalProviderAttached: false,
  },
): ToolInvocationGuard {
  return async (context) => {
    // With only the daemon's built-in policy attached there is no external
    // provider to consult: every non-shell tool is structurally allowed,
    // so resolve locally instead of paying a serialized child-daemon-child
    // round trip on every tool call. The shell-executing tools still go to
    // the daemon because they are the only ones the built-in policy inspects.
    if (
      !options.externalProviderAttached &&
      !SHELL_EXECUTING_TOOL_NAMES.has(context.toolName)
    ) {
      return { allowed: true };
    }
    const invocation = context.invocationContext;
    if (!invocation && options.externalProviderAttached) {
      throw new Error(
        'Managed external tool guard requires a runtime invocation context.',
      );
    }
    // Subagent reasoning loops, cron turns, background notifications, and
    // resumed background agents run without an invocation context by design.
    // Under the built-in policy alone the daemon only needs the session
    // identity, so fall back to the scheduler-owned session id and skip the
    // prompt binding instead of denying every shell call those paths make.
    const sessionId = invocation?.sessionId ?? context.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error(
        'Managed external tool guard requires a session identity.',
      );
    }
    if (context.signal.aborted) {
      throw new DOMException('Tool invocation aborted', 'AbortError');
    }
    let rejectOnAbort: ((error: Error) => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = reject;
    });
    const onAbort = () =>
      rejectOnAbort?.(
        new DOMException('Tool invocation aborted', 'AbortError'),
      );
    context.signal.addEventListener('abort', onAbort, { once: true });
    // Close the check-to-listener race: AbortSignal does not replay an abort
    // event to a listener added after the signal has already transitioned.
    if (context.signal.aborted) onAbort();
    try {
      const response = await Promise.race([
        connection.extMethod(
          SERVE_CONTROL_EXT_METHODS.externalToolGuardPrepare,
          {
            sessionId,
            ...(invocation ? { promptId: invocation.promptId } : {}),
            toolCallId: context.callId,
            toolName: context.toolName,
            arguments: context.args,
            // A sub-agent pinned to a worktree executes here, not in the
            // session's own directory; the host validates this before use.
            ...(typeof context.cwd === 'string' && context.cwd.length > 0
              ? { invocationCwd: context.cwd }
              : {}),
          },
        ),
        aborted,
      ]);
      const keys = Object.keys(response);
      if (
        typeof response['allowed'] !== 'boolean' ||
        keys.some((key) => key !== 'allowed' && key !== 'reason')
      ) {
        throw new Error(
          'Managed external tool guard returned an invalid reply.',
        );
      }
      if (response['allowed']) {
        if (Object.hasOwn(response, 'reason')) {
          throw new Error(
            'Managed external tool guard allow reply contains a reason.',
          );
        }
        return { allowed: true };
      }
      const reason = response['reason'];
      if (reason === undefined) return { allowed: false };
      if (!isValidExternalToolGuardDenialReason(reason)) {
        throw new Error(
          'Managed external tool guard denial reason is invalid.',
        );
      }
      return { allowed: false, reason };
    } finally {
      context.signal.removeEventListener('abort', onAbort);
    }
  };
}

interface RuntimeMcpRequest {
  name: string;
  runtimeClientId: string;
}

interface RuntimeMcpAddRequest extends RuntimeMcpRequest {
  config: MCPServerConfig;
}

function readRuntimeMcpRequest(
  params: Record<string, unknown>,
): RuntimeMcpRequest {
  const name = params['name'];
  if (typeof name !== 'string' || name.length === 0) {
    throw RequestError.invalidParams(undefined, 'Invalid or missing name');
  }
  if (!isValidServerName(name)) {
    throw RequestError.invalidParams(
      undefined,
      'Server name must be ≤256 chars, alphanumeric + underscore/hyphen, and not a reserved JS property name',
    );
  }
  const originatorClientId = params['originatorClientId'];
  return {
    name,
    runtimeClientId:
      typeof originatorClientId === 'string' && originatorClientId.length > 0
        ? originatorClientId
        : 'daemon',
  };
}

function readRuntimeMcpAddRequest(
  params: Record<string, unknown>,
): RuntimeMcpAddRequest {
  const request = readRuntimeMcpRequest(params);
  const config = params['config'];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw RequestError.invalidParams(undefined, 'Invalid or missing config');
  }
  // Runtime callers cannot grant trust, inject credentials, change tool
  // filters, or choose a process working directory.
  const {
    trust: _trust,
    authProviderType: _auth,
    includeTools: _inc,
    excludeTools: _exc,
    cwd: _cwd,
    env: _env,
    oauth: _oauth,
    headers: _headers,
    type: _type,
    [CLIENT_MCP_OVER_WS_CONFIG_FLAG]: clientMcpOverWs,
    ...safeConfig
  } = config as ClientMcpOverWsRuntimeConfig;
  if (clientMcpOverWs === true) {
    (safeConfig as Record<string, unknown>)['type'] = 'sdk';
  }
  return {
    ...request,
    config: safeConfig as MCPServerConfig,
  };
}

function getRuntimeMcpManager(config: Config): McpClientManager {
  const manager = config.getToolRegistry()?.getMcpClientManager();
  if (!manager) {
    throw RequestError.internalError(
      undefined,
      'McpClientManager unavailable on this Config',
    );
  }
  return manager;
}

async function addRuntimeMcpServer(
  manager: McpClientManager,
  request: RuntimeMcpAddRequest,
): Promise<Record<string, unknown>> {
  try {
    return (await manager.addRuntimeMcpServer(
      request.name,
      request.config,
      request.runtimeClientId,
    )) as unknown as Record<string, unknown>;
  } catch (err) {
    if (err instanceof McpBudgetWouldExceedError) {
      throw new RequestError(-32099, err.message, {
        errorKind: err.code,
        serverName: err.serverName,
      });
    }
    if (err instanceof McpServerSpawnFailedError) {
      throw new RequestError(-32099, err.message, {
        errorKind: err.code,
        serverName: err.serverName,
        ...err.details,
      });
    }
    if (err instanceof InvalidMcpConfigError) {
      throw new RequestError(-32099, err.message, {
        errorKind: err.code,
        serverName: err.serverName,
        reason: err.reason,
      });
    }
    throw err;
  }
}

export async function runAcpAgent(
  config: Config,
  settings: LoadedSettings,
  argv: CliArgs,
  options?: {
    privateParentCapability?: string;
    externalToolGuardRequired?: boolean;
    externalToolGuardProviderAttached?: boolean;
  },
) {
  // Freeze the restart-required writer protocol before the first await.
  // Per-request settings reloads must not mix leased and legacy writers
  // within one ACP process lifetime.
  const sessionWriterLeaseEnabledAtStartup =
    typeof config.isSessionWriterLeaseEnabled === 'function'
      ? config.isSessionWriterLeaseEnabled()
      : settings.merged.experimental?.sessionWriterLease === true;
  const privateParentCapability =
    options === undefined
      ? process.env[PRIVATE_ACP_CAPABILITY_ENV]
      : options.privateParentCapability;
  delete process.env[PRIVATE_ACP_CAPABILITY_ENV];
  delete process.env[PRIVATE_EXTERNAL_TOOL_GUARD_ENV];
  delete process.env[PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER_ENV];
  delete process.env[EXTERNAL_TOOL_GUARD_TOKEN_ENV];
  const externalToolGuardRequired = options?.externalToolGuardRequired === true;
  const externalToolGuardProviderAttached =
    options?.externalToolGuardProviderAttached === true;
  if (externalToolGuardRequired && privateParentCapability === undefined) {
    throw new Error(
      'Required external tool guard is available only to a private managed ACP parent.',
    );
  }

  // Reverse tool channel (issue #5626, Phase 2). Runtime-MCP-add targets the
  // BOOTSTRAP (workspace-level) config's `McpClientManager` — `this.config` in
  // the `workspaceMcpRuntimeAdd` handler — so a client-hosted MCP server's SDK
  // callback must be bound HERE, not only on per-session configs. The ACP
  // `connection` doesn't exist until `new AgentSideConnection` runs below, so
  // the sender is late-bound: it reads the connection lazily when the agent
  // first drives the client-hosted server. Filled synchronously by the
  // `AgentSideConnection` callback before any MCP frame can flow.
  let acpConnection: AgentSideConnection | undefined;
  const bootstrapClientMcpSender: SendSdkMcpMessage = (serverName, message) =>
    deliverClientMcpMessage(acpConnection, serverName, message);

  beginAcpBootstrapConfigProfiling();
  try {
    await config.initialize({
      skipLlmInitialization: true,
      // Bootstrap skips MCP discovery — each session runs its own
      // pool-routed discovery, so bootstrap-level spawns would be
      // redundant subprocess leaks (W119).
      skipMcpDiscovery: true,
      // Bind the workspace-level manager's SDK callback so a runtime-added
      // client-hosted MCP server (#5626) round-trips over the parent WS.
      sendSdkMcpMessage: bootstrapClientMcpSender,
    });
  } finally {
    endAcpBootstrapConfigProfiling();
  }
  // The ACP path exits llm.tsx before its startup-warning printing runs,
  // so config warnings (including initialize-time ones like the WebSearch
  // enablement notice) would otherwise vanish. stderr lands in the client's
  // logs without interfering with the ACP protocol on stdout.
  // Defensive `typeof` for tests that stub Config without getWarnings.
  const startupWarnings =
    typeof config.getWarnings === 'function' ? config.getWarnings() : [];
  for (const warning of startupWarnings) {
    process.stderr.write(`${warning}\n`);
  }
  const eventLoopMonitor = startEventLoopLagMonitor({
    suspendThresholdMs: ACP_EVENT_LOOP_STALL_RESTART_MS,
    onNewMaxStall: (maxMs) => {
      console.error(`[perf] acp agent event loop stall: max=${maxMs}ms`);
    },
  });

  let agentInstance: QwenAgent | undefined;
  let connection: AgentSideConnection;
  markAcpStartup('transportSetupStart');
  try {
    const stdout = Writable.toWeb(process.stdout) as WritableStream;
    const stdin = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

    // Stdout is used to send messages to the client, so console.log/console.info
    // messages to stderr so that they don't interfere with ACP.
    console.log = console.error;
    console.info = console.error;
    console.debug = console.error;

    let initializeRequestId: string | number | null | undefined;
    const pendingNewSessionRequestIds = new Set<string | number | null>();
    const stream = ndJsonStream(stdout, stdin, {
      onMessageObserved: ({ direction, bytes, message }) => {
        if (direction === 'sent') {
          observeAcpToolResultWire(message, bytes);
        }
        if (
          direction === 'received' &&
          'id' in message &&
          'method' in message
        ) {
          if (message.method === 'session/new') {
            pendingNewSessionRequestIds.add(message.id);
          } else if (message.method === 'initialize') {
            initializeRequestId = message.id;
          }
          return;
        }
        if (
          direction === 'sent' &&
          'id' in message &&
          !('method' in message) &&
          pendingNewSessionRequestIds.delete(message.id) &&
          'result' in message &&
          typeof message.result === 'object' &&
          message.result !== null &&
          'sessionId' in message.result &&
          typeof message.result.sessionId === 'string'
        ) {
          const sessionId = message.result.sessionId;
          setImmediate(() => {
            const session = agentInstance
              ?.getActiveSessions()
              .find((candidate) => candidate.getId() === sessionId);
            if (!session) return;
            void preloadContentGenerator(
              session.getConfig().getContentGenerator(),
            ).catch((error: unknown) => {
              debugLogger.debug(
                `[ACP] Session provider preload failed for ${sessionId}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            });
          }).unref();
        }
        if (
          direction !== 'sent' ||
          initializeRequestId === undefined ||
          !('id' in message) ||
          'method' in message ||
          message.id !== initializeRequestId
        ) {
          return;
        }
        initializeRequestId = undefined;
        if ('result' in message) {
          void initializeTelemetry(config).then(() => {
            registerAcpEventLoopLagGauge(() => eventLoopMonitor.snapshot());
          });
        }
      },
    });
    connection = new AgentSideConnection((conn) => {
      acpConnection = conn;
      const managedToolInvocationGuard = externalToolGuardRequired
        ? createManagedExternalToolGuard(conn, {
            externalProviderAttached: externalToolGuardProviderAttached,
          })
        : undefined;
      agentInstance = new QwenAgent(
        config,
        settings,
        argv,
        conn,
        privateParentCapability,
        sessionWriterLeaseEnabledAtStartup,
        managedToolInvocationGuard,
        externalToolGuardProviderAttached,
      );
      return agentInstance;
    }, stream);
    markAcpStartup('transportSetupEnd');
  } catch (err) {
    eventLoopMonitor.dispose();
    throw err;
  }

  // Both the SIGTERM handler and the IDE-initiated close path need
  // to drain the MCP pool before runExitCleanup. Single helper
  // closure keeps the timeout + log labels consistent.
  const drainPoolBeforeExit = async (
    label: string,
    strict = false,
  ): Promise<void> => {
    if (!agentInstance) return;
    try {
      await agentInstance.shutdownMcpPool(8_000);
    } catch (err) {
      debugLogger.error(`[ACP] MCP pool drain (${label}) error:`, err);
      if (strict) throw err;
    }
  };

  // Handle SIGTERM/SIGINT for graceful shutdown.
  // Without this, signal handlers registered elsewhere in the CLI
  // (e.g., stdin raw mode restoration) override the default exit behavior,
  // causing the ACP process to ignore termination signals.
  let shuttingDown = false;
  let managedShutdownPromise: Promise<void> | undefined;
  let sessionEndFired = false;

  // Helper to fire SessionEnd hook once, preventing double-fire from both
  // shutdown handler path and connection.closed path.
  const fireSessionEndOnce = async (
    reason: SessionEndReason,
    managedConfigs?: Config[],
  ) => {
    if (sessionEndFired) return;
    sessionEndFired = true;

    const configs = new Set<Config>(managedConfigs ?? [config]);
    if (!managedConfigs) {
      const sessions = agentInstance?.getActiveSessions();
      if (sessions) {
        for (const session of sessions) {
          const sessionConfig = session.getConfig?.();
          if (sessionConfig) {
            configs.add(sessionConfig);
          }
        }
      }
    }

    const failures: unknown[] = [];
    for (const cfg of configs) {
      const hookSystem = cfg.getHookSystem?.();
      const hooksEnabled = !cfg.getDisableAllHooks?.();
      if (
        !hooksEnabled ||
        !hookSystem ||
        !cfg.hasHooksForEvent?.('SessionEnd')
      ) {
        continue;
      }
      try {
        await hookSystem.fireSessionEndEvent(reason);
      } catch (err) {
        if (managedConfigs) failures.push(err);
        debugLogger.warn(
          `SessionEnd hook failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'SessionEnd hook shutdown failed');
    }
  };

  const shutdownManagedAgent = (
    reason: SessionEndReason,
    label: string,
  ): Promise<void> => {
    if (managedShutdownPromise) return managedShutdownPromise;
    const agent = agentInstance;
    if (!agent?.isTrustedManagedParent()) {
      return Promise.reject(
        new Error('Managed shutdown requires a trusted private parent'),
      );
    }
    const terminal = agent.beginManagedShutdown();
    managedShutdownPromise = (async () => {
      const failures: unknown[] = [];
      try {
        await terminal.writerShutdown;
      } catch (error) {
        failures.push(error);
        debugLogger.error('[ACP] Managed writer shutdown error:', error);
        const retainedLockPaths = terminal.configs.flatMap((config) => {
          if (
            typeof config.getSessionRuntimeBaseDir !== 'function' ||
            typeof config.getSessionId !== 'function'
          ) {
            return [];
          }
          return [
            path.join(
              config.getSessionRuntimeBaseDir(),
              'tmp',
              'session-writer-locks',
              `${encodeURIComponent(config.getSessionId())}.lock`,
            ),
          ];
        });
        writeStderrLineSafe(
          'qwen --acp: managed session writer shutdown failed; a writer lock may be retained for safety. ' +
            'Verify that no previous writer is running before manual cleanup.' +
            (retainedLockPaths.length > 0
              ? ` Candidate lock paths: ${retainedLockPaths.join(', ')}`
              : ''),
        );
      }
      try {
        await fireSessionEndOnce(reason, terminal.configs);
      } catch (error) {
        failures.push(error);
      }
      try {
        await agent.finishManagedShutdown(terminal.configs);
      } catch (error) {
        failures.push(error);
        debugLogger.error('[ACP] Managed resource shutdown error:', error);
      }
      try {
        await drainPoolBeforeExit(label, true);
      } catch (error) {
        failures.push(error);
      }
      try {
        await runExitCleanup();
      } catch (error) {
        failures.push(error);
        debugLogger.error('[ACP] Cleanup error:', error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Managed ACP shutdown failed');
      }
    })();
    return managedShutdownPromise;
  };

  const shutdownHandler = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    debugLogger.debug('[ACP] Shutdown signal received, closing streams');

    if (agentInstance?.isTrustedManagedParent()) {
      let exitCode = 0;
      try {
        await shutdownManagedAgent(SessionEndReason.Other, 'signal');
      } catch (err) {
        exitCode = 1;
        debugLogger.error('[ACP] Managed shutdown error:', err);
      } finally {
        eventLoopMonitor.dispose();
      }
      try {
        process.stdin.destroy();
        process.stdout.destroy();
      } catch {
        // streams may already be closed
      }
      process.exit(exitCode);
      return;
    }

    try {
      // Fire SessionEnd hook for all active sessions (aligned with core path)
      await fireSessionEndOnce(SessionEndReason.Other);
      await agentInstance?.disposeSessions();

      try {
        process.stdin.destroy();
      } catch {
        // stdin may already be closed
      }
      try {
        process.stdout.destroy();
      } catch {
        // stdout may already be closed
      }
      // Drain the workspace MCP pool BEFORE runExitCleanup so the
      // descendant pid sweep can SIGTERM wrapper grandchildren.
      await drainPoolBeforeExit('signal');
    } catch (err) {
      debugLogger.error('[ACP] Shutdown error:', err);
    } finally {
      eventLoopMonitor.dispose();
    }
    // Clean up child processes (MCP servers, etc.) and force exit.
    // Without this, orphan subprocesses keep the Node.js event loop alive
    // and the CLI process never terminates after the IDE disconnects.
    runExitCleanup()
      .catch((err) => {
        debugLogger.error('[ACP] Cleanup error:', err);
      })
      .finally(() => {
        process.exit(0);
      });
  };
  process.on('SIGTERM', shutdownHandler);
  process.on('SIGINT', shutdownHandler);

  try {
    await connection.closed;
    if (agentInstance?.isTrustedManagedParent()) {
      try {
        await shutdownManagedAgent(
          SessionEndReason.PromptInputExit,
          'ide_close',
        );
      } catch (error) {
        process.exitCode = 1;
        throw error;
      }
    } else {
      // Connection closed by IDE - fire SessionEnd hook (aligned with core path)
      await fireSessionEndOnce(SessionEndReason.PromptInputExit);
      // Mirror the SIGTERM handler's pool drain on the IDE-initiated
      // normal close path to avoid leaking shared MCP entries.
      await drainPoolBeforeExit('ide_close');
      await agentInstance?.disposeSessions();
    }
  } finally {
    process.off('SIGTERM', shutdownHandler);
    process.off('SIGINT', shutdownHandler);
    eventLoopMonitor.dispose();
  }
}

export function toStdioServer(server: McpServer): McpServerStdio | undefined {
  if ('command' in server && 'args' in server && 'env' in server) {
    return server as McpServerStdio;
  }
  return undefined;
}

export function toSseServer(
  server: McpServer,
): (McpServerSse & { type: 'sse' }) | undefined {
  if ('type' in server && server.type === 'sse') {
    return server as McpServerSse & { type: 'sse' };
  }
  return undefined;
}

export function toHttpServer(
  server: McpServer,
): (McpServerHttp & { type: 'http' }) | undefined {
  if ('type' in server && server.type === 'http') {
    return server as McpServerHttp & { type: 'http' };
  }
  return undefined;
}

/**
 * Parse `QWEN_SERVE_MCP_POOL_TRANSPORTS` env var. Comma-separated list
 * e.g. "stdio,websocket,http". Falls back to `POOLED_TRANSPORTS_DEFAULT`
 * on missing / malformed input. Unknown transport names are silently dropped.
 */
function parsePooledTransports(
  envValue: string | undefined,
): ReadonlySet<McpTransportKind> {
  if (!envValue || !envValue.trim()) return POOLED_TRANSPORTS_DEFAULT;
  const KNOWN: ReadonlySet<McpTransportKind> = new Set([
    'stdio',
    'websocket',
    'http',
    'sse',
  ]);
  const out = new Set<McpTransportKind>();
  for (const raw of envValue.split(',')) {
    const trimmed = raw.trim().toLowerCase();
    if (KNOWN.has(trimmed as McpTransportKind)) {
      out.add(trimmed as McpTransportKind);
    }
  }
  // Empty after parsing (all unknown) → fall back to defaults so an
  // operator typo doesn't silently disable the pool entirely.
  return out.size > 0 ? out : POOLED_TRANSPORTS_DEFAULT;
}

/**
 * Parse `QWEN_SERVE_MCP_POOL_DRAIN_MS` env var. Default 30000ms.
 * Bounded to [1000, 600000] (1s-10min).
 */
function parsePoolDrainMs(envValue: string | undefined): number {
  if (!envValue) return 30_000;
  // Reject input that contains anything other than digits. A unit
  // suffix or typo would silently truncate; strict regex prevents this.
  const trimmed = envValue.trim();
  if (!/^\d+$/.test(trimmed)) {
    process.stderr.write(
      `qwen serve: QWEN_SERVE_MCP_POOL_DRAIN_MS=${JSON.stringify(envValue)} ` +
        `is not a valid integer; using default 30000ms.\n`,
    );
    return 30_000;
  }
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n)) return 30_000;
  return Math.min(600_000, Math.max(1_000, n));
}

/**
 * Construct the workspace-scoped MCP budget controller from env vars.
 * Returns `undefined` when budget is unset or `off` mode. The pool
 * invokes `tryReserve`/`release`; this helper produces the controller
 * and wires the event callback.
 */
export function createWorkspaceMcpBudget(
  onEvent: (event: McpBudgetEvent) => void,
): WorkspaceMcpBudget | undefined {
  const rawBudget = process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'];
  const rawMode = process.env['QWEN_SERVE_MCP_BUDGET_MODE'];
  // Match `McpClientManager.readBudgetFromEnv`'s parsing exactly: only plain
  // decimal digits set a budget. A loose `Number(...)` would silently accept
  // `0x10`=16, `1e2`=100, and `1.0`=1 (all pass `isInteger`); the strict
  // `/^\d+$/` + `isSafeInteger` check rejects them so the pool and the manager
  // honor the same env values.
  let budget: number | undefined;
  if (rawBudget !== undefined && rawBudget !== '') {
    const trimmed = rawBudget.trim();
    const parsed = Number(trimmed);
    if (/^\d+$/.test(trimmed) && Number.isSafeInteger(parsed) && parsed > 0) {
      budget = parsed;
    } else {
      process.stderr.write(
        `qwen serve: ignoring invalid QWEN_SERVE_MCP_CLIENT_BUDGET=` +
          `'${rawBudget}' (expected positive integer); ` +
          `MCP budget enforcement disabled for this child.\n`,
      );
    }
  }
  const mode: McpBudgetMode = (() => {
    if (rawMode === 'enforce' || rawMode === 'warn' || rawMode === 'off') {
      return rawMode;
    }
    return budget !== undefined ? 'warn' : 'off';
  })();
  if (mode === 'off' || budget === undefined) {
    return undefined;
  }
  return new WorkspaceMcpBudget({
    clientBudget: budget,
    mode,
    onEvent,
  });
}

const MAX_ACP_SESSION_PAGE_SIZE = 100;

function normalizeAcpSessionListSize(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return undefined;
  }
  return Math.min(Math.max(value, 1), MAX_ACP_SESSION_PAGE_SIZE);
}

function parseAcpSessionListCursor(
  value: string | null | undefined,
): number | undefined {
  if (value == null || value === '') return undefined;
  const trimmed = value.trim();
  const parsedCursor = Number(trimmed);
  if (
    trimmed === '' ||
    !Number.isFinite(parsedCursor) ||
    parsedCursor < 0 ||
    parsedCursor > Number.MAX_SAFE_INTEGER
  ) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid cursor: "${value}" is not a valid numeric cursor`,
    );
  }
  return parsedCursor;
}

interface TranscriptReplayConfigCacheEntry {
  settings: LoadedSettings;
  config?: Config;
  pending?: Promise<Config>;
}

interface PendingMcpAuthentication {
  started: Promise<{
    authUrl: string;
    messages: string[];
  }>;
}

interface ActivePromptCall {
  controller: AbortController;
  settled: Promise<void>;
}

function isOwnerOnlyDirectory(stats: Stats): boolean {
  if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
  if (process.platform === 'win32') {
    // Node's fs.Stats exposes no ownership or permission bits on Windows, so
    // the POSIX mode/uid check has no equivalent here. Containment then rests
    // on the structural checks around this predicate — symlink rejection and
    // dev/ino identity across the realpath round trip — the same trade-off
    // serve/live/discovery.ts already makes on this platform.
    return true;
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    return false;
  }
  return (stats.mode & 0o077) === 0;
}

/**
 * Deliberately local, NOT the module's `hasRootIdentity`: the wire
 * expectation payload `{ device, inode }` carries no `inodeVerifiable`
 * field, so verifiability must keep being derived from `inode !== 0` here
 * (the parser admits only safe integers >= 0, so the two derivations
 * coincide). The comparison itself must stay in lockstep with
 * `hasRootIdentity` in utils/conversation-directory-identity.ts.
 */
function hasExpectedManagedDirectoryIdentity(
  stats: Stats,
  expected: { device: number; inode: number },
): boolean {
  const inodeVerifiable = hasVerifiableInode(stats.ino);
  return (
    stats.dev === expected.device &&
    inodeVerifiable === (expected.inode !== 0) &&
    (!inodeVerifiable || stats.ino === expected.inode)
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isManagedConversationPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    path.isAbsolute(value)
  );
}

function isManagedConversationIdentityNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseConversationDirectoryExpectation(
  value: unknown,
): BridgeConversationDirectoryExpectation | undefined {
  if (value === undefined) return undefined;
  if (
    !isObjectRecord(value) ||
    !hasOnlyKeys(value, ['canonicalSessionId', 'root', 'child'])
  ) {
    throw RequestError.invalidParams(
      undefined,
      'Invalid managed conversation directory expectation',
    );
  }
  const canonicalSessionId = value['canonicalSessionId'];
  const root = value['root'];
  const child = value['child'];
  const parsedSessionId = parseCallerSuppliedSessionId(canonicalSessionId);
  if (
    parsedSessionId.kind !== 'valid' ||
    parsedSessionId.sessionId !== canonicalSessionId ||
    !isObjectRecord(root) ||
    !hasOnlyKeys(root, ['canonicalPath', 'device', 'inode']) ||
    !isManagedConversationPath(root['canonicalPath']) ||
    !isManagedConversationIdentityNumber(root['device']) ||
    !isManagedConversationIdentityNumber(root['inode']) ||
    !isObjectRecord(child) ||
    !hasOnlyKeys(child, ['name', 'canonicalPath', 'device', 'inode']) ||
    typeof child['name'] !== 'string' ||
    child['name'] !== getConversationDirectoryName(canonicalSessionId) ||
    !isManagedConversationPath(child['canonicalPath']) ||
    !isManagedConversationIdentityNumber(child['device']) ||
    !isManagedConversationIdentityNumber(child['inode']) ||
    !isSameConversationPath(
      path.dirname(child['canonicalPath']),
      root['canonicalPath'],
    ) ||
    path.basename(child['canonicalPath']) !== child['name']
  ) {
    throw RequestError.invalidParams(
      undefined,
      'Invalid managed conversation directory expectation',
    );
  }
  return {
    canonicalSessionId,
    root: {
      canonicalPath: root['canonicalPath'],
      device: root['device'],
      inode: root['inode'],
    },
    child: {
      name: child['name'],
      canonicalPath: child['canonicalPath'],
      device: child['device'],
      inode: child['inode'],
    },
  };
}

function managedConversationDirectoryError(missing: boolean): RequestError {
  return new RequestError(
    -32004,
    missing
      ? 'The standalone working directory is missing.'
      : 'The standalone working directory identity is compromised.',
    {
      errorKind: missing
        ? 'working_directory_missing'
        : 'working_directory_compromised',
    },
  );
}

async function assertManagedConversationDirectoryIdentity(
  expectation: BridgeConversationDirectoryExpectation,
): Promise<void> {
  let rootBefore: Stats;
  let canonicalRoot: string;
  let rootAfter: Stats;
  try {
    rootBefore = await fs.lstat(expectation.root.canonicalPath);
    canonicalRoot = await fs.realpath(expectation.root.canonicalPath);
    rootAfter = await fs.lstat(canonicalRoot);
  } catch (error) {
    throw managedConversationDirectoryError(
      (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
  }
  if (
    !isOwnerOnlyDirectory(rootBefore) ||
    !isOwnerOnlyDirectory(rootAfter) ||
    !isSameConversationPath(canonicalRoot, expectation.root.canonicalPath) ||
    !hasExpectedManagedDirectoryIdentity(rootBefore, expectation.root) ||
    !hasExpectedManagedDirectoryIdentity(rootAfter, expectation.root)
  ) {
    throw managedConversationDirectoryError(false);
  }

  let childBefore: Stats;
  let canonicalChild: string;
  let childAfter: Stats;
  try {
    childBefore = await fs.lstat(expectation.child.canonicalPath);
    canonicalChild = await fs.realpath(expectation.child.canonicalPath);
    childAfter = await fs.lstat(canonicalChild);
  } catch (error) {
    throw managedConversationDirectoryError(
      (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
  }
  if (
    !isOwnerOnlyDirectory(childBefore) ||
    !isOwnerOnlyDirectory(childAfter) ||
    !isSameConversationPath(canonicalChild, expectation.child.canonicalPath) ||
    !hasExpectedManagedDirectoryIdentity(childBefore, expectation.child) ||
    !hasExpectedManagedDirectoryIdentity(childAfter, expectation.child)
  ) {
    throw managedConversationDirectoryError(false);
  }
}

class QwenAgent implements Agent {
  private sessions: Map<string, Session> = new Map();
  private readonly historyMutationTails = new Map<string, Promise<void>>();
  private readonly startingSessionIds = new Set<string>();
  private activePromptCalls = new Map<string, Set<ActivePromptCall>>();
  private workspaceMcpDiscoveryConfig: Config | undefined;
  private workspaceMcpDiscoveryPromise: Promise<void> | undefined;
  private workspaceMcpDiscoveryError: string | undefined;
  private workspaceExtensionStatusRefreshPromise: Promise<void> | undefined;
  private readonly pendingMcpAuthentications = new Map<
    string,
    PendingMcpAuthentication
  >();
  private readonly mcpAuthenticationResults = new Map<
    string,
    { state: 'succeeded' | 'failed'; error?: string }
  >();
  private readonly generationControllers = new Map<
    string,
    { sessionId: string; controller: AbortController }
  >();
  private readonly workspaceGenerationControllers = new Map<
    string,
    AbortController
  >();
  private readonly transcriptReplayConfigCache = new Map<
    string,
    TranscriptReplayConfigCacheEntry
  >();
  private readonly pendingConfigCleanup = new Map<string, Set<Config>>();
  private readonly initializingConfigs = new Set<Config>();
  private sessionWorkflowEnabledOverride: boolean | undefined;
  /**
   * The last file-derived approval mode each live session actually
   * converged on, seeded with the session's boot-derived mode at
   * publication. `workspaceReload` compares the reloaded disk value against
   * this — not against each session's live mode — because approval mode has
   * runtime-only writers (`ExitPlanModeTool` approved plan exits, ACP
   * `session/set_mode`, the `sessionApprovalMode` ext) that never persist,
   * so a live session legitimately diverges from the file mid-workflow and
   * an unchanged file must not clobber those transitions. The record lives
   * on the daemon so it survives a `this.settings` cache swap, and per
   * session because one daemon-wide baseline cannot represent a partially
   * applied convergence: while a session skipped mid-flip still waits for
   * its value, the file can round-trip back to the old baseline and strand
   * the already-flipped sessions on the intermediate mode. An entry advances
   * only when that session successfully converges, so skipped sessions and
   * failed applies retry on the next reload, and an unparseable file value
   * (undefined fold) is never recorded.
   */
  private readonly sessionApprovalModeConverged = new Map<
    string,
    ApprovalMode
  >();
  private managedShuttingDown = false;
  private clientCapabilities: ClientCapabilities | undefined;
  /** Set once the daemon negotiates active-work reporting; one per channel. */
  private activeWorkReporter: ActiveWorkReporter | undefined;
  private privateParentState:
    | 'uninitialized'
    | 'trusted'
    | 'untrusted'
    | 'rejected' = 'uninitialized';
  // CPU-usage delta baseline for the daemon's `workspaceResource` extMethod
  // (Daemon Status child-resource chart). The daemon polls this at a fixed
  // cadence, so successive calls form a clean delta window independent of tool
  // activity. Init is guarded — `process.cpuUsage()` can throw in restricted
  // containers.
  private readonly childCpuCoreCount =
    os.availableParallelism?.() ?? os.cpus().length ?? 1;
  private prevChildCpu: NodeJS.CpuUsage | null = (() => {
    try {
      return process.cpuUsage();
    } catch {
      // null (not {0,0}) so the first successful poll skips the delta instead
      // of billing the since-start total as one window — mirrors the daemon's
      // own safeCpuUsage() null-on-failure contract.
      return null;
    }
  })();
  private prevChildCpuAt = Date.now();
  /**
   * Lifetime old-generation high-water marks, for the daemon's
   * `workspaceResource` poll. `undefined` outside a daemon-spawned child — see
   * {@link shouldProbeChildHeap} for why the gate is where it is.
   *
   * Started at construction rather than on the first poll: the peaks that
   * matter include the ones reached before anyone asks.
   */
  private readonly childHeapProbe: ChildHeapProbe | undefined =
    shouldProbeChildHeap(process.env) ? startChildHeapProbe() : undefined;

  /**
   * Workspace-shared MCP transport pool. Eagerly constructed; lazy
   * w.r.t. actual MCP work — spawns nothing until `pool.acquire`.
   *
   * `undefined` when `QWEN_SERVE_NO_MCP_POOL=1` (kill switch); sessions
   * then fall back to per-session McpClient spawn.
   */
  private readonly mcpPool?: McpTransportPool;

  /**
   * Workspace-scoped MCP budget controller. Constructed alongside
   * `mcpPool` when `--mcp-client-budget=N` is configured. `undefined`
   * when no budget is configured or pool kill switch is on.
   */
  private readonly workspaceMcpBudget?: WorkspaceMcpBudget;

  getActiveSessions(): Session[] {
    return [...this.sessions.values()];
  }

  isTrustedManagedParent(): boolean {
    return this.privateParentState === 'trusted';
  }

  private assertManagedSessionAdmission(): void {
    if (
      this.expectedPrivateParentCapability !== undefined &&
      !this.isTrustedManagedParent()
    ) {
      throw RequestError.invalidParams(
        undefined,
        'Private ACP parent is not initialized',
      );
    }
    if (this.managedShuttingDown) {
      throw new SessionWriterUnavailableError();
    }
  }

  private async runExclusiveHistoryMutation<T>(
    sessionId: string,
    operation: () => Promise<T>,
    waitTimeoutMs?: number,
    waitDisplayTimeoutMs?: number,
  ): Promise<T> {
    const previous =
      this.historyMutationTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.then(() => gate);
    this.historyMutationTails.set(sessionId, current);
    try {
      if (waitTimeoutMs === undefined) {
        await previous;
      } else {
        await waitForSessionDrain(
          previous,
          waitTimeoutMs,
          'close',
          waitDisplayTimeoutMs,
        );
      }
    } catch (error) {
      release();
      void current.then(() => {
        if (this.historyMutationTails.get(sessionId) === current) {
          this.historyMutationTails.delete(sessionId);
        }
      });
      throw error;
    }
    try {
      return await operation();
    } finally {
      release();
      if (this.historyMutationTails.get(sessionId) === current) {
        this.historyMutationTails.delete(sessionId);
      }
    }
  }

  private rejectUnsupportedGuardedHiddenAgent(operation: string): void {
    if (
      this.managedToolInvocationGuard &&
      this.externalToolGuardProviderAttached
    ) {
      throw RequestError.invalidParams(
        undefined,
        `Managed external tool guard v1 does not support ${operation}.`,
      );
    }
  }

  beginManagedShutdown(): {
    configs: Config[];
    writerShutdown: Promise<void>;
  } {
    if (!this.isTrustedManagedParent()) {
      throw new Error('Managed shutdown requires a trusted private parent');
    }
    this.managedShuttingDown = true;
    for (const generation of this.generationControllers.values()) {
      generation.controller.abort();
    }
    this.generationControllers.clear();
    for (const controller of this.workspaceGenerationControllers.values()) {
      controller.abort();
    }
    this.workspaceGenerationControllers.clear();

    const configs = new Set<Config>([this.config, ...this.initializingConfigs]);
    for (const session of this.sessions.values()) {
      try {
        session.beginCloseIfAvailable();
      } catch (error) {
        debugLogger.debug(
          `Session ${session.getId()} admission close during managed shutdown failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      void session.cancelPendingPrompt().catch((error) => {
        debugLogger.debug(
          `Session ${session.getId()} cancel during managed shutdown failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      configs.add(session.getConfig());
    }
    for (const pending of this.pendingConfigCleanup.values()) {
      for (const config of pending) configs.add(config);
    }

    const configList = [...configs];
    const writerTerminals: Array<Promise<void>> = [];
    for (const config of configList) {
      try {
        writerTerminals.push(config.closeSessionWriter({ handoff: true }));
      } catch (error) {
        writerTerminals.push(Promise.reject(error));
      }
    }
    const writerShutdown = Promise.allSettled(writerTerminals).then(
      (results) => {
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            'Managed session writer shutdown failed',
          );
        }
      },
    );
    return { configs: configList, writerShutdown };
  }

  async finishManagedShutdown(configs: Config[]): Promise<void> {
    const failures: unknown[] = [];
    for (const [sessionId, session] of [...this.sessions]) {
      await this.removeStoredSessionEntry(sessionId, session, failures, {
        shutdownConfig: false,
      });
    }
    const results = await Promise.allSettled(
      configs.map((config) =>
        config.shutdown({
          shutdownTelemetry: false,
          skipSessionWriter: true,
          strictResourceCleanup: true,
        }),
      ),
    );
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    this.initializingConfigs.clear();
    this.pendingConfigCleanup.clear();
    this.disposeTranscriptReplayConfigs();
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Managed session cleanup failed');
    }
  }

  private getWorkspaceMcpConfig(serverName?: string): Config {
    if (
      serverName &&
      this.config.getRuntimeMcpServers?.()[serverName] !== undefined
    ) {
      return this.config;
    }
    return this.workspaceMcpDiscoveryConfig ?? this.config;
  }

  private refreshBootstrapExtensionStatus(): Promise<void> {
    if (this.workspaceExtensionStatusRefreshPromise) {
      return this.workspaceExtensionStatusRefreshPromise;
    }

    const promise = (async () => {
      const errors: unknown[] = [];
      try {
        await this.config.getExtensionManager().refreshCache();
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.config.getSkillManager()?.refreshCache();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          'Bootstrap extension status refresh failed',
        );
      }
    })();
    this.workspaceExtensionStatusRefreshPromise = promise;
    const clear = () => {
      if (this.workspaceExtensionStatusRefreshPromise === promise) {
        this.workspaceExtensionStatusRefreshPromise = undefined;
      }
    };
    void promise.then(clear, clear);
    return promise;
  }

  private getLiveMcpConfigs(serverName: string): Config[] {
    return [
      ...new Set([
        this.getWorkspaceMcpConfig(serverName),
        this.config,
        ...this.getActiveSessions().map((session) => session.getConfig()),
      ]),
    ].filter((config) => Boolean(config.getMcpServers()?.[serverName]));
  }

  private async reconcileMcpServerAcrossLiveConfigs(
    serverName: string,
    operation: 'discover' | 'disable' | 'disconnect',
  ): Promise<void> {
    const errors: unknown[] = [];
    for (const config of this.getLiveMcpConfigs(serverName)) {
      try {
        const registry = config.getToolRegistry();
        if (operation === 'discover') {
          await registry?.discoverToolsForServer(serverName);
          const llmClient = config.getLlmClient?.();
          if (llmClient?.isInitialized?.()) {
            await llmClient.setTools?.();
          }
        } else if (operation === 'disable') {
          await registry?.disableMcpServer(serverName);
        } else {
          await registry?.disconnectServer(serverName);
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      const details = errors
        .map((error) =>
          error instanceof Error ? error.message : String(error),
        )
        .join('; ');
      throw new AggregateError(
        errors,
        `Failed to synchronize MCP server ${JSON.stringify(serverName)}: ${details}`,
      );
    }
  }

  private getMcpServerStatus(config: Config, serverName: string) {
    const manager = config.getToolRegistry()?.getMcpClientManager() as
      | { getServerStatus?: (name: string) => MCPServerStatus }
      | undefined;
    return (
      manager?.getServerStatus?.(serverName) ?? getMCPServerStatus(serverName)
    );
  }

  private enqueueWorkspaceMcpDiscovery(
    label: string,
    run: () => Promise<void>,
  ): { accepted: boolean } {
    const previous = this.workspaceMcpDiscoveryPromise ?? Promise.resolve();
    const tracked = previous
      .then(async () => {
        this.workspaceMcpDiscoveryError = undefined;
        await run();
      })
      .catch((err: unknown) => {
        this.workspaceMcpDiscoveryError =
          err instanceof Error ? err.message : String(err);
        debugLogger.error(
          `Workspace MCP ${label} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      })
      .finally(() => {
        if (this.workspaceMcpDiscoveryPromise === tracked) {
          this.workspaceMcpDiscoveryPromise = undefined;
        }
      });
    this.workspaceMcpDiscoveryPromise = tracked;
    return { accepted: true };
  }

  private async createWorkspaceMcpDiscoveryConfig(
    settings: LoadedSettings,
  ): Promise<void> {
    if (this.workspaceMcpDiscoveryConfig) return;
    return sessionIdContext.run('workspace-mcp-discovery', async () => {
      const cwd = this.config.getTargetDir();
      const config = await this.runWithPinnedRuntimeBaseDir(settings, cwd, () =>
        loadCliConfig(
          settings.merged,
          {
            ...this.argv,
            sessionId: 'workspace-mcp-discovery',
            resume: undefined,
            continue: false,
            chatRecording: false,
          },
          cwd,
          undefined,
          {
            userHooks: settings.getUserHooks(),
            projectHooks: settings.getProjectHooks(),
          },
          buildDisabledSkillNamesProvider(settings),
        ),
      );
      config.setMcpTransportPool(this.mcpPool);
      try {
        await config.initialize({
          skipLlmInitialization: true,
          skipFileCheckpointing: true,
          skipHooks: true,
          skipSkillManager: true,
          skipMcpDiscovery: true,
          lenientToolWarmup: true,
        });
        const manager = config.getToolRegistry()?.getMcpClientManager();
        if (!manager) {
          throw new Error('MCP client manager is unavailable');
        }
        await manager.discoverAllMcpToolsIncremental(config);
        if (manager.getDiscoveryState() === MCPDiscoveryState.NOT_STARTED) {
          throw new Error(
            'MCP discovery did not start. The workspace may not be trusted.',
          );
        }
        this.workspaceMcpDiscoveryConfig = config;
      } catch (error) {
        try {
          await config.getToolRegistry()?.stop();
        } catch {
          // Preserve the initialization failure that made this config unusable.
        }
        throw error;
      }
    });
  }

  private initializeWorkspaceMcpDiscovery(): { accepted: boolean } {
    if (this.workspaceMcpDiscoveryConfig || this.workspaceMcpDiscoveryPromise) {
      return { accepted: false };
    }
    return this.enqueueWorkspaceMcpDiscovery('initialization', async () => {
      const settings = loadSettings(this.config.getTargetDir());
      await this.createWorkspaceMcpDiscoveryConfig(settings);
    });
  }

  private reloadWorkspaceMcpDiscovery(
    options: {
      forceReconnectAll?: boolean;
      forceReconnectWhich?: string[];
    } = {},
  ): {
    accepted: boolean;
  } {
    return this.enqueueWorkspaceMcpDiscovery('reload', async () => {
      const settings = loadSettings(this.config.getTargetDir());
      const discoveryConfig = this.workspaceMcpDiscoveryConfig;
      const liveConfigs = new Set([
        this.config,
        ...this.getActiveSessions().map((session) => session.getConfig()),
        ...(discoveryConfig ? [discoveryConfig] : []),
      ]);
      const syncErrors: unknown[] = [];
      for (const config of liveConfigs) {
        try {
          const cwd = config.getTargetDir();
          // Same bare/safe guard as registerMcpHotReload (config/hot-reload.ts)
          // — each live Config in this Set may independently be bare/safe or
          // not, so the check is per-config, not hoisted outside the loop.
          // Without it, this control-endpoint reload path (workspaceMcpReload)
          // would fold settings.merged.mcpServers/mcp.allowed/excluded — LOCAL
          // state safe/bare mode is supposed to distrust — back into an
          // already-running safe/bare session, silently stranding or
          // filtering out the caller's own top-tier server. Same bug class as
          // the loadCliConfig (boot) and registerMcpHotReload (settings-file
          // watcher) fixes earlier in this PR, found here in the third
          // reload path.
          const isBareOrSafe = config.getBareMode() || config.isSafeMode();
          const mcpServers = isBareOrSafe
            ? { ...config.getTopTierMcpServers() }
            : assembleMcpServers(
                settings.merged.mcpServers,
                cwd,
                config.getTopTierMcpServers(),
              );
          const bootAllowed = config.getCliAllowedMcpServerNames();
          const gating = isBareOrSafe
            ? { allowed: bootAllowed ? [...bootAllowed] : undefined }
            : recomputeMcpGating(
                settings,
                mcpServers,
                cwd,
                bootAllowed,
                config.getApprovalMode() === ApprovalMode.YOLO,
              );
          config.setExcludedMcpServers(gating.excluded ?? []);
          config.setAllowedMcpServers(gating.allowed);
          config.setPendingMcpServers(gating.pending);
          await config.reinitializeMcpServers(mcpServers);
        } catch (error) {
          syncErrors.push(error);
        }
      }
      if (!discoveryConfig) {
        try {
          await this.createWorkspaceMcpDiscoveryConfig(settings);
        } catch (error) {
          syncErrors.push(error);
        }
      }
      if (syncErrors.length > 0) {
        throw new AggregateError(
          syncErrors,
          'Failed to synchronize MCP settings with live sessions',
        );
      }
      if (
        options.forceReconnectAll === true ||
        options.forceReconnectWhich !== undefined
      ) {
        await this.forceReconnectWorkspaceMcp(options.forceReconnectWhich);
      }
    });
  }

  private async forceReconnectWorkspaceMcp(
    requestedServerNames?: readonly string[],
  ): Promise<void> {
    const serverNames = new Set<string>();
    for (const config of [
      this.workspaceMcpDiscoveryConfig,
      this.config,
      ...this.getActiveSessions().map((session) => session.getConfig()),
    ]) {
      for (const name of Object.keys(config?.getMcpServers() ?? {})) {
        serverNames.add(name);
      }
    }

    const selectedServerNames = requestedServerNames
      ? [...new Set(requestedServerNames)].filter((name) =>
          serverNames.has(name),
        )
      : [...serverNames];
    const errors: unknown[] = [];
    for (const serverName of selectedServerNames) {
      try {
        const poolHasEntries =
          (this.mcpPool?.getSnapshot().byName[serverName]?.entryCount ?? 0) > 0;
        if (this.mcpPool && poolHasEntries) {
          const results = await this.mcpPool.restartByName(serverName);
          const failed = results.find((result) => !result.restarted);
          if (failed) {
            throw new Error(
              `MCP server ${JSON.stringify(serverName)} failed to reconnect: ${failed.reason ?? 'unknown error'}`,
            );
          }
          await Promise.all(
            this.getLiveMcpConfigs(serverName).map(async (config) => {
              const llmClient = config.getLlmClient?.();
              if (llmClient?.isInitialized?.()) {
                await llmClient.setTools?.();
              }
            }),
          );
        } else {
          await this.reconcileMcpServerAcrossLiveConfigs(
            serverName,
            'discover',
          );
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        'Failed to force reconnect one or more MCP servers',
      );
    }
  }

  /**
   * Drain the workspace MCP transport pool. Called on shutdown so all
   * pool entries get a coordinated SIGTERM before process.exit. No-op
   * when pool is undefined (kill-switch mode).
   */
  async shutdownMcpPool(timeoutMs = 10_000): Promise<void> {
    if (!this.mcpPool) return;
    try {
      const result = await this.mcpPool.drainAll({ force: true, timeoutMs });
      if (result.forced > 0 || result.errors.length > 0) {
        debugLogger.warn(
          `MCP pool drain: ${result.drained} clean, ${result.forced} timed out, ` +
            `${result.errors.length} errors`,
        );
        throw new Error(
          `MCP pool drain incomplete: ${result.forced} forced, ${result.errors.length} errors`,
        );
      }
    } catch (err) {
      debugLogger.error(
        `MCP pool drainAll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  private async removeStoredSessionEntry(
    sessionId: string,
    session: Session,
    cleanupErrors: unknown[] = [],
    options: { shutdownConfig?: boolean } = {},
  ): Promise<void> {
    if (this.sessions.get(sessionId) !== session) return;
    try {
      session.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (options.shutdownConfig !== false) {
      try {
        await session.getConfig().shutdown({ shutdownTelemetry: false });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      this.mcpPool?.releaseSession(sessionId);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      uiTelemetryService.removeSession(sessionId);
    } catch (error) {
      cleanupErrors.push(error);
    }
    this.sessions.delete(sessionId);
    this.sessionApprovalModeConverged.delete(sessionId);
    // A Session missing from the next snapshot is how the daemon learns the
    // child released it — including when it never saw our close response.
    this.activeWorkReporter?.notifyChanged();
    if (cleanupErrors.length > 0) {
      debugLogger.warn(
        `Session ${sessionId} closed after ${cleanupErrors.length} cleanup failure(s): ${cleanupErrors
          .map((error) =>
            error instanceof Error ? error.message : String(error),
          )
          .join('; ')}`,
      );
    }
  }

  private async withLiveSessionRestore<T>(
    sessionId: string,
    session: Session,
    options: SelectiveSessionRestoreOptions,
    operation: (
      config: Config,
      projection: SessionLiveRestoreProjection | undefined,
    ) => Promise<T>,
  ): Promise<T> {
    await session.assertCanStartTurn();
    const config = session.getConfig();
    const releaseGate = session.beginClose();
    try {
      await waitForSessionDrain(
        session.waitForActiveTurnsToSettle(),
        SESSION_DRAIN_TIMEOUT_MS,
        'restore',
      );
      const recorder = config.getChatRecordingService();
      const readProjection = () =>
        config
          .getSessionService()
          .readLiveRestoreProjection(sessionId, options);
      const projection = recorder
        ? await recorder.runWithWriteBarrier(readProjection)
        : await readProjection();
      if (!projection) throw new SessionWriterUnavailableError();
      return await operation(config, projection);
    } catch (error) {
      throw mapSessionRestoreRequestError(error, sessionId);
    } finally {
      releaseGate();
    }
  }

  private async cleanupUnstoredConfig(config: Config): Promise<void> {
    const sessionId = config.getSessionId();
    const cleanupKey = this.pendingConfigCleanupKey(
      config.getSessionRuntimeBaseDir(),
      sessionId,
    );
    try {
      await shutdownSessionConfig(config);
    } catch (error) {
      this.initializingConfigs.delete(config);
      const pending = this.pendingConfigCleanup.get(cleanupKey) ?? new Set();
      pending.add(config);
      this.pendingConfigCleanup.set(cleanupKey, pending);
      throw mapSessionWriterRequestError(error);
    }
    this.initializingConfigs.delete(config);
    const pending = this.pendingConfigCleanup.get(cleanupKey);
    pending?.delete(config);
    if (pending?.size === 0) {
      this.pendingConfigCleanup.delete(cleanupKey);
    }
  }

  private async cleanupAfterRequestFailure(
    error: unknown,
    cleanup: () => Promise<void>,
    sessionId?: string,
  ): Promise<never> {
    try {
      await cleanup();
    } catch (cleanupError) {
      debugLogger.warn(
        `Session cleanup failed while preserving the original request error: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw sessionId
      ? mapSessionRestoreRequestError(error, sessionId)
      : mapSessionWriterRequestError(error);
  }

  private pendingConfigCleanupKey(
    runtimeBaseDir: string,
    sessionId: string,
  ): string {
    return `${path.resolve(runtimeBaseDir)}\0${sessionId}`;
  }

  private withAskUserQuestionRestoreHint<
    T extends { _meta?: Record<string, unknown> | null },
  >(session: Session | undefined, response: T): T {
    if (this.argv.restoreAskUserQuestion !== true) {
      return response;
    }
    if (!session?.shouldHintAskUserQuestionRestore()) {
      return response;
    }
    return {
      ...response,
      _meta: {
        ...(response._meta && typeof response._meta === 'object'
          ? response._meta
          : {}),
        [DAEMON_RESTORE_ASK_USER_QUESTION_META_KEY]: true,
      },
    };
  }

  private async retryPendingConfigCleanup(
    runtimeBaseDir: string,
    requiredSessionId?: string,
  ): Promise<void> {
    const resolvedRuntimeBaseDir = path.resolve(runtimeBaseDir);
    const configs = new Set<Config>();
    for (const pending of this.pendingConfigCleanup.values()) {
      for (const config of pending) {
        if (
          path.resolve(config.getSessionRuntimeBaseDir()) ===
          resolvedRuntimeBaseDir
        ) {
          configs.add(config);
        }
      }
    }
    for (const config of configs) {
      try {
        await this.cleanupUnstoredConfig(config);
      } catch (error) {
        if (config.getSessionId() === requiredSessionId) throw error;
        debugLogger.warn(
          `Deferred Config cleanup retry failed for session ${config.getSessionId()}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async closeStoredSession(
    sessionId: string,
    opts?: {
      requireFlush?: boolean;
      drainTimeoutMs?: number;
      shutdownConfig?: boolean;
      waitForCloseGate?: boolean;
      /**
       * Close only if the Session holds no active work — the daemon's
       * automatic-cleanup path. Explicit close, kill, and shutdown leave this
       * unset and keep their force semantics.
       */
      onlyIfUnheld?: boolean;
    },
  ): Promise<{ closed: boolean; holds: ActiveWorkHoldV1[] }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.mcpPool?.releaseSession(sessionId);
      // Already gone is the outcome the caller wanted, not a refusal.
      return { closed: true, holds: [] };
    }

    const recorder = session.getConfig().getChatRecordingService();
    const requireFlush = opts?.requireFlush === true;
    if (requireFlush) await recorder?.flush();
    const drainTimeoutMs = opts?.drainTimeoutMs ?? SESSION_DRAIN_TIMEOUT_MS;
    const cancelClose = opts?.waitForCloseGate
      ? await beginSessionCloseAfterCurrentGate(session, drainTimeoutMs)
      : session.beginClose();
    const conditionalDrainDeadline = opts?.onlyIfUnheld
      ? Date.now() + drainTimeoutMs
      : undefined;
    // Reject known work before disturbing any active turn. The close gate
    // prevents new turns, but a turn that was already running can still settle
    // into a new hold while the drain below is in progress, so this early read
    // is an optimization rather than the final authorization.
    if (opts?.onlyIfUnheld) {
      const holds = session.collectActiveWorkHolds();
      if (holds.length > 0) {
        cancelClose();
        return { closed: false, holds };
      }
    }
    let removedFromStore = false;
    try {
      if (opts?.onlyIfUnheld) {
        // Let the turn that already owned the gate settle without cancelling
        // queues or stopping schedulers. It may create a hold while settling;
        // a refusal must leave the retained Session untouched.
        await waitForSessionDrain(
          session.waitForActiveTurnsToSettle(),
          drainTimeoutMs,
          'close',
        );
        const holds = session.collectActiveWorkHolds();
        if (holds.length > 0) {
          return { closed: false, holds };
        }
      }

      for (const [requestId, generation] of this.generationControllers) {
        if (generation.sessionId !== sessionId) continue;
        generation.controller.abort();
        this.generationControllers.delete(requestId);
      }
      await waitForSessionDrain(
        (async () => {
          try {
            await session.cancelPendingPrompt();
          } catch (err) {
            debugLogger.debug(
              `Session ${sessionId} cancel during close failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          await session.waitForActiveTurnsToSettle();
        })(),
        conditionalDrainDeadline === undefined
          ? drainTimeoutMs
          : Math.max(1, conditionalDrainDeadline - Date.now()),
        'close',
        // Report the shared budget, not the phase-2 residue — a residue like
        // "1ms" hides that the settle phase consumed the budget and sends
        // oncall grepping for a timeout setting that does not exist.
        drainTimeoutMs,
      );

      const blockedByHolds = await this.runExclusiveHistoryMutation(
        sessionId,
        async () => {
          if (this.sessions.get(sessionId) !== session) {
            removedFromStore = true;
            return undefined;
          }

          // Existing out-of-scope work such as a cron turn may have
          // registered a background shell while it drained. Re-check after
          // every active turn has settled, while both the close gate and the
          // history-mutation gate still block destructive races.
          if (opts?.onlyIfUnheld) {
            const holds = session.collectActiveWorkHolds();
            if (holds.length > 0) {
              return { closed: false, holds };
            }
          }

          recorder?.finalize();
          let flushError: unknown;
          try {
            await recorder?.flush();
          } catch (error) {
            flushError = error;
          }
          if (flushError !== undefined && requireFlush) {
            throw flushError;
          }

          let closeError: unknown;
          try {
            await recorder?.close();
          } catch (error) {
            closeError = error;
          }
          if (recorder?.hasWriteOwnership()) {
            throw closeError ?? new SessionWriterUnavailableError();
          }

          const cleanupErrors: unknown[] = [];
          if (flushError !== undefined) cleanupErrors.push(flushError);
          if (closeError !== undefined) cleanupErrors.push(closeError);
          await this.removeStoredSessionEntry(
            sessionId,
            session,
            cleanupErrors,
            {
              shutdownConfig: opts?.shutdownConfig,
            },
          );
          removedFromStore = true;
          return undefined;
        },
        // The mutation wait shares the conditional close's budget too, or
        // the whole round trip can outlast the daemon's outer wait — the
        // coupling the drain budget exists to keep. The mutation body
        // itself stays untimed, so the guarantee remains approximate. The
        // message reports the shared budget, not the residue.
        conditionalDrainDeadline === undefined
          ? drainTimeoutMs
          : Math.max(1, conditionalDrainDeadline - Date.now()),
        drainTimeoutMs,
      );
      if (blockedByHolds) return blockedByHolds;
    } finally {
      if (!removedFromStore) cancelClose();
    }
    return { closed: true, holds: [] };
  }

  private async discardStoredSessionIfCurrent(
    sessionId: string,
    session: Session,
    opts?: {
      requireFlush?: boolean;
      drainTimeoutMs?: number;
      shutdownConfig?: boolean;
      waitForCloseGate?: boolean;
    },
  ): Promise<void> {
    if (this.sessions.get(sessionId) !== session) {
      return;
    }
    await this.closeStoredSession(sessionId, opts);
  }

  async disposeSessions(): Promise<void> {
    this.activeWorkReporter?.dispose();
    this.activeWorkReporter = undefined;
    for (const generation of this.generationControllers.values()) {
      generation.controller.abort();
    }
    this.generationControllers.clear();
    for (const controller of this.workspaceGenerationControllers.values()) {
      controller.abort();
    }
    this.workspaceGenerationControllers.clear();
    await Promise.allSettled(
      [...this.sessions.entries()].map(([sessionId, session]) =>
        this.discardStoredSessionIfCurrent(sessionId, session, {
          waitForCloseGate: true,
        }),
      ),
    );
    await Promise.allSettled(
      [...this.pendingConfigCleanup.values()]
        .flatMap((configs) => [...configs])
        .map((config) => this.cleanupUnstoredConfig(config)),
    );
    this.disposeTranscriptReplayConfigs();
  }

  constructor(
    private config: Config,
    private settings: LoadedSettings,
    private argv: CliArgs,
    private connection: AgentSideConnection,
    private readonly expectedPrivateParentCapability?: string,
    private readonly sessionWriterLeaseEnabledAtStartup = false,
    private readonly managedToolInvocationGuard?: ToolInvocationGuard,
    private readonly externalToolGuardProviderAttached = false,
  ) {
    // Pool kill switch via env var so operators can A/B compare or
    // roll back without rebuilding. `run-qwen-serve.ts` sets this when
    // `--no-mcp-pool` is passed at daemon startup.
    if (process.env['QWEN_SERVE_NO_MCP_POOL'] === '1') {
      this.mcpPool = undefined;
      this.workspaceMcpBudget = undefined;
    } else {
      // Construct the workspace-scoped budget controller when
      // `--mcp-client-budget=N` was set at boot. With the pool active,
      // this controller's accounting REPLACES per-session copies.
      this.workspaceMcpBudget = createWorkspaceMcpBudget((event) => {
        this.broadcastBudgetEvent(event);
      });
      this.mcpPool = new McpTransportPool(this.config, {
        workspaceContext: this.config.getWorkspaceContext(),
        debugMode: this.config.getDebugMode(),
        // sendSdkMcpMessage left undefined: SDK MCP servers always
        // bypass the pool via createUnpooledConnection (per-session
        // routing through ACP control plane). The legacy
        // McpClientManager path retains its own per-session SDK
        // wiring; pool-mode discoverAllMcpToolsViaPool delegates SDK
        // MCP to that bypass.
        pooledTransports: parsePooledTransports(
          process.env['QWEN_SERVE_MCP_POOL_TRANSPORTS'],
        ),
        drainDelayMs: parsePoolDrainMs(
          process.env['QWEN_SERVE_MCP_POOL_DRAIN_MS'],
        ),
        budget: this.workspaceMcpBudget,
      });
    }
  }

  private runWithPinnedRuntimeBaseDir<T>(
    settings: LoadedSettings,
    cwd: string,
    operation: () => T,
  ): T {
    return runWithAcpRuntimeOutputDir(settings, cwd, operation);
  }

  /**
   * Whether an ungated restore replay (qwen/session/loadUpdates) may
   * finalize dangling tool calls. A session with an active turn — a client
   * prompt or an autonomous goal/cron/notification turn — may still owe the
   * trailing call's result, so the replay keeps it pending and lets the
   * live stream deliver it (#9704). Samples the turn state before the
   * transcript read and again at replay time so a turn that starts or
   * settles inside the read window is seen. Not for the live loadSession
   * path: that restore runs under the close gate, which drains active
   * turns, blocks new ones, and reports closing=true — so isTurnIdle()
   * there is structurally false and would keep genuinely abandoned calls
   * pending forever.
   */
  private finalizeDanglingForRestore(
    session: Session | undefined,
    turnIdleBeforeRead: boolean,
  ): boolean {
    const idleAtReplay = session?.isTurnIdle() ?? true;
    const finalize = turnIdleBeforeRead && idleAtReplay;
    // Template literal, not printf-style placeholders: createDebugLogger's
    // formatArgs does no util.format substitution, it space-joins the args.
    debugLogger.debug(
      `[ACP] restore replay finalizeDangling=${finalize} (idleBeforeRead=${turnIdleBeforeRead}, idleAtReplay=${idleAtReplay}) session=${session?.getId() ?? '(non-live)'}`,
    );
    return finalize;
  }

  private async assertLiveSessionScope(
    config: Config,
    settings: LoadedSettings,
    cwd: string,
  ): Promise<void> {
    if (path.resolve(config.storage.getProjectRoot()) !== path.resolve(cwd)) {
      throw RequestError.invalidParams(
        undefined,
        'The live session belongs to another workspace.',
      );
    }
    const requestedRuntimeBaseDir = await this.runWithPinnedRuntimeBaseDir(
      settings,
      cwd,
      () => Storage.getRuntimeBaseDir(),
    );
    if (
      path.resolve(config.getSessionRuntimeBaseDir()) !==
      path.resolve(requestedRuntimeBaseDir)
    ) {
      throw mapSessionWriterRequestError(new SessionWriterUnavailableError());
    }
  }

  /** Expose the pool's workspace-scoped budget controller for snapshot builders. */
  getWorkspaceMcpBudget(): WorkspaceMcpBudget | undefined {
    return this.workspaceMcpBudget;
  }

  /**
   * Fan-out a workspace-scoped MCP budget event to every active
   * session's SSE bus. Each notification is independently
   * fire-and-forget.
   */
  private broadcastBudgetEvent(event: McpBudgetEvent): void {
    // The QwenAgent's `this.connection` is the single ACP channel to
    // the daemon. The daemon's bridge `bridgeClient.extNotification`
    // resolves the per-session SSE bus from the `sessionId` field of
    // each notification — so we send N notifications (one per active
    // session id) over the same connection. Each notification is
    // independently fire-and-forget; a mid-flight ACP disconnect
    // shouldn't sink delivery to siblings.
    //
    // Snapshot the session id list before the async fan-out so a
    // concurrent `killSession` can't corrupt the iterator.
    const sessionIds = Array.from(this.sessions.keys());
    for (const sid of sessionIds) {
      void this.connection
        .extNotification('qwen/notify/session/mcp-budget-event', {
          v: 1,
          sessionId: sid,
          // Tag workspace-scoped events so SDK reducers can branch.
          scope: 'workspace' as const,
          ...event,
        })
        .catch((err: unknown) => {
          debugLogger.debug(
            `MCP workspace budget event delivery to session ${sid} failed ` +
              `(kind=${event.kind}): ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
  }

  async initialize(args: InitializeRequest): Promise<InitializeResponse> {
    markAcpStartup('initializeHandlerStart');
    if (this.privateParentState === 'rejected') {
      throw RequestError.invalidParams(
        undefined,
        'Invalid private ACP parent capability',
      );
    }
    if (this.privateParentState === 'uninitialized') {
      const expectedCapability = this.expectedPrivateParentCapability;
      if (expectedCapability === undefined) {
        this.privateParentState = 'untrusted';
      } else {
        const suppliedCapability =
          args._meta?.[PRIVATE_PARENT_CAPABILITY_META_KEY];
        const suppliedBuffer =
          typeof suppliedCapability === 'string'
            ? Buffer.from(suppliedCapability)
            : undefined;
        const expectedBuffer = Buffer.from(expectedCapability);
        if (
          suppliedBuffer !== undefined &&
          suppliedBuffer.length === expectedBuffer.length &&
          timingSafeEqual(suppliedBuffer, expectedBuffer)
        ) {
          this.privateParentState = 'trusted';
        } else {
          this.privateParentState = 'rejected';
          throw RequestError.invalidParams(
            undefined,
            'Invalid private ACP parent capability',
          );
        }
      }
    }
    this.clientCapabilities = args.clientCapabilities;
    const authMethods = buildAuthMethods();
    const version = process.env['CLI_VERSION'] || process.version;

    const response: InitializeResponse = {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: 'qwen-code',
        title: 'Qwen Code',
        version,
      },
      authMethods,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: true,
          embeddedContext: true,
        },
        sessionCapabilities: {
          list: {},
          resume: {},
        },
        mcpCapabilities: {
          sse: true,
          http: true,
        },
        _meta: {
          imageCapability: IMAGE_CAPABILITY,
        },
      },
    };
    markAcpStartup('initializeHandlerEnd');
    markAcpStartup('responseBuilt');
    let startupProfile;
    try {
      startupProfile = buildAndFreezeAcpStartupProfile();
    } catch {
      startupProfile = undefined;
    }
    const requestedProfile = args._meta?.[CHANNEL_STARTUP_PROFILE_META_KEY];
    const profileRequested =
      requestedProfile !== null &&
      typeof requestedProfile === 'object' &&
      !Array.isArray(requestedProfile) &&
      (requestedProfile as Record<string, unknown>)['v'] ===
        CHANNEL_STARTUP_PROFILE_VERSION;
    const requestedActiveWork = args._meta?.[ACTIVE_WORK_HEARTBEAT_META_KEY];
    const activeWorkRequested =
      requestedActiveWork !== null &&
      typeof requestedActiveWork === 'object' &&
      !Array.isArray(requestedActiveWork) &&
      (requestedActiveWork as Record<string, unknown>)['v'] ===
        ACTIVE_WORK_HEARTBEAT_VERSION;
    // The daemon proposes a cadence; we answer with the one we will actually
    // use, clamped into the range both sides agree on. The daemon clamps the
    // echo again — neither side trusts the other to pick a sane number, and a
    // flood or a multi-hour interval would each break freshness in its own way.
    const activeWorkIntervalMs = activeWorkRequested
      ? clampActiveWorkIntervalMs(
          (requestedActiveWork as Record<string, unknown>)['intervalMs'],
        )
      : undefined;
    const requestedActiveWorkCategories = activeWorkRequested
      ? (requestedActiveWork as Record<string, unknown>)['categories']
      : undefined;
    const activeWorkCategories = activeWorkRequested
      ? Array.isArray(requestedActiveWorkCategories)
        ? ACTIVE_WORK_HOLD_CATEGORIES.filter((category) =>
            requestedActiveWorkCategories.includes(category),
          )
        : ACTIVE_WORK_LEGACY_HOLD_CATEGORIES
      : undefined;
    const requestedChannelLiveness = args._meta?.[CHANNEL_LIVENESS_META_KEY];
    const channelLivenessRequested =
      requestedChannelLiveness !== null &&
      typeof requestedChannelLiveness === 'object' &&
      !Array.isArray(requestedChannelLiveness) &&
      (requestedChannelLiveness as Record<string, unknown>)['v'] ===
        CHANNEL_LIVENESS_VERSION;
    if (activeWorkIntervalMs !== undefined) {
      this.activeWorkReporter?.dispose();
      this.activeWorkReporter = new ActiveWorkReporter(
        (method, params) => this.connection.extNotification(method, params),
        () => this.sessions.values(),
        activeWorkIntervalMs,
        activeWorkCategories ?? [],
      );
    }

    const responseMeta: Record<string, unknown> = {
      ...(this.managedToolInvocationGuard
        ? {
            [EXTERNAL_TOOL_GUARD_READY_META_KEY]:
              EXTERNAL_TOOL_GUARD_REQUIRED_VALUE,
          }
        : {}),
      ...(profileRequested && startupProfile
        ? { [CHANNEL_STARTUP_PROFILE_META_KEY]: startupProfile }
        : {}),
      ...(activeWorkIntervalMs !== undefined
        ? {
            [ACTIVE_WORK_HEARTBEAT_META_KEY]: {
              v: ACTIVE_WORK_HEARTBEAT_VERSION,
              intervalMs: activeWorkIntervalMs,
              categories: [...(activeWorkCategories ?? [])],
            },
          }
        : {}),
      ...(channelLivenessRequested
        ? {
            [CHANNEL_LIVENESS_META_KEY]: {
              v: CHANNEL_LIVENESS_VERSION,
            },
          }
        : {}),
    };
    return Object.keys(responseMeta).length > 0
      ? { ...response, _meta: responseMeta }
      : response;
  }

  async authenticate({ methodId }: AuthenticateRequest): Promise<void> {
    const method = z.nativeEnum(AuthType).parse(methodId);

    let authUri: string | undefined;
    const authUriHandler = (deviceAuth: DeviceAuthorizationData) => {
      authUri = deviceAuth.verification_uri_complete;
      void this.connection.extNotification('authenticate/update', {
        _meta: { authUri },
      });
    };

    if (method === AuthType.QWEN_OAUTH) {
      qwenOAuth2Events.once(QwenOAuth2Event.AuthUri, authUriHandler);
    }

    await clearCachedCredentialFile();
    try {
      await this.config.refreshAuth(method);
      this.settings.setValue(
        SettingScope.User,
        'security.auth.selectedType',
        method,
      );
    } finally {
      if (method === AuthType.QWEN_OAUTH) {
        qwenOAuth2Events.off(QwenOAuth2Event.AuthUri, authUriHandler);
      }
    }
  }

  private reserveStartingSessionId(sessionId: string): () => void {
    if (
      this.sessions.has(sessionId) ||
      this.startingSessionIds.has(sessionId)
    ) {
      throw new RequestError(
        ACP_ERROR_CODES.INVALID_PARAMS,
        `Session ${sessionId} is already active or starting.`,
        { errorKind: 'session_id_conflict', sessionId },
      );
    }
    this.startingSessionIds.add(sessionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.startingSessionIds.delete(sessionId);
    };
  }

  private createSessionInitializationDeadline(raw: unknown):
    | {
        signal: AbortSignal;
        dispose: () => void;
      }
    | undefined {
    if (raw === undefined || !this.isTrustedManagedParent()) return undefined;
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
      throw RequestError.invalidParams(
        { errorKind: 'invalid_session_initialization_deadline' },
        `\`_meta["${SESSION_INITIALIZATION_DEADLINE_META_KEY}"]\` must be a positive safe integer`,
      );
    }

    const remainingMs = raw - Date.now();
    if (remainingMs > 2_147_483_647) {
      throw RequestError.invalidParams(
        { errorKind: 'invalid_session_initialization_deadline' },
        `\`_meta["${SESSION_INITIALIZATION_DEADLINE_META_KEY}"]\` exceeds the supported timer range`,
      );
    }

    const controller = new AbortController();
    const timeoutError = new RequestError(
      ACP_ERROR_CODES.INTERNAL_ERROR,
      'Session initialization deadline exceeded',
      { errorKind: SESSION_INITIALIZATION_TIMEOUT_ERROR_KIND },
    );
    let timer: NodeJS.Timeout | undefined;
    if (remainingMs <= 0) {
      controller.abort(timeoutError);
    } else {
      timer = setTimeout(() => controller.abort(timeoutError), remainingMs);
      timer.unref();
    }
    return {
      signal: controller.signal,
      dispose: () => {
        if (timer) clearTimeout(timer);
      },
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const { cwd, mcpServers } = params;
    const parsedSessionId = parseCallerSuppliedSessionId(
      params._meta?.[REQUESTED_SESSION_ID_META_KEY],
    );
    if (parsedSessionId.kind === 'invalid') {
      throw new RequestError(
        ACP_ERROR_CODES.INVALID_PARAMS,
        `\`_meta["${REQUESTED_SESSION_ID_META_KEY}"]\` must be an RFC UUID v1-v5`,
        { errorKind: 'invalid_session_id', httpStatus: 400 },
      );
    }
    const requestedSessionId =
      parsedSessionId.kind === 'valid' ? parsedSessionId.sessionId : undefined;
    const releaseStartingSessionId = requestedSessionId
      ? this.reserveStartingSessionId(requestedSessionId)
      : undefined;
    let initializationDeadline:
      | { signal: AbortSignal; dispose: () => void }
      | undefined;
    try {
      initializationDeadline = this.createSessionInitializationDeadline(
        params._meta?.[SESSION_INITIALIZATION_DEADLINE_META_KEY],
      );
      initializationDeadline?.signal.throwIfAborted();
      const sessionSource = getSessionSource(params);
      const provisionalStandalone = isReservedStandaloneSessionSourceType(
        sessionSource?.sourceType,
      );
      if (
        sessionSource &&
        isReservedStandaloneSessionSourceType(sessionSource.sourceType) &&
        (sessionSource.daemonOwnedStandaloneCreation !== true ||
          !this.isTrustedManagedParent())
      ) {
        throw RequestError.invalidParams(
          undefined,
          '`standalone` is reserved for daemon-owned session creation',
        );
      }
      const parentContext = extractDaemonTraceContext(params);
      return await withDaemonSpan(
        'qwen-code.daemon.session_start',
        { 'qwen-code.daemon.operation': 'acp_session_new' },
        async (span) => {
          const profiler = createAcpSessionStartProfiler(span);
          // Per-request settings: session handlers run concurrently, and
          // `this.settings` is only a "latest loaded" cache for agent-level
          // readers. Threading the instance explicitly keeps a slow session
          // creation from picking up whichever workspace loaded last — Session
          // persists model changes through this instance, so a mix-up writes to
          // another workspace's settings.json.
          const settings = profiler.timeSync('settings_load', () =>
            loadSettingsCached(cwd),
          );
          this.settings = settings;
          const deferMcpDiscovery = shouldDeferMcpDiscovery(params);
          const config = await profiler.time('config_setup', () =>
            this.newSessionConfig(
              cwd,
              mcpServers,
              settings,
              sessionSource,
              requestedSessionId,
              undefined,
              initializationDeadline || deferMcpDiscovery
                ? {
                    ...(initializationDeadline
                      ? { signal: initializationDeadline.signal }
                      : {}),
                    ...(deferMcpDiscovery ? { skipMcpDiscovery: true } : {}),
                  }
                : undefined,
            ),
          );
          let session: Session;
          try {
            initializationDeadline?.signal.throwIfAborted();
            if (!provisionalStandalone) {
              await profiler.time('auth', () =>
                this.ensureAuthenticated(config),
              );
              initializationDeadline?.signal.throwIfAborted();
              profiler.timeSync('file_system_setup', () =>
                this.setupFileSystem(config),
              );
            }
            session = await profiler.time('session_register', () =>
              this.createAndStoreSession(config, settings, undefined, {
                deferWorkspaceActivation: provisionalStandalone,
                ...(initializationDeadline
                  ? { signal: initializationDeadline.signal }
                  : {}),
              }),
            );
          } catch (error) {
            return this.cleanupAfterRequestFailure(error, async () => {
              if (
                this.sessions
                  .get(normalizeSessionIdForLookup(config.getSessionId()))
                  ?.getConfig() !== config
              ) {
                await this.cleanupUnstoredConfig(config);
              }
            });
          }
          profiler.setSessionId(session.getId());
          return profiler.timeSync('response_build', () => ({
            sessionId: session.getId(),
            models: this.buildAvailableModels(config),
            modes: this.buildModesData(config),
            configOptions: this.buildConfigOptions(config),
          }));
        },
        parentContext ? { parentContext } : {},
      );
    } finally {
      initializationDeadline?.dispose();
      releaseStartingSessionId?.();
    }
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const sessionId = normalizeSessionIdForLookup(params.sessionId);
    const parentContext = extractDaemonTraceContext(params);
    return await withDaemonSpan(
      'qwen-code.daemon.session_restore',
      {
        'qwen-code.daemon.operation': 'acp_session_load',
        'qwen-code.daemon.session_restore.action': 'load',
        'session.id': sessionId,
      },
      async (span) =>
        this.loadSessionWithProfiler(
          params,
          sessionId,
          createAcpSessionRestoreProfiler(span),
        ),
      parentContext ? { parentContext } : {},
    );
  }

  private async loadSessionWithProfiler(
    params: LoadSessionRequest,
    initialSessionId: string,
    profiler: AcpSessionRestoreProfiler,
  ): Promise<LoadSessionResponse> {
    let sessionId = initialSessionId;
    const sessionSource = getSessionSource(params);
    const provisionalStandalone = isReservedStandaloneSessionSourceType(
      sessionSource?.sourceType,
    );
    if (
      provisionalStandalone &&
      (sessionSource?.daemonOwnedStandaloneCreation !== true ||
        !this.isTrustedManagedParent())
    ) {
      throw RequestError.invalidParams(
        undefined,
        '`standalone` is reserved for daemon-owned session restore',
      );
    }
    const restoreOptions = loadRestoreOptions(params);
    // The daemon already knows it will decline the re-hang (no attached
    // client, fork restore): emit no hint and don't skip finalizing the
    // trailing ask_user_question during replay, so skip and re-hang stay
    // in lockstep.
    const suppressRestoreAskUserQuestion =
      (params._meta as Record<string, unknown> | null | undefined)?.[
        DAEMON_SUPPRESS_RESTORE_ASK_USER_QUESTION_META_KEY
      ] === true;
    const withRestoreHint = <
      T extends { _meta?: Record<string, unknown> | null },
    >(
      session: Session | undefined,
      response: T,
    ): T =>
      suppressRestoreAskUserQuestion
        ? response
        : this.withAskUserQuestionRestoreHint(session, response);
    const liveSession = this.sessions.get(sessionId);
    if (liveSession) {
      const settings = profiler.timeSync('settings_load', () =>
        loadSettingsCached(params.cwd),
      );
      const liveConfig = liveSession.getConfig();
      return profiler.time('live_restore', async () => {
        await this.assertLiveSessionScope(liveConfig, settings, params.cwd);
        return this.withLiveSessionRestore(
          sessionId,
          liveSession,
          restoreOptions,
          async (config, projection) => {
            const response = profiler.timeSync(
              'response_build',
              () =>
                ({
                  modes: this.buildModesData(config),
                  models: this.buildAvailableModels(config),
                  configOptions: this.buildConfigOptions(config),
                  ...(projection?.artifactSnapshot
                    ? { artifactSnapshot: projection.artifactSnapshot }
                    : {}),
                }) as LoadSessionResponse,
            );
            const replayPage = projection?.replay;
            if (!replayPage || replayPage.records.length === 0) {
              return withRestoreHint(liveSession, response);
            }

            const bulkReplay = isBulkLoadReplayRequest(params);
            const replay = await profiler.time('history_replay', () =>
              collectHistoryReplayUpdates({
                sessionId,
                config,
                records: replayPage.records,
                gaps: replayPage.gaps,
                cumulativeUsage: createReplayCumulativeUsage(),
                replayState: replayPage.replay,
                goalBootstrap: replayGoalBootstrap(projection),
                suppressRestoreAskUserQuestion,
                // The restore gate already drained active turns and blocks
                // new ones (and a drain timeout rejects before replay), so
                // a trailing unmatched call here is genuinely abandoned —
                // finalize it. The turn-activity guard cannot be sampled
                // under the gate: isTurnIdle() is structurally false while
                // the close gate is held (#9704).
                finalizeDangling: true,
                ...(restoreOptions.replay.kind === 'recent'
                  ? {
                      limits: {
                        maxBytes: LOAD_REPLAY_MAX_BYTES,
                        maxUpdates: LOAD_REPLAY_MAX_UPDATES,
                      },
                    }
                  : {}),
                logger: debugLogger,
              }),
            );
            addDaemonRequestAttribute(
              'qwen-code.daemon.session_restore.partial_replay',
              replay.replayError !== undefined,
            );
            if (!bulkReplay) {
              try {
                for (const update of replay.updates) {
                  await liveSession.sendUpdate(update);
                }
              } finally {
                // Replayed plan updates re-stamp the revision via sendUpdate;
                // drop it so a replayed snapshot cannot bind a later approval
                // (same rule Session.replayHistory applies to cold loads),
                // even if delivery fails part-way. The bulk path keeps a live
                // binding on purpose: it hands the updates to the client
                // instead of replaying them through this session.
                liveSession.clearActiveTodoPlanRevision();
              }
              if (replay.replayError !== undefined) {
                throw RequestError.internalError(undefined, replay.replayError);
              }
              return withRestoreHint(liveSession, response);
            }

            const envelope: BridgeLoadReplayEnvelope = {
              v: LOAD_REPLAY_VERSION,
              updates: replay.updates,
              ...(replayPage.anchorRecordId
                ? { anchorRecordId: replayPage.anchorRecordId }
                : {}),
              ...(replay.replayError !== undefined
                ? {
                    partial: true,
                    replayError: replay.replayError,
                  }
                : {}),
              ...(replayPage.hasMore ? { hasMore: true } : {}),
            };
            validateLoadReplayEnvelope(
              sessionId,
              envelope,
              restoreOptions.replay.kind === 'recent',
            );
            return withRestoreHint(liveSession, {
              ...response,
              _meta: {
                [LOAD_REPLAY_META_KEY]: envelope,
              },
            });
          },
        );
      });
    }
    const releaseStartingSessionId = this.reserveStartingSessionId(sessionId);
    try {
      // Load per-request settings only after reserving a non-live id. The check
      // must resolve `advanced.runtimeOutputDir` from this request's cwd.
      const settings = profiler.timeSync('settings_load', () =>
        loadSettingsCached(params.cwd),
      );
      const persistedSessionId = await profiler.time('existence_check', () =>
        this.runWithPinnedRuntimeBaseDir(settings, params.cwd, async () => {
          const sessionService = new SessionService(params.cwd);
          return resolvePersistedSessionIdForRestore(sessionService, sessionId);
        }),
      );
      if (!persistedSessionId) {
        profiler.fail('existence_check');
        throw RequestError.resourceNotFound(`session:${sessionId}`);
      }
      sessionId = persistedSessionId;
      profiler.setSessionId(sessionId);
      // Adopt into the "latest loaded" cache only once the session is
      // confirmed — a failed probe for a stale id must not repoint
      // agent-level readers at this request's workspace.
      this.settings = settings;

      const config = await profiler.time('config_setup', () =>
        this.newSessionConfig(
          params.cwd,
          // `LoadSessionRequest.mcpServers` is required in today's ACP
          // schema, but mirror `unstable_resumeSession` and tolerate a
          // future loosening — `newSessionConfig` iterates the list, so
          // a `null`/`undefined` would otherwise throw `TypeError`.
          params.mcpServers ?? [],
          settings,
          sessionSource,
          sessionId,
          true,
          {},
          undefined,
          restoreOptions,
        ),
      );
      if (suppressRestoreAskUserQuestion) {
        config.suppressRestorableAskUserQuestionPreservation();
      }
      const projection = config.consumeSessionRestoreProjection?.();
      const suppressRecoveredGoalPresentation =
        projection?.runtime.goalRecoverySourceUuid !== undefined &&
        projection.runtime.goalRecoverySourceUuid !==
          projection.replay?.goalRecoverySourceUuid;
      const bulkReplay = isBulkLoadReplayRequest(params);
      let replayEnvelope: BridgeLoadReplayEnvelope | undefined;
      const replayUsage = createReplayCumulativeUsage();
      let recoveredGoalPublicationKey: string | undefined;
      let suppressedRecoveredGoalId: string | undefined;
      let streamGoalUpdates: SessionUpdate[] = [];
      let response: LoadSessionResponse | undefined;
      const buildResponse = () =>
        profiler.timeSync('response_build', () => ({
          modes: this.buildModesData(config),
          models: this.buildAvailableModels(config),
          configOptions: this.buildConfigOptions(config),
          ...(projection?.runtime.artifactSnapshot
            ? { artifactSnapshot: projection.runtime.artifactSnapshot }
            : {}),
          ...(replayEnvelope
            ? {
                _meta: {
                  [LOAD_REPLAY_META_KEY]: replayEnvelope,
                },
              }
            : {}),
        })) as LoadSessionResponse;
      try {
        if (!provisionalStandalone) {
          await profiler.time('restore_session_model', () =>
            restoreSessionModelThenAuthenticate(config, projection, () =>
              profiler.time('auth', () => this.ensureAuthenticated(config)),
            ),
          );
          profiler.timeSync('file_system_setup', () =>
            this.setupFileSystem(config),
          );
        }
        await profiler.time('session_register', () =>
          this.createAndStoreSession(config, settings, undefined, {
            deferWorkspaceActivation: provisionalStandalone,
            ...(provisionalStandalone
              ? {
                  beforeDeferredWorkspaceActivation: () =>
                    profiler.time('restore_session_model', () =>
                      restoreSessionModelThenAuthenticate(
                        config,
                        projection,
                        () =>
                          profiler.time('auth', () =>
                            this.ensureAuthenticated(config),
                          ),
                      ),
                    ),
                }
              : {}),
            enableLiveScreenContext: isCompatibleLiveSessionSource(
              sessionSource ?? {},
            ),
            replayHistory: false,
            prepareBeforeSessionCreate: async () => {
              if (bulkReplay && projection?.replay) {
                const replay = await profiler.time('history_replay', () =>
                  collectHistoryReplayUpdates({
                    sessionId,
                    config,
                    records: projection.replay!.records,
                    gaps: projection.replay!.gaps,
                    cumulativeUsage: replayUsage,
                    replayState: projection.replay!.replay,
                    goalBootstrap: replayGoalBootstrap(projection),
                    suppressRestoreAskUserQuestion,
                    ...(restoreOptions.replay.kind === 'recent'
                      ? {
                          limits: {
                            maxBytes: LOAD_REPLAY_MAX_BYTES,
                            maxUpdates: LOAD_REPLAY_MAX_UPDATES,
                          },
                        }
                      : {}),
                    logger: debugLogger,
                  }),
                );
                addDaemonRequestAttribute(
                  'qwen-code.daemon.session_restore.partial_replay',
                  replay.replayError !== undefined,
                );
                replayEnvelope = {
                  v: LOAD_REPLAY_VERSION,
                  updates: replay.updates,
                  ...(projection.replay.anchorRecordId
                    ? { anchorRecordId: projection.replay.anchorRecordId }
                    : {}),
                  ...(replay.replayError !== undefined
                    ? {
                        partial: true,
                        replayError: replay.replayError,
                      }
                    : {}),
                  ...(projection.replay.hasMore ? { hasMore: true } : {}),
                };
                validateLoadReplayEnvelope(
                  sessionId,
                  replayEnvelope,
                  restoreOptions.replay.kind === 'recent',
                );
              }
              const goalBootstrap = replayGoalBootstrap(projection);
              const rendered = await renderPreparedGoalUpdate(
                () => config.getGoalRuntimePrepared(),
                {
                  ...(projection?.replay?.records
                    ? { replayedRecords: projection.replay.records }
                    : {}),
                  ...(suppressRecoveredGoalPresentation
                    ? { hideRuntimeGoal: true }
                    : {}),
                  ...(goalBootstrap ? { bootstrap: goalBootstrap } : {}),
                },
              ).catch((error) => {
                if (suppressRecoveredGoalPresentation) throw error;
                debugLogger.debug(
                  `Failed to render recovered Goal state: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
                return {
                  publicationKey: undefined,
                  suppressedGoalId: undefined,
                  updates: [],
                };
              });
              recoveredGoalPublicationKey = rendered.publicationKey;
              suppressedRecoveredGoalId = rendered.suppressedGoalId;
              if (!bulkReplay) {
                streamGoalUpdates = rendered.updates;
                return;
              }
              const goalUpdates = rendered.updates;
              if (goalUpdates.length > 0) {
                replayEnvelope ??= {
                  v: LOAD_REPLAY_VERSION,
                  updates: [],
                };
                replayEnvelope.updates.push(...goalUpdates);
                validateLoadReplayEnvelope(
                  sessionId,
                  replayEnvelope,
                  restoreOptions.replay.kind === 'recent',
                );
              }
            },
            beforeSessionCreate: () => {
              response = buildResponse();
            },
            primeSession: (createdSession) => {
              profiler.timeSync('runtime_initialize', () => {
                if (!projection) return;
                createdSession.primeTurnState(
                  projection.runtime.initialTurn,
                  projection.runtime.backgroundNotificationTaskIds,
                );
                copyCumulativeUsage(
                  createdSession.cumulativeUsage,
                  replayUsage,
                );
                createdSession.primeRecoveredGoalPublication(
                  recoveredGoalPublicationKey,
                  suppressedRecoveredGoalId,
                );
              });
            },
            beforeStartPostReplayServices: async (createdSession) => {
              if (!bulkReplay && projection?.replay) {
                await profiler.time('history_replay', async () => {
                  const goalBootstrap = replayGoalBootstrap(projection);
                  const initialGoalState = replayInitialGoalState(projection);
                  const hasGoalReplayState =
                    goalBootstrap !== undefined ||
                    initialGoalState.initialGoalState !== undefined ||
                    initialGoalState.initialGoalCause !== undefined;
                  if (hasGoalReplayState) {
                    await createdSession.replayHistory(
                      projection.replay!.records,
                      projection.replay!.gaps,
                      {
                        ...(goalBootstrap ? { goalBootstrap } : {}),
                        ...initialGoalState,
                        ...(suppressRestoreAskUserQuestion
                          ? { skipFinalizeCallIds: undefined }
                          : {}),
                      },
                    );
                  } else if (suppressRestoreAskUserQuestion) {
                    await createdSession.replayHistory(
                      projection.replay!.records,
                      projection.replay!.gaps,
                      { skipFinalizeCallIds: undefined },
                    );
                  } else {
                    await createdSession.replayHistory(
                      projection.replay!.records,
                      projection.replay!.gaps,
                    );
                  }
                });
                try {
                  for (const update of streamGoalUpdates) {
                    await createdSession.sendUpdate(update);
                  }
                } catch (error) {
                  debugLogger.debug(
                    `Failed to publish recovered Goal state: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  );
                }
              }
              await profiler.time('post_replay_services', async () => {
                if (!provisionalStandalone) {
                  await this.#restoreWorktreeOnResume(config, createdSession);
                }
                await this.#restoreBackgroundAgentsOnResume(
                  config,
                  createdSession,
                );
              });
            },
          }),
        );
      } catch (error) {
        return this.cleanupAfterRequestFailure(
          error,
          async () => {
            if (
              this.sessions
                .get(normalizeSessionIdForLookup(config.getSessionId()))
                ?.getConfig() !== config
            ) {
              await this.cleanupUnstoredConfig(config);
            }
          },
          sessionId,
        );
      }
      return withRestoreHint(
        this.sessions.get(normalizeSessionIdForLookup(sessionId)),
        response!,
      );
    } finally {
      releaseStartingSessionId();
    }
  }

  async unstable_resumeSession(
    params: ResumeSessionRequest,
  ): Promise<ResumeSessionResponse> {
    const sessionId = normalizeSessionIdForLookup(params.sessionId);
    const parentContext = extractDaemonTraceContext(params);
    return await withDaemonSpan(
      'qwen-code.daemon.session_restore',
      {
        'qwen-code.daemon.operation': 'acp_session_resume',
        'qwen-code.daemon.session_restore.action': 'resume',
        'session.id': sessionId,
      },
      async (span) =>
        this.resumeSessionWithProfiler(
          params,
          sessionId,
          createAcpSessionRestoreProfiler(span),
        ),
      parentContext ? { parentContext } : {},
    );
  }

  private async resumeSessionWithProfiler(
    params: ResumeSessionRequest,
    initialSessionId: string,
    profiler: AcpSessionRestoreProfiler,
  ): Promise<ResumeSessionResponse> {
    let sessionId = initialSessionId;
    const sessionSource = getSessionSource(params);
    const provisionalStandalone = isReservedStandaloneSessionSourceType(
      sessionSource?.sourceType,
    );
    if (
      provisionalStandalone &&
      (sessionSource?.daemonOwnedStandaloneCreation !== true ||
        !this.isTrustedManagedParent())
    ) {
      throw RequestError.invalidParams(
        undefined,
        '`standalone` is reserved for daemon-owned session restore',
      );
    }
    // Same daemon-decline suppression as loadSessionWithProfiler: no hint,
    // and the replay finalize-skip stays aligned with the re-hang decision.
    const suppressRestoreAskUserQuestion =
      (params._meta as Record<string, unknown> | null | undefined)?.[
        DAEMON_SUPPRESS_RESTORE_ASK_USER_QUESTION_META_KEY
      ] === true;
    const withRestoreHint = <
      T extends { _meta?: Record<string, unknown> | null },
    >(
      session: Session | undefined,
      response: T,
    ): T =>
      suppressRestoreAskUserQuestion
        ? response
        : this.withAskUserQuestionRestoreHint(session, response);
    const liveSession = this.sessions.get(sessionId);
    if (liveSession) {
      const settings = profiler.timeSync('settings_load', () =>
        loadSettingsCached(params.cwd),
      );
      const liveConfig = liveSession.getConfig();
      return profiler.time('live_restore', async () => {
        await this.assertLiveSessionScope(liveConfig, settings, params.cwd);
        return this.withLiveSessionRestore(
          sessionId,
          liveSession,
          RESUME_RESTORE_OPTIONS,
          async (config, projection) =>
            withRestoreHint(
              liveSession,
              profiler.timeSync(
                'response_build',
                () =>
                  ({
                    modes: this.buildModesData(config),
                    models: this.buildAvailableModels(config),
                    configOptions: this.buildConfigOptions(config),
                    ...(projection?.artifactSnapshot
                      ? { artifactSnapshot: projection.artifactSnapshot }
                      : {}),
                  }) as ResumeSessionResponse,
              ),
            ),
        );
      });
    }
    const releaseStartingSessionId = this.reserveStartingSessionId(sessionId);
    try {
      // Same per-request settings discipline as `loadSession`.
      const settings = profiler.timeSync('settings_load', () =>
        loadSettingsCached(params.cwd),
      );
      const persistedSessionId = await profiler.time('existence_check', () =>
        this.runWithPinnedRuntimeBaseDir(settings, params.cwd, async () => {
          const sessionService = new SessionService(params.cwd);
          return resolvePersistedSessionIdForRestore(sessionService, sessionId);
        }),
      );
      if (!persistedSessionId) {
        profiler.fail('existence_check');
        throw RequestError.resourceNotFound(`session:${sessionId}`);
      }
      sessionId = persistedSessionId;
      profiler.setSessionId(sessionId);
      this.settings = settings;

      const config = await profiler.time('config_setup', () =>
        this.newSessionConfig(
          params.cwd,
          params.mcpServers ?? [],
          settings,
          sessionSource,
          sessionId,
          true,
          {},
          undefined,
          RESUME_RESTORE_OPTIONS,
        ),
      );
      if (suppressRestoreAskUserQuestion) {
        config.suppressRestorableAskUserQuestionPreservation();
      }
      const projection = config.consumeSessionRestoreProjection?.();
      let response: ResumeSessionResponse | undefined;
      try {
        if (!provisionalStandalone) {
          await profiler.time('restore_session_model', () =>
            restoreSessionModelThenAuthenticate(config, projection, () =>
              profiler.time('auth', () => this.ensureAuthenticated(config)),
            ),
          );
          profiler.timeSync('file_system_setup', () =>
            this.setupFileSystem(config),
          );
        }
        await profiler.time('session_register', () =>
          this.createAndStoreSession(config, settings, undefined, {
            deferWorkspaceActivation: provisionalStandalone,
            ...(provisionalStandalone
              ? {
                  beforeDeferredWorkspaceActivation: () =>
                    profiler.time('restore_session_model', () =>
                      restoreSessionModelThenAuthenticate(
                        config,
                        projection,
                        () =>
                          profiler.time('auth', () =>
                            this.ensureAuthenticated(config),
                          ),
                      ),
                    ),
                }
              : {}),
            enableLiveScreenContext: isCompatibleLiveSessionSource(
              sessionSource ?? {},
            ),
            replayHistory: false,
            beforeSessionCreate: () => {
              response = profiler.timeSync('response_build', () => ({
                modes: this.buildModesData(config),
                models: this.buildAvailableModels(config),
                configOptions: this.buildConfigOptions(config),
                ...(projection?.runtime.artifactSnapshot
                  ? { artifactSnapshot: projection.runtime.artifactSnapshot }
                  : {}),
              })) as ResumeSessionResponse;
            },
            primeSession: (createdSession) => {
              profiler.timeSync('runtime_initialize', () => {
                if (!projection) return;
                createdSession.primeTurnState(
                  projection.runtime.initialTurn,
                  projection.runtime.backgroundNotificationTaskIds,
                );
              });
            },
            beforeStartPostReplayServices: async (createdSession) => {
              await profiler.time('post_replay_services', async () => {
                if (!provisionalStandalone) {
                  await this.#restoreWorktreeOnResume(config, createdSession);
                }
                await this.#restoreBackgroundAgentsOnResume(
                  config,
                  createdSession,
                );
              });
            },
          }),
        );
      } catch (error) {
        return this.cleanupAfterRequestFailure(
          error,
          async () => {
            if (
              this.sessions
                .get(normalizeSessionIdForLookup(config.getSessionId()))
                ?.getConfig() !== config
            ) {
              await this.cleanupUnstoredConfig(config);
            }
          },
          sessionId,
        );
      }

      return withRestoreHint(
        this.sessions.get(normalizeSessionIdForLookup(sessionId)),
        response!,
      );
    } finally {
      releaseStartingSessionId();
    }
  }

  /**
   * Shared worktree restore for both ACP entry points (`loadSession` and
   * `unstable_resumeSession`). Best-effort: failures don't block session
   * load — worktree context is a hint to the model, not a correctness
   * requirement.
   */
  async #restoreWorktreeOnResume(
    config: Config,
    session: Session,
  ): Promise<void> {
    try {
      const sessionPath = config
        .getSessionService()
        .getWorktreeSessionPath(config.getSessionId());
      const restored = await restoreWorktreeContext(sessionPath);
      if (restored.contextMessage) {
        session.pendingWorktreeNotice = restored.contextMessage;
      }
    } catch (error) {
      debugLogger.warn(`ACP worktree restore failed: ${error}`);
    }
  }

  async #restoreBackgroundAgentsOnResume(
    config: Config,
    session: Session,
  ): Promise<void> {
    await config.loadPausedBackgroundAgents(config.getSessionId());
    session.pendingRecoveredAgentsNotice =
      config.consumePendingRecoveredAgentsNotice();
  }

  async unstable_listSessions(
    params: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    const cwd = params.cwd || process.cwd();
    const numericCursor = parseAcpSessionListCursor(params.cursor);

    // The ACP spec's ListSessionsRequest doesn't include a page-size field,
    // so the SDK's zod validator strips any top-level `size` the client sends
    // before it reaches this handler. Carry page size through `_meta.size`
    // (same pattern filesystem.ts uses for `_meta.bom` / `_meta.encoding`).
    const size = normalizeAcpSessionListSize(params._meta?.['size']);

    const result = await runWithAcpRuntimeOutputDir(this.settings, cwd, () => {
      const sessionService = new SessionService(cwd);
      return sessionService.listSessions({
        cursor: numericCursor,
        size,
      });
    });

    const sessions: SessionInfo[] = result.items.map((item) => ({
      _meta: {
        createdAt: item.startTime,
        startTime: item.startTime,
        preview: item.prompt,
        ...(item.gitBranch ? { gitBranch: item.gitBranch } : {}),
        ...(item.titleSource ? { titleSource: item.titleSource } : {}),
      },
      cwd: item.cwd,
      sessionId: item.sessionId,
      title: item.customTitle || item.prompt || '(session)',
      updatedAt: new Date(item.mtime).toISOString(),
    }));

    return {
      sessions,
      nextCursor:
        result.nextCursor != null ? String(result.nextCursor) : undefined,
    };
  }

  async setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse | void> {
    const sessionId = normalizeSessionIdForLookup(params.sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Session not found for id: ${sessionId}`,
      );
    }
    return this.runInSessionContext(session, () =>
      session.setMode({ ...params, sessionId }),
    );
  }

  async unstable_setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse | void> {
    const sessionId = normalizeSessionIdForLookup(params.sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Session not found for id: ${sessionId}`,
      );
    }
    return await this.runInSessionContext(session, () =>
      session.setModel({ ...params, sessionId }),
    );
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const sessionId = normalizeSessionIdForLookup(params.sessionId);
    const { configId, value } = params;

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Session not found for id: ${sessionId}`,
      );
    }

    return this.runInSessionContext(session, async () => {
      switch (configId) {
        case 'mode': {
          await this.setSessionMode({
            sessionId,
            modeId: value as string,
          });
          break;
        }
        case 'model': {
          await session.setModel(
            {
              sessionId,
              modelId: value as string,
            },
            { persistDefault: false },
          );
          break;
        }
        case 'reasoning_effort': {
          const generation = session.getConfig().getContentGeneratorConfig();
          const thinkingMandatory = generation.thinkingMandatory === true;
          const modelReasoning = this.getModelReasoningConfiguration(
            session.getConfig(),
          );
          if (modelReasoning) {
            const effortValues = modelReasoning.toggleOnly
              ? undefined
              : modelReasoning.efforts;
            const selected =
              value === REASONING_EFFORT_NONE && !thinkingMandatory
                ? REASONING_EFFORT_NONE
                : modelReasoning.toggleOnly
                  ? value === REASONING_EFFORT_DEFAULT
                    ? REASONING_EFFORT_DEFAULT
                    : undefined
                  : effortValues?.find((effort) => effort === value);
            if (!selected) {
              const choices = [
                ...(thinkingMandatory ? [] : [REASONING_EFFORT_NONE]),
                ...(effortValues ?? [REASONING_EFFORT_DEFAULT]),
              ];
              throw RequestError.invalidParams(
                undefined,
                `Unknown reasoning effort: ${value}. Choose one of: ${choices.join(', ')}`,
              );
            }
            if (!modelReasoning.toggleOnly) {
              for (const source of ['extra_body', 'samplingParams'] as const) {
                const layer = generation[source];
                if (!layer) continue;
                const next = { ...layer };
                delete next['enable_thinking'];
                delete next['reasoning_effort'];
                delete next['thinking_budget'];
                generation[source] = next;
              }
            }
            if (selected === REASONING_EFFORT_NONE) {
              generation.reasoning = false;
            } else if (selected === REASONING_EFFORT_DEFAULT) {
              generation.reasoning = undefined;
            } else {
              const current = generation.reasoning;
              generation.reasoning = {
                ...(current || {}),
                effort: selected,
              };
            }
            break;
          }
          const effort =
            value === REASONING_EFFORT_DEFAULT
              ? undefined
              : REASONING_EFFORT_TIERS.find((tier) => tier === value);
          if (value !== REASONING_EFFORT_DEFAULT && effort === undefined) {
            throw RequestError.invalidParams(
              undefined,
              `Unknown reasoning effort: ${value}. Choose one of: ${REASONING_EFFORT_DEFAULT}, ${REASONING_EFFORT_TIERS.join(', ')}`,
            );
          }
          if (!applyReasoningEffort(session.getConfig(), effort)) {
            throw RequestError.invalidParams(
              undefined,
              'Reasoning effort cannot be applied while thinking is disabled',
            );
          }
          break;
        }
        default:
          throw RequestError.invalidParams(
            undefined,
            `Unsupported configId: ${configId}`,
          );
      }

      return {
        configOptions: this.buildConfigOptions(session.getConfig()),
      };
    });
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const sessionId = normalizeSessionIdForLookup(params.sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const sanitizedParams = { ...params, sessionId };
    const meta =
      params._meta && typeof params._meta === 'object'
        ? { ...params._meta }
        : {};
    const suppliedContext = meta[INVOCATION_CONTEXT_META_KEY];
    const suppliedModelPrompt = meta[DAEMON_MODEL_PROMPT_META_KEY];
    const suppliedPromptDisplayText = meta[DAEMON_PROMPT_DISPLAY_TEXT_META_KEY];
    const suppliedChannelPrompt = meta[CHANNEL_PROMPT_META_KEY];
    const suppliedChannelDelivery = meta[DAEMON_CHANNEL_DELIVERY_META_KEY];
    delete meta[INVOCATION_CONTEXT_META_KEY];
    delete meta[DAEMON_MODEL_PROMPT_META_KEY];
    delete meta[PRIVATE_PARENT_CAPABILITY_META_KEY];
    delete meta[DAEMON_PROMPT_DISPLAY_TEXT_META_KEY];
    delete meta[CHANNEL_PROMPT_META_KEY];
    delete meta[DAEMON_CHANNEL_DELIVERY_META_KEY];
    // The user-facing display projection is caller-controlled metadata; honor
    // it only for trusted parents (the daemon bridge re-injects the trusted
    // channel-worker value here). A plain delete would drop that re-injection.
    if (
      this.privateParentState === 'trusted' &&
      typeof suppliedPromptDisplayText === 'string'
    ) {
      meta[DAEMON_PROMPT_DISPLAY_TEXT_META_KEY] = suppliedPromptDisplayText;
    }
    // Channel classification is trusted-parent metadata: only the channel
    // bridges and the daemon bridge hold the private parent capability. An
    // untrusted caller must not be able to mark its own prompt as a channel
    // turn — that opts the turn out of loop-detected rejection and the
    // repeated-failure guard.
    if (
      this.privateParentState === 'trusted' &&
      suppliedChannelPrompt === true
    ) {
      meta[CHANNEL_PROMPT_META_KEY] = true;
    }
    // Channel delivery is a daemon-managed side effect (the prompt route
    // injects it from the trusted context); an untrusted direct-ACP caller
    // must not self-schedule its own response delivery through the key.
    if (
      this.privateParentState === 'trusted' &&
      suppliedChannelDelivery !== undefined
    ) {
      meta[DAEMON_CHANNEL_DELIVERY_META_KEY] = suppliedChannelDelivery;
    }
    if (Object.keys(meta).length > 0) {
      sanitizedParams._meta = meta;
    } else {
      delete sanitizedParams._meta;
    }

    const invocationContext =
      this.privateParentState === 'trusted' && suppliedContext !== undefined
        ? parseInvocationContext(suppliedContext)
        : undefined;
    if (
      this.privateParentState === 'trusted' &&
      suppliedContext !== undefined &&
      invocationContext === undefined
    ) {
      throw RequestError.invalidParams(
        undefined,
        'Invalid trusted ACP invocation context',
      );
    }
    const modelPrompt =
      this.privateParentState === 'trusted' &&
      suppliedModelPrompt !== undefined &&
      isValidTrustedModelPrompt(suppliedModelPrompt)
        ? suppliedModelPrompt
        : undefined;
    if (
      this.privateParentState === 'trusted' &&
      suppliedModelPrompt !== undefined &&
      modelPrompt === undefined
    ) {
      throw RequestError.invalidParams(
        undefined,
        'Invalid trusted ACP model prompt',
      );
    }
    let settleCall = () => {};
    const call: ActivePromptCall = {
      controller: new AbortController(),
      settled: new Promise<void>((resolve) => {
        settleCall = resolve;
      }),
    };
    let calls = this.activePromptCalls.get(sessionId);
    if (!calls) {
      calls = new Set();
      this.activePromptCalls.set(sessionId, calls);
    }
    calls.add(call);
    try {
      return await session.prompt(
        sanitizedParams,
        invocationContext,
        call.controller.signal,
        modelPrompt,
      );
    } finally {
      calls.delete(call);
      if (calls.size === 0) {
        this.activePromptCalls.delete(sessionId);
      }
      settleCall();
      // Order a fresh snapshot ahead of this response on the same stream. The
      // daemon drops its own pending-prompt count the instant the response
      // lands, so any hold this prompt left behind — a background agent it
      // started, a background shell, or a terminal notification — has to
      // already be on the wire or the daemon sees an idle Session for as long
      // as the next report takes.
      await this.activeWorkReporter?.flush();
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const sessionId = normalizeSessionIdForLookup(params.sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.runInSessionContext(session, async () => {
      try {
        await session.cancelPendingPrompt();
      } catch (error) {
        if (!isNotCurrentlyGeneratingCancelError(error)) {
          throw error;
        }
      }
      // Prompt calls still waiting at Session admission are tracked in
      // activePromptCalls but have no session pendingPrompt yet, so
      // cancelPendingPrompt cannot see them. Abort their controllers too, or a
      // cancelled prompt would run in full once admission frees.
      for (const call of this.activePromptCalls.get(sessionId) ?? []) {
        call.controller.abort();
      }
    });
  }

  private loadPermissionSettings(cwd: string): LoadedSettings {
    this.settings = loadSettings(cwd);
    return this.settings;
  }

  private async buildCoreSettings(
    settings: LoadedSettings,
    cwd: string,
  ): Promise<Record<string, unknown>> {
    const userSettings = settings.user.settings as Record<string, unknown>;
    const workspaceSettings = settings.workspace.settings as Record<
      string,
      unknown
    >;
    const mergedSettings = settings.merged as Record<string, unknown>;

    let extensions: ReturnType<ExtensionManager['getLoadedExtensions']> = [];
    try {
      const extensionManager = new ExtensionManager({
        workspaceDir: cwd,
        isWorkspaceTrusted: settings.isTrusted,
        locale: getCurrentLanguage(),
      });
      await extensionManager.refreshCache();
      extensions = extensionManager.getLoadedExtensions();
    } catch (error) {
      debugLogger.warn(
        'Extension loading failed, continuing without extensions:',
        error,
      );
    }

    const extensionEntries = await Promise.all(
      extensions.map(async (extension) => {
        const userEnv = await getScopedEnvContents(
          extension.config,
          extension.id,
          ExtensionSettingScope.USER,
        );
        const workspaceEnv = await getScopedEnvContents(
          extension.config,
          extension.id,
          ExtensionSettingScope.WORKSPACE,
        );
        const settingDefs = extension.settings ?? [];
        return {
          id: extension.id,
          name: extension.name,
          displayName: extension.displayName,
          version: extension.version,
          isActive: extension.isActive,
          path: extension.path,
          commands: extension.commands ?? [],
          skills: (extension.skills ?? []).map((skill) => skill.name),
          mcpServers: Object.keys(extension.config.mcpServers ?? {}),
          settings: settingDefs.map((setting) => {
            const userValue = userEnv[setting.envVar];
            const workspaceValue = workspaceEnv[setting.envVar];
            const hasWorkspaceValue = workspaceValue !== undefined;
            const hasUserValue = userValue !== undefined;
            const effectiveValue = hasWorkspaceValue
              ? workspaceValue
              : userValue;
            const effectiveScope = hasWorkspaceValue
              ? 'workspace'
              : hasUserValue
                ? 'user'
                : undefined;
            return {
              name: setting.name,
              description: setting.description,
              envVar: setting.envVar,
              sensitive: !!setting.sensitive,
              userValue: setting.sensitive ? undefined : userValue,
              workspaceValue: setting.sensitive ? undefined : workspaceValue,
              effectiveValue: setting.sensitive ? undefined : effectiveValue,
              effectiveScope,
              hasUserValue,
              hasWorkspaceValue,
            };
          }),
        };
      }),
    );

    const activeExtensions = extensions.filter(
      (extension) => extension.isActive,
    );
    const extensionMcpServers = activeExtensions.flatMap((extension) =>
      readMcpServers(
        { mcpServers: extension.config.mcpServers ?? {} },
        'extension',
      ).map((entry) => ({
        ...entry,
        server: {
          ...entry.server,
          extensionName: extension.displayName ?? extension.name,
        },
      })),
    );
    const extensionHooks = activeExtensions.flatMap((extension) =>
      readHooks(
        { hooks: extension.hooks ?? {} },
        'extension',
        extension.displayName ?? extension.name,
      ),
    );

    // Build the merged MCP/hook lists from the user and workspace settings
    // separately so each entry keeps its real scope label. Reading
    // mergedSettings with a single 'workspace' label mislabeled user-scope
    // servers/hooks. MCP servers are keyed by name, so dedupe with workspace
    // overriding user (matching the merged/effective semantics); hooks stack
    // across scopes, so they are concatenated.
    const mergedMcpByName = new Map<
      string,
      ReturnType<typeof readMcpServers>[number]
    >();
    for (const entry of readMcpServers(userSettings, 'user')) {
      mergedMcpByName.set(entry.name, entry);
    }
    if (settings.isTrusted) {
      for (const entry of readMcpServers(workspaceSettings, 'workspace')) {
        mergedMcpByName.set(entry.name, entry);
      }
    }
    const mergedHooks = [
      ...readHooks(userSettings, 'user'),
      ...(settings.isTrusted ? readHooks(workspaceSettings, 'workspace') : []),
    ];

    return {
      user: {
        path: settings.user.path,
        values: readCoreSettingValues(userSettings),
        mcpServers: readMcpServers(userSettings, 'user'),
        hooks: readHooks(userSettings, 'user'),
      },
      workspace: {
        path: settings.workspace.path,
        values: readCoreSettingValues(workspaceSettings),
        mcpServers: readMcpServers(workspaceSettings, 'workspace'),
        hooks: readHooks(workspaceSettings, 'workspace'),
      },
      merged: {
        values: readCoreSettingValues(mergedSettings),
        mcpServers: [...mergedMcpByName.values(), ...extensionMcpServers],
        hooks: [...mergedHooks, ...extensionHooks],
      },
      extensions: extensionEntries,
      isTrusted: settings.isTrusted,
    };
  }

  private syncLivePermissionManagers(
    before: PermissionRuleSet,
    after: PermissionRuleSet,
  ): void {
    for (const ruleType of PERMISSION_RULE_TYPES) {
      const oldRules = new Set(before[ruleType]);
      const newRules = new Set(after[ruleType]);
      const removed = before[ruleType].filter((rule) => !newRules.has(rule));
      const added = after[ruleType].filter((rule) => !oldRules.has(rule));

      if (removed.length === 0 && added.length === 0) continue;

      for (const session of this.sessions.values()) {
        const pm = session.getConfig().getPermissionManager?.();
        if (!pm) continue;
        // Isolate per-session failures: a stale/broken permission manager for
        // one session must not abort syncing the rest (settings are already
        // persisted, so the in-memory sync is best-effort).
        try {
          for (const rule of removed) {
            pm.removePersistentRule(rule, ruleType);
          }
          for (const rule of added) {
            pm.addPersistentRule(rule, ruleType);
          }
        } catch (error) {
          debugLogger.warn(
            `Failed to sync permission rules to a live session: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  }

  private workspaceCwd(config: Config): string {
    return config.getTargetDir();
  }

  private safeWorkspaceCwd(config: Config): string {
    try {
      return this.workspaceCwd(config);
    } catch {
      return '';
    }
  }

  private mcpTransport(server: unknown): ServeMcpTransport {
    if (!server || typeof server !== 'object') return 'unknown';
    const s = server as Record<string, unknown>;
    if (s['type'] === 'sdk') return 'sdk';
    if (typeof s['httpUrl'] === 'string') return 'http';
    if (typeof s['url'] === 'string') return 'sse';
    if (typeof s['tcp'] === 'string') return 'websocket';
    if (typeof s['command'] === 'string') return 'stdio';
    return 'unknown';
  }

  private mcpStatus(status: MCPServerStatus): ServeMcpServerRuntimeStatus {
    switch (status) {
      case MCPServerStatus.CONNECTED:
        return 'connected';
      case MCPServerStatus.CONNECTING:
        return 'connecting';
      case MCPServerStatus.DISCONNECTED:
      default:
        return 'disconnected';
    }
  }

  private mcpCellStatus(
    status: MCPServerStatus,
    disabled: boolean,
  ): ServeStatus {
    if (disabled) return 'disabled';
    switch (status) {
      case MCPServerStatus.CONNECTED:
        return 'ok';
      case MCPServerStatus.CONNECTING:
        return 'warning';
      case MCPServerStatus.DISCONNECTED:
      default:
        return 'error';
    }
  }

  private discoveryState(config?: Config): ServeMcpDiscoveryState {
    if (
      this.workspaceMcpDiscoveryPromise &&
      (config === this.config || config === this.workspaceMcpDiscoveryConfig)
    ) {
      return 'in_progress';
    }
    let state = getMCPDiscoveryState();
    try {
      state =
        config?.getToolRegistry()?.getMcpClientManager().getDiscoveryState() ??
        state;
    } catch {
      // A discovery Config can still be constructing its tool registry.
    }
    switch (state) {
      case MCPDiscoveryState.IN_PROGRESS:
        return 'in_progress';
      case MCPDiscoveryState.COMPLETED:
        return 'completed';
      case MCPDiscoveryState.NOT_STARTED:
      default:
        return 'not_started';
    }
  }

  private async buildWorkspaceMcpStatus(
    config: Config,
  ): Promise<ServeWorkspaceMcpStatus> {
    try {
      const workspaceCwd = this.workspaceCwd(config);
      const settings = loadSettings(config.getTargetDir());
      const userServers = settings.user?.settings.mcpServers ?? {};
      const systemDefaultServers =
        settings.systemDefaults?.settings.mcpServers ?? {};
      const servers = config.getMcpServers() ?? {};
      const approvals = loadMcpApprovals();

      // Pool snapshot for per-server `entryCount` + `entrySummary`.
      // Captured once outside the per-server loop. Absent when the
      // pool is disabled.
      let poolByName: Record<
        string,
        {
          entryCount: number;
          entrySummary: ReadonlyArray<{
            entryIndex: number;
            refs: number;
            status: MCPServerStatus;
          }>;
        }
      > = {};
      try {
        const snap = this.mcpPool?.getSnapshot();
        if (snap) poolByName = snap.byName;
      } catch (err) {
        // Pool snapshot failures must not crash the wider status —
        // surface to stderr so silent regressions are visible without
        // depending on `debugLogger.debug` operator opt-in (matches
        // the budget-accounting fail-loud pattern below).
        process.stderr.write(
          `qwen serve: pool snapshot for workspace MCP status failed: ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
      }

      // Pull live accounting + budget config. When the workspace-scoped
      // budget controller is active, prefer its accounting. Manager
      // fall-back keeps the legacy per-session cell shape.
      let clientCount: number | undefined;
      let clientBudget: number | undefined;
      let budgetMode: ServeMcpBudgetMode | undefined;
      let refusedSet: ReadonlySet<string> = new Set<string>();
      let budgetCellScope: 'workspace' | 'session' = 'session';
      const wsBudget = this.workspaceMcpBudget;
      if (wsBudget !== undefined) {
        budgetCellScope = 'workspace';
        clientCount = wsBudget.getReservedCount();
        clientBudget = wsBudget.getBudget();
        budgetMode = this.coerceBudgetMode(wsBudget.getMode());
        refusedSet = new Set(wsBudget.getRefusedServerNames());
      } else {
        try {
          const manager = config.getToolRegistry()?.getMcpClientManager();
          if (manager) {
            const accounting = manager.getMcpClientAccounting();
            clientCount = accounting.total;
            clientBudget = manager.getMcpClientBudget();
            budgetMode = manager.getMcpBudgetMode();
            refusedSet = new Set(accounting.refusedServerNames);
          }
        } catch (err) {
          // Accounting failure must not crash the snapshot — the per-
          // server data is still useful even without budget overlay.
          process.stderr.write(
            `qwen serve: getMcpClientAccounting failed: ` +
              `${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }

      const sharedTokenStorage = new MCPOAuthTokenStorage();

      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        initialized: true,
        discoveryState: this.discoveryState(config),
        servers: await Promise.all(
          Object.entries(servers).map(async ([name, server]) => {
            const disabled = config.isMcpServerDisabled(name);
            let hasOAuthTokens = false;
            try {
              const credentials = await sharedTokenStorage.getCredentials(name);
              hasOAuthTokens = credentials !== null;
            } catch {
              // Match CLI: token lookup errors should not break /mcp status.
            }
            const rawStatus = this.getMcpServerStatus(config, name);
            const requiresAuth =
              rawStatus !== MCPServerStatus.CONNECTED &&
              (mcpServerRequiresOAuth.get(name) === true ||
                (server.oauth?.enabled === true && !hasOAuthTokens));
            const refusedByBudget = refusedSet.has(name);
            // Config-disable takes precedence over budget-refusal.
            const effectivelyRefused = refusedByBudget && !disabled;
            const out: ServeWorkspaceMcpServerStatus = {
              kind: 'mcp_server',
              // Refused-by-budget shadows the raw status: the rawStatus
              // is `DISCONNECTED` (we never tried to connect), but the
              // operator-facing severity is `error` with an explanatory
              // errorKind rather than the generic disconnected `error`.
              status: effectivelyRefused
                ? 'error'
                : this.mcpCellStatus(rawStatus, disabled),
              name,
              mcpStatus: this.mcpStatus(rawStatus),
              transport: this.mcpTransport(server),
              disabled,
              hasOAuthTokens,
              ...(requiresAuth ? { requiresAuth: true } : {}),
            };
            if (isGatedMcpScope(server.scope)) {
              const approvalState = approvals.getState(
                config.getWorkingDir(),
                name,
                server,
              );
              if (approvalState !== 'approved') {
                out.approvalState = approvalState;
                if (!disabled) {
                  out.status = 'warning';
                  out.mcpStatus = 'disconnected';
                }
              }
            }
            if (this.pendingMcpAuthentications.has(name)) {
              out.authenticationState = 'pending';
            } else {
              const authentication = this.mcpAuthenticationResults.get(name);
              if (authentication) {
                out.authenticationState = authentication.state;
                if (authentication.error) {
                  out.authenticationError = authentication.error;
                }
              }
            }
            if (effectivelyRefused) {
              out.errorKind = 'budget_exhausted';
              out.disabledReason = 'budget';
              out.hint =
                'Raise --mcp-client-budget or remove servers from mcpServers config.';
            } else if (disabled) {
              out.disabledReason = 'config';
            }
            const description =
              server && typeof server === 'object'
                ? (server as { description?: unknown }).description
                : undefined;
            const extensionName =
              server && typeof server === 'object'
                ? (server as { extensionName?: unknown }).extensionName
                : undefined;
            if (typeof description === 'string') {
              out.description = description;
            }
            if (typeof extensionName === 'string') {
              out.extensionName = extensionName;
            }
            const transient =
              config.getTopTierMcpServers?.()?.[name] !== undefined ||
              config.getRuntimeMcpServers?.()[name] !== undefined;
            const configOrigin: NonNullable<
              ServeWorkspaceMcpServerStatus['configOrigin']
            > = out.extensionName
              ? 'extension'
              : transient
                ? 'runtime'
                : server.scope === 'workspace'
                  ? 'workspace_settings'
                  : server.scope === 'project'
                    ? 'project_mcp_json'
                    : server.scope === 'system'
                      ? 'system_settings'
                      : userServers[name] !== undefined
                        ? 'user_settings'
                        : systemDefaultServers[name] !== undefined
                          ? 'system_settings'
                          : 'user_settings';
            out.configOrigin = configOrigin;
            out.source = out.extensionName
              ? 'extension'
              : configOrigin === 'workspace_settings'
                ? 'project'
                : 'user';
            out.removable =
              configOrigin === 'user_settings' ||
              configOrigin === 'workspace_settings';
            if (server && typeof server === 'object') {
              const candidate = server as {
                command?: unknown;
                args?: unknown;
                httpUrl?: unknown;
                url?: unknown;
                cwd?: unknown;
              };
              const serverConfig: NonNullable<
                ServeWorkspaceMcpServerStatus['config']
              > = {};
              if (typeof candidate.command === 'string') {
                serverConfig.command = candidate.command;
              }
              if (Array.isArray(candidate.args)) {
                const args = candidate.args.filter(
                  (arg): arg is string => typeof arg === 'string',
                );
                if (args.length > 0) {
                  serverConfig.args = args;
                }
              }
              if (typeof candidate.httpUrl === 'string') {
                serverConfig.httpUrl = candidate.httpUrl;
              }
              if (typeof candidate.url === 'string') {
                serverConfig.url = candidate.url;
              }
              if (typeof candidate.cwd === 'string') {
                serverConfig.cwd = candidate.cwd;
              }
              if (Object.keys(serverConfig).length > 0) {
                out.config = serverConfig;
              }
            }
            // Pool entries enrichment.
            const poolRow = poolByName[name];
            if (poolRow) {
              out.entryCount = poolRow.entryCount;
              out.entrySummary = poolRow.entrySummary.map((e) => ({
                entryIndex: e.entryIndex,
                refs: e.refs,
                status: this.mcpStatus(e.status),
              }));
            }
            // Resource / prompt counts ride the base status so the /mcp
            // dialog can render "Resources: N" / "Prompts: N" and gate the
            // resource-browser affordance without a separate round-trip.
            // Disabled servers are not discovered, so leave their counts
            // absent — mirrors the TUI ServerDetailStep gating.
            if (!disabled) {
              out.resourceCount = this.resolveServerMcpResources(
                config,
                name,
              ).length;
              out.promptCount = this.resolveServerMcpPrompts(
                config,
                name,
              ).length;
            }
            return out;
          }),
        ),
        ...(clientCount !== undefined ? { clientCount } : {}),
        ...(clientBudget !== undefined ? { clientBudget } : {}),
        ...(budgetMode !== undefined ? { budgetMode } : {}),
        ...(budgetMode !== undefined
          ? {
              // Filter out config-disabled servers so the workspace
              // cell matches the per-server cell precedence.
              budgets: this.buildBudgetCells(
                clientCount ?? 0,
                clientBudget,
                budgetMode,
                Array.from(refusedSet).filter(
                  (n) => !config.isMcpServerDisabled(n),
                ).length,
                budgetCellScope,
              ),
            }
          : {}),
        ...(this.workspaceMcpDiscoveryError
          ? {
              errors: [
                this.errorCell(
                  'mcp',
                  new Error(this.workspaceMcpDiscoveryError),
                ),
              ],
            }
          : {}),
      };
    } catch (error) {
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.safeWorkspaceCwd(config),
        initialized: true,
        servers: [],
        errors: [this.errorCell('mcp', error)],
      };
    }
  }

  private async buildManagedWorkspaceMcpStatus(): Promise<ServeWorkspaceMcpStatus> {
    const config = this.getWorkspaceMcpConfig();
    const status = await this.buildWorkspaceMcpStatus(config);
    if (config === this.config) return status;
    const runtimeNames = new Set(
      Object.keys(this.config.getRuntimeMcpServers?.() ?? {}),
    );
    if (runtimeNames.size === 0) return status;
    const runtimeStatus = await this.buildWorkspaceMcpStatus(this.config);
    const errors = [
      ...(status.errors ?? []),
      ...(runtimeStatus.errors ?? []).filter(
        (candidate) =>
          !status.errors?.some(
            (existing) =>
              existing.kind === candidate.kind &&
              existing.status === candidate.status &&
              existing.error === candidate.error,
          ),
      ),
    ];
    return {
      ...status,
      servers: [
        ...status.servers.filter((server) => !runtimeNames.has(server.name)),
        ...runtimeStatus.servers.filter((server) =>
          runtimeNames.has(server.name),
        ),
      ],
      ...(errors.length > 0 ? { errors } : {}),
    };
  }

  private buildWorkspaceMcpToolsStatus(
    config: Config,
    serverName: string,
  ): ServeWorkspaceMcpToolsStatus {
    const workspaceCwd = this.safeWorkspaceCwd(config);
    try {
      const servers = config.getMcpServers() ?? {};
      if (!Object.prototype.hasOwnProperty.call(servers, serverName)) {
        return {
          v: STATUS_SCHEMA_VERSION,
          workspaceCwd,
          serverName,
          initialized: true,
          acpChannelLive: true,
          tools: [],
          errors: [
            {
              kind: 'mcp_tools',
              status: 'error',
              error: `MCP server not configured: ${serverName}`,
            },
          ],
        };
      }

      let registry = config.getToolRegistry();
      let allTools = registry?.getAllTools() ?? [];
      if (
        allTools.filter(
          (t) => t instanceof DiscoveredMCPTool && t.serverName === serverName,
        ).length === 0
      ) {
        for (const session of this.getActiveSessions()) {
          const sessionRegistry = session.getConfig().getToolRegistry();
          const sessionTools = sessionRegistry?.getAllTools() ?? [];
          if (
            sessionTools.some(
              (t) =>
                t instanceof DiscoveredMCPTool && t.serverName === serverName,
            )
          ) {
            registry = sessionRegistry;
            allTools = sessionTools;
            break;
          }
        }
      }
      const tools: ServeWorkspaceMcpToolStatus[] = allTools
        .filter(
          (tool): tool is DiscoveredMCPTool =>
            tool instanceof DiscoveredMCPTool && tool.serverName === serverName,
        )
        .map((tool) => {
          const invalidReasons: string[] = [];
          if (!tool.name) invalidReasons.push('missing name');
          if (!tool.description) invalidReasons.push('missing description');
          const schema =
            tool.parameterSchema &&
            typeof tool.parameterSchema === 'object' &&
            !Array.isArray(tool.parameterSchema)
              ? (tool.parameterSchema as Record<string, unknown>)
              : undefined;
          const annotations =
            tool.annotations &&
            typeof tool.annotations === 'object' &&
            !Array.isArray(tool.annotations)
              ? (tool.annotations as Record<string, unknown>)
              : undefined;
          return {
            name: tool.name || '(unnamed)',
            serverToolName: tool.serverToolName,
            description: tool.description,
            ...(schema ? { schema } : {}),
            ...(annotations ? { annotations } : {}),
            isValid: invalidReasons.length === 0,
            ...(invalidReasons.length > 0
              ? { invalidReason: invalidReasons.join(', ') }
              : {}),
          };
        });

      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        serverName,
        initialized: true,
        acpChannelLive: true,
        tools,
      };
    } catch (error) {
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        serverName,
        initialized: true,
        acpChannelLive: true,
        tools: [],
        errors: [this.errorCell('mcp_tools', error)],
      };
    }
  }

  /**
   * Resolve the resources discovered for one server, with the same
   * pool-mode fallback `buildWorkspaceMcpToolsStatus` uses for tools: the
   * workspace `Config`'s `ResourceRegistry` is authoritative in
   * single-session mode, but in pool mode resources are registered into
   * per-session registries (`SessionMcpView.applyResources`), leaving the
   * workspace registry empty. Fall back to the first active session that
   * has this server's resources.
   */
  private resolveServerMcpResources(
    config: Config,
    serverName: string,
  ): DiscoveredMCPResource[] {
    // Defensive optional-call mirrors useAtCompletion.ts: a partial Config
    // (older snapshot or a test stub) may not expose the registry accessor,
    // and a missing registry must degrade to "no resources" rather than
    // throwing and collapsing the whole /mcp status into an error cell.
    const resources =
      config.getResourceRegistry?.()?.getResourcesByServer(serverName) ?? [];
    if (resources.length > 0) {
      return resources;
    }
    for (const session of this.getActiveSessions()) {
      try {
        const sessionResources =
          session
            .getConfig()
            .getResourceRegistry?.()
            ?.getResourcesByServer(serverName) ?? [];
        if (sessionResources.length > 0) {
          return sessionResources;
        }
      } catch {
        // A degraded session must not collapse the base /workspace/mcp
        // status — skip it and keep scanning. (The counts ride that status,
        // so one bad session shouldn't blank out every server's row.)
      }
    }
    return resources;
  }

  /**
   * Resolve the prompts discovered for one server, mirroring
   * {@link resolveServerMcpResources}. Used only for the per-server
   * `promptCount` on the base status — prompts have no drill-down
   * endpoint (they surface as slash commands).
   */
  private resolveServerMcpPrompts(
    config: Config,
    serverName: string,
  ): DiscoveredMCPPrompt[] {
    // Defensive optional-call — see resolveServerMcpResources.
    const prompts =
      config.getPromptRegistry?.()?.getPromptsByServer(serverName) ?? [];
    if (prompts.length > 0) {
      return prompts;
    }
    for (const session of this.getActiveSessions()) {
      try {
        const sessionPrompts =
          session
            .getConfig()
            .getPromptRegistry?.()
            ?.getPromptsByServer(serverName) ?? [];
        if (sessionPrompts.length > 0) {
          return sessionPrompts;
        }
      } catch {
        // See resolveServerMcpResources — skip a degraded session.
      }
    }
    return prompts;
  }

  private buildWorkspaceMcpResourcesStatus(
    config: Config,
    serverName: string,
  ): ServeWorkspaceMcpResourcesStatus {
    const workspaceCwd = this.safeWorkspaceCwd(config);
    try {
      const servers = config.getMcpServers() ?? {};
      if (!Object.prototype.hasOwnProperty.call(servers, serverName)) {
        return {
          v: STATUS_SCHEMA_VERSION,
          workspaceCwd,
          serverName,
          initialized: true,
          acpChannelLive: true,
          resources: [],
          errors: [
            {
              kind: 'mcp_resources',
              status: 'error',
              error: `MCP server not configured: ${serverName}`,
            },
          ],
        };
      }

      const resources: ServeWorkspaceMcpResourceStatus[] =
        this.resolveServerMcpResources(config, serverName).map((resource) => ({
          uri: resource.uri,
          ...(typeof resource.name === 'string' ? { name: resource.name } : {}),
          ...(typeof resource.title === 'string'
            ? { title: resource.title }
            : {}),
          ...(typeof resource.description === 'string'
            ? { description: resource.description }
            : {}),
          ...(typeof resource.mimeType === 'string'
            ? { mimeType: resource.mimeType }
            : {}),
          ...(typeof resource.size === 'number' ? { size: resource.size } : {}),
        }));

      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        serverName,
        initialized: true,
        acpChannelLive: true,
        resources,
      };
    } catch (error) {
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        serverName,
        initialized: true,
        acpChannelLive: true,
        resources: [],
        errors: [this.errorCell('mcp_resources', error)],
      };
    }
  }

  /**
   * Build the MCP budget status cells exposed on `GET /workspace/mcp`.
   *
   * Cell `status` semantics:
   *   - `error`   — refusals happened this pass (enforce mode only)
   *   - `warning` — live count crossed 75% of budget
   *   - `ok`      — under threshold (or `off` mode)
   *
   * `liveCount` is the connected-client count (for operator
   * observability), while enforcement uses `reservedSlots.size` to
   * prevent capacity races.
   */
  private buildBudgetCells(
    liveCount: number,
    budget: number | undefined,
    mode: ServeMcpBudgetMode,
    refusedCount: number,
    scope: 'workspace' | 'session' = 'session',
  ): ServeMcpBudgetStatusCell[] {
    // When mode is 'off', return empty — no budget surface to show.
    if (mode === 'off') return [];
    let status: ServeStatus = 'ok';
    let errorKind: ServeErrorKind | undefined;
    let hint: string | undefined;
    if (refusedCount > 0) {
      status = 'error';
      errorKind = 'budget_exhausted';
      hint =
        'Raise --mcp-client-budget or remove servers from mcpServers config.';
    } else if (
      budget !== undefined &&
      budget > 0 &&
      liveCount >= MCP_BUDGET_WARN_FRACTION * budget
    ) {
      status = 'warning';
      hint = `Live MCP clients are above ${Math.round(
        MCP_BUDGET_WARN_FRACTION * 100,
      )}% of the configured budget.`;
    }
    const cell: ServeMcpBudgetStatusCell = {
      kind: 'mcp_budget',
      // `scope` is 'workspace' when the workspace budget controller is
      // active, otherwise 'session' for legacy per-session caps.
      scope,
      status,
      liveCount,
      mode,
      refusedCount,
    };
    if (budget !== undefined) cell.budget = budget;
    if (errorKind) cell.errorKind = errorKind;
    if (hint) cell.hint = hint;
    return [cell];
  }

  /** Map core `McpBudgetMode` to protocol `ServeMcpBudgetMode`. */
  private coerceBudgetMode(mode: McpBudgetMode): ServeMcpBudgetMode {
    return mode;
  }

  private errorCell(
    kind: string,
    error: unknown,
    errorKind?: ServeErrorKind,
  ): ServeStatusCell {
    const inferred = errorKind ?? mapDomainErrorToErrorKind(error);
    return {
      kind,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      ...(inferred ? { errorKind: inferred } : {}),
    };
  }

  /**
   * Keeps the extension-derived half of the skill snapshot self-healing.
   *
   * Skills have a watcher (`SkillManager.startWatching`); extensions do not, so
   * without this the child would never notice an extension installed, removed,
   * enabled, or disabled outside the daemon — and extension-level skills are
   * derived from that set, so a skill-watcher tick alone cannot recover it.
   *
   * The check is one `readdir` plus a bounded number of `stat`s, and refreshes
   * only when the sources actually moved, so a steady-state read still parses
   * no manifest and no `SKILL.md`. Failures are logged and swallowed: a status
   * read must not fail because revalidation could not run.
   *
   * Skipped in safe and bare mode. Those modes deliberately never populate the
   * extension cache (`Config.initialize` omits the refresh), and the snapshot
   * derives extension skills from `getExtensions()` — so revalidating here
   * would load the extensions those modes exist to exclude.
   */
  private async revalidateExtensionSources(config: Config): Promise<void> {
    // Everything here is inside the boundary, mode check included: this must not
    // be able to fail a status read no matter which accessor misbehaves.
    try {
      if (config.isSafeMode() || config.getBareMode()) return;
      const changed = await config
        .getExtensionManager()
        .refreshCacheIfSourcesChanged();
      if (!changed) return;
      await config.getSkillManager()?.refreshCache();
    } catch (error) {
      debugLogger.warn('Extension source revalidation failed:', error);
    }
  }

  private async buildWorkspaceSkillsStatus(
    config: Config,
  ): Promise<ServeWorkspaceSkillsStatus> {
    const skillManager = config.getSkillManager();
    if (!skillManager) {
      // No manager means nothing has been enumerated and nothing ever will be
      // on this config — report that rather than an empty "initialized" list,
      // which the daemon would latch as a valid snapshot and then keep serving
      // in preference to its own local enumeration.
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.workspaceCwd(config),
        initialized: false,
        skills: [],
      };
    }

    await this.revalidateExtensionSources(config);

    try {
      const skills = skillManager.getCachedSkills();
      if (skills === null) {
        return {
          v: STATUS_SCHEMA_VERSION,
          workspaceCwd: this.workspaceCwd(config),
          initialized: false,
          skills: [],
        };
      }
      const resolved = resolveSkillSettings(this.settings);
      const disablements = new Map(
        Array.from(config.getDisabledSkillNames(), (name) => {
          const normalizedName = name.trim().toLowerCase();
          return [
            normalizedName,
            resolved.disablements.get(normalizedName) ??
              ({ reason: 'hard' } as const),
          ] as const;
        }),
      );
      const inactiveSkillRefs = inactiveExtensionSkillRefs(config);
      const skillsByKey = new Map(
        skills.map((skill) => [
          `${skill.level}:${skill.extensionName ?? ''}:${skill.name}`,
          mapSkillConfigToStatus(skill, disablements, {
            disabled: isInactiveExtensionSkill(skill, inactiveSkillRefs),
          }),
        ]),
      );
      for (const extension of config.getExtensions()) {
        if (extension.isActive) continue;
        for (const skill of extension.skills ?? []) {
          const extensionName = extension.name;
          const key = `extension:${extensionName}:${skill.name}`;
          if (skillsByKey.has(key)) continue;
          skillsByKey.set(
            key,
            mapSkillConfigToStatus(
              {
                ...skill,
                level: 'extension',
                extensionName,
                extensionDisplayName: extension.displayName,
              },
              disablements,
              { disabled: true },
            ),
          );
        }
      }
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.workspaceCwd(config),
        initialized: true,
        skills: Array.from(skillsByKey.values()).sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      };
    } catch (error) {
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.workspaceCwd(config),
        initialized: true,
        skills: [],
        errors: [this.errorCell('skills', error)],
      };
    }
  }

  private buildWorkspaceProvidersStatus(
    config: Config,
  ): ServeWorkspaceProvidersStatus {
    try {
      const workspaceCwd = this.workspaceCwd(config);
      const currentAuthType = config.getAuthType?.();
      const activeRuntimeSnapshot = config.getActiveRuntimeModelSnapshot?.();
      const currentModelId = activeRuntimeSnapshot
        ? activeRuntimeSnapshot.id
        : (config.getModel() || '').trim();
      const hasCurrentModel = currentModelId.length > 0;
      const currentAuth = activeRuntimeSnapshot?.authType ?? currentAuthType;
      const modelOptions = buildAcpModelOptions(
        config.getAllConfiguredModels(),
      );
      const currentAcpModelId = hasCurrentModel
        ? getCurrentAcpModelId(
            modelOptions,
            currentModelId,
            currentAuth,
            activeRuntimeSnapshot
              ? undefined
              : config.getCurrentModelRegistryBaseUrl?.(),
          )
        : undefined;
      const providers = new Map<string, ServeWorkspaceProviderStatus>();

      for (const option of modelOptions) {
        const { model, effectiveModelId, modelId } = option;
        const authType = String(model.authType);
        let provider = providers.get(authType);
        if (!provider) {
          provider = {
            kind: 'model_provider',
            status: 'ok',
            authType,
            current: false,
            models: [],
          };
          providers.set(authType, provider);
        }

        const isCurrent =
          currentAuth === model.authType && currentAcpModelId === modelId;
        const configOptions =
          model.isRuntimeModel || modelId.startsWith(ACP_ROUTE_ID_PREFIX)
            ? undefined
            : buildModelReasoningConfigPreview(model.id, {
                thinkingMandatory:
                  config.getResolvedModelConfig?.(
                    model.authType,
                    model.id,
                    model.registryBaseUrl ?? model.baseUrl,
                  )?.generationConfig.thinkingMandatory === true,
              });
        const providerModel: ServeWorkspaceProviderModel = {
          modelId,
          baseModelId: parseAcpBaseModelId(effectiveModelId),
          name: model.label,
          ...(model.description !== undefined
            ? { description: model.description }
            : {}),
          contextLimit: model.contextWindowSize ?? tokenLimit(effectiveModelId),
          ...(model.modalities !== undefined
            ? { modalities: model.modalities }
            : {}),
          ...(model.baseUrl !== undefined
            ? { baseUrl: sanitizeProviderBaseUrl(model.baseUrl) }
            : {}),
          ...(model.envKey !== undefined ? { envKey: model.envKey } : {}),
          isCurrent,
          isRuntime: model.isRuntimeModel === true,
          ...(configOptions ? { configOptions } : {}),
        };
        provider.models.push(providerModel);
        if (isCurrent) provider.current = true;
      }

      const cgConfig = config.getContentGeneratorConfig?.();
      const baseUrl = cgConfig?.baseUrl || undefined;
      const fastModelId = this.settings.merged?.fastModel || undefined;

      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        initialized: true,
        ...(currentAuth || currentAcpModelId
          ? {
              current: {
                ...(currentAuth ? { authType: String(currentAuth) } : {}),
                ...(currentAcpModelId ? { modelId: currentAcpModelId } : {}),
                ...(baseUrl
                  ? { baseUrl: sanitizeProviderBaseUrl(baseUrl) }
                  : {}),
                ...(fastModelId ? { fastModelId } : {}),
              },
            }
          : {}),
        providers: [...providers.values()],
      };
    } catch (error) {
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.safeWorkspaceCwd(config),
        initialized: true,
        providers: [],
        errors: [this.errorCell('providers', error)],
      };
    }
  }

  private async buildAcpPreflightCells(
    config: Config,
  ): Promise<{ cells: ServePreflightCell[]; errors?: ServeStatusCell[] }> {
    // Drive emission order from the shared `ACP_PREFLIGHT_KINDS` constant
    // (also consumed by `createIdleAcpPreflightCells` from
    // `@qwen-code/acp-bridge/status`)
    // so the idle-placeholder list and the live builder cannot drift —
    // adding a new ACP kind in the constant flags any builder dispatch
    // gap as a TS exhaustiveness error in the switch below, instead of
    // silently dropping the cell from one path or the other.
    const builders: Record<
      AcpPreflightKind,
      () => ServePreflightCell | Promise<ServePreflightCell>
    > = {
      auth: () => this.buildAuthPreflightCell(config),
      mcp_discovery: () => this.buildMcpDiscoveryPreflightCell(config),
      skills: () => this.buildSkillsPreflightCell(config),
      providers: () => this.buildProvidersPreflightCell(config),
      tool_registry: () => this.buildToolRegistryPreflightCell(config),
      egress: () => ({
        kind: 'egress',
        status: 'not_started',
        locality: 'acp',
        hint: 'egress probing not yet implemented',
      }),
    };
    const cells: ServePreflightCell[] = [];
    for (const kind of ACP_PREFLIGHT_KINDS) {
      cells.push(await builders[kind]());
    }
    return { cells };
  }

  private acpCell(
    kind: ServePreflightKind,
    spec: Omit<ServePreflightCell, 'kind' | 'locality'>,
  ): ServePreflightCell {
    return { kind, locality: 'acp', ...spec };
  }

  /**
   * Pure auth preflight check. First looks up the well-known env var keys
   * for the configured auth method, then falls back to the API key already
   * resolved into the generation config (which folds settings.security.auth.apiKey,
   * provider envKey from settings.env, and CLI flags into a single value).
   *
   * Deliberately does NOT call `validateAuthMethod` from `cli/config/auth.ts`:
   * that helper has side effects (reloads `.env` from disk via
   * `loadEnvironment`, writes `process.env['GOOGLE_GENAI_USE_VERTEXAI']` for
   * Vertex auth) which would let a read-only `GET /workspace/preflight`
   * mutate daemon state and produce torn snapshots when racing
   * `GET /workspace/env`. Full validation still happens at session start.
   */
  private buildAuthPreflightCell(config: Config): ServePreflightCell {
    try {
      const authType = config.getAuthType?.();
      if (!authType) {
        return this.acpCell('auth', {
          status: 'warning',
          errorKind: 'auth_env_error',
          error: 'No auth method configured.',
          hint: 'Run `qwen` and complete the auth flow, or set a provider env var.',
          detail: { source: 'none', hasToken: false },
        });
      }
      const apiKeyVars = AUTH_PREFLIGHT_ENV_KEYS[String(authType)] ?? [];
      const presentVar = apiKeyVars.find((name: string) =>
        Boolean(process.env[name]),
      );
      let hasToken = Boolean(presentVar);
      if (
        !hasToken &&
        !AUTH_PREFLIGHT_WAIVED_AUTH_TYPES.has(String(authType))
      ) {
        const resolvedApiKey = config
          .getModelsConfig()
          .getGenerationConfig()?.apiKey;
        if (resolvedApiKey) {
          hasToken = true;
        }
      }
      // Keyless Vertex: a configured project selects the ADC path, but it is
      // routing configuration, not evidence that a usable credential exists.
      // Report indeterminate rather than a confirmed token and let the session
      // boot settle it.
      if (
        !hasToken &&
        authType === AuthType.USE_VERTEX_AI &&
        hasVertexProjectConfigured()
      ) {
        return this.acpCell('auth', {
          status: 'unknown',
          hint: 'Vertex AI is configured for Application Default Credentials; whether they resolve is only known at session start.',
          detail: {
            source: String(authType),
            hasToken: 'unknown' as const,
            envVarCandidates: apiKeyVars,
          },
        });
      }
      // No env-var registration → either OAuth-style auth (qwen-oauth) or
      // a custom provider whose key is sourced from settings rather than
      // env. If the resolved generation config already contains an apiKey
      // we can report 'ok'; otherwise surface 'unknown' so the SDK
      // consumer defers to the `/session` boot for definitive validation.
      if (apiKeyVars.length === 0) {
        return this.acpCell('auth', {
          status: hasToken ? 'ok' : 'unknown',
          ...(hasToken
            ? {}
            : {
                hint: 'Auth credentials for this provider are not env-keyed; full validation runs at session start.',
              }),
          detail: {
            source: String(authType),
            hasToken: hasToken || ('unknown' as const),
            envVarCandidates: [],
          },
        });
      }
      return this.acpCell('auth', {
        status: hasToken ? 'ok' : 'warning',
        ...(hasToken
          ? {}
          : {
              errorKind: 'auth_env_error' as const,
              error: `None of the env vars [${apiKeyVars.join(', ')}] is set for authType '${String(authType)}'.`,
              hint: `Set one of: ${apiKeyVars.join(' / ')}.`,
            }),
        detail: {
          source: String(authType),
          hasToken,
          envVarCandidates: apiKeyVars,
          ...(presentVar ? { presentVar } : {}),
        },
      });
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err) ?? 'auth_env_error';
      return this.acpCell('auth', {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        errorKind,
      });
    }
  }

  private buildMcpDiscoveryPreflightCell(config: Config): ServePreflightCell {
    try {
      const discovery = this.discoveryState(config);
      const servers = config.getMcpServers() ?? {};
      const total = Object.keys(servers).length;
      // Today `MCPServerStatus` is `{CONNECTED, CONNECTING, DISCONNECTED}`,
      // but a future state (e.g. `ERROR`, `NEEDS_AUTH`) could be added.
      // Bucketing it as `disconnected` would silently lose the distinction
      // between "credential failed" and "idle, will spawn on demand".
      // Track an explicit `unknown` count so unrecognized states surface in
      // the cell `detail` rather than disappearing.
      const counts = {
        connected: 0,
        connecting: 0,
        disconnected: 0,
        unknown: 0,
      };
      for (const name of Object.keys(servers)) {
        const raw = getMCPServerStatus(name);
        switch (raw) {
          case MCPServerStatus.CONNECTED:
            counts.connected += 1;
            break;
          case MCPServerStatus.CONNECTING:
            counts.connecting += 1;
            break;
          case MCPServerStatus.DISCONNECTED:
            counts.disconnected += 1;
            break;
          default:
            counts.unknown += 1;
            break;
        }
      }
      const detail = { discoveryState: discovery, total, ...counts };

      if (total === 0) {
        return this.acpCell('mcp_discovery', {
          status: 'ok',
          detail,
          hint: 'No MCP servers configured.',
        });
      }
      if (counts.unknown > 0) {
        return this.acpCell('mcp_discovery', {
          status: 'warning',
          errorKind: 'protocol_error',
          error: `${counts.unknown}/${total} MCP server(s) in an unrecognized state.`,
          detail,
        });
      }
      if (counts.disconnected > 0 && discovery === 'completed') {
        return this.acpCell('mcp_discovery', {
          status: 'error',
          errorKind: 'protocol_error',
          error: `${counts.disconnected}/${total} MCP server(s) disconnected after discovery.`,
          detail,
        });
      }
      if (counts.connecting > 0 || discovery === 'in_progress') {
        // No `errorKind`: this is a normal transitional state (just-spawned
        // MCP servers haven't completed their handshake yet), not an
        // `init_timeout`. The latter would push SDK consumers to render
        // timeout-specific remediation ("increase init timeout") when the
        // correct user action is simply "wait or retry shortly". A real
        // timeout surfaces via `BridgeTimeoutError` from the bridge's
        // `withTimeout`, mapped through `mapDomainErrorToErrorKind`.
        return this.acpCell('mcp_discovery', {
          status: 'warning',
          error: `${counts.connecting}/${total} MCP server(s) still connecting.`,
          detail,
        });
      }
      return this.acpCell('mcp_discovery', { status: 'ok', detail });
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err);
      return this.acpCell('mcp_discovery', {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        ...(errorKind ? { errorKind } : {}),
      });
    }
  }

  private async buildSkillsPreflightCell(
    config: Config,
  ): Promise<ServePreflightCell> {
    // Whole body wrapped in try so a Config getter that throws
    // synchronously (mock-style or future Config refactor) doesn't escape
    // out of `buildAcpPreflightCells` and 500 the whole envelope.
    try {
      const skillManager = config.getSkillManager();
      if (!skillManager) {
        return this.acpCell('skills', {
          status: 'disabled',
          // `disabled` here is the structural state — Config has no
          // SkillManager attached. That can mean the user opted out OR a
          // mis-config silently dropped the manager; preflight cannot
          // distinguish the two without settings introspection. Hint
          // surfaces the ambiguity so operators investigate when
          // unexpected.
          hint: 'No SkillManager attached to Config; verify settings if you expected skills to load.',
          detail: { configured: false },
        });
      }
      const skills = await skillManager.listSkills();
      return this.acpCell('skills', {
        status: 'ok',
        detail: { count: skills.length },
      });
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err);
      return this.acpCell('skills', {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        ...(errorKind ? { errorKind } : {}),
      });
    }
  }

  private buildProvidersPreflightCell(config: Config): ServePreflightCell {
    try {
      const models = config
        .getAllConfiguredModels()
        .filter((model) => !model.imageOnly);
      const authType = config.getAuthType?.();
      if (models.length === 0) {
        // `authType` set but zero models = the next `POST /session` will
        // fail. Report `error`, not `warning`: the daemon literally cannot
        // serve a prompt in this state.
        return this.acpCell('providers', {
          status: authType ? 'error' : 'disabled',
          ...(authType ? { errorKind: 'auth_env_error' } : {}),
          ...(authType
            ? {
                error: `No model configured for authType ${String(authType)}.`,
              }
            : {}),
          detail: { count: 0, authType: authType ? String(authType) : null },
        });
      }
      const authTypes = new Set(models.map((m) => String(m.authType)));
      return this.acpCell('providers', {
        status: 'ok',
        detail: {
          count: models.length,
          providers: [...authTypes],
        },
      });
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err) ?? 'auth_env_error';
      return this.acpCell('providers', {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        errorKind,
      });
    }
  }

  private buildToolRegistryPreflightCell(config: Config): ServePreflightCell {
    try {
      const registry = config.getToolRegistry();
      if (!registry) {
        return this.acpCell('tool_registry', {
          status: 'error',
          errorKind: 'protocol_error',
          error: 'Tool registry is not initialized.',
        });
      }
      const tools = registry.getAllTools();
      return this.acpCell('tool_registry', {
        status: 'ok',
        detail: { count: tools.length },
      });
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err) ?? 'protocol_error';
      return this.acpCell('tool_registry', {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        errorKind,
      });
    }
  }

  private buildWorkspaceToolsStatus(config: Config): ServeWorkspaceToolsStatus {
    const workspaceCwd = this.safeWorkspaceCwd(config);
    try {
      const registry = config.getToolRegistry();
      if (!registry) {
        return {
          v: STATUS_SCHEMA_VERSION,
          workspaceCwd,
          initialized: true,
          acpChannelLive: true,
          tools: [],
          errors: [
            {
              kind: 'tools',
              status: 'error',
              errorKind: 'protocol_error',
              error: 'Tool registry is not initialized.',
            },
          ],
        };
      }

      const disabled = config.getDisabledTools();
      const tools: ServeWorkspaceToolStatus[] = registry
        .getAllToolNames()
        .flatMap((name) => {
          const tool = registry.getTool(name);
          if (tool && 'serverName' in tool) return [];
          return [
            {
              name,
              ...(tool
                ? {
                    displayName: tool.displayName,
                    description: tool.description,
                  }
                : {}),
              enabled: !disabled.has(name),
            },
          ];
        })
        .sort((left, right) => left.name.localeCompare(right.name));

      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        initialized: true,
        acpChannelLive: true,
        tools,
      };
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err) ?? 'protocol_error';
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        initialized: true,
        acpChannelLive: true,
        tools: [],
        errors: [
          {
            kind: 'tools',
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
            errorKind,
          },
        ],
      };
    }
  }

  private sessionOrThrow(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Session not found for id: ${sessionId}`,
      );
    }
    return session;
  }

  private async refreshLiveSessionMemoryInstructions(
    logContext: string,
  ): Promise<void> {
    const sessions = [...this.sessions.values()];
    if (sessions.length === 0) {
      return;
    }
    await Promise.all(
      sessions.map((session) =>
        refreshMemoryInstruction(session.getConfig(), {
          logContext: `${logContext} session ${session.getId()}`,
        }),
      ),
    );
  }

  private buildSessionContextStatus(
    sessionId: string,
  ): ServeSessionContextStatus {
    const session = this.sessionOrThrow(sessionId);
    const config = session.getConfig();
    return {
      v: STATUS_SCHEMA_VERSION,
      sessionId,
      workspaceCwd: this.workspaceCwd(config),
      state: {
        models: this.buildAvailableModels(config),
        modes: this.buildModesData(config),
        configOptions: this.buildConfigOptions(config),
      },
    };
  }

  private async buildSessionContextUsageStatus(
    sessionId: string,
    showDetails: boolean,
  ): Promise<ServeSessionContextUsageStatus> {
    const session = this.sessionOrThrow(sessionId);
    const config = session.getConfig();
    let usage;
    try {
      usage = await collectContextData(config, showDetails);
    } catch (err) {
      console.warn('[context-usage] collectContextData failed:', err);
      usage = {
        type: 'context_usage' as const,
        modelName: config.getModel() || 'unknown',
        totalTokens: 0,
        contextWindowSize: 0,
        breakdown: {
          systemPrompt: 0,
          builtinTools: 0,
          mcpTools: 0,
          memoryFiles: 0,
          skills: 0,
          messages: 0,
          freeSpace: 0,
          autocompactBuffer: 0,
        },
        builtinTools: [] as Array<{ name: string; tokens: number }>,
        mcpTools: [] as Array<{ name: string; tokens: number }>,
        memoryFiles: [] as Array<{ path: string; tokens: number }>,
        skills: [] as Array<{
          name: string;
          tokens: number;
          loaded?: boolean;
          bodyTokens?: number;
        }>,
        isEstimated: true,
        showDetails,
      };
    }
    return {
      v: STATUS_SCHEMA_VERSION,
      sessionId,
      workspaceCwd: this.workspaceCwd(config),
      usage: {
        modelName: usage.modelName,
        totalTokens: usage.totalTokens,
        contextWindowSize: usage.contextWindowSize,
        breakdown: usage.breakdown,
        builtinTools: usage.builtinTools,
        mcpTools: usage.mcpTools,
        memoryFiles: usage.memoryFiles,
        skills: usage.skills,
        isEstimated: usage.isEstimated,
        showDetails: usage.showDetails,
      },
      formattedText: formatContextUsageText(usage as HistoryItemContextUsage),
    };
  }

  private async buildSessionSupportedCommandsStatus(
    sessionId: string,
  ): Promise<ServeSessionSupportedCommandsStatus> {
    const session = this.sessionOrThrow(sessionId);
    const { availableCommands, availableSkills } =
      await session.buildAvailableCommandsSnapshot();
    return {
      v: STATUS_SCHEMA_VERSION,
      sessionId,
      availableCommands,
      availableSkills: availableSkills ?? [],
    };
  }

  private buildSessionTasksStatus(sessionId: string): ServeSessionTasksStatus {
    const session = this.sessionOrThrow(sessionId);
    return buildSessionTasksStatus(sessionId, session.getConfig());
  }

  private buildSessionLspStatus(sessionId: string): ServeSessionLspStatus {
    const session = this.sessionOrThrow(sessionId);
    const config = session.getConfig();
    const snapshot = config.getLspStatusSnapshot();
    return {
      v: STATUS_SCHEMA_VERSION,
      sessionId,
      workspaceCwd: this.workspaceCwd(config),
      enabled: snapshot.enabled,
      configuredServers: snapshot.configuredServers,
      readyServers: snapshot.readyServers,
      failedServers: snapshot.failedServers,
      inProgressServers: snapshot.inProgressServers,
      notStartedServers: snapshot.notStartedServers,
      ...(snapshot.statusUnavailable ? { statusUnavailable: true } : {}),
      ...(snapshot.initializationError
        ? { initializationError: snapshot.initializationError }
        : {}),
      servers: snapshot.servers.map((server) => ({
        name: server.name,
        status: server.status,
        languages: server.languages,
        ...(server.transport ? { transport: server.transport } : {}),
        ...(server.command ? { command: server.command } : {}),
        ...(server.error ? { error: server.error } : {}),
      })),
    };
  }

  private buildSessionStatsStatus(sessionId: string): ServeSessionStatsStatus {
    const session = this.sessionOrThrow(sessionId);
    const config = session.getConfig();
    const metrics = uiTelemetryService.getMetricsForSession(sessionId);
    const now = Date.now();
    const createdAt = session.getCreatedAt();

    const models: ServeSessionStatsStatus['models'] = {};
    // Per-instance subagent token totals (keyed by unique invocation id), so
    // repeated calls of the same agent type stay distinguishable. Output as a
    // structured array with readable type/name labels from sourceMeta.
    for (const [name, rawMetrics] of Object.entries(metrics.models)) {
      const m = metrics.statsModels?.[name] ?? rawMetrics;
      models[name] = {
        api: { ...m.api },
        tokens: { ...m.tokens },
      };
    }
    const sources: ServeSessionStatsStatus['sources'] = [];
    for (const [id, source] of Object.entries(metrics.sourceMetrics ?? {})) {
      const meta = metrics.sourceMeta?.[id];
      sources.push({
        id,
        type: meta?.type ?? '',
        name: meta?.name ?? id,
        tokens: { ...source.tokens },
      });
    }
    sources.sort(
      (a, b) => b.tokens.total - a.tokens.total || a.id.localeCompare(b.id),
    );

    const byName: ServeSessionStatsStatus['tools']['byName'] = {};
    for (const [name, t] of Object.entries(metrics.tools.byName)) {
      byName[name] = {
        count: t.count,
        success: t.success,
        fail: t.fail,
        durationMs: t.durationMs,
        decisions: {
          accept: t.decisions.accept,
          reject: t.decisions.reject,
          modify: t.decisions.modify,
          auto_accept: t.decisions.auto_accept,
        },
      };
    }

    const skillMetrics = metrics.skills ?? {
      totalCalls: 0,
      totalSuccess: 0,
      totalFail: 0,
      byName: {},
    };
    const skillsByName: ServeSessionStatsStatus['skills']['byName'] = {};
    for (const [name, skill] of Object.entries(skillMetrics.byName)) {
      Object.defineProperty(skillsByName, name, {
        value: {
          count: skill.count,
          success: skill.success,
          fail: skill.fail,
        },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }

    return {
      v: STATUS_SCHEMA_VERSION,
      sessionId,
      workspaceCwd: this.workspaceCwd(config),
      sessionStartTimeMs: createdAt,
      durationMs: now - createdAt,
      promptCount: session.getTurnCount(),
      models,
      sources,
      tools: {
        totalCalls: metrics.tools.totalCalls,
        totalSuccess: metrics.tools.totalSuccess,
        totalFail: metrics.tools.totalFail,
        totalDurationMs: metrics.tools.totalDurationMs,
        byName,
      },
      files: {
        totalLinesAdded: metrics.files.totalLinesAdded,
        totalLinesRemoved: metrics.files.totalLinesRemoved,
      },
      skills: {
        totalCalls: skillMetrics.totalCalls,
        totalSuccess: skillMetrics.totalSuccess,
        totalFail: skillMetrics.totalFail,
        byName: skillsByName,
      },
    };
  }

  private serializeHookConfig(config: HookConfig): ServeHookConfig {
    switch (config.type) {
      case 'command':
        return {
          type: 'command',
          command: config.command,
          ...(config.name !== undefined ? { name: config.name } : {}),
          ...(config.description !== undefined
            ? { description: config.description }
            : {}),
          ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
          ...(config.env ? { env: config.env } : {}),
          ...(config.async !== undefined ? { async: config.async } : {}),
          ...(config.shell ? { shell: config.shell } : {}),
          ...(config.statusMessage !== undefined
            ? { statusMessage: config.statusMessage }
            : {}),
        };
      case 'http':
        return {
          type: 'http',
          url: config.url,
          ...(config.name !== undefined ? { name: config.name } : {}),
          ...(config.description !== undefined
            ? { description: config.description }
            : {}),
          ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
          ...(config.headers ? { headers: config.headers } : {}),
          ...(config.allowedEnvVars
            ? { allowedEnvVars: config.allowedEnvVars }
            : {}),
          ...(config.if !== undefined ? { if: config.if } : {}),
          ...(config.statusMessage !== undefined
            ? { statusMessage: config.statusMessage }
            : {}),
          ...(config.once !== undefined ? { once: config.once } : {}),
        };
      case 'function':
        return {
          type: 'function',
          ...(config.id !== undefined ? { id: config.id } : {}),
          ...(config.name !== undefined ? { name: config.name } : {}),
          ...(config.description !== undefined
            ? { description: config.description }
            : {}),
          ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
          ...(config.errorMessage !== undefined
            ? { errorMessage: config.errorMessage }
            : {}),
          ...(config.statusMessage !== undefined
            ? { statusMessage: config.statusMessage }
            : {}),
        };
      case 'prompt':
        return {
          type: 'prompt',
          prompt: config.prompt,
          ...(config.name !== undefined ? { name: config.name } : {}),
          ...(config.description !== undefined
            ? { description: config.description }
            : {}),
          ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
          ...(config.model ? { model: config.model } : {}),
          ...(config.statusMessage !== undefined
            ? { statusMessage: config.statusMessage }
            : {}),
        };
      default:
        return { type: (config as { type: string }).type };
    }
  }

  private buildWorkspaceHooksStatus(config: Config): ServeWorkspaceHooksStatus {
    try {
      const workspaceCwd = this.workspaceCwd(config);
      const disabled = config.getDisableAllHooks();
      const hookSystem = config.getHookSystem();
      if (!hookSystem) {
        return {
          v: STATUS_SCHEMA_VERSION,
          workspaceCwd,
          initialized: true,
          disabled,
          hooks: [],
          events: IDLE_HOOK_EVENTS,
        };
      }
      const registryEntries = hookSystem.getAllHooks();
      const hooks: ServeHookEntry[] = registryEntries.map(
        (entry): ServeHookEntry => ({
          kind: 'hook',
          eventName: entry.eventName,
          config: this.serializeHookConfig(entry.config),
          source: entry.source as ServeHookSource,
          ...(entry.matcher ? { matcher: entry.matcher } : {}),
          ...(entry.sequential !== undefined
            ? { sequential: entry.sequential }
            : {}),
          enabled: entry.enabled,
        }),
      );
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        initialized: true,
        disabled,
        hooks,
        events: IDLE_HOOK_EVENTS,
      };
    } catch (error) {
      let disabled = false;
      try {
        disabled = config.getDisableAllHooks();
      } catch {
        // config may be in a broken state; fall back to false
      }
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.safeWorkspaceCwd(config),
        initialized: false,
        disabled,
        hooks: [],
        events: IDLE_HOOK_EVENTS,
        errors: [this.errorCell('hooks', error)],
      };
    }
  }

  private buildSessionHooksStatus(sessionId: string): ServeSessionHooksStatus {
    const session = this.sessionOrThrow(sessionId);
    const config = session.getConfig();
    try {
      const workspaceCwd = this.workspaceCwd(config);
      const disabled = config.getDisableAllHooks();
      const hookSystem = config.getHookSystem();
      if (!hookSystem) {
        return {
          v: STATUS_SCHEMA_VERSION,
          sessionId,
          workspaceCwd,
          disabled,
          hooks: [],
        };
      }
      const sessionHooks = hookSystem
        .getSessionHooksManager()
        .getAllSessionHooks(sessionId);
      const hooks: ServeHookEntry[] = sessionHooks.map(
        (entry): ServeHookEntry => ({
          kind: 'hook',
          eventName: entry.eventName,
          config: this.serializeHookConfig(entry.config),
          source: 'session',
          ...(entry.matcher ? { matcher: entry.matcher } : {}),
          ...(entry.sequential !== undefined
            ? { sequential: entry.sequential }
            : {}),
          enabled: true,
          hookId: entry.hookId,
          ...(entry.skillRoot ? { skillRoot: entry.skillRoot } : {}),
        }),
      );
      return {
        v: STATUS_SCHEMA_VERSION,
        sessionId,
        workspaceCwd,
        disabled,
        hooks,
      };
    } catch (error) {
      let disabled = false;
      try {
        disabled = config.getDisableAllHooks();
      } catch {
        // config may be in a broken state; fall back to false
      }
      return {
        v: STATUS_SCHEMA_VERSION,
        sessionId,
        workspaceCwd: this.safeWorkspaceCwd(config),
        disabled,
        hooks: [],
        errors: [this.errorCell('session_hooks', error)],
      };
    }
  }

  private buildWorkspaceExtensionsStatus(
    config: Config,
  ): ServeWorkspaceExtensionsStatus {
    try {
      const workspaceCwd = this.workspaceCwd(config);
      const extensions = config.getExtensions();
      const entries: ServeExtensionEntry[] = extensions.map(
        (ext): ServeExtensionEntry => {
          const capabilities: ServeExtensionCapabilities = {
            mcpServerCount: ext.mcpServers
              ? Object.keys(ext.mcpServers).length
              : 0,
            skillCount: ext.skills?.length ?? 0,
            agentCount: ext.agents?.length ?? 0,
            hookCount: ext.hooks
              ? Object.values(ext.hooks).reduce(
                  (sum, defs) => sum + (defs?.length ?? 0),
                  0,
                )
              : 0,
            commandCount: ext.commands?.length ?? 0,
            contextFileCount: ext.contextFiles.length,
            channelCount: ext.channels ? Object.keys(ext.channels).length : 0,
            hasSettings: (ext.settings?.length ?? 0) > 0,
          };
          return {
            kind: 'extension',
            id: ext.id,
            name: ext.name,
            displayName: ext.displayName,
            ...(ext.config.description
              ? { description: ext.config.description }
              : {}),
            version: ext.version,
            isActive: ext.isActive,
            path: ext.path,
            ...(ext.installMetadata?.source
              ? { source: redactUrlCredentials(ext.installMetadata.source) }
              : {}),
            ...(ext.installMetadata?.type
              ? { installType: ext.installMetadata.type }
              : {}),
            ...(ext.installMetadata?.originSource
              ? { originSource: ext.installMetadata.originSource }
              : {}),
            ...(ext.installMetadata?.ref
              ? { ref: ext.installMetadata.ref }
              : {}),
            ...(ext.installMetadata?.autoUpdate !== undefined
              ? { autoUpdate: ext.installMetadata.autoUpdate }
              : {}),
            capabilities,
            updateState: ext.installMetadata ? 'unknown' : 'not updatable',
            details: {
              mcpServers: ext.mcpServers ? Object.keys(ext.mcpServers) : [],
              commands: ext.commands ?? [],
              skills: ext.skills?.map((skill) => skill.name) ?? [],
              agents: ext.agents?.map((agent) => agent.name) ?? [],
              contextFiles: ext.contextFiles,
              settings:
                ext.resolvedSettings?.map((setting) => setting.name) ?? [],
            },
          };
        },
      );
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        initialized: true,
        extensions: entries,
      };
    } catch (error) {
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.safeWorkspaceCwd(config),
        initialized: false,
        extensions: [],
        errors: [this.errorCell('extensions', error)],
      };
    }
  }

  private runInSessionContext<T>(session: Session, fn: () => T): T {
    // Use the Config's session id spelling (not the lowercased lookup form
    // stored on the Session object) so the context matches the binding in
    // Session.ts and the debug log filename on disk.
    return sessionIdContext.run(session.getConfig().getSessionId(), fn);
  }

  private isSessionScopedExtMethod(method: string): boolean {
    return (
      method === PROMPT_CANCEL_METHOD ||
      method === TODO_STOP_GUARD_QUEUE_RELEASE_METHOD ||
      method.startsWith('qwen/control/session/') ||
      method.startsWith('qwen/status/session/') ||
      method.startsWith('qwen/session/') ||
      method === 'deleteSession' ||
      method === 'renameSession' ||
      method === 'rewindSession' ||
      method === 'restoreSessionHistory'
    );
  }

  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      const rawSessionId = params['sessionId'];
      const normalizedParams =
        typeof rawSessionId === 'string'
          ? {
              ...params,
              sessionId: normalizeSessionIdForLookup(rawSessionId),
            }
          : params;
      if (
        method === SERVE_CONTROL_EXT_METHODS.sessionBackgroundNotification &&
        this.privateParentState !== 'trusted'
      ) {
        throw RequestError.invalidParams(
          undefined,
          'Background notifications require a trusted private ACP parent',
        );
      }
      const sessionId = normalizedParams['sessionId'];
      const session =
        typeof sessionId === 'string' && sessionId.length > 0
          ? this.sessions.get(sessionId)
          : undefined;
      if (
        typeof sessionId === 'string' &&
        sessionId.length > 0 &&
        this.isSessionScopedExtMethod(method) &&
        (session !== undefined || SESSION_ID_RE.test(sessionId))
      ) {
        return await sessionIdContext.run(
          session?.getConfig().getSessionId() ?? sessionId,
          () => this.extMethodInternal(method, normalizedParams),
        );
      }

      return await this.extMethodInternal(method, normalizedParams);
    } catch (error) {
      const writerError = getSessionWriterError(error);
      if (writerError) {
        throw new RequestError(writerError.rpcCode, writerError.message, {
          errorKind: writerError.errorKind,
        });
      }
      throw error;
    }
  }

  private async extMethodInternal(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const requestedCwd =
      typeof params['cwd'] === 'string' ? params['cwd'] : undefined;
    const cwd = requestedCwd || process.cwd();
    switch (method) {
      case SERVE_STATUS_EXT_METHODS.channelPing: {
        const nonce = params['nonce'];
        if (
          params['v'] !== CHANNEL_LIVENESS_VERSION ||
          typeof nonce !== 'number' ||
          !Number.isSafeInteger(nonce) ||
          nonce < 0
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid channel liveness ping',
          );
        }
        return { v: CHANNEL_LIVENESS_VERSION, nonce };
      }
      case PROMPT_CANCEL_METHOD: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const session = this.sessions.get(sessionId);
        if (!session) {
          throw RequestError.invalidParams(
            undefined,
            `Session not found for id: ${sessionId}`,
          );
        }
        const targetedCalls = new Set(
          this.activePromptCalls.get(sessionId) ?? [],
        );
        if (targetedCalls.size === 0) {
          return { cancelled: false };
        }
        targetedCalls.forEach((call) => call.controller.abort());
        await Promise.all(Array.from(targetedCalls, (call) => call.settled));
        return { cancelled: true };
      }
      case TODO_STOP_GUARD_QUEUE_RELEASE_METHOD: {
        const sessionId = params['sessionId'];
        const promptId = params['promptId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (typeof promptId !== 'string' || promptId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing promptId',
          );
        }
        const session = this.sessions.get(sessionId);
        if (!session) {
          throw RequestError.invalidParams(
            undefined,
            `Session not found for id: ${sessionId}`,
          );
        }
        return {
          released: session.releaseTodoStopGuardQueuedPromptWait(promptId),
        };
      }
      case 'qwen/providers/list': {
        return {
          providers: ALL_PROVIDERS.map((provider) =>
            serializeProviderConfig(provider, this.settings),
          ),
        };
      }
      case 'qwen/providers/connect': {
        const providerId = readRequiredString(
          params['providerId'],
          'providerId',
        );
        const providerConfig = findProviderById(providerId);
        if (!providerConfig) {
          throw RequestError.invalidParams(
            undefined,
            `Unknown provider: ${providerId}`,
          );
        }

        const inputs = readProviderSetupInputs(
          providerConfig,
          params,
          (protocol, baseUrl) =>
            resolveExistingProviderApiKey(
              providerConfig,
              this.settings,
              protocol,
              baseUrl,
            ),
        );
        const persistScope = readProviderConnectScope(params['scope']);
        const plan = buildInstallPlan(providerConfig, inputs);
        const adapter = createLoadedSettingsAdapter(
          this.settings,
          persistScope,
        );
        await applyProviderInstallPlan(plan, {
          settings: adapter,
          reloadModelProviders: (modelProviders) =>
            this.config.reloadModelProvidersConfig(modelProviders),
          syncAuthState: (authType, modelId, baseUrl) =>
            this.config
              .getModelsConfig()
              .syncAfterAuthRefresh(authType, modelId, baseUrl),
          refreshAuth: (authType) => this.config.refreshAuth(authType),
        });
        const effectiveModelId =
          (adapter.getValue('model.name') as string | undefined) ??
          plan.modelSelection?.modelId;
        const effectiveBaseUrl =
          (adapter.getValue('model.baseUrl') as string | undefined) ??
          plan.modelSelection?.baseUrl;
        return {
          success: true,
          providerId: providerConfig.id,
          providerLabel: providerConfig.label,
          authType: plan.authType,
          ...(effectiveModelId ? { modelId: effectiveModelId } : {}),
          ...(effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {}),
        };
      }
      case 'qwen/skills/install': {
        return installManagedSkill(this.config, params);
      }
      case 'qwen/skills/delete': {
        return deleteManagedSkill(this.config, params);
      }
      case 'qwen/skills/setEnabled': {
        return setManagedSkillEnabled(this.config, params, requestedCwd);
      }
      case 'qwen/settings/getMemory': {
        const settings = loadSettings(cwd);
        this.settings = settings;
        return {
          settings: normalizeQwenMemorySettings(settings.merged.memory),
        };
      }
      case 'qwen/settings/setMemory': {
        const updates = toRecord(params['updates']);
        // Mutate a freshly loaded settings object and adopt it, mirroring the
        // other settings mutation handlers, instead of writing through the
        // possibly-stale cached `this.settings` and reading it back.
        const settings = loadSettings(cwd);
        for (const key of QWEN_MEMORY_SETTING_KEYS) {
          if (updates[key] === undefined) continue;
          if (typeof updates[key] !== 'boolean') {
            throw RequestError.invalidParams(
              undefined,
              `Invalid memory setting '${key}': expected boolean`,
            );
          }
          settings.setValue(SettingScope.User, `memory.${key}`, updates[key]);
        }
        this.settings = settings;
        return {
          settings: normalizeQwenMemorySettings(settings.merged.memory),
        };
      }
      case 'qwen/settings/getPath': {
        return { path: this.settings.user.path };
      }
      case 'qwen/settings/getMemoryPaths': {
        const projectRoot =
          typeof params['projectRoot'] === 'string'
            ? params['projectRoot']
            : cwd;
        return {
          paths: await resolveQwenMemoryPaths({ cwd, projectRoot }),
        };
      }
      case SERVE_STATUS_EXT_METHODS.workspaceMcp:
        return (await this.buildManagedWorkspaceMcpStatus()) as unknown as Record<
          string,
          unknown
        >;
      case SERVE_STATUS_EXT_METHODS.workspaceMcpTools: {
        const serverName = params['serverName'];
        if (typeof serverName !== 'string' || serverName.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing serverName',
          );
        }
        return this.buildWorkspaceMcpToolsStatus(
          this.getWorkspaceMcpConfig(serverName),
          serverName,
        ) as unknown as Record<string, unknown>;
      }
      case SERVE_STATUS_EXT_METHODS.workspaceMcpResources: {
        const serverName = params['serverName'];
        if (typeof serverName !== 'string' || serverName.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing serverName',
          );
        }
        return this.buildWorkspaceMcpResourcesStatus(
          this.getWorkspaceMcpConfig(serverName),
          serverName,
        ) as unknown as Record<string, unknown>;
      }
      case SERVE_STATUS_EXT_METHODS.workspaceSkills:
        return (await this.buildWorkspaceSkillsStatus(
          this.config,
        )) as unknown as Record<string, unknown>;
      case SERVE_STATUS_EXT_METHODS.workspaceTools:
        return this.buildWorkspaceToolsStatus(this.config) as unknown as Record<
          string,
          unknown
        >;
      case SERVE_STATUS_EXT_METHODS.workspaceProviders:
        return this.buildWorkspaceProvidersStatus(
          this.config,
        ) as unknown as Record<string, unknown>;
      case SERVE_STATUS_EXT_METHODS.workspacePreflight:
        return (await this.buildAcpPreflightCells(
          this.config,
        )) as unknown as Record<string, unknown>;
      case SERVE_STATUS_EXT_METHODS.workspaceResource: {
        // Process-wide rss/cpu of this ACP child, for the Daemon Status
        // child-resource chart. cpuPercent is a delta since the previous poll
        // (mirrors the daemon's own self-sampler), normalized by core count and
        // clamped to [0,100].
        const now = Date.now();
        let cpu: NodeJS.CpuUsage | null = null;
        try {
          cpu = process.cpuUsage();
        } catch {
          /* keep prev baseline on failure → this window reads 0, and the next
             successful poll still measures a correct delta window */
        }
        // Shared delta math: returns 0 when either sample is null (init-time or
        // read failure) or the window is non-positive, so no phantom spike.
        const cpuPercent = computeCpuPercent(
          this.prevChildCpu,
          cpu,
          now - this.prevChildCpuAt,
          this.childCpuCoreCount,
        );
        // Advance the baseline ONLY on a successful read (this also seeds it
        // after an init-time null). Advancing prevAt after a throw would pair a
        // full since-last-success cpuUs with a short since-last-failure
        // elapsedMs on the next poll → a ~2x phantom spike.
        if (cpu) {
          this.prevChildCpu = cpu;
          this.prevChildCpuAt = now;
        }
        // Guard memoryUsage too (same restricted-container risk as cpuUsage): on
        // failure report 0 rss but keep the already-computed cpuPercent rather
        // than throwing the whole handler.
        let rssBytes = 0;
        try {
          rssBytes = process.memoryUsage().rss;
        } catch {
          /* restricted container — report 0 rss */
        }
        // Spread rather than always-present fields: a child without the probe
        // (no daemon marker) omits them entirely, so the daemon can tell "not
        // measured" from a measured zero. Reporting 0 here would read as "this
        // child needs no heap", which is the one wrong answer. The probe
        // itself returns undefined until its first successful read, so a child
        // whose every V8 call throws (restricted container) omits heap the
        // same way instead of publishing a zeroed, coverage-complete report.
        const childHeap = this.childHeapProbe?.snapshot();
        return {
          rssBytes,
          cpuPercent,
          ...(childHeap ? { heap: childHeap } : {}),
        };
      }
      case SERVE_STATUS_EXT_METHODS.sessionContext: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        return this.buildSessionContextStatus(sessionId) as unknown as Record<
          string,
          unknown
        >;
      }
      case SERVE_STATUS_EXT_METHODS.sessionContextUsage: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        return (await this.buildSessionContextUsageStatus(
          sessionId,
          params['detail'] === true,
        )) as unknown as Record<string, unknown>;
      }
      case SERVE_STATUS_EXT_METHODS.sessionSupportedCommands: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        return (await this.buildSessionSupportedCommandsStatus(
          sessionId,
        )) as unknown as Record<string, unknown>;
      }
      case SERVE_STATUS_EXT_METHODS.sessionTasks: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        return this.buildSessionTasksStatus(sessionId) as unknown as Record<
          string,
          unknown
        >;
      }
      case SERVE_STATUS_EXT_METHODS.sessionLspStatus: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        return this.buildSessionLspStatus(sessionId) as unknown as Record<
          string,
          unknown
        >;
      }
      case SERVE_STATUS_EXT_METHODS.sessionTranscript: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const rawCursor = params['cursor'];
        if (rawCursor !== undefined && typeof rawCursor !== 'string') {
          throw RequestError.invalidParams(
            undefined,
            'Invalid transcript cursor',
          );
        }
        const rawBeforeRecordId = params['beforeRecordId'];
        if (
          rawBeforeRecordId !== undefined &&
          (typeof rawBeforeRecordId !== 'string' ||
            rawBeforeRecordId.length === 0)
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid transcript record boundary',
          );
        }
        if (rawCursor !== undefined && rawBeforeRecordId !== undefined) {
          throw RequestError.invalidParams(
            undefined,
            'Transcript cursor and record boundary are mutually exclusive',
          );
        }
        const rawDirection = params['direction'];
        if (rawDirection !== undefined && rawDirection !== 'backward') {
          throw RequestError.invalidParams(
            undefined,
            'Invalid transcript direction',
          );
        }
        if (rawCursor !== undefined && rawDirection !== undefined) {
          throw RequestError.invalidParams(
            undefined,
            'Transcript cursor and direction are mutually exclusive',
          );
        }
        if (rawBeforeRecordId !== undefined && rawDirection !== undefined) {
          throw RequestError.invalidParams(
            undefined,
            'Transcript record boundary and direction are mutually exclusive',
          );
        }
        const rawLimit = params['limit'];
        if (
          rawLimit !== undefined &&
          (!Number.isSafeInteger(rawLimit) ||
            (rawLimit as number) < 1 ||
            (rawLimit as number) > SESSION_TRANSCRIPT_MAX_LIMIT)
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid transcript limit',
          );
        }

        try {
          const settings = loadSettingsCached(cwd);
          return await runWithAcpRuntimeOutputDir(settings, cwd, async () => {
            if (rawDirection === 'backward') {
              await this.sessions
                .get(sessionId)
                ?.getConfig()
                .getChatRecordingService()
                ?.flush();
            }
            const reader = new SessionTranscriptReader(cwd);
            const activePromptBeforeRead =
              this.activePromptCalls.has(sessionId);
            const page = await reader.readPage(sessionId, {
              ...(typeof rawCursor === 'string' ? { cursor: rawCursor } : {}),
              ...(typeof rawBeforeRecordId === 'string'
                ? { beforeRecordId: rawBeforeRecordId }
                : {}),
              ...(rawDirection === 'backward'
                ? { direction: rawDirection }
                : {}),
              ...(typeof rawLimit === 'number' ? { limit: rawLimit } : {}),
              maxBytes: SESSION_TRANSCRIPT_MAX_PAGE_BYTES,
            });
            const config = await this.getTranscriptReplayConfig(cwd, settings);
            const replay = await replayTranscriptRecordPage({
              sessionId,
              page,
              config,
              finalizeDangling:
                !activePromptBeforeRead &&
                !this.activePromptCalls.has(sessionId),
              encodeCursor: (state) =>
                encodeSessionTranscriptCursor(state, cwd),
              logger: debugLogger,
            });
            return {
              v: 1,
              sessionId,
              events: replay.updates.map((update) => ({
                v: 1,
                type: 'session_update',
                data: update,
              })),
              ...(replay.nextCursor !== undefined
                ? { nextCursor: replay.nextCursor }
                : {}),
              hasMore: replay.hasMore,
              startTime: replay.startTime,
              lastUpdated: replay.lastUpdated,
              ...(replay.replayError !== undefined
                ? { partial: true, replayError: replay.replayError }
                : {}),
            } as Record<string, unknown>;
          });
        } catch (error) {
          if (
            error instanceof InvalidSessionTranscriptCursorError ||
            error instanceof RangeError
          ) {
            throw new RequestError(
              -32602,
              error instanceof Error ? error.message : 'Invalid transcript',
              {
                errorKind:
                  error instanceof InvalidSessionTranscriptCursorError
                    ? 'invalid_transcript_cursor'
                    : 'invalid_transcript_limit',
              },
            );
          }
          if (error instanceof SessionTranscriptSnapshotUnavailableError) {
            throw new RequestError(-32010, error.message, {
              errorKind: 'transcript_snapshot_unavailable',
              sessionId,
            });
          }
          if (error instanceof SessionTranscriptTooLargeError) {
            throw new RequestError(-32011, error.message, {
              errorKind: 'transcript_too_large',
              sessionId,
              snapshotSize: error.snapshotSize,
              maxBytes: error.maxBytes,
            });
          }
          if (error instanceof SessionTranscriptPageTooLargeError) {
            throw new RequestError(-32012, error.message, {
              errorKind: 'transcript_page_too_large',
              sessionId,
              pageBytes: error.pageBytes,
              maxBytes: error.maxBytes,
            });
          }
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            if (typeof rawCursor === 'string') {
              throw new RequestError(
                -32010,
                `Transcript snapshot is unavailable for session ${sessionId}`,
                {
                  errorKind: 'transcript_snapshot_unavailable',
                  sessionId,
                },
              );
            }
            throw RequestError.resourceNotFound(`session:${sessionId}`);
          }
          throw error;
        }
      }
      case SERVE_STATUS_EXT_METHODS.sessionStats: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        return this.buildSessionStatsStatus(sessionId) as unknown as Record<
          string,
          unknown
        >;
      }
      case SERVE_STATUS_EXT_METHODS.sessionRewindSnapshots: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const session = this.sessions.get(sessionId as string);
        if (!session) {
          throw RequestError.invalidParams(
            undefined,
            `Session not found for id: ${sessionId}`,
          );
        }
        const fhs = session.getConfig().getFileHistoryService();
        const snapshots = fhs.getSnapshots();
        const rewindableTurnCount = session.getRewindableUserTurnCount();
        const prefix = (sessionId as string) + '########';
        const results = await Promise.all(
          snapshots
            .map((s, idx) => ({ s, idx }))
            .filter(
              ({ s }) =>
                s.promptId.startsWith(prefix) &&
                /^\d+$/.test(s.promptId.slice(prefix.length)),
            )
            .filter(({ idx }) => idx < rewindableTurnCount)
            .map(async ({ s, idx }) => {
              const stats = await fhs.getDiffStats(s.promptId);
              return {
                promptId: s.promptId,
                turnIndex: idx,
                timestamp: s.timestamp.toISOString(),
                diffStats: {
                  filesChanged: stats?.filesChanged?.length ?? 0,
                  insertions: stats?.insertions ?? 0,
                  deletions: stats?.deletions ?? 0,
                },
              };
            }),
        );
        return { snapshots: results } as unknown as Record<string, unknown>;
      }
      case SERVE_STATUS_EXT_METHODS.workspaceHooks:
        return this.buildWorkspaceHooksStatus(this.config) as unknown as Record<
          string,
          unknown
        >;
      case SERVE_STATUS_EXT_METHODS.sessionHooks: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        return this.buildSessionHooksStatus(sessionId) as unknown as Record<
          string,
          unknown
        >;
      }
      case SERVE_STATUS_EXT_METHODS.workspaceExtensions:
        return this.buildWorkspaceExtensionsStatus(
          this.config,
        ) as unknown as Record<string, unknown>;
      case SERVE_CONTROL_EXT_METHODS.workspaceMemoryRememberAvailability:
        return {
          available:
            !(
              this.managedToolInvocationGuard &&
              this.externalToolGuardProviderAttached
            ) && this.config.isManagedMemoryAvailable(),
        };
      case SERVE_CONTROL_EXT_METHODS.workspaceMemoryRemember: {
        this.rejectUnsupportedGuardedHiddenAgent(
          'agent-backed workspace memory remember',
        );
        const content = params['content'];
        if (typeof content !== 'string' || !content.trim()) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing content',
          );
        }
        if (Buffer.byteLength(content, 'utf8') > MAX_REMEMBER_CONTENT_BYTES) {
          throw RequestError.invalidParams(
            undefined,
            'Content exceeds maximum size',
          );
        }
        const rawContextMode = params['contextMode'] ?? 'workspace';
        if (rawContextMode !== 'workspace' && rawContextMode !== 'clean') {
          throw RequestError.invalidParams(undefined, 'Invalid contextMode');
        }
        const contextMode: WorkspaceRememberContextMode = rawContextMode;
        const rawScope = params['scope'];
        if (
          rawScope !== undefined &&
          rawScope !== 'project' &&
          rawScope !== 'user'
        ) {
          throw RequestError.invalidParams(undefined, 'Invalid scope');
        }
        if (!this.config.isManagedMemoryAvailable()) {
          throw new RequestError(
            -32009,
            'Managed memory is unavailable for this daemon workspace',
            { errorKind: 'managed_memory_unavailable' },
          );
        }

        const childSignal = AbortSignal.timeout(
          WORKSPACE_MEMORY_REMEMBER_CHILD_TIMEOUT_MS,
        );
        let projectRoot = '<unknown>';
        try {
          projectRoot = this.config.getProjectRoot();
          const result = await runManagedRememberByAgent({
            config: this.config,
            projectRoot,
            content: content.trim(),
            contextMode,
            ...(rawScope ? { scope: rawScope } : {}),
            abortSignal: childSignal,
          });
          if (result.filesTouched.length > 0) {
            await this.refreshLiveSessionMemoryInstructions(
              'workspace memory remember',
            );
          }
          return result as unknown as Record<string, unknown>;
        } catch (err) {
          if (err instanceof RequestError) {
            throw err;
          }
          const diagnostics = workspaceMemoryFailureDiagnostics(
            err,
            logWorkspaceMemoryExtractionError,
          );
          const code = workspaceMemoryFailureCode(
            err,
            'remember_failed',
            logWorkspaceMemoryExtractionError,
          );
          if (childSignal.aborted) {
            const timeoutCode = 'remember_timeout';
            debugLogger.error('Workspace memory remember timed out:', {
              projectRoot,
              code: timeoutCode,
              details: diagnostics.debugDetails,
              ...(diagnostics.stack ? { stack: diagnostics.stack } : {}),
            });
            throw new RequestError(
              -32099,
              'Workspace memory remember timed out',
              workspaceMemoryErrorData(timeoutCode, diagnostics),
            );
          }
          debugLogger.error('Workspace memory remember failed:', {
            projectRoot,
            code,
            details: diagnostics.debugDetails,
            ...(diagnostics.stack ? { stack: diagnostics.stack } : {}),
          });
          if (shouldSuppressRememberErrorDetails(code)) {
            throw new RequestError(
              -32009,
              'Managed memory is unavailable for this daemon workspace',
              { errorKind: 'managed_memory_unavailable' },
            );
          }
          throw new RequestError(
            -32099,
            'Workspace memory remember failed',
            workspaceMemoryErrorData(code, diagnostics),
          );
        }
      }
      case SERVE_CONTROL_EXT_METHODS.workspaceMemoryForget: {
        const query = params['query'];
        if (typeof query !== 'string' || !query.trim()) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing query',
          );
        }
        const trimmedQuery = query.trim();
        if (
          Buffer.byteLength(trimmedQuery, 'utf8') > MAX_REMEMBER_CONTENT_BYTES
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Query exceeds maximum size',
          );
        }
        const rawScope = params['scope'];
        if (
          rawScope !== undefined &&
          rawScope !== 'project' &&
          rawScope !== 'user'
        ) {
          throw RequestError.invalidParams(undefined, 'Invalid scope');
        }
        if (!this.config.isManagedMemoryAvailable()) {
          throw new RequestError(
            -32009,
            'Managed memory is unavailable for this daemon workspace',
            { errorKind: 'managed_memory_unavailable' },
          );
        }

        const childSignal = AbortSignal.timeout(
          WORKSPACE_MEMORY_REMEMBER_CHILD_TIMEOUT_MS,
        );
        let projectRoot = '<unknown>';
        try {
          projectRoot = this.config.getProjectRoot();
          const hiddenConfig = createHiddenWorkspaceMemoryConfig(this.config);
          const result = await this.config
            .getMemoryManager()
            .forget(projectRoot, trimmedQuery, {
              config: hiddenConfig,
              abortSignal: childSignal,
              ...(rawScope ? { scope: rawScope } : {}),
            });
          return {
            summary:
              result.systemMessage ??
              formatWorkspaceMemoryForgetSummary(result.removedEntries.length),
            removedEntries: result.removedEntries,
            touchedTopics: result.touchedTopics,
            touchedScopes: result.touchedScopes,
          } as unknown as Record<string, unknown>;
        } catch (err) {
          if (err instanceof RequestError) {
            throw err;
          }
          const diagnostics = workspaceMemoryFailureDiagnostics(
            err,
            logWorkspaceMemoryExtractionError,
          );
          const code = workspaceMemoryFailureCode(
            err,
            'forget_failed',
            logWorkspaceMemoryExtractionError,
          );
          if (childSignal.aborted) {
            const timeoutCode = 'forget_timeout';
            debugLogger.error('Workspace memory forget timed out:', {
              projectRoot,
              code: timeoutCode,
              details: diagnostics.debugDetails,
              ...(diagnostics.stack ? { stack: diagnostics.stack } : {}),
            });
            throw new RequestError(
              -32099,
              'Workspace memory forget timed out',
              workspaceMemoryErrorData(timeoutCode, diagnostics),
            );
          }
          debugLogger.error('Workspace memory forget failed:', {
            projectRoot,
            code,
            details: diagnostics.debugDetails,
            ...(diagnostics.stack ? { stack: diagnostics.stack } : {}),
          });
          if (shouldSuppressRememberErrorDetails(code)) {
            throw new RequestError(
              -32009,
              'Managed memory is unavailable for this daemon workspace',
              { errorKind: 'managed_memory_unavailable' },
            );
          }
          throw new RequestError(
            -32099,
            'Workspace memory forget failed',
            workspaceMemoryErrorData(code, diagnostics),
          );
        }
      }
      case SERVE_CONTROL_EXT_METHODS.workspaceMemoryDream: {
        this.rejectUnsupportedGuardedHiddenAgent(
          'agent-backed workspace memory dream',
        );
        if (!this.config.isManagedMemoryAvailable()) {
          throw new RequestError(
            -32009,
            'Managed memory is unavailable for this daemon workspace',
            { errorKind: 'managed_memory_unavailable' },
          );
        }

        const childSignal = AbortSignal.timeout(
          WORKSPACE_MEMORY_REMEMBER_CHILD_TIMEOUT_MS,
        );
        let projectRoot = '<unknown>';
        try {
          projectRoot = this.config.getProjectRoot();
          const result = await runManagedAutoMemoryDream(
            projectRoot,
            new Date(),
            createHiddenWorkspaceMemoryConfig(this.config),
            childSignal,
            {
              trigger: 'manual',
              recordMetadata: true,
              suppressChatRecording: true,
            },
          );
          return {
            summary: result.systemMessage,
            touchedTopics: result.touchedTopics,
            dedupedEntries: result.dedupedEntries,
          } as unknown as Record<string, unknown>;
        } catch (err) {
          if (err instanceof RequestError) {
            throw err;
          }
          const diagnostics = workspaceMemoryFailureDiagnostics(
            err,
            logWorkspaceMemoryExtractionError,
          );
          const code = workspaceMemoryFailureCode(
            err,
            'dream_failed',
            logWorkspaceMemoryExtractionError,
          );
          if (childSignal.aborted) {
            const timeoutCode = 'dream_timeout';
            debugLogger.error('Workspace memory dream timed out:', {
              projectRoot,
              code: timeoutCode,
              details: diagnostics.debugDetails,
              ...(diagnostics.stack ? { stack: diagnostics.stack } : {}),
            });
            throw new RequestError(
              -32099,
              'Workspace memory dream timed out',
              workspaceMemoryErrorData(timeoutCode, diagnostics),
            );
          }
          debugLogger.error('Workspace memory dream failed:', {
            projectRoot,
            code,
            details: diagnostics.debugDetails,
            ...(diagnostics.stack ? { stack: diagnostics.stack } : {}),
          });
          if (shouldSuppressRememberErrorDetails(code)) {
            throw new RequestError(
              -32009,
              'Managed memory is unavailable for this daemon workspace',
              { errorKind: 'managed_memory_unavailable' },
            );
          }
          throw new RequestError(
            -32099,
            'Workspace memory dream failed',
            workspaceMemoryErrorData(code, diagnostics),
          );
        }
      }
      case SERVE_CONTROL_EXT_METHODS.workspaceMcpRestart: {
        // Single-server MCP restart with budget pre-check. Soft skips
        // return structured 200 responses; hard errors propagate as
        // JSON-RPC errors. Pool-mode routing when available.
        const serverName = params['serverName'];
        if (typeof serverName !== 'string' || serverName.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing serverName',
          );
        }
        const config = this.getWorkspaceMcpConfig(serverName);
        // Optional `entryIndex` selector for pool-mode targeted restarts.
        let entryIndex: number | undefined;
        const rawEntryIndex = params['entryIndex'];
        if (rawEntryIndex !== undefined && rawEntryIndex !== '*') {
          if (
            typeof rawEntryIndex !== 'number' ||
            !Number.isInteger(rawEntryIndex) ||
            rawEntryIndex < 0
          ) {
            throw RequestError.invalidParams(
              undefined,
              'entryIndex must be a non-negative integer or "*"',
            );
          }
          entryIndex = rawEntryIndex;
        }
        const servers = config.getMcpServers() ?? {};
        if (!Object.prototype.hasOwnProperty.call(servers, serverName)) {
          // Structured payload so the bridge can map to a typed
          // `McpServerNotFoundError` and HTTP 404.
          throw new RequestError(
            -32004,
            `MCP server not configured: ${JSON.stringify(serverName)}`,
            { errorKind: 'mcp_server_not_found', serverName },
          );
        }
        if (config.isMcpServerDisabled(serverName)) {
          return {
            serverName,
            restarted: false,
            skipped: true,
            reason: 'disabled' as const,
          };
        }
        const server = servers[serverName]!;
        let requiresAuth = mcpServerRequiresOAuth.get(serverName) === true;
        if (!requiresAuth && server.oauth?.enabled === true) {
          try {
            requiresAuth =
              (await new MCPOAuthTokenStorage().getCredentials(serverName)) ===
              null;
          } catch {
            // A token-storage read failure is not proof that authentication is
            // required; let reconnect surface the underlying connection error.
          }
        }
        if (
          requiresAuth &&
          this.getMcpServerStatus(config, serverName) !==
            MCPServerStatus.CONNECTED
        ) {
          return {
            serverName,
            restarted: false,
            skipped: true,
            reason: 'authentication_required' as const,
          };
        }
        const manager = config.getToolRegistry()?.getMcpClientManager();
        if (!manager) {
          throw RequestError.internalError(
            undefined,
            'McpClientManager unavailable on this Config',
          );
        }
        if (manager.isServerDiscovering(serverName)) {
          return {
            serverName,
            restarted: false,
            skipped: true,
            reason: 'in_flight' as const,
          };
        }
        const accounting = manager.getMcpClientAccounting();
        const budget = manager.getMcpClientBudget();
        const mode = manager.getMcpBudgetMode();
        // Check `reservedSlots.length` (not `total`) to mirror the
        // manager's enforce-mode capacity policy.
        if (
          mode === 'enforce' &&
          budget !== undefined &&
          !accounting.reservedSlots.includes(serverName) &&
          accounting.reservedSlots.length >= budget
        ) {
          return {
            serverName,
            restarted: false,
            skipped: true,
            reason: 'budget_would_exceed' as const,
          };
        }
        // Re-read MERGED settings to pick up any `tools.disabled`
        // toggles applied since this ACP child booted. Reads need the
        // union (User + System + Workspace); writes target Workspace only.
        try {
          const fresh = loadSettings(config.getTargetDir());
          const mergedDisabled = fresh.merged.tools?.disabled;
          // Detect and stderr-log malformed `tools.disabled` before
          // clearing so a misconfigured settings file is loud.
          if (mergedDisabled !== undefined && !Array.isArray(mergedDisabled)) {
            process.stderr.write(
              `qwen serve: MCP restart for ${JSON.stringify(serverName)}: ` +
                `tools.disabled has unexpected type ${typeof mergedDisabled}; ` +
                `clearing disabled set — check settings.json. ` +
                `Expected an array of strings.\n`,
            );
          }
          // Use the shared `normalizeDisabledToolList` helper so
          // boot and restart paths agree on what counts as "disabled".
          const disabledList = normalizeDisabledToolList(mergedDisabled);
          config.setDisabledTools(new Set(disabledList));
        } catch (err) {
          // Settings load failures are non-fatal — fall through with
          // the existing in-memory snapshot.
          process.stderr.write(
            `qwen serve: MCP restart for ${JSON.stringify(serverName)} ` +
              `could not refresh disabledTools from merged settings ` +
              `(${err instanceof Error ? err.message : String(err)}); ` +
              `proceeding with the bootstrap snapshot — recently toggled ` +
              `tools may not take effect until daemon restart.\n`,
          );
        }
        // Pool-mode routing: when the pool holds entries for this name,
        // route through the pool. Legacy path stays as fallback.
        const poolSnapshot = this.mcpPool?.getSnapshot();
        const poolHasEntries =
          poolSnapshot !== undefined &&
          (poolSnapshot.byName[serverName]?.entryCount ?? 0) > 0;
        if (this.mcpPool && poolHasEntries) {
          const restartResults = await this.mcpPool.restartByName(serverName, {
            ...(entryIndex !== undefined ? { entryIndex } : {}),
          });
          await Promise.all(
            this.getLiveMcpConfigs(serverName).map(async (liveConfig) => {
              const llmClient = liveConfig.getLlmClient?.();
              if (llmClient?.isInitialized?.()) {
                await llmClient.setTools?.();
              }
            }),
          );
          // When `entryIndex` doesn't match any current pool entry,
          // return an empty `entries` array (soft signal).
          return {
            serverName,
            entries: restartResults,
          };
        }
        // Route through `ToolRegistry.discoverToolsForServer` (not the
        // manager directly) so existing tools are purged before
        // rediscovery — ensures toggle-disable-then-restart works.
        // An explicit `entryIndex` against the legacy (no-pool) path
        // is invalid unless it's 0.
        if (entryIndex !== undefined && entryIndex !== 0) {
          throw RequestError.invalidParams(
            undefined,
            `entryIndex=${entryIndex} requested but pool not active for ` +
              `${JSON.stringify(serverName)} — legacy single-entry path ` +
              `only supports entryIndex=0 or undefined`,
          );
        }
        const start = Date.now();
        await this.reconcileMcpServerAcrossLiveConfigs(serverName, 'discover');
        const disconnectedRuntime = this.getLiveMcpConfigs(serverName).find(
          (liveConfig) =>
            this.getMcpServerStatus(liveConfig, serverName) !==
            MCPServerStatus.CONNECTED,
        );
        if (disconnectedRuntime) {
          const postStatus = this.getMcpServerStatus(
            disconnectedRuntime,
            serverName,
          );
          throw new RequestError(
            -32099,
            `MCP server ${JSON.stringify(serverName)} did not reach a ` +
              `connected state in every live runtime after restart ` +
              `(status: ${postStatus}).`,
            {
              errorKind: 'mcp_restart_failed',
              serverName,
              mcpStatus: postStatus,
            },
          );
        }
        return {
          serverName,
          restarted: true,
          durationMs: Date.now() - start,
        };
      }
      case SERVE_CONTROL_EXT_METHODS.workspaceMcpInitialize:
        return this.initializeWorkspaceMcpDiscovery();
      case SERVE_CONTROL_EXT_METHODS.workspaceMcpReload: {
        const forceReconnectAll = params['forceReconnectAll'];
        const forceReconnectWhich = params['forceReconnectWhich'];
        if (
          forceReconnectAll !== undefined &&
          typeof forceReconnectAll !== 'boolean'
        ) {
          throw RequestError.invalidParams(
            undefined,
            'forceReconnectAll must be a boolean',
          );
        }
        if (
          forceReconnectWhich !== undefined &&
          (!Array.isArray(forceReconnectWhich) ||
            forceReconnectWhich.some(
              (serverName) =>
                typeof serverName !== 'string' || serverName.length === 0,
            ))
        ) {
          throw RequestError.invalidParams(
            undefined,
            'forceReconnectWhich must be an array of server names',
          );
        }
        if (forceReconnectAll === true && forceReconnectWhich !== undefined) {
          throw RequestError.invalidParams(
            undefined,
            'forceReconnectAll and forceReconnectWhich cannot be used together',
          );
        }
        return this.reloadWorkspaceMcpDiscovery({
          forceReconnectAll: forceReconnectAll === true,
          forceReconnectWhich: forceReconnectWhich as string[] | undefined,
        });
      }
      case SERVE_CONTROL_EXT_METHODS.workspaceMcpManage: {
        const serverName = params['serverName'];
        const action = params['action'];
        if (typeof serverName !== 'string' || serverName.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing serverName',
          );
        }
        if (
          action !== 'approve' &&
          action !== 'enable' &&
          action !== 'disable' &&
          action !== 'authenticate' &&
          action !== 'clear-auth'
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing MCP manage action',
          );
        }
        const config = this.getWorkspaceMcpConfig(serverName);
        const servers = config.getMcpServers() ?? {};
        const server = servers[serverName];
        if (!server) {
          throw new RequestError(
            -32004,
            `MCP server not configured: ${JSON.stringify(serverName)}`,
            { errorKind: 'mcp_server_not_found', serverName },
          );
        }
        const toolRegistry = config.getToolRegistry();
        if (!toolRegistry) {
          throw RequestError.internalError(
            undefined,
            'ToolRegistry unavailable on this Config',
          );
        }

        if (action === 'approve') {
          if (!isGatedMcpScope(server.scope)) {
            throw RequestError.invalidParams(
              undefined,
              `MCP server is not approval-gated: ${serverName}`,
            );
          }
          const approvals = loadMcpApprovals();
          await approvals.setState(
            config.getWorkingDir(),
            serverName,
            server,
            'approved',
          );
          for (const liveConfig of this.getLiveMcpConfigs(serverName)) {
            liveConfig.approveMcpServerForSession(serverName);
          }
          await this.reconcileMcpServerAcrossLiveConfigs(
            serverName,
            'discover',
          );
          return { serverName, action, ok: true, changed: true };
        }

        if (action === 'enable') {
          const settings = loadSettings(config.getTargetDir());
          let settingsChanged = false;
          for (const scope of [SettingScope.User, SettingScope.Workspace]) {
            const scopeSettings = settings.forScope(scope).settings;
            const currentExcluded = scopeSettings.mcp?.excluded || [];
            const filtered = currentExcluded.filter(
              (pattern: string) => pattern !== serverName,
            );
            if (filtered.length !== currentExcluded.length) {
              settings.setValue(scope, 'mcp.excluded', filtered);
              settingsChanged = true;
            }
          }
          let runtimeChanged = false;
          for (const liveConfig of this.getLiveMcpConfigs(serverName)) {
            const currentExcluded = liveConfig.getExcludedMcpServers() || [];
            const runtimeFiltered = currentExcluded.filter(
              (pattern: string) => pattern !== serverName,
            );
            if (runtimeFiltered.length !== currentExcluded.length) {
              liveConfig.setExcludedMcpServers(runtimeFiltered);
              runtimeChanged = true;
            }
          }
          await this.reconcileMcpServerAcrossLiveConfigs(
            serverName,
            'discover',
          );
          return {
            serverName,
            action,
            ok: true,
            changed: settingsChanged || runtimeChanged,
          };
        }

        if (action === 'disable') {
          const settings = loadSettings(config.getTargetDir());
          const userSettings = settings.forScope(SettingScope.User).settings;
          const workspaceSettings = settings.forScope(
            SettingScope.Workspace,
          ).settings;
          let targetScope = SettingScope.User;
          if (server.extensionName) {
            throw RequestError.invalidParams(
              undefined,
              `Cannot disable extension MCP server: ${serverName}`,
            );
          }
          if (
            server.scope === 'project' ||
            server.scope === 'workspace' ||
            workspaceSettings.mcpServers?.[serverName]
          ) {
            targetScope = SettingScope.Workspace;
          } else if (userSettings.mcpServers?.[serverName]) {
            targetScope = SettingScope.User;
          }
          const scopeSettings = settings.forScope(targetScope).settings;
          const currentExcluded = scopeSettings.mcp?.excluded || [];
          let settingsChanged = false;
          if (!matchesAnyServerPattern(serverName, currentExcluded)) {
            settings.setValue(targetScope, 'mcp.excluded', [
              ...currentExcluded,
              serverName,
            ]);
            settingsChanged = true;
          }
          let runtimeChanged = false;
          const liveConfigs = this.getLiveMcpConfigs(serverName);
          for (const liveConfig of liveConfigs) {
            const runtimeExcluded = liveConfig.getExcludedMcpServers() || [];
            if (!matchesAnyServerPattern(serverName, runtimeExcluded)) {
              liveConfig.setExcludedMcpServers([
                ...runtimeExcluded,
                serverName,
              ]);
              runtimeChanged = true;
            }
          }
          await this.reconcileMcpServerAcrossLiveConfigs(serverName, 'disable');
          return {
            serverName,
            action,
            ok: true,
            changed: settingsChanged || runtimeChanged,
          };
        }

        if (action === 'clear-auth') {
          const tokenStorage = new MCPOAuthTokenStorage();
          await tokenStorage.deleteCredentials(serverName);
          await this.reconcileMcpServerAcrossLiveConfigs(
            serverName,
            'disconnect',
          );
          return { serverName, action, ok: true, changed: true };
        }

        let pending = this.pendingMcpAuthentications.get(serverName);
        if (!pending) {
          this.mcpAuthenticationResults.delete(serverName);
          const messages: string[] = [];
          let resolveStarted!: (value: {
            authUrl: string;
            messages: string[];
          }) => void;
          let rejectStarted!: (reason: unknown) => void;
          let startedTimer!: NodeJS.Timeout;
          const started = new Promise<{
            authUrl: string;
            messages: string[];
          }>((resolve, reject) => {
            resolveStarted = (value) => {
              clearTimeout(startedTimer);
              resolve(value);
            };
            rejectStarted = (reason) => {
              clearTimeout(startedTimer);
              reject(reason);
            };
            startedTimer = setTimeout(
              () =>
                rejectStarted(
                  new Error(
                    `MCP OAuth authentication did not provide a URL within ${MCP_OAUTH_START_TIMEOUT_MS / 1000} seconds`,
                  ),
                ),
              MCP_OAUTH_START_TIMEOUT_MS,
            );
            startedTimer.unref();
          });
          pending = { started };
          this.pendingMcpAuthentications.set(serverName, pending);

          const displayListener = (message: unknown) => {
            if (typeof message === 'string') {
              messages.push(message);
            } else if (message && typeof message === 'object') {
              const key = (message as { key?: unknown }).key;
              if (typeof key === 'string') messages.push(key);
            }
          };
          const authUrlListener = (url: unknown) => {
            if (typeof url === 'string') {
              resolveStarted({ authUrl: url, messages: [...messages] });
            }
          };
          appEvents.on(AppEvent.OauthDisplayMessage, displayListener);
          appEvents.on(AppEvent.OauthAuthUrl, authUrlListener);
          void (async () => {
            try {
              try {
                const oauthConfig = server.oauth ?? { enabled: false };
                const mcpServerUrl = server.httpUrl || server.url;
                const authProvider = new MCPOAuthProvider(
                  new MCPOAuthTokenStorage(),
                );
                await authProvider.authenticate(
                  serverName,
                  oauthConfig,
                  mcpServerUrl,
                  appEvents,
                );
                this.mcpAuthenticationResults.set(serverName, {
                  state: 'succeeded',
                });
              } catch (error) {
                this.mcpAuthenticationResults.set(serverName, {
                  state: 'failed',
                  error: error instanceof Error ? error.message : String(error),
                });
                rejectStarted(error);
                debugLogger.warn(
                  `MCP OAuth authentication failed for ${serverName}:`,
                  error,
                );
                return;
              }
              try {
                await this.reconcileMcpServerAcrossLiveConfigs(
                  serverName,
                  'discover',
                );
              } catch (error) {
                debugLogger.warn(
                  `MCP OAuth authenticated for ${serverName}, but tool synchronization failed:`,
                  error,
                );
              }
            } finally {
              appEvents.removeListener(
                AppEvent.OauthDisplayMessage,
                displayListener,
              );
              appEvents.removeListener(AppEvent.OauthAuthUrl, authUrlListener);
              this.pendingMcpAuthentications.delete(serverName);
            }
          })();
        }

        const { authUrl, messages } = await pending.started;
        return {
          serverName,
          action,
          ok: true,
          pending: true,
          messages,
          authUrl,
        };
      }
      case SERVE_CONTROL_EXT_METHODS.workspaceGenerationStart: {
        const requestId = params['requestId'];
        const prompt = params['prompt'];
        if (typeof requestId !== 'string' || requestId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing requestId',
          );
        }
        if (
          typeof prompt !== 'string' ||
          !prompt.trim() ||
          Buffer.byteLength(prompt, 'utf8') > GENERATION_MAX_PROMPT_BYTES ||
          params['purpose'] !== 'text'
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid workspace generation request',
          );
        }
        if (this.workspaceGenerationControllers.has(requestId)) {
          throw RequestError.invalidParams(
            undefined,
            'Duplicate workspace generation requestId',
          );
        }
        const controller = new AbortController();
        this.workspaceGenerationControllers.set(requestId, controller);
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(GENERATION_TIMEOUT_MS),
        ]);
        try {
          const emit = async (event: GenerationEvent) => {
            await this.connection.extNotification(
              'qwen/notify/workspace/generation/event',
              { v: 1, requestId, event },
            );
          };
          const result = await executeGeneration(
            this.config,
            requestId,
            prompt.trim(),
            signal,
            emit,
          );
          return { requestId, ...result };
        } finally {
          this.workspaceGenerationControllers.delete(requestId);
        }
      }
      case SERVE_CONTROL_EXT_METHODS.workspaceAgentGenerate: {
        const description = params['description'];
        if (
          typeof description !== 'string' ||
          !description.trim() ||
          description.length > 4096
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing description (max 4096 chars)',
          );
        }
        // No end-to-end AbortSignal from the bridge ext-method yet.
        // The bridge may time out via Promise.race, but that only
        // rejects the caller — this generator keeps running until it
        // finishes naturally. A real fix requires wiring an abort
        // signal through the ext-method protocol.
        return (await subagentGenerator(
          description.trim(),
          this.config,
          AbortSignal.timeout(5 * 60_000),
        )) as unknown as Record<string, unknown>;
      }
      case SERVE_CONTROL_EXT_METHODS.workspaceGenerationCancel: {
        const requestId = params['requestId'];
        if (typeof requestId !== 'string' || requestId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing requestId',
          );
        }
        const controller = this.workspaceGenerationControllers.get(requestId);
        const cancelled = controller !== undefined;
        if (cancelled) {
          controller.abort();
          this.workspaceGenerationControllers.delete(requestId);
        }
        return { requestId, cancelled };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionArtifactsPersist: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const kind = params['kind'];
        if (kind !== 'event' && kind !== 'snapshot') {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing artifact persist kind',
          );
        }
        const payload = params['payload'];
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing artifact persist payload',
          );
        }
        const session = this.sessionOrThrow(sessionId);
        const recording = session.getConfig().getChatRecordingService();
        if (!recording) {
          throw RequestError.internalError(
            undefined,
            'Chat recording service unavailable',
          );
        }
        if (kind === 'event') {
          await recording.recordSessionArtifactEvent(
            parseSessionArtifactEventPayload(payload, sessionId),
          );
        } else {
          await recording.recordSessionArtifactSnapshot(
            parseSessionArtifactSnapshotPayload(payload, sessionId),
          );
        }
        return { sessionId, persisted: true, kind };
      }
      case 'qwen/session/recordTextElements': {
        const sessionId = params['sessionId'];
        const content = params['content'];
        const textElements = params['textElements'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (typeof content !== 'string' || !Array.isArray(textElements)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid user text elements payload',
          );
        }
        const session = this.sessionOrThrow(sessionId);
        await session.assertCanStartTurn();
        const recording = session.getConfig().getChatRecordingService();
        if (!recording) {
          throw RequestError.internalError(
            undefined,
            'Chat recording service unavailable',
          );
        }
        await recording.recordUserTextElements({ content, textElements });
        return { sessionId, persisted: true };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionTitle: {
        const sessionId = params['sessionId'];
        const displayName = params['displayName'];
        const titleSource = params['titleSource'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (typeof displayName !== 'string') {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing displayName',
          );
        }
        if (displayName.length > SESSION_TITLE_MAX_LENGTH) {
          throw RequestError.invalidParams(
            undefined,
            `Title too long (max ${SESSION_TITLE_MAX_LENGTH} chars)`,
          );
        }
        const session = this.sessionOrThrow(sessionId);
        const source =
          titleSource === 'auto' ? ('auto' as const) : ('manual' as const);
        const recording = session.getConfig().getChatRecordingService();
        let ok = false;
        if (recording) {
          ok = await recording.recordCustomTitle(displayName, source);
        }
        return { sessionId, displayName, titleSource: source, persisted: ok };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionParent: {
        const sessionId = params['sessionId'];
        const parentSessionId = params['parentSessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (
          typeof parentSessionId !== 'string' ||
          parentSessionId.length === 0
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing parentSessionId',
          );
        }
        const session = this.sessionOrThrow(sessionId);
        const recording = session.getConfig().getChatRecordingService();
        let ok = false;
        if (recording) {
          // Awaited: `recordParentSession` resolves only once the record is
          // durably written, so `persisted` never claims success for a write
          // that silently failed.
          ok = await recording.recordParentSession(parentSessionId);
        }
        return { sessionId, parentSessionId, persisted: ok };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionSource: {
        const sessionId = params['sessionId'];
        const sourceType = params['sourceType'];
        const sourceId = params['sourceId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const source = parseSessionSource(sourceType, sourceId);
        if ('error' in source || source.sourceType === undefined) {
          throw RequestError.invalidParams(
            undefined,
            'error' in source ? source.error : 'Invalid or missing sourceType',
          );
        }
        if (isReservedStandaloneSessionSourceType(source.sourceType)) {
          const standaloneSession = this.sessionOrThrow(sessionId);
          if (
            params[DAEMON_OWNED_STANDALONE_CREATION_KEY] !== true ||
            this.privateParentState !== 'trusted' ||
            !isReservedStandaloneSessionSourceType(
              standaloneSession.getConfig().getSessionSourceType(),
            )
          ) {
            throw RequestError.invalidParams(
              undefined,
              '`standalone` is reserved for daemon-owned session creation',
            );
          }
        }
        const session = this.sessionOrThrow(sessionId);
        if (isCompatibleLiveSessionSource(source)) {
          await session.enableLiveScreenContext();
        }
        const recording = session.getConfig().getChatRecordingService();
        let ok = false;
        if (recording) {
          ok = await recording.recordSessionSource(
            source.sourceType,
            source.sourceId,
          );
        }
        return {
          sessionId,
          sourceType: source.sourceType,
          ...(source.sourceId !== undefined
            ? { sourceId: source.sourceId }
            : {}),
          persisted: ok,
        };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionLiveConversation: {
        const sessionId = params['sessionId'];
        const active = params['active'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (typeof active !== 'boolean') {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing active state',
          );
        }
        await this.sessionOrThrow(sessionId).setLiveConversationActive(active);
        return { sessionId, active };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionLiveTranscript: {
        const sessionId = params['sessionId'];
        const entries = params['entries'];
        const model = params['model'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (
          typeof model !== 'string' ||
          model.length === 0 ||
          model.length > 256
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing realtime model',
          );
        }
        if (!Array.isArray(entries) || entries.length > 128) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid realtime transcript entries',
          );
        }
        const transcript: Array<{
          role: 'user' | 'assistant';
          text: string;
        }> = [];
        let totalLength = 0;
        for (const entry of entries) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw RequestError.invalidParams(
              undefined,
              'Invalid realtime transcript entry',
            );
          }
          const role = (entry as Record<string, unknown>)['role'];
          const text = (entry as Record<string, unknown>)['text'];
          if (
            (role !== 'user' && role !== 'assistant') ||
            typeof text !== 'string' ||
            text.length === 0 ||
            text.length > 32_768
          ) {
            throw RequestError.invalidParams(
              undefined,
              'Invalid realtime transcript entry',
            );
          }
          totalLength += text.length;
          if (totalLength > 131_072) {
            throw RequestError.invalidParams(
              undefined,
              'Realtime transcript is too large',
            );
          }
          transcript.push({ role, text });
        }
        await this.sessionOrThrow(sessionId).appendLiveConversationTranscript(
          transcript,
          model,
        );
        return { sessionId, persisted: transcript.length };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionBackgroundNotification: {
        const sessionId = params['sessionId'];
        const displayText = params['displayText'];
        const modelText = params['modelText'];
        const taskId = params['taskId'];
        const status = params['status'];
        const kind = params['kind'];
        const toolUseId = params['toolUseId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (
          typeof displayText !== 'string' ||
          displayText.length === 0 ||
          displayText.length > 8_192
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing background notification displayText',
          );
        }
        if (
          typeof modelText !== 'string' ||
          modelText.length === 0 ||
          modelText.length > 32_768
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing background notification modelText',
          );
        }
        if (
          typeof taskId !== 'string' ||
          taskId.length === 0 ||
          taskId.length > 256
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing background notification taskId',
          );
        }
        if (
          status !== 'completed' &&
          status !== 'failed' &&
          status !== 'cancelled'
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid background notification status',
          );
        }
        if (kind !== 'agent') {
          throw RequestError.invalidParams(
            undefined,
            'Invalid background notification kind',
          );
        }
        if (
          toolUseId !== undefined &&
          (typeof toolUseId !== 'string' ||
            toolUseId.length === 0 ||
            toolUseId.length > 256)
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid background notification toolUseId',
          );
        }
        const session = this.sessionOrThrow(sessionId);
        const result = await session.enqueueBackgroundNotification({
          displayText,
          modelText,
          taskId,
          status,
          kind,
          ...(typeof toolUseId === 'string' ? { toolUseId } : {}),
        });
        return { sessionId, accepted: result.accepted };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionClose: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const rawDrainTimeoutMs = params['drainTimeoutMs'];
        if (
          rawDrainTimeoutMs !== undefined &&
          (typeof rawDrainTimeoutMs !== 'number' ||
            !Number.isSafeInteger(rawDrainTimeoutMs) ||
            rawDrainTimeoutMs < 1 ||
            rawDrainTimeoutMs > 2_147_483_647)
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid session close drain timeout',
          );
        }
        const outcome = await this.closeStoredSession(sessionId, {
          requireFlush: params['requireFlush'] === true,
          onlyIfUnheld: params[ACTIVE_WORK_CLOSE_IF_UNHELD_PARAM] === true,
          ...(typeof rawDrainTimeoutMs === 'number'
            ? { drainTimeoutMs: rawDrainTimeoutMs }
            : {}),
        });
        // `holds` rides along only on a refusal, so the response every existing
        // caller already parses keeps its exact shape.
        return outcome.closed
          ? { sessionId, closed: true }
          : { sessionId, closed: false, holds: outcome.holds };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionCd: {
        const sessionId = params['sessionId'];
        const targetPath = params['path'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (
          typeof targetPath !== 'string' ||
          targetPath.length === 0 ||
          !path.isAbsolute(targetPath) ||
          targetPath.includes('\0')
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing path (must be an absolute path)',
          );
        }
        const managedRelocation = params['managedRelocation'];
        if (
          managedRelocation !== undefined &&
          managedRelocation !== 'live-conversation'
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid managed relocation capability',
          );
        }
        const conversationDirectoryExpectation =
          parseConversationDirectoryExpectation(
            params['conversationDirectoryExpectation'],
          );
        if (
          conversationDirectoryExpectation !== undefined &&
          managedRelocation !== 'live-conversation'
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Managed conversation directory expectation requires managed relocation',
          );
        }
        const allowedRoots = params['allowedRoots'];

        const session = this.sessionOrThrow(sessionId);
        const config = session.getConfig();
        const standalone = isReservedStandaloneSessionSourceType(
          config.getSessionSourceType(),
        );
        if (
          standalone &&
          (managedRelocation !== 'live-conversation' ||
            conversationDirectoryExpectation === undefined)
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Standalone relocation requires an exact managed directory expectation',
          );
        }
        if (conversationDirectoryExpectation !== undefined) {
          if (
            this.privateParentState !== 'trusted' ||
            conversationDirectoryExpectation.canonicalSessionId !==
              normalizeSessionIdForLookup(sessionId) ||
            !Array.isArray(allowedRoots) ||
            allowedRoots.length !== 1 ||
            typeof allowedRoots[0] !== 'string' ||
            !isSameConversationPath(
              allowedRoots[0],
              conversationDirectoryExpectation.root.canonicalPath,
            ) ||
            !isSameConversationPath(
              targetPath,
              conversationDirectoryExpectation.child.canonicalPath,
            )
          ) {
            throw managedConversationDirectoryError(false);
          }
          await assertManagedConversationDirectoryIdentity(
            conversationDirectoryExpectation,
          );
        }

        // Restrictive sandbox check
        if (config.isRestrictiveSandbox()) {
          throw new RequestError(-32003, 'Restrictive sandbox mode active', {
            errorKind: 'restrictive_sandbox',
          });
        }

        // Verify directory exists
        let stats;
        try {
          stats = await fs.stat(targetPath);
        } catch {
          if (conversationDirectoryExpectation !== undefined) {
            throw managedConversationDirectoryError(true);
          }
          throw new RequestError(-32002, `Directory not found: ${targetPath}`, {
            errorKind: 'directory_not_found',
            path: targetPath,
          });
        }
        if (!stats.isDirectory()) {
          if (conversationDirectoryExpectation !== undefined) {
            throw managedConversationDirectoryError(false);
          }
          throw new RequestError(-32002, `Not a directory: ${targetPath}`, {
            errorKind: 'directory_not_found',
            path: targetPath,
          });
        }

        // Canonicalize path
        let canonicalPath: string;
        try {
          canonicalPath = await fs.realpath(targetPath);
        } catch (error) {
          if (conversationDirectoryExpectation !== undefined) {
            throw managedConversationDirectoryError(
              (error as NodeJS.ErrnoException).code === 'ENOENT',
            );
          }
          throw error;
        }

        let containmentRoots = allowedRoots;
        let managedTrustAllowed = false;
        if (managedRelocation === 'live-conversation') {
          if (this.privateParentState !== 'trusted') {
            throw RequestError.invalidParams(
              undefined,
              'Live managed relocation requires a trusted private ACP parent',
            );
          }
          if (
            !Array.isArray(allowedRoots) ||
            allowedRoots.length !== 1 ||
            typeof allowedRoots[0] !== 'string' ||
            !path.isAbsolute(allowedRoots[0]) ||
            allowedRoots[0].includes('\0')
          ) {
            throw RequestError.invalidParams(
              undefined,
              'Live managed relocation requires one absolute allowed root',
            );
          }

          const rootPath = allowedRoots[0];
          let rootBefore: Stats;
          let canonicalRoot: string;
          let rootAfter: Stats;
          try {
            rootBefore = await fs.lstat(rootPath);
            canonicalRoot = await fs.realpath(rootPath);
            rootAfter = await fs.lstat(canonicalRoot);
          } catch {
            if (conversationDirectoryExpectation !== undefined) {
              throw managedConversationDirectoryError(false);
            }
            throw new RequestError(
              -32004,
              'Live managed relocation requires an owner-only allowed root',
              { errorKind: 'containment_violation', path: rootPath },
            );
          }
          if (
            !isOwnerOnlyDirectory(rootBefore) ||
            !isOwnerOnlyDirectory(rootAfter) ||
            !isSameDirectoryIdentity(rootBefore, rootAfter) ||
            (conversationDirectoryExpectation !== undefined &&
              (!isSameConversationPath(
                canonicalRoot,
                conversationDirectoryExpectation.root.canonicalPath,
              ) ||
                !hasExpectedManagedDirectoryIdentity(
                  rootAfter,
                  conversationDirectoryExpectation.root,
                )))
          ) {
            if (conversationDirectoryExpectation !== undefined) {
              throw managedConversationDirectoryError(false);
            }
            throw new RequestError(
              -32004,
              'Live managed relocation requires an owner-only allowed root',
              { errorKind: 'containment_violation', path: rootPath },
            );
          }

          let targetBefore: Stats;
          let targetAfter: Stats;
          try {
            targetBefore = await fs.lstat(targetPath);
            targetAfter = await fs.lstat(canonicalPath);
          } catch (error) {
            if (conversationDirectoryExpectation !== undefined) {
              throw managedConversationDirectoryError(
                (error as NodeJS.ErrnoException).code === 'ENOENT',
              );
            }
            throw new RequestError(
              -32004,
              'Live managed relocation requires an owner-only direct child',
              { errorKind: 'containment_violation', path: canonicalPath },
            );
          }
          const relativeTarget = path.relative(canonicalRoot, canonicalPath);
          if (
            !isOwnerOnlyDirectory(targetBefore) ||
            !isOwnerOnlyDirectory(targetAfter) ||
            !isSameDirectoryIdentity(targetBefore, targetAfter) ||
            (conversationDirectoryExpectation !== undefined &&
              (!isSameConversationPath(
                canonicalPath,
                conversationDirectoryExpectation.child.canonicalPath,
              ) ||
                !hasExpectedManagedDirectoryIdentity(
                  targetAfter,
                  conversationDirectoryExpectation.child,
                ))) ||
            relativeTarget.length === 0 ||
            relativeTarget.startsWith('..') ||
            path.isAbsolute(relativeTarget) ||
            relativeTarget.includes(path.sep)
          ) {
            if (conversationDirectoryExpectation !== undefined) {
              throw managedConversationDirectoryError(false);
            }
            throw new RequestError(
              -32004,
              'Live managed relocation requires an owner-only direct child',
              { errorKind: 'containment_violation', path: canonicalPath },
            );
          }

          let rootFinal: Stats;
          try {
            rootFinal = await fs.lstat(canonicalRoot);
          } catch {
            if (conversationDirectoryExpectation !== undefined) {
              throw managedConversationDirectoryError(false);
            }
            throw new RequestError(
              -32004,
              'Live managed relocation allowed root changed during validation',
              { errorKind: 'containment_violation', path: canonicalRoot },
            );
          }
          if (
            !isOwnerOnlyDirectory(rootFinal) ||
            !isSameDirectoryIdentity(rootFinal, rootAfter) ||
            (conversationDirectoryExpectation !== undefined &&
              !hasExpectedManagedDirectoryIdentity(
                rootFinal,
                conversationDirectoryExpectation.root,
              ))
          ) {
            if (conversationDirectoryExpectation !== undefined) {
              throw managedConversationDirectoryError(false);
            }
            throw new RequestError(
              -32004,
              'Live managed relocation allowed root changed during validation',
              { errorKind: 'containment_violation', path: canonicalRoot },
            );
          }
          containmentRoots = [canonicalRoot];
          managedTrustAllowed = true;
        }

        // Server-controlled containment check (worktree create/restore).
        // Must run BEFORE the no-op check: a no-op cd to a directory
        // outside the allowed roots must still be rejected.
        if (Array.isArray(containmentRoots) && containmentRoots.length > 0) {
          const contained = containmentRoots.some((root: unknown) => {
            if (typeof root !== 'string') return false;
            const rel = path.relative(root, canonicalPath);
            return !rel.startsWith('..') && !path.isAbsolute(rel);
          });
          if (!contained) {
            if (conversationDirectoryExpectation !== undefined) {
              throw managedConversationDirectoryError(false);
            }
            throw new RequestError(
              -32004,
              `Path outside allowed roots: ${canonicalPath}`,
              { errorKind: 'containment_violation', path: canonicalPath },
            );
          }
        }

        const previousCwd = config.getTargetDir();
        let trustValidated = false;
        const validateTrust = () => {
          if (
            managedTrustAllowed ||
            !isFolderTrustEnabled(this.settings.merged)
          ) {
            trustValidated = true;
            return;
          }
          const trustedFolders = loadTrustedFolders();
          if (trustedFolders.isPathTrusted(canonicalPath) !== true) {
            throw new RequestError(
              -32001,
              `Directory not trusted: ${canonicalPath}`,
              { errorKind: 'directory_not_trusted', path: canonicalPath },
            );
          }
          trustValidated = true;
        };
        if (canonicalPath !== previousCwd) {
          validateTrust();
        }

        const releaseGate = await beginSessionCloseAfterCurrentGate(
          session,
          SESSION_DRAIN_TIMEOUT_MS,
        );
        try {
          const settledPreviousCwd = config.getTargetDir();
          if (
            canonicalPath === settledPreviousCwd &&
            conversationDirectoryExpectation === undefined
          ) {
            return {
              previousCwd: settledPreviousCwd,
              newCwd: canonicalPath,
              warnings: [],
            };
          }
          if (!trustValidated) {
            validateTrust();
          }

          session.hardSuspendTodoStopGuard();
          await waitForSessionDrain(
            session.waitForActiveTurnsToSettle(),
            SESSION_DRAIN_TIMEOUT_MS,
            'close',
          );
          if (
            conversationDirectoryExpectation !== undefined &&
            session.hasStandaloneRelocationBlockers()
          ) {
            throw new RequestError(
              -32602,
              'Cannot relocate while standalone background work is active',
              { errorKind: 'session_busy' },
            );
          }

          // Relocate working directory (skip process.chdir and artifact
          // migration for ACP — storage stays at the bound workspace so
          // branch/load/lifecycle paths remain consistent).
          const warnings: string[] = [];
          const relocation = await config.relocateWorkingDirectory(
            canonicalPath,
            canonicalPath,
            { skipProcessChdir: true, skipArtifactMigration: true },
          );
          if (conversationDirectoryExpectation !== undefined) {
            await assertManagedConversationDirectoryIdentity(
              conversationDirectoryExpectation,
            );
            session.installPendingManagedConversationBinding(
              conversationDirectoryExpectation,
              () =>
                assertManagedConversationDirectoryIdentity(
                  conversationDirectoryExpectation,
                ),
            );
          }
          if (relocation.memoryRefreshError) {
            warnings.push(
              `Memory refresh failed: ${
                relocation.memoryRefreshError instanceof Error
                  ? relocation.memoryRefreshError.message
                  : String(relocation.memoryRefreshError)
              }`,
            );
          }
          if (relocation.mcpRefreshError) {
            warnings.push(
              `MCP refresh failed: ${
                relocation.mcpRefreshError instanceof Error
                  ? relocation.mcpRefreshError.message
                  : String(relocation.mcpRefreshError)
              }`,
            );
          }

          try {
            await config
              .getLlmClient()
              ?.addWorkingDirectoryChangedContext(
                settledPreviousCwd,
                canonicalPath,
              );
          } catch (error) {
            warnings.push(
              `Model context refresh failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }

          return {
            previousCwd: settledPreviousCwd,
            newCwd: canonicalPath,
            warnings,
          };
        } finally {
          releaseGate();
        }
      }
      case SERVE_CONTROL_EXT_METHODS.sessionManagedConversationBindingCommit:
      case SERVE_CONTROL_EXT_METHODS.sessionManagedConversationBindingRelease: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (this.privateParentState !== 'trusted') {
          throw RequestError.invalidParams(
            undefined,
            'Managed conversation binding requires a trusted private ACP parent',
          );
        }
        const expectation = parseConversationDirectoryExpectation(
          params['conversationDirectoryExpectation'],
        );
        if (
          expectation === undefined ||
          expectation.canonicalSessionId !==
            normalizeSessionIdForLookup(sessionId)
        ) {
          throw managedConversationDirectoryError(false);
        }
        const session = this.sessionOrThrow(sessionId);
        if (
          !isReservedStandaloneSessionSourceType(
            session.getConfig().getSessionSourceType(),
          )
        ) {
          throw managedConversationDirectoryError(false);
        }
        await assertManagedConversationDirectoryIdentity(expectation);
        if (
          method ===
          SERVE_CONTROL_EXT_METHODS.sessionManagedConversationBindingCommit
        ) {
          await session.commitManagedConversationBinding(expectation);
          return { sessionId, committed: true };
        }
        await session.releaseManagedConversationBinding(expectation);
        return { sessionId, released: true };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionApprovalMode: {
        const sessionId = params['sessionId'];
        const mode = params['mode'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (
          typeof mode !== 'string' ||
          !APPROVAL_MODES.includes(mode as ApprovalMode)
        ) {
          throw RequestError.invalidParams(
            undefined,
            `Invalid approval mode; allowed: ${APPROVAL_MODES.join(', ')}`,
          );
        }
        const session = this.sessionOrThrow(sessionId);
        const config = session.getConfig();
        const previous = config.getApprovalMode();
        try {
          config.setApprovalMode(mode as ApprovalMode);
        } catch (err) {
          // `TrustGateError` is the core's structured rejection for
          // untrusted-folder + privileged-mode. We re-raise it as a
          // JSON-RPC error whose `data.errorKind` is the literal the
          // bridge looks for to reconstruct a typed `TrustGateError` on
          // the daemon side (JSON-RPC strips the class name across the
          // wire). Other errors propagate unchanged.
          if (err instanceof Error && err.name === 'TrustGateError') {
            throw new RequestError(-32003, err.message, {
              errorKind: 'trust_gate',
            });
          }
          throw err;
        }
        const current = config.getApprovalMode();
        if (current === 'plan') {
          if (previous !== 'plan') {
            session.clearActiveTodoPlanRevision();
          }
          session.clearTodoStopGuardTrust();
        } else if (previous === 'plan') {
          session.clearActiveTodoPlanRevision();
        }
        return { previous, current };
      }
      case SERVE_CONTROL_EXT_METHODS.workspaceSessionWorkflow: {
        const enabled = params['enabled'];
        if (typeof enabled !== 'boolean') {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing Session Workflow setting',
          );
        }
        // Same-value guard: the settings POST routes push the post-write
        // *effective* value, and a system-scope settings file can shadow a
        // workspace write, so the effective value can equal the override
        // already pinned here. Re-applying would clear every live session's
        // active plan revision even though the gate never changed (the
        // workspaceReload twin above guards its no-op case the same way).
        // This only covers the already-pinned case: on the first write the
        // override is still `undefined`, so the per-session no-op decision
        // inside applySessionWorkflowOverrideToLiveSessions catches a first
        // write whose pushed value matches what live sessions already derive
        // from settings.
        if (this.sessionWorkflowEnabledOverride === enabled) {
          return { enabled, sessionsUpdated: 0 };
        }
        const sessionsUpdated =
          this.applySessionWorkflowOverrideToLiveSessions(enabled);
        return { enabled, sessionsUpdated };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionLanguage: {
        const sessionId = params['sessionId'];
        const language = params['language'];
        const syncOutputLanguage = params['syncOutputLanguage'] === true;

        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const allowedLanguages = [
          ...SUPPORTED_LANGUAGES.map((l) => l.code),
          'auto',
        ];
        if (
          typeof language !== 'string' ||
          !allowedLanguages.includes(language)
        ) {
          throw RequestError.invalidParams(
            undefined,
            `Invalid language; must be one of: ${allowedLanguages.join(', ')}`,
          );
        }

        const session = this.sessionOrThrow(sessionId);

        try {
          await setLanguageAsync(language);
        } catch (err) {
          debugLogger.warn('setLanguageAsync failed:', err);
          throw new RequestError(
            -32603,
            `Failed to switch UI language: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        const resolvedLanguage = getCurrentLanguage();

        try {
          this.settings.setValue(
            SettingScope.User,
            'general.language',
            language,
          );
        } catch (err) {
          debugLogger.warn('Failed to persist UI language setting:', err);
        }

        let outputLanguage: string | null = null;
        let refreshed = false;

        if (syncOutputLanguage) {
          const settingValue = resolveOutputLanguageOrPreserveAuto(language);

          let fileWriteOk = false;
          try {
            writeOutputLanguageAndRegisterPath(
              settingValue,
              session.getConfig(),
            );
            fileWriteOk = true;
          } catch (err) {
            debugLogger.warn('Failed to write output-language.md:', err);
          }

          if (fileWriteOk) {
            try {
              this.settings.setValue(
                SettingScope.User,
                'general.outputLanguage',
                settingValue,
              );
            } catch (err) {
              debugLogger.warn(
                'Failed to persist output language setting:',
                err,
              );
            }
            const writtenPath =
              session.getConfig().getOutputLanguageFilePath() ??
              getOutputLanguageFilePath();
            const allSessions = [...this.sessions.values()];
            const results = await Promise.allSettled(
              allSessions.map(async (s) => {
                const cfg = s.getConfig();
                let sessionPath: string | undefined;
                try {
                  sessionPath = cfg.getOutputLanguageFilePath();
                  if (sessionPath && sessionPath !== writtenPath) {
                    updateOutputLanguageFile(settingValue, sessionPath);
                  }
                  if (!sessionPath) {
                    writeOutputLanguageAndRegisterPath(settingValue, cfg);
                  }
                } catch (err) {
                  debugLogger.warn(
                    `Failed to write output-language.md for session ${s.getId()} (path=${sessionPath ?? 'global-default'}):`,
                    err,
                  );
                }
                await cfg.refreshHierarchicalMemory();
                await cfg.getLlmClient()?.refreshSystemInstruction();
              }),
            );
            const failedCount = results.filter(
              (r) => r.status === 'rejected',
            ).length;
            if (failedCount > 0) {
              debugLogger.warn(
                `Language refresh failed for ${failedCount}/${results.length} session(s)`,
              );
            }
            refreshed = results.length === 0 || failedCount === 0;
          }
          outputLanguage = fileWriteOk ? settingValue : null;
        }

        return { language: resolvedLanguage, outputLanguage, refreshed };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionRecap: {
        // Generate a one-sentence "where did I leave off" summary.
        // Best-effort: returns `null` on short history or model failure.
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        debugLogger.debug(`recap ext-method received for session=${sessionId}`);
        const session = this.sessionOrThrow(sessionId);
        const config = session.getConfig();
        // v1: no cross-process abort plumbing. The bridge does not listen
        // for HTTP client disconnect and no AbortSignal is threaded through
        // the ext-method, so the LLM call in this child always runs to
        // completion. The only ceilings are the bridge's 60s
        // `SESSION_RECAP_TIMEOUT_MS` backstop and the transport-closed race
        // against ACP channel death. Acceptable because recap is short
        // (single-attempt side-query, `maxOutputTokens: 300`). A future
        // request-id-based cancel ext-method can plumb a real signal
        // end-to-end if the bandwidth cost ever becomes an issue.
        const recap = await generateSessionRecap(
          config,
          new AbortController().signal,
        );
        debugLogger.debug(
          `recap ext-method completed for session=${sessionId} result=${recap ? `len=${recap.length}` : 'null'}`,
        );
        return { sessionId, recap };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionGenerationStart: {
        const sessionId = params['sessionId'];
        const requestId = params['requestId'];
        const prompt = params['prompt'];
        if (
          typeof sessionId !== 'string' ||
          typeof requestId !== 'string' ||
          typeof prompt !== 'string' ||
          prompt.trim().length === 0 ||
          Buffer.byteLength(prompt, 'utf8') > GENERATION_MAX_PROMPT_BYTES
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid generation request',
          );
        }
        if (this.generationControllers.has(requestId)) {
          throw RequestError.invalidParams(
            undefined,
            'Duplicate generation requestId',
          );
        }

        const session = this.sessionOrThrow(sessionId);
        const controller = new AbortController();
        this.generationControllers.set(requestId, { sessionId, controller });
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(GENERATION_TIMEOUT_MS),
        ]);
        try {
          const result = await executeGeneration(
            session.getConfig(),
            requestId,
            prompt,
            signal,
            async (event) => {
              await this.connection.extNotification(
                'qwen/notify/session/generation/event',
                { v: 1, sessionId, requestId, event },
              );
            },
          );
          return { sessionId, requestId, ...result };
        } finally {
          this.generationControllers.delete(requestId);
        }
      }
      case SERVE_CONTROL_EXT_METHODS.sessionGenerationCancel: {
        const sessionId = params['sessionId'];
        const requestId = params['requestId'];
        if (typeof sessionId !== 'string' || typeof requestId !== 'string') {
          throw RequestError.invalidParams(
            undefined,
            'Invalid generation cancellation request',
          );
        }
        const generation = this.generationControllers.get(requestId);
        const cancelled = generation?.sessionId === sessionId;
        if (cancelled) {
          generation.controller.abort();
          this.generationControllers.delete(requestId);
        }
        return { sessionId, requestId, cancelled };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionBtw: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const question = params['question'];
        if (
          typeof question !== 'string' ||
          !question.trim() ||
          question.length > BTW_MAX_INPUT_LENGTH
        ) {
          throw RequestError.invalidParams(
            undefined,
            `Invalid or missing question (max ${BTW_MAX_INPUT_LENGTH} chars)`,
          );
        }
        const session = this.sessionOrThrow(sessionId);
        const config = session.getConfig();
        const cacheSafeParams = buildBtwCacheSafeParams(config);
        if (!cacheSafeParams) {
          debugLogger.debug(`btw: no cacheSafeParams for session=${sessionId}`);
          return { sessionId, answer: null };
        }
        const childSignal = AbortSignal.timeout(BTW_CHILD_TIMEOUT_MS);
        let result;
        try {
          result = await runForkedAgent({
            config,
            userMessage: buildBtwPrompt(question.trim()),
            cacheSafeParams,
            abortSignal: childSignal,
          });
        } catch (err) {
          if (childSignal.aborted) {
            throw RequestError.internalError(
              undefined,
              'Side question timed out after 55s',
            );
          }
          throw err;
        }
        return { sessionId, answer: result.text || null };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionForkAgent: {
        if (
          this.managedToolInvocationGuard &&
          this.externalToolGuardProviderAttached
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Managed external tool guard v1 does not support /fork.',
          );
        }
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const directive =
          typeof params['directive'] === 'string' ? params['directive'] : '';
        const trimmed = directive.trim();
        if (!trimmed) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing directive',
          );
        }

        const session = this.sessionOrThrow(sessionId);
        const config = session.getConfig();
        if (!config.getModel()) {
          throw RequestError.invalidParams(undefined, 'No model configured.');
        }

        let hasHistory = false;
        try {
          hasHistory =
            (config.getLlmClient().getHistoryShallow() ?? []).length > 0;
        } catch (error) {
          debugLogger.debug('Failed to read history before /fork:', error);
        }
        if (!hasHistory) {
          throw RequestError.invalidParams(
            undefined,
            'Cannot fork before the first conversation turn.',
          );
        }

        const agentTool = config.getToolRegistry().getTool(ToolNames.AGENT);
        if (!agentTool) {
          throw RequestError.invalidParams(
            undefined,
            'The agent tool is unavailable; cannot fork.',
          );
        }

        const description = deriveForkDescription(trimmed);
        const agentParams: AgentParams = {
          description,
          prompt: trimmed,
          subagent_type: FORK_SUBAGENT_TYPE,
          run_in_background: true,
        };
        const result = await agentTool
          .build(agentParams)
          .execute(new AbortController().signal);
        if (hasFailedDisplayStatus(result?.returnDisplay)) {
          const reason =
            typeof result.llmContent === 'string' && result.llmContent.trim()
              ? result.llmContent.trim()
              : 'the background agent could not be started.';
          throw RequestError.invalidParams(
            undefined,
            `Failed to launch fork: ${reason}`,
          );
        }

        try {
          config.getLlmClient().addHistory({
            role: 'user',
            parts: [
              {
                text: `User launched a background fork via /fork. Directive (truncated): ${truncateForkDirectiveForHistory(
                  trimmed,
                )}`,
              },
            ],
          });
        } catch (error) {
          debugLogger.debug('Failed to record fork event in history:', error);
        }

        return { sessionId, description, launched: true };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionShellHistory: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const command = params['command'];
        if (typeof command !== 'string') {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing command',
          );
        }
        const session = this.sessionOrThrow(sessionId);
        const config = session.getConfig();
        const llmClient = config.getLlmClient()!;
        const outputText =
          typeof params['output'] === 'string' ? params['output'] : '';
        llmClient.addHistory({
          role: 'user',
          parts: [
            {
              text: `I ran the following shell command:\n\`\`\`sh\n${command}\n\`\`\`\n\nThis produced the following result:\n\`\`\`\n${outputText}\n\`\`\``,
            },
          ],
        });
        return { sessionId, injected: true };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionTaskCancel: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const taskId = params['taskId'];
        if (typeof taskId !== 'string' || taskId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing taskId',
          );
        }
        const taskKind = params['taskKind'];
        if (
          taskKind !== 'agent' &&
          taskKind !== 'shell' &&
          taskKind !== 'monitor'
        ) {
          throw RequestError.invalidParams(
            undefined,
            'taskKind must be "agent", "shell", or "monitor"',
          );
        }
        debugLogger.info(
          `sessionTaskCancel requested sessionId=${sessionId} taskId=${taskId} taskKind=${taskKind}`,
        );
        const session = this.sessionOrThrow(sessionId);
        const config = session.getConfig();
        switch (taskKind) {
          case 'agent': {
            const task = config.getBackgroundTaskRegistry().get(taskId);
            if (
              !task ||
              (task.status !== 'running' && task.status !== 'paused')
            ) {
              const reason = task ? 'not_running' : 'not_found';
              debugLogger.info(
                `sessionTaskCancel skipped sessionId=${sessionId} taskId=${taskId} taskKind=${taskKind} reason=${reason} status=${task?.status ?? 'missing'}`,
              );
              return { cancelled: false, reason, status: task?.status };
            }
            if (task.status === 'paused') {
              config.getBackgroundTaskRegistry().abandon(taskId);
            } else {
              config.getBackgroundTaskRegistry().cancel(taskId);
            }
            debugLogger.info(
              `sessionTaskCancel completed sessionId=${sessionId} taskId=${taskId} taskKind=${taskKind} status=${task.status}`,
            );
            return { cancelled: true, status: task.status };
          }
          case 'shell': {
            const task = config.getBackgroundShellRegistry().get(taskId);
            if (!task || task.status !== 'running') {
              const reason = task ? 'not_running' : 'not_found';
              debugLogger.info(
                `sessionTaskCancel skipped sessionId=${sessionId} taskId=${taskId} taskKind=${taskKind} reason=${reason} status=${task?.status ?? 'missing'}`,
              );
              return { cancelled: false, reason, status: task?.status };
            }
            config.getBackgroundShellRegistry().requestCancel(taskId);
            debugLogger.info(
              `sessionTaskCancel completed sessionId=${sessionId} taskId=${taskId} taskKind=${taskKind} status=${task.status}`,
            );
            return { cancelled: true, status: task.status };
          }
          case 'monitor': {
            const task = config.getMonitorRegistry().get(taskId);
            if (!task || task.status !== 'running') {
              const reason = task ? 'not_running' : 'not_found';
              debugLogger.info(
                `sessionTaskCancel skipped sessionId=${sessionId} taskId=${taskId} taskKind=${taskKind} reason=${reason} status=${task?.status ?? 'missing'}`,
              );
              return { cancelled: false, reason, status: task?.status };
            }
            config.getMonitorRegistry().cancel(taskId);
            debugLogger.info(
              `sessionTaskCancel completed sessionId=${sessionId} taskId=${taskId} taskKind=${taskKind} status=${task.status}`,
            );
            return { cancelled: true, status: task.status };
          }
          default: {
            const exhaustive: never = taskKind;
            throw new Error(`Unhandled task kind: ${exhaustive}`);
          }
        }
      }
      case SERVE_CONTROL_EXT_METHODS.sessionGoalClear: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const session = this.sessionOrThrow(sessionId);
        const config = session.getConfig();
        let runtime;
        try {
          runtime = await config.getGoalRuntimeReady();
        } catch (error) {
          if (!(error instanceof GoalPersistenceUnavailableError)) throw error;
          // No persistence means no goal to clear. Answering honestly beats
          // failing the request: `general.chatRecording: false` is a config
          // choice, and a sticky `recoveryError` from a malformed transcript
          // record would otherwise break clear for this session forever.
          debugLogger.info(
            `sessionGoalClear sessionId=${sessionId} cleared=false (goal persistence unavailable)`,
          );
          return {
            cleared: false,
            condition: undefined,
            snapshot: emptyGoalSnapshot(),
          };
        }
        const before = runtime.getSnapshot();
        const goal = before.goal;
        const response = goal
          ? await runtime.dispatch({
              action: 'clear',
              expectedGoalId: goal.goalId,
              expectedRevision: goal.revision,
            })
          : { snapshot: before };
        debugLogger.info(
          `sessionGoalClear sessionId=${sessionId} cleared=${!!goal} objective=${goal?.objective ?? '(none)'}`,
        );
        return {
          cleared: !!goal,
          condition: goal?.objective,
          snapshot: response.snapshot,
        };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionGoalControl: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const request = parseGoalControlRequest(params['request']);
        if (!request) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing Goal control request',
          );
        }
        const session = this.sessionOrThrow(sessionId);
        const response = await dispatchGoalControl(
          session.getConfig(),
          request,
        );
        return { snapshot: response.snapshot };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionGoalGet: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const session = this.sessionOrThrow(sessionId);
        let snapshot: GoalSnapshotV2;
        try {
          snapshot = (
            await session.getConfig().getGoalRuntimeReady()
          ).getSnapshot();
        } catch (error) {
          if (!(error instanceof GoalPersistenceUnavailableError)) throw error;
          // A session that cannot persist goals has no goal, which is a
          // perfectly describable state. Rejecting instead would make
          // `GET /goals` drop this session on every poll and report it as
          // unreachable, which reads as a wedged child rather than a config.
          snapshot = emptyGoalSnapshot();
        }
        const activeGoal =
          snapshot.goal?.status === 'active' ? snapshot.goal : null;
        return {
          snapshot,
          active: activeGoal
            ? {
                condition: activeGoal.objective,
                iterations: activeGoal.turnCount,
                setAt: activeGoal.createdAt,
                ...(activeGoal.lastReason !== undefined
                  ? { lastReason: activeGoal.lastReason }
                  : {}),
              }
            : null,
        };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionTurnStatus: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const rawPromptId = params['promptId'];
        if (
          rawPromptId !== undefined &&
          (typeof rawPromptId !== 'string' || rawPromptId.length === 0)
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing promptId',
          );
        }
        const session = this.sessionOrThrow(sessionId);
        const settings = loadSettingsCached(cwd);
        return await runWithAcpRuntimeOutputDir(settings, cwd, async () => {
          try {
            await session.getConfig().getChatRecordingService()?.flush();
          } catch {
            // Read the last durable snapshot after a best-effort flush.
          }
          let reader: SessionTranscriptReader | undefined;
          try {
            reader = new SessionTranscriptReader(cwd);
            const turnResult = await findSettledTurnResult(
              reader,
              sessionId,
              typeof rawPromptId === 'string' ? rawPromptId : undefined,
              cwd,
            );
            return {
              v: 1,
              sessionId,
              turnResult: turnResult ?? null,
            };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              // Transcript file not written yet (no settled turn
              // persisted). Scoped to the read so an unrelated ENOENT
              // (settings/runtime resolution) still surfaces.
              return { v: 1, sessionId, turnResult: null };
            }
            if (
              error instanceof SessionTranscriptSnapshotUnavailableError &&
              reader
            ) {
              try {
                const transcript = await fs.stat(
                  reader.getSessionFilePath(sessionId),
                );
                if (transcript.size === 0) {
                  return { v: 1, sessionId, turnResult: null };
                }
              } catch (statError) {
                if ((statError as NodeJS.ErrnoException).code === 'ENOENT') {
                  return { v: 1, sessionId, turnResult: null };
                }
              }
            }
            if (error instanceof InvalidSessionTranscriptCursorError) {
              throw new RequestError(-32602, error.message, {
                errorKind: 'invalid_transcript_cursor',
              });
            }
            if (error instanceof SessionTranscriptSnapshotUnavailableError) {
              throw new RequestError(-32010, error.message, {
                errorKind: 'transcript_snapshot_unavailable',
                sessionId,
              });
            }
            if (error instanceof SessionTranscriptTooLargeError) {
              throw new RequestError(-32011, error.message, {
                errorKind: 'transcript_too_large',
                sessionId,
                snapshotSize: error.snapshotSize,
                maxBytes: error.maxBytes,
              });
            }
            if (error instanceof SessionTranscriptPageTooLargeError) {
              throw new RequestError(-32012, error.message, {
                errorKind: 'transcript_page_too_large',
                sessionId,
                pageBytes: error.pageBytes,
                maxBytes: error.maxBytes,
              });
            }
            throw error;
          }
        });
      }
      case SERVE_CONTROL_EXT_METHODS.sessionContinue: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const session = this.sessionOrThrow(sessionId);
        const result = await session.continueLastTurn();
        debugLogger.info(
          `sessionContinue sessionId=${sessionId} accepted=${result.accepted} interruption=${result.interruption}`,
        );
        return result;
      }
      case SERVE_CONTROL_EXT_METHODS.workspaceMcpRuntimeAdd: {
        const request = readRuntimeMcpAddRequest(params);
        const result = await addRuntimeMcpServer(
          getRuntimeMcpManager(this.config),
          request,
        );
        await Promise.all(
          this.getActiveSessions().map(async (session) => {
            const sessionManager = session
              .getConfig()
              .getToolRegistry()
              ?.getMcpClientManager();
            if (!sessionManager) return;
            try {
              await sessionManager.addRuntimeMcpServer(
                request.name,
                request.config,
                request.runtimeClientId,
              );
            } catch (sessionErr) {
              debugLogger.warn(
                `workspaceMcpRuntimeAdd: failed to add runtime MCP server ` +
                  `'${request.name}' to active session ${session.getConfig().getSessionId()}: ` +
                  `${
                    sessionErr instanceof Error
                      ? sessionErr.message
                      : String(sessionErr)
                  }`,
              );
            }
          }),
        );
        return result;
      }
      case SERVE_CONTROL_EXT_METHODS.workspaceMcpRuntimeRemove: {
        const request = readRuntimeMcpRequest(params);
        const result = await getRuntimeMcpManager(
          this.config,
        ).removeRuntimeMcpServer(request.name, request.runtimeClientId);
        // Mirror of the add fan-out (#5626): the runtime server was also
        // registered on each active session's manager, so deregistering it
        // must tear it down there too — otherwise an active session keeps a
        // stale client-hosted server (and its WS-bound SDK transport) alive
        // after the extension is gone. Best-effort + additive: per-session
        // failures are logged, never failing the deregistration; no active
        // sessions ⇒ no-op.
        await Promise.all(
          this.getActiveSessions().map(async (session) => {
            const sessionManager = session
              .getConfig()
              .getToolRegistry()
              ?.getMcpClientManager();
            if (!sessionManager) return;
            try {
              await sessionManager.removeRuntimeMcpServer(
                request.name,
                request.runtimeClientId,
              );
            } catch (sessionErr) {
              debugLogger.warn(
                `workspaceMcpRuntimeRemove: failed to remove runtime MCP server ` +
                  `'${request.name}' from active session ${session.getConfig().getSessionId()}: ` +
                  `${
                    sessionErr instanceof Error
                      ? sessionErr.message
                      : String(sessionErr)
                  }`,
              );
            }
          }),
        );
        return result as unknown as Record<string, unknown>;
      }
      case SERVE_CONTROL_EXT_METHODS.sessionMcpRuntimeAdd: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const session = this.sessionOrThrow(sessionId);
        return addRuntimeMcpServer(
          getRuntimeMcpManager(session.getConfig()),
          readRuntimeMcpAddRequest(params),
        );
      }
      case SERVE_CONTROL_EXT_METHODS.sessionMcpRuntimeRemove: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const session = this.sessionOrThrow(sessionId);
        const request = readRuntimeMcpRequest(params);
        const result = await getRuntimeMcpManager(
          session.getConfig(),
        ).removeRuntimeMcpServer(request.name, request.runtimeClientId);
        return result as unknown as Record<string, unknown>;
      }
      case SERVE_CONTROL_EXT_METHODS.workspaceExtensionsRefresh: {
        const sessionId = params['sessionId'] as string;
        const rawRefreshBootstrap = params['refreshBootstrap'];
        if (
          rawRefreshBootstrap !== undefined &&
          typeof rawRefreshBootstrap !== 'boolean'
        ) {
          throw RequestError.invalidParams(
            undefined,
            'refreshBootstrap must be a boolean',
          );
        }
        const session = this.sessionOrThrow(sessionId);
        const config = session.getConfig();
        const extensionManager = config.getExtensionManager();
        const errors: unknown[] = [];
        const runRefresh = async (refresh: () => Promise<unknown>) => {
          try {
            await refresh();
          } catch (error) {
            errors.push(error);
          }
        };
        await runRefresh(async () => await extensionManager.refreshCache());
        await runRefresh(async () => await extensionManager.refreshTools());
        const bootstrapConfig = this.config;
        if (rawRefreshBootstrap !== false && bootstrapConfig !== config) {
          await runRefresh(
            async () => await this.refreshBootstrapExtensionStatus(),
          );
        }
        const discoveryConfig = this.workspaceMcpDiscoveryConfig;
        if (discoveryConfig && discoveryConfig !== config) {
          const discoveryExtensionManager =
            discoveryConfig.getExtensionManager();
          await runRefresh(
            async () => await discoveryExtensionManager.refreshCache(),
          );
          await runRefresh(
            async () => await discoveryExtensionManager.refreshTools(),
          );
        }
        await runRefresh(
          async () => await config.getLlmClient()?.refreshSystemInstruction(),
        );
        await runRefresh(
          async () => await session.sendAvailableCommandsUpdate(),
        );
        if (errors.length > 0) {
          const details = errors
            .map((error) =>
              error instanceof Error ? error.message : String(error),
            )
            .join('; ');
          throw new AggregateError(
            errors,
            `Extension runtime refresh failed: ${details}`,
          );
        }
        return { ok: true };
      }
      case 'deleteSession': {
        const sessionId = params['sessionId'] as string;
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const success = await runWithAcpRuntimeOutputDir(
          this.settings,
          cwd,
          async () => {
            const sessionService = new SessionService(cwd);
            return sessionService.removeSession(sessionId);
          },
        );
        if (success) {
          fireSessionDeleteHook(this.config, sessionId, debugLogger);
        }
        return { success };
      }
      case 'renameSession': {
        const sessionId = params['sessionId'] as string;
        const title = params['title'] as string;
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (!title || typeof title !== 'string') {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing title',
          );
        }
        if (title.length > SESSION_TITLE_MAX_LENGTH) {
          throw RequestError.invalidParams(
            undefined,
            `Title too long (max ${SESSION_TITLE_MAX_LENGTH} chars)`,
          );
        }
        // When the target session is currently live in this process, route
        // through its ChatRecordingService so the in-memory `currentCustomTitle`
        // stays in sync. Writing directly to disk via SessionService here
        // would leave the live recording's cache stale; the next title
        // re-anchor (every 32KB of writes) or finalize() would re-emit the
        // old title and silently revert the rename. The disk-only path
        // remains for the dead-session case (e.g., another client renaming
        // a session that isn't active in this process).
        const liveRecording = this.sessions
          .get(sessionId)
          ?.getConfig()
          .getChatRecordingService();
        if (liveRecording) {
          const ok = await liveRecording.recordCustomTitle(title, 'manual');
          return { success: ok };
        }
        const success = await runWithAcpRuntimeOutputDir(
          this.settings,
          cwd,
          async () => {
            const sessionService = new SessionService(cwd);
            return sessionService.renameSession(sessionId, title);
          },
        );
        return { success };
      }
      case 'rewindSession':
      case SERVE_CONTROL_EXT_METHODS.sessionRewind: {
        const sessionId = params['sessionId'] as string;
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const session = this.sessions.get(sessionId);
        if (!session) {
          throw RequestError.invalidParams(
            undefined,
            `Session not found for id: ${sessionId}`,
          );
        }

        // Fail fast like branch admission: the bridge bounds this RPC with a
        // timeout that races but cannot cancel queued work, so a rewind
        // admitted behind an active turn would still truncate history after
        // the client was told it failed. rewindToTurn re-checks inside the
        // gate.
        if (!session.isTurnIdle()) {
          throw new RequestError(
            -32602,
            'Cannot rewind while a prompt is running',
            {
              errorKind: 'session_busy',
            },
          );
        }

        // Validate request FORMAT synchronously at RPC entry so a malformed
        // rewind fails with a deterministic invalid_rewind_target instead of
        // queueing behind an active mutation and surfacing as a bridge
        // timeout (which for a destructive op means "may have executed").
        // Only the snapshot-index resolution needs the gate.
        const rawPromptId = params['promptId'];
        if (rawPromptId !== undefined && typeof rawPromptId !== 'string') {
          throw new RequestError(-32602, 'Invalid promptId format', {
            errorKind: 'invalid_rewind_target',
          });
        }
        const promptId =
          typeof rawPromptId === 'string' ? rawPromptId : undefined;
        let turnIndex: number | undefined = params['targetTurnIndex'] as
          | number
          | undefined;
        const resolveFromPromptId =
          promptId !== undefined &&
          (turnIndex === undefined || turnIndex === null);
        if (resolveFromPromptId) {
          const prefix = sessionId + '########';
          if (!promptId.startsWith(prefix)) {
            throw new RequestError(-32602, 'Invalid promptId format', {
              errorKind: 'invalid_rewind_target',
            });
          }
          const suffix = promptId.slice(prefix.length);
          if (!/^\d+$/.test(suffix)) {
            throw new RequestError(
              -32602,
              'Invalid promptId: non-numeric turn suffix',
              { errorKind: 'invalid_rewind_target' },
            );
          }
        } else if (!Number.isInteger(turnIndex) || (turnIndex as number) < 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing targetTurnIndex',
          );
        }

        return await this.runExclusiveHistoryMutation(sessionId, async () => {
          if (resolveFromPromptId) {
            // Derive turnIndex from the snapshot's position in the array,
            // NOT from the promptId suffix. Session.turn is monotonic and
            // does not reset on rewind, so after a rewind cycle the suffix
            // no longer matches the turn's position in the current history.
            const fhs = session.getConfig().getFileHistoryService();
            const snapshots = fhs.getSnapshots();
            const snapshotIdx = snapshots.findIndex(
              (s) => s.promptId === promptId,
            );
            if (snapshotIdx < 0) {
              throw new RequestError(
                -32602,
                'Snapshot not found for the given promptId',
                { errorKind: 'invalid_rewind_target' },
              );
            }
            turnIndex = snapshotIdx;
          }

          const rewindFiles = params['rewindFiles'] !== false;
          const historyBeforeRewind = session.captureHistorySnapshot();
          let rewindResult;
          let releaseHistoryMutation: () => void;
          try {
            rewindResult = session.rewindToTurn(turnIndex as number, {
              rewindFiles,
            });
            releaseHistoryMutation = session.beginHistoryMutation();
          } catch (err) {
            if (err instanceof RequestError) {
              const msg = err.message;
              if (
                msg.includes('Cannot rewind while a prompt is running') ||
                msg.includes('Session is busy processing a turn')
              ) {
                throw new RequestError(err.code, msg, {
                  errorKind: 'session_busy',
                });
              }
              if (msg.includes('compressed or does not exist')) {
                throw new RequestError(err.code, msg, {
                  errorKind: 'invalid_rewind_target',
                });
              }
            }
            throw err;
          }

          try {
            let filesChanged: string[] = [];
            let filesFailed: string[] = [];
            if (rewindFiles && promptId) {
              const fhs = session.getConfig().getFileHistoryService();
              try {
                const fileResult = await fhs.rewind(promptId, true);
                filesChanged = fileResult.filesChanged;
                filesFailed = fileResult.filesFailed;
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                debugLogger.error(
                  `[ACP] File-history rewind failed for session=${sessionId} promptId=${promptId}: ${reason}`,
                );
                filesFailed = [`file-history-rewind: ${reason}`];
              }
            }
            let artifactSnapshot: unknown;
            let artifactSnapshotUnavailable: string | undefined;
            try {
              const config = session.getConfig();
              const recording = config.getChatRecordingService();
              await recording?.flush();
              const loadAuthoritative = () =>
                config.getSessionService().loadSession(sessionId);
              const sessionData = recording
                ? await recording.runWithWriteBarrier(loadAuthoritative)
                : await loadAuthoritative();
              if (sessionData === undefined) {
                artifactSnapshotUnavailable =
                  'session data unavailable after rewind';
              } else if (sessionData.artifactSnapshot) {
                artifactSnapshot = sessionData.artifactSnapshot;
              } else {
                // A successful reload with no artifact records is a valid empty
                // artifact timeline, distinct from an unavailable reload.
                artifactSnapshot = {
                  v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
                  sessionId,
                  sequence: 0,
                  artifacts: [],
                  tombstonedIds: [],
                  stickyEphemeralIds: [],
                  warnings: [],
                };
              }
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              artifactSnapshotUnavailable =
                'artifact snapshot unavailable after rewind';
              debugLogger.warn(
                `[ACP] Failed to rebuild artifact snapshot after rewind for session=${sessionId}: ${reason}`,
              );
            }

            return {
              success: true,
              historyBeforeRewind,
              ...rewindResult,
              filesChanged,
              filesFailed,
              ...(artifactSnapshot ? { artifactSnapshot } : {}),
              ...(artifactSnapshotUnavailable
                ? { artifactSnapshotUnavailable }
                : {}),
            };
          } finally {
            releaseHistoryMutation();
          }
        });
      }
      case 'qwen/session/loadUpdates': {
        const sessionId = params['sessionId'] as string;
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }

        const liveSession = this.sessions.get(sessionId);
        const turnIdleBeforeRead = liveSession?.isTurnIdle() ?? true;
        let replayConfig = this.config;
        let sessionData: ResumedSessionData | undefined;
        if (liveSession) {
          const config = liveSession.getConfig();
          await this.assertLiveSessionScope(
            config,
            loadSettingsCached(cwd),
            cwd,
          );
          const recording = config.getChatRecordingService();
          const loadAuthoritative = () =>
            config.getSessionService().loadSession(sessionId);
          sessionData = recording
            ? await recording.runWithWriteBarrier(loadAuthoritative)
            : await loadAuthoritative();
          replayConfig = config;
        } else {
          const settings = loadSettingsCached(cwd);
          sessionData = await this.runWithPinnedRuntimeBaseDir(
            settings,
            cwd,
            async () => {
              const sessionService = new SessionService(cwd);
              return sessionService.loadSession(sessionId);
            },
          );
        }
        if (!sessionData?.conversation) {
          return { updates: [] };
        }

        const replay = await collectHistoryReplayUpdates({
          sessionId,
          config: replayConfig,
          records: sessionData.conversation.messages,
          gaps: sessionData.historyGaps,
          cumulativeUsage: createReplayCumulativeUsage(),
          logger: debugLogger,
          // Read-only history dump never re-hangs the question. Skip
          // finalize only on load/resume that will actually restore.
          suppressRestoreAskUserQuestion: true,
          // Ungated read: unlike the live loadSession restore (whose gate
          // drains turns), a turn may still be running here, so guard on
          // turn activity instead of finalizing unconditionally (#9704).
          finalizeDangling: this.finalizeDanglingForRestore(
            liveSession,
            turnIdleBeforeRead,
          ),
        });

        return {
          updates: replay.updates,
          startTime: sessionData.conversation.startTime,
          lastUpdated: sessionData.conversation.lastUpdated,
          // Signal to the client that replay aborted partway so it doesn't
          // render a truncated replay as the full conversation.
          ...(replay.replayError !== undefined
            ? { partial: true, replayError: replay.replayError }
            : {}),
        };
      }
      case 'restoreSessionHistory': {
        const sessionId = params['sessionId'] as string;
        const history = params['history'];
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (!Array.isArray(history)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing history',
          );
        }
        const session = this.sessions.get(sessionId);
        if (!session) {
          throw RequestError.invalidParams(
            undefined,
            `Session not found for id: ${sessionId}`,
          );
        }

        session.restoreHistory(history as Content[]);
        return { success: true };
      }
      case 'getAccountInfo': {
        const sessionId = params['sessionId'] as string | undefined;
        const session = sessionId ? this.sessions.get(sessionId) : undefined;
        const config = session ? session.getConfig() : this.config;
        const cfg = config.getContentGeneratorConfig();
        return {
          authType: cfg?.authType ?? config.getAuthType() ?? null,
          model: cfg?.model ?? config.getModel() ?? null,
          baseUrl: cfg?.baseUrl ? sanitizeProviderBaseUrl(cfg.baseUrl) : null,
          apiKeyEnvKey: cfg?.apiKeyEnvKey ?? null,
        };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionBranch:
      case SERVE_CONTROL_EXT_METHODS.sessionSideTask: {
        const isSideTask = method === SERVE_CONTROL_EXT_METHODS.sessionSideTask;
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const name = params['name'];
        const atRecordId = params['atRecordId'];
        if (atRecordId !== undefined && typeof atRecordId !== 'string') {
          throw RequestError.invalidParams(undefined, 'Invalid atRecordId');
        }
        if (isSideTask && atRecordId !== undefined) {
          throw RequestError.invalidParams(
            undefined,
            'atRecordId is not supported for side tasks',
          );
        }

        const sourceSession = this.sessions.get(sessionId);
        if (!sourceSession) {
          throw new RequestError(-32004, `Session not found: ${sessionId}`, {
            errorKind: 'session_not_found',
            sessionId,
          });
        }

        if (!isSideTask) {
          if (!sourceSession.isTurnIdle()) {
            throw new RequestError(
              -32602,
              'Cannot branch while a prompt is running',
              { errorKind: 'session_busy' },
            );
          }
          try {
            return await this.runExclusiveHistoryMutation(
              sessionId,
              async () => {
                await sourceSession.assertCanStartTurn();
                const releaseHistoryMutation =
                  sourceSession.beginHistoryMutation();
                try {
                  const sourceConfig = sourceSession.getConfig();
                  const recording = sourceConfig.getChatRecordingService();
                  const sessionService = sourceConfig.getSessionService();

                  const requestedName = normalizeRequestedBranchName(name);
                  const sourceCustomTitle =
                    requestedName === undefined
                      ? recording?.getCurrentCustomTitle()
                      : undefined;
                  const persistedDisplayName =
                    requestedName === undefined &&
                    sourceCustomTitle === undefined
                      ? await sessionService.getSessionDisplayName(sessionId)
                      : undefined;
                  const sourceDisplayName =
                    sourceCustomTitle ?? persistedDisplayName;
                  const derivedBaseName = sourceCustomTitle
                    ? normalizeDerivedBranchTitle(sourceCustomTitle)
                    : sourceDisplayName;
                  // A base that is empty, whitespace-only, or exactly a
                  // legacy `(Branch)`/`(Branch N)` token falls back to the
                  // session-id prefix here, while CLI /branch falls back to
                  // the first prompt. Deliberate: no picker name survives to
                  // anchor the family to, and one shared fallback would need
                  // a prompt-only display-name read on this route.
                  const baseName =
                    requestedName ??
                    (derivedBaseName?.trim() || undefined) ??
                    sessionId.slice(0, 8);

                  const title = await computeUniqueBranchTitle(
                    baseName,
                    sessionService,
                  );
                  const newSessionId = randomUUID();
                  const fork = () =>
                    sessionService.forkSession(sessionId, newSessionId, {
                      title,
                      ...(atRecordId !== undefined ? { atRecordId } : {}),
                    });
                  if (recording) {
                    await recording.runWithWriteBarrier(fork);
                  } else {
                    await fork();
                  }
                  return { newSessionId, title, displayName: title };
                } finally {
                  releaseHistoryMutation();
                }
              },
            );
          } catch (error) {
            if (error instanceof BranchPointInvalidError) {
              throw new RequestError(-32009, error.message, {
                errorKind: 'branch_point_invalid',
                recordId: error.recordId,
              });
            }
            throw error;
          }
        }

        const sourceConfig = sourceSession.getConfig();
        const recording = sourceConfig.getChatRecordingService();
        if (recording) await recording.flush();
        const sessionService = sourceConfig.getSessionService();
        const requestedName = normalizeRequestedBranchName(name);
        let title = requestedName;
        if (title === undefined) {
          const sourceCustomTitle = recording?.getCurrentCustomTitle();
          title = sourceCustomTitle
            ? (normalizeDerivedBranchTitle(sourceCustomTitle) ??
              sessionId.slice(0, 8))
            : sessionId.slice(0, 8);
        }
        const newSessionId = randomUUID();
        const fork = () =>
          sessionService.forkSession(sessionId, newSessionId, {
            source: {
              sourceType: 'side_task',
              sourceId: sessionId,
            },
            title,
          });
        if (recording) {
          await recording.runWithWriteBarrier(fork);
        } else {
          await fork();
        }
        return { newSessionId, title, displayName: title };
      }
      case 'qwen/settings/getCore': {
        const settings = loadSettings(cwd);
        this.settings = settings;
        return this.buildCoreSettings(settings, cwd);
      }
      case 'qwen/settings/setCoreValue': {
        const key = params['key'];
        if (
          typeof key !== 'string' ||
          !QWEN_CORE_SETTING_KEYS.includes(key as QwenCoreSettingKey)
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Unsupported Qwen setting key',
          );
        }
        const settings = loadSettings(cwd);
        const settingKey = key as QwenCoreSettingKey;
        const normalizedValue = normalizeCoreSettingValue(
          settingKey,
          params['value'],
        );
        const scope = toSettingsScope(params['scope']);
        settings.setValue(scope, key, normalizedValue);
        if (settingKey === 'model.name') {
          // Selecting a model by id here can't disambiguate providers that
          // share that id, so clear the paired baseUrl disambiguator left by a
          // previous model-picker selection. Empty-string tombstone overrides a
          // lower-scope value on merge (undefined would be dropped from JSON).
          settings.setValue(scope, 'model.baseUrl', '');
        }
        if (
          settingKey === 'general.outputLanguage' &&
          typeof normalizedValue === 'string' &&
          scope === SettingScope.User
        ) {
          // output-language.md is a single global instruction file. Only a
          // user-scoped change should rewrite it; a workspace-scoped change is
          // persisted to the workspace settings file and must not clobber the
          // global file (which would silently affect every other workspace and
          // session).
          updateOutputLanguageFile(normalizedValue);
        }
        // `setValue` already persisted to disk and recomputed the in-memory
        // merged view, so reloading from disk here is redundant I/O.
        this.settings = settings;
        return this.buildCoreSettings(settings, cwd);
      }
      case 'qwen/settings/setMcpServer': {
        const name = params['name'];
        if (typeof name !== 'string' || !name.trim()) {
          throw RequestError.invalidParams(
            undefined,
            'MCP server name is required',
          );
        }
        const settings = loadSettings(cwd);
        const settingScope = toSettingsScope(params['scope']);
        const scope =
          settingScope === SettingScope.Workspace ? 'workspace' : 'user';
        const existing = readScopeSettings(settings, scope);
        const existingServers = toRecord(existing['mcpServers']);
        const mcpServers = {
          ...existingServers,
          [name.trim()]: toStoredMcpServerConfig(
            restoreRedactedMcpSecrets(
              normalizeMcpServerConfig(params['server']),
              toRecord(existingServers[name.trim()]),
            ),
          ),
        };
        settings.setValue(settingScope, 'mcpServers', mcpServers);
        // `setValue` already persisted to disk and recomputed the in-memory
        // merged view, so reloading from disk here is redundant I/O.
        this.settings = settings;
        return this.buildCoreSettings(settings, cwd);
      }
      case 'qwen/settings/removeMcpServer': {
        const name = params['name'];
        if (typeof name !== 'string' || !name.trim()) {
          throw RequestError.invalidParams(
            undefined,
            'MCP server name is required',
          );
        }
        const settings = loadSettings(cwd);
        const settingScope = toSettingsScope(params['scope']);
        const scope =
          settingScope === SettingScope.Workspace ? 'workspace' : 'user';
        const existing = readScopeSettings(settings, scope);
        const mcpServers = { ...toRecord(existing['mcpServers']) };
        delete mcpServers[name.trim()];
        settings.setValue(settingScope, 'mcpServers', mcpServers);
        // `setValue` already persisted to disk and recomputed the in-memory
        // merged view, so reloading from disk here is redundant I/O.
        this.settings = settings;
        return this.buildCoreSettings(settings, cwd);
      }
      case 'qwen/settings/setHook': {
        const event = params['event'];
        if (!isHookEvent(event)) {
          throw RequestError.invalidParams(undefined, 'Invalid hook event');
        }
        const settings = loadSettings(cwd);
        const settingScope = toSettingsScope(params['scope']);
        const scope =
          settingScope === SettingScope.Workspace ? 'workspace' : 'user';
        const existing = readScopeSettings(settings, scope);
        const hooksRoot = { ...toRecord(existing['hooks']) };
        const eventHooks = Array.isArray(hooksRoot[event])
          ? [...(hooksRoot[event] as unknown[])]
          : [];
        const incomingHook = normalizeHookDefinition(params['hook']);
        const index = params['index'];
        // Only replace when the index points at an existing entry. An
        // out-of-range index would create sparse-array holes that serialize to
        // `null` in settings.json and corrupt hook loading, so treat it (and a
        // missing/negative index) as an append.
        const isReplace =
          typeof index === 'number' &&
          Number.isInteger(index) &&
          index >= 0 &&
          index < eventHooks.length;
        // Restore any `__redacted__` env/header values the client echoed back
        // from getCore against the hook being replaced, so masking on read
        // never persists the sentinel over a real secret.
        const hook = restoreRedactedHookSecrets(
          incomingHook,
          isReplace ? toRecord(eventHooks[index as number]) : {},
        );
        if (isReplace) {
          eventHooks[index as number] = hook;
        } else {
          // Missing/negative/non-integer index → append. (A non-integer like
          // 1.5 would otherwise create a sparse, non-integer array property
          // that JSON.stringify silently drops, corrupting the hook list.)
          eventHooks.push(hook);
        }
        hooksRoot[event] = eventHooks;
        settings.setValue(settingScope, 'hooks', hooksRoot);
        // `setValue` already persisted to disk and recomputed the in-memory
        // merged view, so reloading from disk here is redundant I/O.
        this.settings = settings;
        return this.buildCoreSettings(settings, cwd);
      }
      case 'qwen/settings/removeHook': {
        const event = params['event'];
        if (!isHookEvent(event)) {
          throw RequestError.invalidParams(undefined, 'Invalid hook event');
        }
        const index = params['index'];
        if (
          typeof index !== 'number' ||
          !Number.isInteger(index) ||
          index < 0
        ) {
          throw RequestError.invalidParams(undefined, 'Invalid hook index');
        }
        const settings = loadSettings(cwd);
        const settingScope = toSettingsScope(params['scope']);
        const scope =
          settingScope === SettingScope.Workspace ? 'workspace' : 'user';
        const existing = readScopeSettings(settings, scope);
        const hooksRoot = { ...toRecord(existing['hooks']) };
        const eventHooks = Array.isArray(hooksRoot[event])
          ? [...(hooksRoot[event] as unknown[])]
          : [];
        if (index >= eventHooks.length) {
          throw RequestError.invalidParams(
            undefined,
            `Hook index ${index} out of range (event has ${eventHooks.length} hooks)`,
          );
        }
        eventHooks.splice(index, 1);
        hooksRoot[event] = eventHooks;
        settings.setValue(settingScope, 'hooks', hooksRoot);
        // `setValue` already persisted to disk and recomputed the in-memory
        // merged view, so reloading from disk here is redundant I/O.
        this.settings = settings;
        return this.buildCoreSettings(settings, cwd);
      }
      case 'qwen/settings/setExtensionSetting': {
        const extensionId = params['extensionId'];
        const settingKey = params['settingKey'];
        const value = params['value'];
        if (typeof extensionId !== 'string' || !extensionId) {
          throw RequestError.invalidParams(
            undefined,
            'extensionId is required',
          );
        }
        if (typeof settingKey !== 'string' || !settingKey) {
          throw RequestError.invalidParams(undefined, 'settingKey is required');
        }
        if (typeof value !== 'string') {
          throw RequestError.invalidParams(undefined, 'value must be a string');
        }
        const settings = loadSettings(cwd);
        const extensionManager = new ExtensionManager({
          workspaceDir: cwd,
          isWorkspaceTrusted:
            isWorkspaceTrusted(settings.merged).isTrusted ?? true,
          locale: getCurrentLanguage(),
        });
        await extensionManager.refreshCache();
        const extension = extensionManager
          .getLoadedExtensions()
          .find((item) => item.id === extensionId || item.name === extensionId);
        if (!extension) {
          throw RequestError.invalidParams(undefined, 'Extension not found');
        }
        const extScope =
          toSettingsScope(params['scope']) === SettingScope.Workspace
            ? ExtensionSettingScope.WORKSPACE
            : ExtensionSettingScope.USER;
        await updateSetting(
          extension.config,
          extension.id,
          settingKey,
          async () => value,
          extScope,
        );
        // Unlike the sibling core-setting handlers, this persists through
        // `updateSetting` (extension settings store), not `settings.setValue`,
        // so `settings` here is just the snapshot loaded above and is reused to
        // build the response.
        this.settings = settings;
        return this.buildCoreSettings(settings, cwd);
      }
      case 'qwen/permissions/getSettings': {
        const settings = this.loadPermissionSettings(cwd);
        return buildPermissionSettings(settings) as unknown as Record<
          string,
          unknown
        >;
      }
      case 'qwen/permissions/setRules': {
        const scope = params['scope'];
        const ruleType = params['ruleType'];
        if (scope !== 'user' && scope !== 'workspace') {
          throw RequestError.invalidParams(
            undefined,
            'scope must be "user" or "workspace"',
          );
        }
        if (ruleType !== 'allow' && ruleType !== 'ask' && ruleType !== 'deny') {
          throw RequestError.invalidParams(
            undefined,
            'ruleType must be "allow", "ask", or "deny"',
          );
        }

        const settings = this.loadPermissionSettings(cwd);
        const before = readPermissionRuleSet(settings.merged);
        const settingScope =
          scope === 'workspace' ? SettingScope.Workspace : SettingScope.User;
        const scopeSettings =
          scope === 'workspace'
            ? settings.workspace.settings
            : settings.user.settings;
        const existingRules = readPermissionRuleSet(scopeSettings)[ruleType];
        let rules: string[];
        try {
          rules = normalizePermissionRules(params['rules'], {
            existingRules,
          });
        } catch (error) {
          if (error instanceof PermissionRulesValidationError) {
            throw RequestError.invalidParams(undefined, error.message);
          }
          throw error;
        }

        settings.setValue(settingScope, `permissions.${ruleType}`, rules);
        // `setValue` already recomputed the in-memory merged view, so read the
        // "after" state from the same instance instead of reloading from disk
        // (avoids redundant I/O and a concurrency window where another handler
        // could mutate settings between the two loads).
        const after = readPermissionRuleSet(settings.merged);
        this.syncLivePermissionManagers(before, after);
        return buildPermissionSettings(settings) as unknown as Record<
          string,
          unknown
        >;
      }
      case SERVE_CONTROL_EXT_METHODS.workspaceReload: {
        const oldMerged = structuredClone(this.settings.merged);

        this.settings.reloadScopeFromDisk(SettingScope.User);
        this.settings.reloadScopeFromDisk(SettingScope.Workspace);
        const newMerged = this.settings.merged;

        const envResult = reloadEnvironment(newMerged, cwd);

        const changed = diffSettingsKeys(oldMerged, newMerged);
        const envChanged =
          envResult.updatedKeys.length > 0 || envResult.removedKeys.length > 0;

        // A settings-file edit to the Session Workflow gate must reach live
        // sessions too. The UI ext method pins every Session's provider to the
        // daemon-held override, so without re-deriving it here a disk change
        // (hand edit, dotfile sync) would stay masked until daemon restart.
        const readSessionWorkflow = (merged: Record<string, unknown>) =>
          (merged as { experimental?: { sessionWorkflow?: unknown } })
            .experimental?.sessionWorkflow === true;
        const reloadedSessionWorkflow = readSessionWorkflow(newMerged);
        // Apply the reloaded gate to live sessions unconditionally. A
        // merged↔merged diff against `oldMerged` is unreliable here:
        // `this.settings` is a replaceable "latest loaded" cache that many
        // handlers swap for a fresh loadSettings instance, and after such a
        // swap the diff compares two fresh views of the same disk state and
        // misses a flip the live sessions (which still hold their own,
        // now-stale LoadedSettings) never saw. The helper makes the no-op
        // decision per live session — comparing the reloaded disk value
        // against each session's effective gate — so calling it on every
        // reload is idempotent, re-pins only the sessions that actually
        // change, and keeps the daemon-held override equal to the disk
        // truth (which also covers a disk state that contradicts a
        // UI-pinned override).
        this.applySessionWorkflowOverrideToLiveSessions(
          reloadedSessionWorkflow,
        );

        // Fold a missing key to the fresh-session default (AUTO for
        // unrestricted sessions; restricted sessions converge on DEFAULT per
        // session below) so a key deletion reaches live sessions too. A
        // present-but-invalid value folds to undefined instead: boot rejects
        // that file, so reload must not converge live sessions on it either
        // (folding it to AUTO would silently escalate the approval gate),
        // and the undefined is never recorded as converged.
        const reloadedApprovalMode = foldReloadApprovalMode(
          newMerged.tools?.approvalMode,
        );
        if (reloadedApprovalMode === undefined) {
          debugLogger.warn(
            'reload: tools.approvalMode holds a value boot would reject; live sessions keep their current modes until the file is corrected',
          );
        }

        const sessions = [...this.sessions.entries()];
        const refreshed: string[] = [];
        const skipped: string[] = [];

        const results = await Promise.allSettled(
          sessions.map(async ([id, session]) => {
            if (!session.isIdle()) {
              skipped.push(id);
              return;
            }
            const config = session.getConfig();
            const authType = config.getAuthType();
            const providersChanged =
              changed.has('modelProviders') || changed.has('providerProtocol');

            // Long-lived ACP sessions never restart, so honor providerProtocol
            // changes here too (its requiresRestart only gates the TUI path) and
            // always pass the current map so a modelProviders-only reload doesn't
            // re-register against a stale protocol mapping.
            if (providersChanged) {
              try {
                config.reloadModelProvidersConfig(
                  newMerged.modelProviders,
                  newMerged.providerProtocol ?? {},
                );
              } catch (err) {
                debugLogger.warn(
                  `reload: reloadModelProvidersConfig failed for session ${id}: ${err}`,
                );
              }
            }

            const newModelName = newMerged.model?.name;
            if (
              changed.has('model') &&
              newModelName &&
              newModelName !== config.getModel() &&
              authType
            ) {
              try {
                await config.switchModel(authType, newModelName);
              } catch (err) {
                debugLogger.warn(
                  `reload: switchModel failed for session ${id}: ${err}`,
                );
              }
            } else if ((providersChanged || envChanged) && authType) {
              try {
                await config.refreshAuth(authType);
              } catch (err) {
                debugLogger.warn(
                  `reload: refreshAuth failed for session ${id}: ${err}`,
                );
              }
            }

            if (changed.has('tools')) {
              const disabled = normalizeDisabledToolList(
                newMerged.tools?.disabled,
              );
              config.setDisabledTools(new Set(disabled));
            }

            // Apply the reloaded approval mode only when it differs from
            // what this session last converged on (see the record's
            // derivation above); the `!== previousMode` guard keeps the
            // apply idempotent for sessions already at the disk value while
            // the record still advances, so a later round-trip of the file
            // re-converges exactly the sessions that moved. An undefined
            // fold (present-but-invalid file value) is neither applied nor
            // recorded, so no session converges on a value boot would
            // reject. Restricted sessions ignore the file at boot
            // (loadCliConfig pins them to DEFAULT), so reload must converge
            // them on DEFAULT too — pushing the file value (or the AUTO fold
            // of a missing key) into a safe-mode session would silently
            // strip its approval restriction.
            const reloadedSessionMode = isRestrictedApprovalModeConfig(config)
              ? ApprovalMode.DEFAULT
              : reloadedApprovalMode;
            const previousMode = config.getApprovalMode();
            const convergedMode = this.sessionApprovalModeConverged.get(id);
            if (
              reloadedSessionMode !== undefined &&
              reloadedSessionMode !== convergedMode
            ) {
              if (reloadedSessionMode !== previousMode) {
                try {
                  config.setApprovalMode(reloadedSessionMode);
                  if (reloadedSessionMode === 'plan') {
                    session.clearActiveTodoPlanRevision();
                    session.clearTodoStopGuardTrust();
                  } else if (previousMode === 'plan') {
                    session.clearActiveTodoPlanRevision();
                  }
                  this.sessionApprovalModeConverged.set(
                    id,
                    reloadedSessionMode,
                  );
                } catch (err) {
                  debugLogger.warn(
                    `reload: setApprovalMode failed for session ${id}: ${err}`,
                  );
                }
              } else {
                this.sessionApprovalModeConverged.set(id, reloadedSessionMode);
              }
            }

            try {
              await config.refreshHierarchicalMemory();
            } catch (err) {
              debugLogger.warn(
                `reload: refreshHierarchicalMemory failed for session ${id}: ${err}`,
              );
            }
            try {
              await config.getLlmClient()?.refreshSystemInstruction();
            } catch (err) {
              debugLogger.warn(
                `reload: refreshSystemInstruction failed for session ${id}: ${err}`,
              );
            }

            refreshed.push(id);
          }),
        );
        for (let i = 0; i < results.length; i++) {
          if (results[i]!.status === 'rejected') {
            const reason = (results[i] as PromiseRejectedResult).reason;
            debugLogger.warn(
              `Session ${sessions[i]![0]} reload failed: ${reason}`,
            );
            skipped.push(sessions[i]![0]);
          }
        }

        return {
          env: envResult,
          changedKeys: [...changed],
          sessionsRefreshed: refreshed,
          sessionsSkipped: skipped,
        };
      }
      case SERVE_CONTROL_EXT_METHODS.workspaceSkillsRefresh: {
        const rawReason = params['reason'];
        if (
          rawReason !== undefined &&
          rawReason !== 'settings' &&
          rawReason !== 'content' &&
          rawReason !== 'all'
        ) {
          throw RequestError.invalidParams(
            undefined,
            'reason must be settings, content, or all',
          );
        }
        const reason = rawReason ?? 'all';
        const refreshSettings = reason !== 'content';
        const refreshContent = reason !== 'settings';
        if (refreshSettings) {
          this.settings.reloadScopeFromDisk(SettingScope.Workspace);
        }
        const sessions = this.getActiveSessions();
        const settingsReloadResults = refreshSettings
          ? await Promise.allSettled(
              sessions.map((session) =>
                Promise.resolve().then(() => session.reloadSkillSettings()),
              ),
            )
          : undefined;
        let configResults: Array<PromiseSettledResult<void>> = [];
        if (refreshContent) {
          const skillManagers = new Set(
            [this.config, ...sessions.map((session) => session.getConfig())]
              .map((config) => config.getSkillManager())
              .filter(
                (manager): manager is NonNullable<typeof manager> =>
                  manager !== undefined,
              ),
          );
          configResults = await Promise.allSettled(
            [...skillManagers].map((manager) => manager.refreshCache()),
          );
          for (const result of configResults) {
            if (result.status === 'rejected') {
              debugLogger.warn(`Skill config refresh failed: ${result.reason}`);
            }
          }
        }
        const results = await Promise.allSettled(
          sessions.map((session, index) => {
            const settingsReload = settingsReloadResults?.[index];
            if (settingsReload?.status === 'rejected') {
              return Promise.reject(settingsReload.reason);
            }
            return session.refreshSkillsFromSettings({
              reloadSettings: false,
              notifyConfigChanged: !refreshContent,
            });
          }),
        );
        for (let i = 0; i < results.length; i++) {
          if (results[i]!.status === 'rejected') {
            const reason = (results[i] as PromiseRejectedResult).reason;
            debugLogger.warn(
              `Session ${sessions[i]!.getId()} skill refresh failed: ${reason}`,
            );
          }
        }
        return {
          sessionsRefreshed: results.filter(
            (result) => result.status === 'fulfilled',
          ).length,
          sessionsFailed: results.filter(
            (result) => result.status === 'rejected',
          ).length,
          configsRefreshed: configResults.filter(
            (result) => result.status === 'fulfilled',
          ).length,
          configsFailed: configResults.filter(
            (result) => result.status === 'rejected',
          ).length,
          reason,
        };
      }
      default:
        throw RequestError.methodNotFound(method);
    }
  }

  // --- private helpers ---

  /**
   * Reverse tool channel (issue #5626, Phase 2). Build the session
   * `McpClientManager`'s `sendSdkMcpMessage` callback. Client-hosted
   * (extension) MCP servers are registered SDK-type, so the manager routes
   * their JSON-RPC through this callback. We forward each frame UP to the
   * parent serve process via the `qwen/control/client_mcp/message` ext-method;
   * the parent's `BridgeClient.extMethod` hands it to the per-WS-connection
   * `ClientMcpRegistrar`, which carries it down the daemon WS to the extension
   * and returns the correlated response (the `payload` field). All SDK-type
   * servers in this session share one callback — the `serverName` argument
   * routes to the right client-hosted server in the parent.
   */
  private buildClientMcpSender(sessionId?: string): SendSdkMcpMessage {
    return (serverName: string, message: JSONRPCMessage) =>
      deliverClientMcpMessage(this.connection, serverName, message, sessionId);
  }

  private disposeTranscriptReplayConfig(config: Config): void {
    try {
      void Promise.resolve(config.getToolRegistry()?.stop()).catch((err) => {
        debugLogger.debug(
          `Transcript replay config tool registry stop failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    } catch (err) {
      debugLogger.debug(
        `Transcript replay config tool registry stop failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private disposeTranscriptReplayConfigs(): void {
    for (const entry of this.transcriptReplayConfigCache.values()) {
      if (entry.config) {
        this.disposeTranscriptReplayConfig(entry.config);
      }
    }
    this.transcriptReplayConfigCache.clear();
  }

  private async getTranscriptReplayConfig(
    cwd: string,
    settings: LoadedSettings,
  ): Promise<Config> {
    const key = path.resolve(cwd);
    const cached = this.transcriptReplayConfigCache.get(key);
    if (cached?.settings === settings) {
      if (cached.config) {
        return cached.config;
      }
      if (cached.pending) {
        return cached.pending;
      }
    } else if (cached?.config) {
      this.disposeTranscriptReplayConfig(cached.config);
    }

    const entry: TranscriptReplayConfigCacheEntry = { settings };
    const pending = this.newSessionConfig(
      cwd,
      [],
      settings,
      undefined,
      undefined,
      false,
      {
        skipMcpDiscovery: true,
        skipHooks: true,
        skipSkillManager: true,
        skipFileCheckpointing: true,
        // Read-only replay: tolerate tools that cannot construct without the
        // subsystems skipped above (e.g. SkillTool needs the SkillManager). The
        // registry is only consulted for optional tool_call metadata during
        // replay, and ToolCallEmitter falls back to the recorded tool name.
        lenientToolWarmup: true,
      },
      false,
    );
    entry.pending = pending;
    this.transcriptReplayConfigCache.set(key, entry);
    try {
      const config = await pending;
      const current = this.transcriptReplayConfigCache.get(key);
      if (current !== entry) {
        this.disposeTranscriptReplayConfig(config);
        if (current?.config) {
          return current.config;
        }
        if (current?.pending) {
          return current.pending;
        }
        throw new Error(
          'Transcript replay config was invalidated while loading',
        );
      }
      entry.config = config;
      entry.pending = undefined;
      return config;
    } catch (error) {
      if (this.transcriptReplayConfigCache.get(key) === entry) {
        this.transcriptReplayConfigCache.delete(key);
      }
      throw error;
    }
  }

  private async newSessionConfig(
    cwd: string,
    mcpServers: McpServer[],
    settings: LoadedSettings,
    sessionSource?: SessionSource,
    sessionId?: string,
    resume?: boolean,
    initializeOptions: ConfigInitializeOptions = {},
    chatRecording?: boolean,
    restoreOptions?: SelectiveSessionRestoreOptions,
  ): Promise<Config> {
    // Transcript replay is the only recording-disabled Config and must remain
    // id-less; it borrows the validated target session context from extMethod.
    const preserveIdlessSession =
      sessionId === undefined && chatRecording === false;
    const inheritedSessionId = preserveIdlessSession
      ? sessionIdContext.getStore()
      : undefined;
    // A generated id exists only to bind the debug-log context before Config
    // construction; loadCliConfig must not treat it as caller-supplied (the
    // occupancy check is for caller-chosen ids that may have a case-twin).
    const sessionIdGenerated =
      sessionId === undefined && !preserveIdlessSession;
    const effectiveSessionId =
      sessionId ?? (sessionIdGenerated ? randomUUID() : undefined);
    const debugSessionId =
      effectiveSessionId ?? inheritedSessionId ?? 'transcript-replay';
    try {
      this.assertManagedSessionAdmission();
      return await sessionIdContext.run(debugSessionId, () =>
        this.runWithPinnedRuntimeBaseDir(settings, cwd, async () => {
          await this.retryPendingConfigCleanup(
            Storage.getRuntimeBaseDir(),
            effectiveSessionId,
          );
          return this.newSessionConfigInRuntimeContext(
            cwd,
            mcpServers,
            settings,
            sessionSource,
            effectiveSessionId,
            resume,
            initializeOptions,
            chatRecording,
            restoreOptions,
            sessionIdGenerated,
          );
        }),
      );
    } catch (error) {
      if (error instanceof SessionIdConflictError) {
        throw new RequestError(ACP_ERROR_CODES.INVALID_PARAMS, error.message, {
          errorKind: 'session_id_conflict',
          sessionId: error.sessionId,
        });
      }
      const writerError = getSessionWriterError(error);
      if (writerError) {
        throw new RequestError(writerError.rpcCode, writerError.message, {
          errorKind: writerError.errorKind,
        });
      }
      throw sessionId && restoreOptions
        ? mapSessionRestoreRequestError(error, sessionId)
        : error;
    }
  }

  private async newSessionConfigInRuntimeContext(
    cwd: string,
    mcpServers: McpServer[],
    settings: LoadedSettings,
    sessionSource?: SessionSource,
    sessionId?: string,
    resume?: boolean,
    initializeOptions: ConfigInitializeOptions = {},
    chatRecording?: boolean,
    restoreOptions?: SelectiveSessionRestoreOptions,
    sessionIdGenerated?: boolean,
  ): Promise<Config> {
    const provisionalWorkspace = isReservedStandaloneSessionSourceType(
      sessionSource?.sourceType,
    );
    // ACP/IDE-injected servers are session-level: they must outrank a project
    // `.mcp.json` and stay un-gated. Collect them separately and pass them as
    // `sessionMcpServers` (top precedence tier) rather than merging into
    // `settings.mcpServers`, where `assembleMcpServers` would demote them below
    // `.mcp.json` (#4615).
    const sessionMcpServers: Record<string, MCPServerConfig> = {};

    for (const server of mcpServers) {
      const stdioServer = toStdioServer(server);
      if (stdioServer) {
        const env: Record<string, string> = {};
        for (const { name: envName, value } of stdioServer.env) {
          env[envName] = value;
        }
        sessionMcpServers[stdioServer.name] = new MCPServerConfig(
          stdioServer.command,
          stdioServer.args,
          env,
        );
        continue;
      }

      const sseServer = toSseServer(server);
      if (sseServer) {
        const headers: Record<string, string> = {};
        for (const { name: headerName, value } of sseServer.headers) {
          headers[headerName] = value;
        }
        sessionMcpServers[sseServer.name] = new MCPServerConfig(
          undefined,
          undefined,
          undefined,
          undefined,
          sseServer.url,
          undefined,
          Object.keys(headers).length > 0 ? headers : undefined,
        );
        continue;
      }

      const httpServer = toHttpServer(server);
      if (httpServer) {
        const headers: Record<string, string> = {};
        for (const { name: headerName, value } of httpServer.headers) {
          headers[headerName] = value;
        }
        sessionMcpServers[httpServer.name] = new MCPServerConfig(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          httpServer.url,
          Object.keys(headers).length > 0 ? headers : undefined,
        );
        continue;
      }
    }

    const mergedSettings = {
      ...settings.merged,
      experimental: {
        ...settings.merged.experimental,
        sessionWriterLease: this.sessionWriterLeaseEnabledAtStartup,
        ...(sessionSource?.sourceType === 'channel' ? { cron: false } : {}),
      },
    };

    const sessionArg =
      resume === true
        ? { resume: sessionId, sessionId: undefined }
        : {
            sessionId,
            sessionIdGenerated: sessionIdGenerated === true || undefined,
            resume: undefined,
          };
    const argvForSession = {
      ...this.argv,
      ...(provisionalWorkspace ? { experimentalLsp: false } : {}),
      // Docker sandbox relaunch injects a fixed --sandbox-session-id into
      // the ACP process argv. Without clearing it, every newSession()
      // inherits the same ID and the second session collides with the
      // first's writer lease (#7435).
      sandboxSessionId: undefined,
      ...sessionArg,
      continue: false,
      ...(chatRecording !== undefined ? { chatRecording } : {}),
    };

    const config = await loadCliConfig(
      mergedSettings,
      argvForSession,
      cwd,
      // ACP sessions do not provide an extension override. Passing [] is a
      // truthy override and prevents default/argv extension commands from
      // loading, so leave it unset to preserve normal CLI behavior.
      undefined,
      // Pass separated hooks for proper source attribution
      {
        userHooks: settings.getUserHooks(),
        projectHooks: settings.getProjectHooks(),
      },
      // CRITICAL: close over the per-request `settings` (LoadedSettings
      // instance), NOT over the `mergedSettings` snapshot built above.
      // `LoadedSettings.setValue` replaces `_merged`, so a closure over the
      // snapshot would never see workspace toggles applied during the
      // session. ACP/Zed sessions otherwise leak persisted disabled skills
      // into the first <available_skills> at cold start.
      buildDisabledSkillNamesProvider(settings),
      sessionMcpServers,
      // The daemon owns the settings watcher lifecycle.
      undefined,
      // A duplicate caller-supplied session id must fail this one request,
      // not process.exit(1) the shared ACP child and every session on its
      // channel. newSessionConfig maps the throw to a RequestError.
      true,
      this.managedToolInvocationGuard || restoreOptions || provisionalWorkspace
        ? {
            ...(provisionalWorkspace
              ? { provisionalWorkspace: true as const }
              : {}),
            ...(this.managedToolInvocationGuard
              ? { toolInvocationGuard: this.managedToolInvocationGuard }
              : {}),
            ...(restoreOptions && sessionId
              ? {
                  sessionRestore: {
                    projectionSource: (restoreSessionId) =>
                      new SessionService(cwd, {
                        runtimeBaseDir: Storage.getRuntimeBaseDir(),
                      }).readRestoreProjection(
                        restoreSessionId,
                        restoreOptions,
                      ),
                  },
                }
              : {}),
          }
        : undefined,
    );
    if (sessionSource) {
      config.setSessionSource(sessionSource.sourceType, sessionSource.sourceId);
    }
    if (chatRecording !== false) {
      this.initializingConfigs.add(config);
    }
    try {
      this.assertManagedSessionAdmission();
      if (this.isTrustedManagedParent()) {
        config.setSessionWriterReclaimPolicy('never');
        config.setSessionWriterTakeoverPolicy('certified');
      }
    } catch (error) {
      return this.cleanupAfterRequestFailure(error, () =>
        this.cleanupUnstoredConfig(config),
      );
    }
    // ACP sessions run with piped stdio (non-TTY), so the default
    // interactive-based gating disables file checkpointing. Enable it
    // explicitly so /rewind works across daemon session resume.
    if (
      !initializeOptions.skipFileCheckpointing &&
      typeof config.enableFileCheckpointing === 'function'
    ) {
      config.enableFileCheckpointing();
    }
    // Reverse tool channel (issue #5626, Phase 2). Runtime-added MCP servers
    // (notably client-hosted/extension SDK servers registered via
    // `workspaceMcpRuntimeAdd`) live in a private per-Config map that
    // `loadCliConfig` does NOT re-read — it only reloads the settings layer.
    // A session created AFTER a client MCP server was registered would
    // therefore start with an empty runtime overlay and never discover the
    // client-hosted tools, so a model-driven `tools/call` for them would fail
    // with "not found in registry". Copy the bootstrap/workspace Config's
    // runtime servers onto the new session Config BEFORE `config.initialize()`
    // so its discovery pass picks them up and binds THIS session's
    // `sendSdkMcpMessage` (SDK servers route through the per-session callback).
    // Guarded + additive: no runtime servers ⇒ no-op, and settings-based MCP
    // servers (already re-read by `loadCliConfig`) are untouched.
    if (
      typeof this.config.getRuntimeMcpServers === 'function' &&
      typeof config.addRuntimeMcpServer === 'function'
    ) {
      const bootstrapRuntimeMcpServers = this.config.getRuntimeMcpServers();
      for (const [runtimeServerName, runtimeServerConfig] of Object.entries(
        bootstrapRuntimeMcpServers,
      )) {
        config.addRuntimeMcpServer(runtimeServerName, runtimeServerConfig);
      }
    }
    // Inject the workspace-shared MCP transport pool BEFORE
    // `config.initialize()` so the ToolRegistry picks it up.
    if (
      this.mcpPool !== undefined &&
      typeof config.setMcpTransportPool === 'function'
    ) {
      config.setMcpTransportPool(this.mcpPool);
    }
    // Register the MCP budget-event callback BEFORE `config.initialize()`
    // so it catches events from both synchronous and background discovery.
    const wiredSessionId =
      typeof config.getSessionId === 'function'
        ? config.getSessionId()
        : undefined;
    // When the workspace-scoped budget controller is active, skip the
    // per-session callback to prevent double-firing. Daemons without
    // a configured budget keep the per-session callback.
    const skipPerSessionBudgetCallback = this.workspaceMcpBudget !== undefined;
    if (
      !skipPerSessionBudgetCallback &&
      typeof config.setMcpBudgetEventCallback === 'function' &&
      wiredSessionId !== undefined
    ) {
      const acpSessionId = wiredSessionId;
      config.setMcpBudgetEventCallback((event) => {
        sessionIdContext.run(config.getSessionId(), () => {
          // Fire-and-forget. `.catch` suppresses unhandled rejections
          // and logs at debug level for operator visibility.
          void this.connection
            .extNotification('qwen/notify/session/mcp-budget-event', {
              v: 1,
              sessionId: acpSessionId,
              ...event,
            })
            .catch((err: unknown) => {
              debugLogger.debug(
                `MCP budget extNotification dropped ` +
                  `(session=${acpSessionId}, kind=${event.kind}): ` +
                  `${err instanceof Error ? err.message : String(err)}`,
              );
            });
        });
      });
    }
    try {
      await config.initialize({
        ...initializeOptions,
        // Reverse tool channel (issue #5626, Phase 2): bind the session
        // manager's SDK MCP callback to the `client_mcp/message` ext-method so a
        // client-hosted (extension) MCP server added at runtime reaches the
        // daemon WS. Servers that aren't client-hosted never use this callback
        // (the daemon only adds SDK-type runtime servers for client MCP).
        sendSdkMcpMessage: this.buildClientMcpSender(wiredSessionId),
      });
      this.assertManagedSessionAdmission();
    } catch (error) {
      return this.cleanupAfterRequestFailure(error, () =>
        this.cleanupUnstoredConfig(config),
      );
    }
    if (!provisionalWorkspace) {
      startNonInteractiveOpenAILogHousekeeping(config, settings);
    }
    // ACP sessions served to WebUI clients are interactive: MCP tools can
    // arrive progressively, but session creation/loading must not wait for a
    // slow or wedged server discovery.
    if (!provisionalWorkspace) {
      void this.surfaceMcpFailuresWhenReady(config);
    }
    return config;
  }

  private async surfaceMcpFailuresWhenReady(config: Config): Promise<void> {
    try {
      await config.waitForMcpReady();
    } catch (err) {
      debugLogger.error(
        `MCP discovery readiness failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const failedMcpServers =
      typeof config.getFailedMcpServerNames === 'function'
        ? config.getFailedMcpServerNames()
        : [];
    if (failedMcpServers.length > 0) {
      process.stderr.write(
        `Warning: MCP server(s) failed to start: ${failedMcpServers.join(', ')}. ` +
          `Continuing with built-in tools and any servers that did connect.\n`,
      );
    }
  }

  private async ensureAuthenticated(config: Config): Promise<void> {
    const selectedType = config.getModelsConfig().getCurrentAuthType();
    if (!selectedType) {
      throw RequestError.authRequired(
        { authMethods: pickAuthMethodsForAuthRequired() },
        'Use Qwen Code CLI to authenticate first.',
      );
    }

    try {
      await config.refreshAuth(selectedType, true);
    } catch (e) {
      debugLogger.error(`Authentication failed: ${e}`);
      throw RequestError.authRequired(
        {
          authMethods: pickAuthMethodsForAuthRequired(selectedType),
        },
        'Authentication failed: ' + (e as Error).message,
      );
    }
  }

  /**
   * Pins the workflow gate of every live Session whose effective gate
   * actually changes to `enabled`, dropping the bound plan revision on those
   * sessions, then records `enabled` as the daemon-held override. The no-op
   * decision is per-session because neither caller's own state can answer it:
   * on a first UI write the override is still `undefined` although sessions
   * already derive the pushed value from settings (a shadowed workspace
   * write), and a reload diff can fire against a stale settings view that the
   * UI write path never updated. Each session's live value is read BEFORE the
   * field reassignment below so a pinned provider cannot report the new value
   * as its "before" state. The provider reads the field rather than capturing
   * a value so a later re-derivation (a settings-file reload) reaches
   * sessions that were pinned earlier. Returns the number of sessions whose
   * gate changed.
   */
  private applySessionWorkflowOverrideToLiveSessions(enabled: boolean): number {
    let sessionsUpdated = 0;
    for (const session of this.sessions.values()) {
      const config = session.getConfig();
      if (config.isSessionWorkflowEnabled?.() === enabled) {
        continue;
      }
      config.setSessionWorkflowEnabledProvider?.(
        () => this.sessionWorkflowEnabledOverride === true,
      );
      session.clearActiveTodoPlanRevision();
      sessionsUpdated++;
    }
    this.sessionWorkflowEnabledOverride = enabled;
    return sessionsUpdated;
  }

  private setupFileSystem(config: Config): void {
    if (!this.clientCapabilities?.fs) return;

    const acpFileSystemService = new AcpFileSystemService(
      this.connection,
      config.getSessionId(),
      this.clientCapabilities.fs,
      config.getFileSystemService(),
      {
        localReadRoots: buildAcpLocalReadRoots(config),
      },
    );
    config.setFileSystemService(acpFileSystemService);
  }

  private async createAndStoreSession(
    config: Config,
    settings: LoadedSettings,
    sessionData?: ResumedSessionData,
    options: {
      replayHistory?: boolean;
      enableLiveScreenContext?: boolean;
      deferWorkspaceActivation?: boolean;
      beforeDeferredWorkspaceActivation?: () => Promise<void>;
      prepareBeforeSessionCreate?: () => Promise<void>;
      beforeSessionCreate?: () => void;
      primeSession?: (session: Session) => void;
      beforeStartPostReplayServices?: (session: Session) => Promise<void>;
      signal?: AbortSignal;
    } = {},
  ): Promise<Session> {
    options.signal?.throwIfAborted();
    this.assertManagedSessionAdmission();
    const sessionId = normalizeSessionIdForLookup(config.getSessionId());
    const llmClient = config.getLlmClient();
    const needsInitialize = !llmClient.isInitialized();

    if (needsInitialize && options.deferWorkspaceActivation !== true) {
      await llmClient.initialize(undefined, options.signal);
    }
    options.signal?.throwIfAborted();
    this.assertManagedSessionAdmission();

    if (this.sessions.has(sessionId)) {
      throw new RequestError(
        ACP_ERROR_CODES.INVALID_PARAMS,
        `Session ${sessionId} is already active.`,
        { errorKind: 'session_id_conflict', sessionId },
      );
    }

    await options.prepareBeforeSessionCreate?.();
    options.signal?.throwIfAborted();
    this.assertManagedSessionAdmission();
    if (this.sessions.has(sessionId)) {
      throw new RequestError(
        ACP_ERROR_CODES.INVALID_PARAMS,
        `Session ${sessionId} is already active.`,
        { errorKind: 'session_id_conflict', sessionId },
      );
    }
    options.beforeSessionCreate?.();

    const session = new Session(
      sessionId,
      config,
      this.connection,
      settings,
      (operation) => this.runExclusiveHistoryMutation(sessionId, operation),
      () => this.activeWorkReporter?.notifyChanged(),
    );
    const replaySessionHistory = async () => {
      if (
        options.replayHistory === false ||
        !sessionData?.conversation.messages
      ) {
        return;
      }
      await session.replayHistory(
        sessionData.conversation.messages,
        sessionData.historyGaps,
      );
      try {
        await session.publishRecoveredGoalState(
          sessionData.conversation.messages,
        );
      } catch (error) {
        debugLogger.debug(
          `Failed to publish recovered Goal state: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    };
    if (options.deferWorkspaceActivation === true) {
      session.installManagedConversationActivation(
        async () => {
          this.assertManagedSessionAdmission();
          if (options.beforeDeferredWorkspaceActivation) {
            await options.beforeDeferredWorkspaceActivation();
          } else {
            await this.ensureAuthenticated(config);
          }
          this.assertManagedSessionAdmission();
          await config.activateProvisionalWorkspace();
          this.assertManagedSessionAdmission();
          this.setupFileSystem(config);
          config.hydrateSessionRestoreFileHistory?.();
          if (sessionData?.fileHistorySnapshots?.length) {
            config
              .getFileHistoryService()
              .restoreFromSnapshots(sessionData.fileHistorySnapshots);
          }
          await replaySessionHistory();
          await options.beforeStartPostReplayServices?.(session);
          session.installRewriter();
          config.finalizeSessionRestore?.();
          startNonInteractiveOpenAILogHousekeeping(config, settings);
        },
        () => {
          void this.surfaceMcpFailuresWhenReady(config);
        },
      );
    }
    let published = false;
    try {
      // After `new Session` (which wires the spawner the tool needs) and before
      // the session is published: the permission check is async, and the tool
      // must be declared before the first prompt can be served.
      await registerCreateSubSessionTool(config);
      options.signal?.throwIfAborted();
      options.primeSession?.(session);
      if (options.deferWorkspaceActivation !== true) {
        config.hydrateSessionRestoreFileHistory?.();
      }
      // Pin the workflow gate synchronously adjacent to publication. A write
      // that lands while `registerCreateSubSessionTool` is suspended finds
      // the session in neither the construction-time view nor the ext
      // handler's live-session loop (it is not in `this.sessions` yet), so
      // the recorded override must be applied here; from `sessions.set`
      // onward concurrent writes reach the session through that loop. No
      // await sits between the pin and the publication, so no write can land
      // in between.
      if (this.sessionWorkflowEnabledOverride !== undefined) {
        config.setSessionWorkflowEnabledProvider?.(
          () => this.sessionWorkflowEnabledOverride === true,
        );
      }
      this.sessions.set(sessionId, session);
      // The session boots converged on the mode its settings derived; later
      // reloads track convergence from here. Restricted sessions derive
      // DEFAULT, mirroring the fold the reload loop applies to them.
      this.sessionApprovalModeConverged.set(
        sessionId,
        config.getApprovalMode(),
      );
      published = true;
      // The Session set itself is part of the snapshot: publish so the daemon
      // learns about this Session from a report rather than inferring it.
      this.activeWorkReporter?.notifyChanged();
      this.initializingConfigs.delete(config);
      if (options.enableLiveScreenContext) {
        await session.enableLiveScreenContext();
      }

      if (
        options.deferWorkspaceActivation !== true &&
        sessionData?.fileHistorySnapshots?.length
      ) {
        config
          .getFileHistoryService()
          .restoreFromSnapshots(sessionData.fileHistorySnapshots);
      }

      if (sessionData?.conversation.messages) {
        config
          .getChatRecordingService()
          ?.rebuildTurnBoundaries(sessionData.conversation.messages);
      }

      if (options.deferWorkspaceActivation !== true) {
        await replaySessionHistory();
      }

      if (options.deferWorkspaceActivation !== true) {
        await options.beforeStartPostReplayServices?.(session);
      }

      // Install rewriter AFTER history replay to avoid rewriting historical messages
      if (options.deferWorkspaceActivation !== true) {
        session.installRewriter();
      }

      if (options.deferWorkspaceActivation !== true) {
        config.finalizeSessionRestore?.();
      }

      // After replay and resume-state restoration so a durable cron fire can't
      // interleave with either.
      session.startCronScheduler();

      setTimeout(() => {
        void session.sendAvailableCommandsUpdate();
      }, 0);
      return session;
    } catch (error) {
      if (!published) {
        try {
          session.dispose();
        } catch (disposeError) {
          debugLogger.warn(
            `Failed to dispose unpublished session ${sessionId}: ${disposeError instanceof Error ? disposeError.message : String(disposeError)}`,
          );
        }
        throw error;
      }
      try {
        await this.discardStoredSessionIfCurrent(sessionId, session, {
          shutdownConfig: false,
        });
      } catch (cleanupError) {
        await this.removeStoredSessionEntry(
          sessionId,
          session,
          [cleanupError],
          { shutdownConfig: false },
        );
      }
      throw error;
    }
  }

  private buildAvailableModels(config: Config): NewSessionResponse['models'] {
    const rawCurrentModelId = (
      config.getModel() ||
      this.config.getModel() ||
      ''
    ).trim();
    const currentAuthType = config.getAuthType();
    const modelOptions = this.buildSelectableModelOptions(config);

    const activeRuntimeSnapshot = config.getActiveRuntimeModelSnapshot?.();
    const currentModelId = getCurrentAcpModelId(
      modelOptions,
      activeRuntimeSnapshot?.id ?? rawCurrentModelId,
      activeRuntimeSnapshot?.authType ?? currentAuthType,
      activeRuntimeSnapshot
        ? undefined
        : config.getCurrentModelRegistryBaseUrl?.(),
    );

    const mappedAvailableModels = modelOptions.map(({ model, modelId }) => ({
      modelId,
      name: model.label,
      description: model.description ?? null,
      _meta: {
        contextLimit: model.contextWindowSize ?? tokenLimit(model.id),
      },
    }));

    return {
      currentModelId,
      availableModels: mappedAvailableModels,
    };
  }

  private buildModesData(config: Config): SessionModeState {
    const currentApprovalMode = config.getApprovalMode();

    const availableModes = APPROVAL_MODES.map((mode) => ({
      id: mode as ApprovalModeValue,
      name: APPROVAL_MODE_INFO[mode].name,
      description: APPROVAL_MODE_INFO[mode].description,
    }));

    return {
      currentModeId: currentApprovalMode as ApprovalModeValue,
      availableModes,
    };
  }

  private buildConfigOptions(config: Config): SessionConfigOption[] {
    const currentApprovalMode = config.getApprovalMode();
    const modelOptions = this.buildSelectableModelOptions(config);
    const rawCurrentModelId = (config.getModel() || '').trim();
    const currentAuthType = config.getAuthType?.();

    const activeRuntimeSnapshot = config.getActiveRuntimeModelSnapshot?.();
    const currentModelId = getCurrentAcpModelId(
      modelOptions,
      activeRuntimeSnapshot?.id ?? rawCurrentModelId,
      activeRuntimeSnapshot?.authType ?? currentAuthType,
      activeRuntimeSnapshot
        ? undefined
        : config.getCurrentModelRegistryBaseUrl?.(),
    );

    const modeOptions = APPROVAL_MODES.map((mode) => ({
      value: mode,
      name: APPROVAL_MODE_INFO[mode].name,
      description: APPROVAL_MODE_INFO[mode].description,
    }));

    const modeConfigOption: SessionConfigOption = {
      id: 'mode',
      name: 'Mode',
      description: 'Session permission mode',
      category: 'mode',
      type: 'select' as const,
      currentValue: currentApprovalMode,
      options: modeOptions,
    };

    const configModelOptions = modelOptions.map(({ model, modelId }) => ({
      value: modelId,
      name: model.label,
      description: model.description ?? '',
    }));

    const modelConfigOption: SessionConfigOption = {
      id: 'model',
      name: 'Model',
      description: 'AI model to use',
      category: 'model',
      type: 'select' as const,
      currentValue: currentModelId,
      options: configModelOptions,
    };

    const generation = config.getContentGeneratorConfig();
    const modelReasoning = this.getModelReasoningConfiguration(
      config,
      currentModelId,
    );
    const currentModelEffort = config.getReasoningEffort?.();
    const reasoningOverride = config.getReasoningEffortOverride?.();
    const reasoningOverrideValue = reasoningOverride
      ? generation[reasoningOverride.source]?.[reasoningOverride.field]
      : undefined;
    const normalizedEffortOverride =
      reasoningOverride?.field === 'reasoning_effort' &&
      typeof reasoningOverrideValue === 'string'
        ? reasoningOverrideValue === 'minimal'
          ? 'low'
          : REASONING_EFFORT_TIERS.find(
              (effort) => effort === reasoningOverrideValue,
            )
        : undefined;
    const normalizedBudgetOverride =
      reasoningOverride?.field === 'thinking_budget' &&
      typeof reasoningOverrideValue === 'number' &&
      Number.isFinite(reasoningOverrideValue) &&
      reasoningOverrideValue >= 0 &&
      reasoningOverrideValue <= 262_144
        ? reasoningOverrideValue <= 4_096
          ? 'low'
          : reasoningOverrideValue <= 16_384
            ? 'medium'
            : 'xhigh'
        : undefined;
    const normalizedOverrideEffort =
      normalizedEffortOverride ?? normalizedBudgetOverride;
    const overrideDisablesReasoning =
      (reasoningOverride?.field === 'enable_thinking' &&
        reasoningOverrideValue === false) ||
      (reasoningOverride?.field === 'reasoning_effort' &&
        reasoningOverrideValue === REASONING_EFFORT_NONE);
    const mandatoryUsesDefaultEffort =
      generation.thinkingMandatory === true &&
      (overrideDisablesReasoning ||
        (generation.reasoning === false &&
          reasoningOverride?.field === 'reasoning_effort'));
    const effectiveModelEffort =
      modelReasoning && !modelReasoning.toggleOnly
        ? mandatoryUsesDefaultEffort
          ? modelReasoning.defaultEffort
          : normalizedOverrideEffort
            ? (modelReasoning.efforts.find(
                (effort) => effort === normalizedOverrideEffort,
              ) ?? modelReasoning.defaultEffort)
            : currentModelEffort
        : currentModelEffort;
    const reasoningEnabled =
      generation.reasoning !== false &&
      (!reasoningOverride || !overrideDisablesReasoning);
    const reasoningEffortConfigOption: SessionConfigOption = (modelReasoning
      ? buildModelReasoningConfigOption(rawCurrentModelId, {
          enabled: reasoningEnabled,
          effort: effectiveModelEffort,
          thinkingMandatory: generation.thinkingMandatory === true,
        })
      : undefined) ?? {
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      description: 'How hard reasoning-capable models should think',
      category: 'thought_level',
      type: 'select' as const,
      currentValue: currentModelEffort ?? REASONING_EFFORT_DEFAULT,
      options: [
        {
          value: REASONING_EFFORT_DEFAULT,
          name: 'Default',
          description: 'Use the model or provider default',
        },
        ...REASONING_EFFORT_TIERS.map((effort) => ({
          value: effort,
          name: REASONING_EFFORT_NAMES[effort],
          description:
            'Providers map or clamp the requested tier for the active model',
        })),
      ],
    };

    return [modeConfigOption, modelConfigOption, reasoningEffortConfigOption];
  }

  private getModelReasoningConfiguration(
    config: Config,
    currentAcpModelId?: string,
  ): ModelReasoningConfiguration | undefined {
    if (config.getActiveRuntimeModelSnapshot?.()) {
      return undefined;
    }
    const completeModelId =
      currentAcpModelId ??
      getCurrentAcpModelId(
        this.buildSelectableModelOptions(config),
        (config.getModel() || '').trim(),
        config.getAuthType?.(),
        config.getCurrentModelRegistryBaseUrl?.(),
      );
    if (completeModelId.startsWith(ACP_ROUTE_ID_PREFIX)) {
      return undefined;
    }
    const reasoning = getModelConfiguration(config.getModel())?.reasoning;
    return reasoning?.thinking ? reasoning : undefined;
  }

  private buildSelectableModelOptions(config: Config) {
    const currentAuthType = config.getAuthType();
    return buildAcpModelOptions(
      config
        .getAllConfiguredModels()
        .filter(
          (model) =>
            model.authType !== AuthType.QWEN_OAUTH ||
            currentAuthType === AuthType.QWEN_OAUTH,
        ),
    );
  }
}

function diffSettingsKeys(
  oldMerged: Record<string, unknown>,
  newMerged: Record<string, unknown>,
): Set<string> {
  const changed = new Set<string>();
  const allKeys = new Set([
    ...Object.keys(oldMerged),
    ...Object.keys(newMerged),
  ]);
  for (const key of allKeys) {
    if (JSON.stringify(oldMerged[key]) !== JSON.stringify(newMerged[key])) {
      changed.add(key);
    }
  }
  return changed;
}
