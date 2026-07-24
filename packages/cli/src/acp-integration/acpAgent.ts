/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  APPROVAL_MODE_INFO,
  APPROVAL_MODES,
  AuthType,
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
  getAllGeminiMdFilenames,
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
  SessionService,
  SESSION_WRITER_RPC_CODES,
  SessionWriterUnavailableError,
  SESSION_TITLE_MAX_LENGTH,
  Storage,
  tokenLimit,
  getMCPDiscoveryState,
  getMCPServerStatus,
  initializeTelemetry,
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
  subagentGenerator,
  redactUrlCredentials,
  computeUniqueBranchTitle,
  getActiveGoal,
  unregisterGoalHook,
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
  extractDaemonTraceContext,
  withDaemonSpan,
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
  type SendSdkMcpMessage,
  type SessionArtifactEventRecordPayload,
  type SessionArtifactSnapshotRecordPayload,
  type WorkspaceRememberContextMode,
  type ChatRecord,
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
  SessionModeState,
  SessionUpdate,
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
import { Readable, Writable } from 'node:stream';
import { normalizeDisabledToolList } from '../config/normalizeDisabledTools.js';
import { pipeline } from 'node:stream/promises';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createGunzip } from 'node:zlib';
import type { LoadedSettings } from '../config/settings.js';
import {
  loadSettings,
  reloadEnvironment,
  SettingScope,
} from '../config/settings.js';
import { loadSettingsCached } from '../config/settings-cache.js';
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
import type { ApprovalModeValue } from './session/types.js';
import { z } from 'zod';
import type { CliArgs } from '../config/config.js';
import {
  buildDisabledSkillNamesProvider,
  loadCliConfig,
} from '../config/config.js';
import {
  createWorkspaceMemoryExtractionErrorLogger,
  shouldSuppressRememberErrorDetails,
  workspaceMemoryFailureCode,
  workspaceMemoryFailureDiagnostics,
} from '../serve/workspace-remember-errors.js';
import { formatWorkspaceMemoryForgetSummary } from '../serve/workspace-memory-summaries.js';
import { mapSkillConfigToStatus } from '../serve/workspace-skills-mapping.js';
import {
  inactiveExtensionSkillRefs,
  isInactiveExtensionSkill,
} from './extension-skills.js';
import { Session, buildAvailableCommandsSnapshot } from './session/Session.js';
import { buildSessionTasksStatus } from './session/tasksSnapshot.js';
import {
  collectHistoryReplayUpdates,
  copyCumulativeUsage,
  createReplayCumulativeUsage,
  replayTranscriptRecordPage,
} from './session/history-replay-page.js';
import {
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
} from '../utils/languageUtils.js';
import { runWithAcpRuntimeOutputDir } from './runtimeOutputDirContext.js';
import { runExitCleanup } from '../utils/cleanup.js';
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
import { parseSessionSource } from '@qwen-code/acp-bridge';
import {
  CHANNEL_STARTUP_PROFILE_META_KEY,
  CHANNEL_STARTUP_PROFILE_VERSION,
  CLIENT_MCP_OVER_WS_CONFIG_FLAG,
  LOAD_REPLAY_BULK_MODE,
  LOAD_REPLAY_META_KEY,
  LOAD_REPLAY_MODE_META_KEY,
  LOAD_REPLAY_PAGE_SIZE_META_KEY,
  LOAD_REPLAY_VERSION,
  PROMPT_CANCEL_METHOD,
  TODO_STOP_GUARD_QUEUE_RELEASE_METHOD,
  type ClientMcpOverWsRuntimeConfig,
  type BridgeLoadReplayEnvelope,
} from '@qwen-code/acp-bridge/bridgeTypes';
import {
  beginAcpBootstrapConfigProfiling,
  buildAndFreezeAcpStartupProfile,
  endAcpBootstrapConfigProfiling,
  markAcpStartup,
} from '../utils/acp-startup-profiler.js';
import { isValidServerName } from '../serve/validate-server-name.js';
import { MAX_REMEMBER_CONTENT_BYTES } from '../serve/workspace-memory-remember-constants.js';
import { computeCpuPercent } from '../serve/daemon-metrics-ring.js';
import {
  collectContextData,
  formatContextUsageText,
} from '../ui/commands/contextCommand.js';
import type { HistoryItemContextUsage } from '../ui/types.js';
import {
  collectGoalStatusItemsFromRecords,
  restoreGoalFromHistory,
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
// Must be less than WORKSPACE_MEMORY_REMEMBER_TIMEOUT_MS (300s) in bridge.ts.
const WORKSPACE_MEMORY_REMEMBER_CHILD_TIMEOUT_MS = 295_000;

type AcpSessionStartStage =
  | 'settings_load'
  | 'config_setup'
  | 'auth'
  | 'file_system_setup'
  | 'session_register'
  | 'response_build';

interface AcpSessionStartSpan {
  setAttribute(name: string, value: string | number | boolean): unknown;
}

function createAcpSessionStartProfiler(span: AcpSessionStartSpan | undefined) {
  let failedStage: AcpSessionStartStage | undefined;
  const setAttribute = (
    name: string,
    value: string | number | boolean,
  ): void => {
    try {
      span?.setAttribute(name, value);
    } catch {
      // Telemetry must not affect session creation.
    }
  };
  const recordStage = (stage: AcpSessionStartStage, start: number): void => {
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      setAttribute(`qwen-code.daemon.session_start.${stage}_ms`, durationMs);
    }
  };
  const recordFailure = (stage: AcpSessionStartStage): void => {
    if (failedStage !== undefined) return;
    failedStage = stage;
    setAttribute('qwen-code.daemon.session_start.failed_stage', stage);
  };

  return {
    async time<T>(
      stage: AcpSessionStartStage,
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
    timeSync<T>(stage: AcpSessionStartStage, fn: () => T): T {
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
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Session ${kind} timed out after ${timeoutMs}ms`)),
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

function isHistoryTurnStart(record: ChatRecord): boolean {
  return record.type === 'user' && record.subtype !== 'mid_turn_user_message';
}

function selectRecentHistoryRecords(
  records: ChatRecord[],
  pageSize: number | undefined,
): { records: ChatRecord[]; hasMore: boolean } {
  if (pageSize === undefined || records.length <= pageSize) {
    return { records, hasMore: false };
  }
  let start = records.length - pageSize;
  for (let i = start; i < records.length; i++) {
    if (isHistoryTurnStart(records[i]!)) {
      start = i;
      break;
    }
  }
  while (start > 0 && !isHistoryTurnStart(records[start]!)) {
    start--;
  }
  return { records: records.slice(start), hasMore: start > 0 };
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

type QwenSkillInstallRequest = {
  id: string;
  slug: string;
  name: string;
  description?: string;
  sourceUrl: string;
  scope: 'global';
};

type QwenSkillDeleteRequest = {
  slug: string;
  scope: 'global';
};

type QwenSkillSetEnabledRequest = {
  slug: string;
  enabled: boolean;
  scope: 'global' | 'project';
};

type QwenManagedSkillFile = {
  skillDir: string;
  skillFile: string;
  content: string;
};

const PROJECT_SKILL_DIRS = ['.qwen', '.agents'] as const;
const SKILLS_DIR = 'skills';

type DownloadedSkillFile = {
  relativePath: string;
  content: Uint8Array;
};

type DownloadedSkill = {
  skillContent: string;
  files: DownloadedSkillFile[];
};

type GitHubBlobSkillUrl = {
  owner: string;
  repo: string;
  ref: string;
  filePath: string;
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
    values: ['plan', 'default', 'auto-edit', 'auto', 'yolo'],
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

// Skill slugs are used to build filesystem paths under `<globalQwenDir>/skills`.
// The character allowlist below already excludes `/` and `\`, but `.` and `..`
// would still slip through and let `path.join` traverse out of the skills dir
// (e.g. slug `..` resolves to the global config dir). Reject them explicitly.
function validateSkillSlug(slug: string): void {
  if (
    !slug ||
    slug === '.' ||
    slug === '..' ||
    slug.includes('/') ||
    slug.includes(path.sep) ||
    !/^[a-zA-Z0-9._-]+$/.test(slug)
  ) {
    throw RequestError.invalidParams(undefined, 'Invalid skill.slug');
  }
}

function readSkillInstallRequest(
  params: Record<string, unknown>,
): QwenSkillInstallRequest {
  const skillParams = toRecord(params['skill']);
  const input = Object.keys(skillParams).length > 0 ? skillParams : params;
  const slug = readRequiredString(input['slug'], 'skill.slug');
  validateSkillSlug(slug);

  const scope = readOptionalString(input['scope'], 'skill.scope') ?? 'global';
  if (scope !== 'global') {
    throw RequestError.invalidParams(
      undefined,
      'Only global skill installation is supported',
    );
  }

  const description = readOptionalString(
    input['description'],
    'skill.description',
  );
  return {
    id: readOptionalString(input['id'], 'skill.id') ?? slug,
    slug,
    name: readOptionalString(input['name'], 'skill.name') ?? slug,
    ...(description ? { description } : {}),
    sourceUrl: readRequiredString(input['sourceUrl'], 'skill.sourceUrl'),
    scope,
  };
}

function readSkillSlugRequest(
  params: Record<string, unknown>,
): QwenSkillDeleteRequest {
  const skillParams = toRecord(params['skill']);
  const input = Object.keys(skillParams).length > 0 ? skillParams : params;
  const slug = readRequiredString(input['slug'], 'skill.slug');
  validateSkillSlug(slug);

  const scope = readOptionalString(input['scope'], 'skill.scope') ?? 'global';
  if (scope !== 'global') {
    throw RequestError.invalidParams(
      undefined,
      'Only global skill management is supported',
    );
  }

  return { slug, scope };
}

function readSkillSetEnabledRequest(
  params: Record<string, unknown>,
): QwenSkillSetEnabledRequest {
  const skillParams = toRecord(params['skill']);
  const input = Object.keys(skillParams).length > 0 ? skillParams : params;
  const slug = readRequiredString(input['slug'], 'skill.slug');
  validateSkillSlug(slug);

  const scope = readOptionalString(input['scope'], 'skill.scope') ?? 'global';
  if (scope !== 'global' && scope !== 'project') {
    throw RequestError.invalidParams(
      undefined,
      'Only global or project skill management is supported',
    );
  }

  if (typeof input['enabled'] !== 'boolean') {
    throw RequestError.invalidParams(
      undefined,
      'Invalid skill.enabled: expected boolean',
    );
  }
  return {
    slug,
    scope,
    enabled: input['enabled'],
  };
}

function splitSkillMarkdown(content: string): {
  frontmatter: string;
  body: string;
} {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) {
    throw RequestError.invalidParams(
      undefined,
      'Invalid skill file: missing YAML frontmatter',
    );
  }
  return {
    frontmatter: match[1],
    body: match[2],
  };
}

function setSkillFrontmatterEnabled(content: string, enabled: boolean): string {
  const { frontmatter, body } = splitSkillMarkdown(content);

  // Surgically add/remove only the top-level `disable-model-invocation:` line
  // instead of round-tripping the whole frontmatter through a YAML
  // parse/stringify. The minimal core YAML serializer drops comments and
  // flattens nested structures (e.g. `hooks:`), so reserializing here would
  // corrupt hooks-bearing skills and strip user comments. Working on the raw
  // text leaves every other byte untouched.
  const lines = frontmatter.split('\n');
  const disabledLineIndex = lines.findIndex((line) =>
    /^disable-model-invocation\s*:/.test(line),
  );

  if (enabled) {
    if (disabledLineIndex !== -1) {
      lines.splice(disabledLineIndex, 1);
    }
  } else if (disabledLineIndex !== -1) {
    lines[disabledLineIndex] = 'disable-model-invocation: true';
  } else {
    let insertIndex = lines.length;
    while (insertIndex > 0 && lines[insertIndex - 1].trim() === '') {
      insertIndex -= 1;
    }
    lines.splice(insertIndex, 0, 'disable-model-invocation: true');
  }

  const nextFrontmatter = lines.join('\n');
  return `---\n${nextFrontmatter}\n---\n${body}`;
}

// Skill downloads must come from the GitHub host set. Restricting the host
// here prevents the client-supplied `sourceUrl` from driving server-side
// fetches at internal/loopback/link-local endpoints (SSRF), e.g.
// `http://169.254.169.254/` cloud-metadata or `http://localhost:<port>/`.
const ALLOWED_SKILL_SOURCE_HOSTS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'api.github.com',
]);

function assertAllowedSkillSourceUrl(sourceUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw RequestError.invalidParams(
      undefined,
      'Skill sourceUrl must be a valid URL',
    );
  }
  // Require HTTPS: a plaintext http: fetch of skill content (which can include
  // executable hooks) is MITM-able by a network-position attacker, so the host
  // allowlist alone is not sufficient. All supported GitHub hosts serve HTTPS.
  if (parsed.protocol !== 'https:') {
    throw RequestError.invalidParams(
      undefined,
      'Skill sourceUrl must be an HTTPS URL',
    );
  }
  if (!ALLOWED_SKILL_SOURCE_HOSTS.has(parsed.hostname)) {
    throw RequestError.invalidParams(
      undefined,
      'Skill sourceUrl host is not allowed (only github.com sources are supported)',
    );
  }
}

function parseGitHubBlobSkillUrl(sourceUrl: string): GitHubBlobSkillUrl | null {
  const parsed = new URL(sourceUrl);
  // HTTPS-only, consistent with assertAllowedSkillSourceUrl (skill content can
  // include executable hooks, so plaintext http: is MITM-able).
  if (parsed.protocol !== 'https:') {
    throw RequestError.invalidParams(
      undefined,
      'Skill sourceUrl must be an HTTPS URL',
    );
  }

  if (parsed.hostname !== 'github.com') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 5 || parts[2] !== 'blob') return null;

  const owner = parts[0];
  const repo = parts[1];
  const ref = parts[3];
  const filePathParts = parts.slice(4);
  if (!owner || !repo || !ref || filePathParts.length === 0) return null;

  return {
    owner,
    repo,
    ref,
    filePath: filePathParts.join('/'),
  };
}

function toRawGitHubUrl(githubUrl: GitHubBlobSkillUrl): string {
  return `https://raw.githubusercontent.com/${githubUrl.owner}/${githubUrl.repo}/${githubUrl.ref}/${githubUrl.filePath}`;
}

function encodeGitHubPath(filePath: string): string {
  if (!filePath || filePath === '.') return '';
  return filePath.split('/').map(encodeURIComponent).join('/');
}

function readTarString(
  archive: Uint8Array,
  offset: number,
  length: number,
): string {
  const bytes = archive.subarray(offset, offset + length);
  const nul = bytes.indexOf(0);
  const end = nul >= 0 ? nul : bytes.length;
  return Buffer.from(bytes.subarray(0, end)).toString('utf8').trim();
}

function readTarSize(archive: Uint8Array, offset: number): number {
  const raw = readTarString(archive, offset + 124, 12);
  return raw ? Number.parseInt(raw, 8) : 0;
}

function isZeroTarBlock(archive: Uint8Array, offset: number): boolean {
  for (let i = 0; i < 512; i += 1) {
    if (archive[offset + i] !== 0) return false;
  }
  return true;
}

function readTarPath(archive: Uint8Array, offset: number): string {
  const name = readTarString(archive, offset, 100);
  const prefix = readTarString(archive, offset + 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function stripArchiveRoot(filePath: string): string {
  const parts = filePath.split('/').filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join('/') : '';
}

// Bound the work done on untrusted skill archives so a malicious or oversized
// download cannot exhaust memory. Decompression is streamed (createGunzip) and
// aborted the moment the cumulative inflated size crosses the cap, so a
// decompression bomb can never fully inflate into memory.
const MAX_SKILL_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100 MB compressed
const MAX_SKILL_DECOMPRESSED_BYTES = 500 * 1024 * 1024; // 500 MB decompressed
// Bounds for the GitHub Contents-API directory walk (the archive path is
// already bounded by the byte caps above).
const MAX_SKILL_API_DIR_DEPTH = 16;
const MAX_SKILL_API_FILE_COUNT = 2000;

// Sentinel so the streaming decompression's size-limit abort can be told apart
// from a genuine gunzip/format error in the catch below.
class DecompressedSizeExceededError extends Error {}

export async function extractFilesFromTarGz(
  archiveBytes: Uint8Array,
  directoryPath: string,
  // Limits are injectable so the size-guard branches can be exercised in tests
  // without allocating the 100MB/500MB production thresholds.
  limits: {
    maxCompressedBytes?: number;
    maxDecompressedBytes?: number;
  } = {},
): Promise<DownloadedSkillFile[]> {
  const maxCompressedBytes =
    limits.maxCompressedBytes ?? MAX_SKILL_DOWNLOAD_BYTES;
  const maxDecompressedBytes =
    limits.maxDecompressedBytes ?? MAX_SKILL_DECOMPRESSED_BYTES;

  if (archiveBytes.length > maxCompressedBytes) {
    throw RequestError.invalidParams(
      undefined,
      'Skill archive exceeds the maximum allowed size',
    );
  }

  let archive: Buffer;
  try {
    // Stream the inflate so we can abort as soon as the cumulative output
    // exceeds the cap, instead of materializing the entire decompressed buffer
    // first (a ~1000:1 gzip ratio could otherwise inflate a small archive to
    // many GB before any post-hoc length check fires).
    const chunks: Buffer[] = [];
    let total = 0;
    await pipeline(
      // Wrap in an array so the whole archive is emitted as a single chunk;
      // `Readable.from(uint8array)` would otherwise iterate it byte-by-byte.
      Readable.from([Buffer.from(archiveBytes)]),
      createGunzip(),
      new Writable({
        write(chunk: Buffer, _enc, cb) {
          total += chunk.length;
          if (total > maxDecompressedBytes) {
            cb(new DecompressedSizeExceededError());
            return;
          }
          chunks.push(chunk);
          cb();
        },
      }),
    );
    archive = Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof DecompressedSizeExceededError) {
      throw RequestError.invalidParams(
        undefined,
        'Decompressed skill archive exceeds the maximum allowed size',
      );
    }
    throw RequestError.invalidParams(
      undefined,
      `Failed to decompress skill archive: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const normalizedDirectory = directoryPath.replace(/^\/+|\/+$/g, '');
  // Treat '.' (SKILL.md at the repository root) as the empty prefix; otherwise
  // the prefix becomes './' and never matches the root-stripped archive paths
  // (e.g. 'SKILL.md'), yielding zero extracted files.
  const directoryPrefix =
    normalizedDirectory && normalizedDirectory !== '.'
      ? `${normalizedDirectory}/`
      : '';
  const files: DownloadedSkillFile[] = [];

  for (let offset = 0; offset + 512 <= archive.length; ) {
    if (isZeroTarBlock(archive, offset)) break;

    const fullPath = readTarPath(archive, offset);
    const typeFlag = String.fromCharCode(archive[offset + 156] || 0);
    const size = readTarSize(archive, offset);
    const dataOffset = offset + 512;
    const nextOffset = dataOffset + Math.ceil(size / 512) * 512;

    if (typeFlag === '0' || typeFlag === '\0') {
      const repoPath = stripArchiveRoot(fullPath);
      if (repoPath.startsWith(directoryPrefix)) {
        const relativePath = repoPath.slice(directoryPrefix.length);
        if (relativePath) {
          files.push({
            relativePath,
            content: archive.subarray(dataOffset, dataOffset + size),
          });
        }
      }
    }

    offset = nextOffset;
  }

  return files;
}

// GitHub host suffixes a download may legitimately redirect to (raw/codeload
// commonly 302 to their object CDN for geo/CDN routing). Redirects to anything
// outside these are rejected, preserving the SSRF guard while not breaking
// real downloads.
const ALLOWED_REDIRECT_HOST_SUFFIXES = [
  '.githubusercontent.com',
  '.github.com',
  // Note: '.github.io' is intentionally excluded — *.github.io are
  // user-controlled GitHub Pages sites, so allowing redirects there would
  // reopen the SSRF/exfiltration surface this allowlist exists to close.
];

function isAllowedSkillFetchHost(hostname: string): boolean {
  if (ALLOWED_SKILL_SOURCE_HOSTS.has(hostname)) return true;
  return ALLOWED_REDIRECT_HOST_SUFFIXES.some((suffix) =>
    hostname.endsWith(suffix),
  );
}

/**
 * Fetch that follows redirects manually, validating every hop stays on an
 * allowed GitHub host over HTTPS. This keeps the SSRF protection of
 * `redirect: 'manual'` (a malicious repo cannot bounce the fetch to an internal
 * endpoint) while still following GitHub's legitimate CDN redirects, which
 * plain `redirect: 'manual'` would surface as a download failure.
 */
export async function fetchAllowedGitHub(
  url: string,
  init: RequestInit = {},
  maxRedirects = 5,
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await fetch(current, { ...init, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) {
      return response;
    }
    const location = response.headers?.get('location');
    if (!location) return response;
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw RequestError.invalidParams(
        undefined,
        'Skill download redirected to an invalid URL',
      );
    }
    if (next.protocol !== 'https:' || !isAllowedSkillFetchHost(next.hostname)) {
      throw RequestError.invalidParams(
        undefined,
        'Skill download redirected to a disallowed host',
      );
    }
    current = next.toString();
  }
  throw RequestError.invalidParams(
    undefined,
    'Skill download exceeded the maximum number of redirects',
  );
}

// Read a response body while enforcing a hard byte cap against the *actual*
// streamed bytes. The Content-Length pre-checks at the call sites are advisory
// only — a server that omits the header (chunked transfer, CDN redirect) could
// otherwise stream an arbitrarily large body straight into memory via
// `arrayBuffer()`.
async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const body = response.body;
  if (!body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw RequestError.invalidParams(
        undefined,
        'Skill download exceeds the maximum allowed size',
      );
    }
    return buf;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw RequestError.invalidParams(
        undefined,
        'Skill download exceeds the maximum allowed size',
      );
    }
    chunks.push(value);
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetchAllowedGitHub(url);
  if (!response.ok) {
    throw RequestError.invalidParams(
      undefined,
      `Failed to download skill (${response.status})`,
    );
  }

  const contentLength = response.headers?.get('content-length');
  if (contentLength) {
    const declaredSize = Number.parseInt(contentLength, 10);
    if (
      Number.isFinite(declaredSize) &&
      declaredSize > MAX_SKILL_DOWNLOAD_BYTES
    ) {
      throw RequestError.invalidParams(
        undefined,
        'Skill download exceeds the maximum allowed size',
      );
    }
  }

  return readBodyWithLimit(response, MAX_SKILL_DOWNLOAD_BYTES);
}

async function downloadSingleSkillFile(
  sourceUrl: string,
): Promise<DownloadedSkill> {
  const githubUrl = parseGitHubBlobSkillUrl(sourceUrl);
  const fetchUrl = githubUrl ? toRawGitHubUrl(githubUrl) : sourceUrl;
  const content = await fetchBytes(fetchUrl);
  return {
    skillContent: Buffer.from(content).toString('utf8'),
    files: [{ relativePath: 'SKILL.md', content }],
  };
}

async function downloadGitHubSkillDirectoryFromArchive(
  githubUrl: GitHubBlobSkillUrl,
  directoryPath: string,
): Promise<DownloadedSkillFile[]> {
  const archiveUrl = `https://codeload.github.com/${githubUrl.owner}/${githubUrl.repo}/tar.gz/${encodeURIComponent(
    githubUrl.ref,
  )}`;
  const response = await fetchAllowedGitHub(archiveUrl, {
    headers: {
      'User-Agent': 'qwen-code',
    },
  });
  if (!response.ok) {
    throw RequestError.invalidParams(
      undefined,
      `Failed to download GitHub skill archive (${response.status})`,
    );
  }

  // Reject oversized archives by declared Content-Length before buffering the
  // whole body into memory, mirroring the guard in fetchBytes.
  const contentLength = response.headers?.get('content-length');
  if (contentLength) {
    const declaredSize = Number.parseInt(contentLength, 10);
    if (
      Number.isFinite(declaredSize) &&
      declaredSize > MAX_SKILL_DOWNLOAD_BYTES
    ) {
      throw RequestError.invalidParams(
        undefined,
        'Skill archive exceeds the maximum allowed size',
      );
    }
  }

  return extractFilesFromTarGz(
    await readBodyWithLimit(response, MAX_SKILL_DOWNLOAD_BYTES),
    directoryPath,
  );
}

async function fetchGitHubDirectoryItems(
  githubUrl: GitHubBlobSkillUrl,
  directoryPath: string,
): Promise<unknown[]> {
  const encodedPath = encodeGitHubPath(directoryPath);
  const apiUrl = `https://api.github.com/repos/${githubUrl.owner}/${githubUrl.repo}/contents/${encodedPath}?ref=${encodeURIComponent(githubUrl.ref)}`;
  const response = await fetchAllowedGitHub(apiUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'qwen-code',
    },
  });
  if (!response.ok) {
    throw RequestError.invalidParams(
      undefined,
      `Failed to list GitHub skill files (${response.status})`,
    );
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    throw RequestError.invalidParams(
      undefined,
      'GitHub skill URL must point to a directory-backed SKILL.md file',
    );
  }
  return data;
}

async function downloadGitHubSkillDirectoryFromApi(
  githubUrl: GitHubBlobSkillUrl,
  directoryPath: string,
  relativeRoot = '',
  // Bound the recursive API walk so a crafted repo (deeply nested dirs, huge
  // file counts, or large cumulative size) can't exhaust memory/time. The
  // archive fallback already enforces size caps; this gives the API path
  // equivalent guards.
  depth = 0,
  budget: { files: number; bytes: number } = { files: 0, bytes: 0 },
): Promise<DownloadedSkillFile[]> {
  if (depth > MAX_SKILL_API_DIR_DEPTH) {
    throw RequestError.invalidParams(
      undefined,
      'Skill directory nesting exceeds the maximum allowed depth',
    );
  }
  const items = await fetchGitHubDirectoryItems(githubUrl, directoryPath);
  const files: DownloadedSkillFile[] = [];

  for (const item of items) {
    const record = toRecord(item);
    const name = readRequiredString(record['name'], 'github.name');
    const itemPath = readRequiredString(record['path'], 'github.path');
    const type = readRequiredString(record['type'], 'github.type');
    const relativePath = relativeRoot
      ? path.posix.join(relativeRoot, name)
      : name;

    if (type === 'dir') {
      files.push(
        ...(await downloadGitHubSkillDirectoryFromApi(
          githubUrl,
          itemPath,
          relativePath,
          depth + 1,
          budget,
        )),
      );
      continue;
    }

    if (type !== 'file') continue;
    budget.files += 1;
    if (budget.files > MAX_SKILL_API_FILE_COUNT) {
      throw RequestError.invalidParams(
        undefined,
        'Skill directory contains too many files',
      );
    }
    const downloadUrl = readRequiredString(
      record['download_url'],
      'github.download_url',
    );
    // SSRF defense: the API-provided download_url is attacker-influenced, so
    // run it through the same host allowlist + HTTPS check as the initial URL.
    assertAllowedSkillSourceUrl(downloadUrl);
    const content = await fetchBytes(downloadUrl);
    budget.bytes += content.length;
    if (budget.bytes > MAX_SKILL_DECOMPRESSED_BYTES) {
      throw RequestError.invalidParams(
        undefined,
        'Skill directory exceeds the maximum allowed size',
      );
    }
    files.push({
      relativePath,
      content,
    });
  }

  return files;
}

async function downloadGitHubSkillDirectory(
  githubUrl: GitHubBlobSkillUrl,
  directoryPath: string,
): Promise<DownloadedSkillFile[]> {
  const apiFiles = await downloadGitHubSkillDirectoryFromApi(
    githubUrl,
    directoryPath,
  ).catch((error) => {
    debugLogger.warn(
      'GitHub API directory listing failed, falling back to archive download:',
      error,
    );
    return null;
  });
  if (apiFiles) return apiFiles;

  return downloadGitHubSkillDirectoryFromArchive(githubUrl, directoryPath);
}

async function downloadSkill(sourceUrl: string): Promise<DownloadedSkill> {
  assertAllowedSkillSourceUrl(sourceUrl);
  const githubUrl = parseGitHubBlobSkillUrl(sourceUrl);
  if (!githubUrl || path.posix.basename(githubUrl.filePath) !== 'SKILL.md') {
    return downloadSingleSkillFile(sourceUrl);
  }

  const skillDirectory = path.posix.dirname(githubUrl.filePath);
  const files = await downloadGitHubSkillDirectory(githubUrl, skillDirectory);
  const skillFile = files.find((file) => file.relativePath === 'SKILL.md');
  if (!skillFile) {
    throw RequestError.invalidParams(
      undefined,
      'GitHub skill directory does not contain SKILL.md',
    );
  }

  return {
    skillContent: Buffer.from(skillFile.content).toString('utf8'),
    files,
  };
}

function resolveSkillInstallPath(
  skillDir: string,
  relativePath: string,
): string {
  const root = path.resolve(skillDir);
  const target = path.resolve(skillDir, relativePath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid skill file path: ${relativePath}`,
    );
  }
  return target;
}

// Builds the per-skill directory and asserts (defense-in-depth, on top of
// validateSkillSlug) that it stays strictly under the managed skills root, so a
// crafted slug can never make install/delete operate on `<globalQwenDir>` itself.
function resolveManagedSkillDir(skillsBaseDir: string, slug: string): string {
  const root = path.resolve(skillsBaseDir);
  const skillDir = path.resolve(skillsBaseDir, slug);
  if (!skillDir.startsWith(root + path.sep)) {
    throw RequestError.invalidParams(undefined, 'Invalid skill.slug');
  }
  return skillDir;
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
  for (const filename of getAllGeminiMdFilenames()) {
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
  const fallbackFilename = getAllGeminiMdFilenames()[0] ?? 'QWEN.md';
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
  options?: { privateParentCapability?: string },
) {
  const privateParentCapability =
    options === undefined
      ? process.env[PRIVATE_ACP_CAPABILITY_ENV]
      : options.privateParentCapability;
  delete process.env[PRIVATE_ACP_CAPABILITY_ENV];

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
      skipGeminiInitialization: true,
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
  // The ACP path exits gemini.tsx before its startup-warning printing runs,
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
    const stream = ndJsonStream(stdout, stdin, {
      onMessageObserved: ({ direction, message }) => {
        if (
          direction === 'received' &&
          'id' in message &&
          'method' in message &&
          message.method === 'initialize'
        ) {
          initializeRequestId = message.id;
          return;
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
      agentInstance = new QwenAgent(
        config,
        settings,
        argv,
        conn,
        privateParentCapability,
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
  const drainPoolBeforeExit = async (label: string): Promise<void> => {
    if (!agentInstance) return;
    try {
      await agentInstance.shutdownMcpPool(8_000);
    } catch (err) {
      debugLogger.error(`[ACP] MCP pool drain (${label}) error:`, err);
    }
  };

  // Handle SIGTERM/SIGINT for graceful shutdown.
  // Without this, signal handlers registered elsewhere in the CLI
  // (e.g., stdin raw mode restoration) override the default exit behavior,
  // causing the ACP process to ignore termination signals.
  let shuttingDown = false;
  let sessionEndFired = false;

  // Helper to fire SessionEnd hook once, preventing double-fire from both
  // shutdown handler path and connection.closed path.
  const fireSessionEndOnce = async (reason: SessionEndReason) => {
    if (sessionEndFired) return;
    sessionEndFired = true;

    const configs = new Set<Config>([config]);
    const sessions = agentInstance?.getActiveSessions();
    if (sessions) {
      for (const session of sessions) {
        const sessionConfig = session.getConfig?.();
        if (sessionConfig) {
          configs.add(sessionConfig);
        }
      }
    }

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
        debugLogger.warn(
          `SessionEnd hook failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };

  const shutdownHandler = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    debugLogger.debug('[ACP] Shutdown signal received, closing streams');

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
    // Connection closed by IDE - fire SessionEnd hook (aligned with core path)
    await fireSessionEndOnce(SessionEndReason.PromptInputExit);
    // Mirror the SIGTERM handler's pool drain on the IDE-initiated
    // normal close path to avoid leaking shared MCP entries.
    await drainPoolBeforeExit('ide_close');
    await agentInstance?.disposeSessions();
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

class QwenAgent implements Agent {
  private sessions: Map<string, Session> = new Map();
  private activePromptCalls = new Map<string, Set<ActivePromptCall>>();
  private workspaceMcpDiscoveryConfig: Config | undefined;
  private workspaceMcpDiscoveryPromise: Promise<void> | undefined;
  private workspaceMcpDiscoveryError: string | undefined;
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
  private clientCapabilities: ClientCapabilities | undefined;
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

  private getWorkspaceMcpConfig(serverName?: string): Config {
    if (
      serverName &&
      this.config.getRuntimeMcpServers?.()[serverName] !== undefined
    ) {
      return this.config;
    }
    return this.workspaceMcpDiscoveryConfig ?? this.config;
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
          const geminiClient = config.getGeminiClient?.();
          if (geminiClient?.isInitialized?.()) {
            await geminiClient.setTools?.();
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
        skipGeminiInitialization: true,
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
          const mcpServers = assembleMcpServers(
            settings.merged.mcpServers,
            cwd,
            config.getTopTierMcpServers(),
          );
          const gating = recomputeMcpGating(
            settings,
            mcpServers,
            cwd,
            config.getCliAllowedMcpServerNames(),
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
              const geminiClient = config.getGeminiClient?.();
              if (geminiClient?.isInitialized?.()) {
                await geminiClient.setTools?.();
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
      }
    } catch (err) {
      debugLogger.error(
        `MCP pool drainAll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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
      unregisterGoalHook(session.getConfig(), sessionId);
    } catch (error) {
      cleanupErrors.push(error);
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
    operation: (config: Config, data: ResumedSessionData) => Promise<T>,
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
      const loadAuthoritative = () =>
        config.getSessionService().loadSession(sessionId);
      const data = recorder
        ? await recorder.runWithWriteBarrier(loadAuthoritative)
        : await loadAuthoritative();
      if (!data) throw new SessionWriterUnavailableError();
      return await operation(config, data);
    } catch (error) {
      throw mapSessionWriterRequestError(error);
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
      const pending = this.pendingConfigCleanup.get(cleanupKey) ?? new Set();
      pending.add(config);
      this.pendingConfigCleanup.set(cleanupKey, pending);
      throw mapSessionWriterRequestError(error);
    }
    const pending = this.pendingConfigCleanup.get(cleanupKey);
    pending?.delete(config);
    if (pending?.size === 0) {
      this.pendingConfigCleanup.delete(cleanupKey);
    }
  }

  private async cleanupAfterRequestFailure(
    error: unknown,
    cleanup: () => Promise<void>,
  ): Promise<never> {
    try {
      await cleanup();
    } catch (cleanupError) {
      debugLogger.warn(
        `Session cleanup failed while preserving the original request error: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw error;
  }

  private pendingConfigCleanupKey(
    runtimeBaseDir: string,
    sessionId: string,
  ): string {
    return `${path.resolve(runtimeBaseDir)}\0${sessionId}`;
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
    },
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.mcpPool?.releaseSession(sessionId);
      return;
    }

    const recorder = session.getConfig().getChatRecordingService();
    const requireFlush = opts?.requireFlush === true;
    if (requireFlush) {
      await recorder?.flush();
    }

    const drainTimeoutMs = opts?.drainTimeoutMs ?? SESSION_DRAIN_TIMEOUT_MS;
    const cancelClose = opts?.waitForCloseGate
      ? await beginSessionCloseAfterCurrentGate(session, drainTimeoutMs)
      : session.beginClose();
    for (const [requestId, generation] of this.generationControllers) {
      if (generation.sessionId !== sessionId) continue;
      generation.controller.abort();
      this.generationControllers.delete(requestId);
    }
    let removedFromStore = false;
    try {
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
        drainTimeoutMs,
        'close',
      );

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
      await this.removeStoredSessionEntry(sessionId, session, cleanupErrors, {
        shutdownConfig: opts?.shutdownConfig,
      });
      removedFromStore = true;
    } finally {
      if (!removedFromStore) cancelClose();
    }
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

    return profileRequested && startupProfile
      ? {
          ...response,
          _meta: {
            [CHANNEL_STARTUP_PROFILE_META_KEY]: startupProfile,
          },
        }
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

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const { cwd, mcpServers } = params;
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
        const config = await profiler.time('config_setup', () =>
          this.newSessionConfig(cwd, mcpServers, settings),
        );
        let session: Session;
        try {
          await profiler.time('auth', () => this.ensureAuthenticated(config));
          profiler.timeSync('file_system_setup', () =>
            this.setupFileSystem(config),
          );
          session = await profiler.time('session_register', () =>
            this.createAndStoreSession(config, settings),
          );
        } catch (error) {
          return this.cleanupAfterRequestFailure(error, async () => {
            if (
              this.sessions.get(config.getSessionId())?.getConfig() !== config
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
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    // Load per-request settings BEFORE the existence check: the check must
    // resolve `advanced.runtimeOutputDir` from THIS request's cwd, not from
    // whichever settings a concurrent handler loaded last.
    const settings = loadSettingsCached(params.cwd);
    const liveSession = this.sessions.get(params.sessionId);
    if (liveSession) {
      const liveConfig = liveSession.getConfig();
      await this.assertLiveSessionScope(liveConfig, settings, params.cwd);
      return this.withLiveSessionRestore(
        params.sessionId,
        liveSession,
        async (config, sessionData) => {
          const response: LoadSessionResponse = {
            modes: this.buildModesData(config),
            models: this.buildAvailableModels(config),
            configOptions: this.buildConfigOptions(config),
            ...(sessionData.artifactSnapshot
              ? { artifactSnapshot: sessionData.artifactSnapshot }
              : {}),
          } as LoadSessionResponse;
          const records = sessionData.conversation.messages;
          if (records.length === 0) return response;

          const bulkReplay = isBulkLoadReplayRequest(params);
          const replayPage = bulkReplay
            ? selectRecentHistoryRecords(records, getLoadReplayPageSize(params))
            : { records, hasMore: false };
          const replay = await collectHistoryReplayUpdates({
            sessionId: params.sessionId,
            config,
            records: replayPage.records,
            gaps: sessionData.historyGaps,
            cumulativeUsage: createReplayCumulativeUsage(),
            logger: debugLogger,
          });
          if (!bulkReplay) {
            for (const update of replay.updates) {
              await liveSession.sendUpdate(update);
            }
            if (replay.replayError !== undefined) {
              throw RequestError.internalError(undefined, replay.replayError);
            }
            return response;
          }

          return {
            ...response,
            _meta: {
              [LOAD_REPLAY_META_KEY]: {
                v: LOAD_REPLAY_VERSION,
                updates: replay.updates,
                ...(replay.replayError !== undefined
                  ? { partial: true as const, replayError: replay.replayError }
                  : {}),
                ...(replayPage.hasMore ? { hasMore: true as const } : {}),
              },
            },
          };
        },
      );
    }
    const exists = await this.runWithPinnedRuntimeBaseDir(
      settings,
      params.cwd,
      async () => {
        const sessionService = new SessionService(params.cwd);
        return sessionService.sessionExists(params.sessionId);
      },
    );
    if (!exists) {
      throw RequestError.resourceNotFound(`session:${params.sessionId}`);
    }
    // Adopt into the "latest loaded" cache only once the session is
    // confirmed — a failed probe for a stale id must not repoint
    // agent-level readers at this request's workspace.
    this.settings = settings;

    const config = await this.newSessionConfig(
      params.cwd,
      // `LoadSessionRequest.mcpServers` is required in today's ACP
      // schema, but mirror `unstable_resumeSession` and tolerate a
      // future loosening — `newSessionConfig` iterates the list, so
      // a `null`/`undefined` would otherwise throw `TypeError`.
      params.mcpServers ?? [],
      settings,
      params.sessionId,
      true,
    );
    const sessionData = config.getResumedSessionData();
    const bulkReplay = isBulkLoadReplayRequest(params);
    const replayPageSize = bulkReplay
      ? getLoadReplayPageSize(params)
      : undefined;
    let session: Session;
    try {
      await this.ensureAuthenticated(config);
      this.setupFileSystem(config);
      session = await this.createAndStoreSession(
        config,
        settings,
        sessionData,
        bulkReplay
          ? { replayHistory: false, startPostReplayServices: false }
          : {},
      );
    } catch (error) {
      return this.cleanupAfterRequestFailure(error, async () => {
        if (this.sessions.get(config.getSessionId())?.getConfig() !== config) {
          await this.cleanupUnstoredConfig(config);
        }
      });
    }
    let replayEnvelope: BridgeLoadReplayEnvelope | undefined;
    if (bulkReplay) {
      try {
        const records = sessionData?.conversation.messages;
        let replayUpdates: SessionUpdate[] = [];
        if (records) {
          session.primeTurnFromHistory(records);
          const replayPage = selectRecentHistoryRecords(
            records,
            replayPageSize,
          );
          const replayUsage = createReplayCumulativeUsage();
          const replay = await collectHistoryReplayUpdates({
            sessionId: params.sessionId,
            config,
            records: replayPage.records,
            gaps: sessionData?.historyGaps,
            cumulativeUsage: replayUsage,
            // A resume: the goal restore runs right after this.
            supersedeUnrestorableGoal: true,
            logger: debugLogger,
          });
          replayUpdates = replay.updates;
          copyCumulativeUsage(session.cumulativeUsage, replayUsage);
          if (replay.replayError !== undefined) {
            replayEnvelope = {
              v: LOAD_REPLAY_VERSION,
              updates: replayUpdates,
              partial: true,
              replayError: replay.replayError,
              ...(replayPage.hasMore ? { hasMore: true } : {}),
            };
          }
          replayEnvelope ??= {
            v: LOAD_REPLAY_VERSION,
            updates: replayUpdates,
            ...(replayPage.hasMore ? { hasMore: true } : {}),
          };
        }
        replayEnvelope ??= {
          v: LOAD_REPLAY_VERSION,
          updates: replayUpdates,
        };
        session.installRewriter();
        session.startCronScheduler();
      } catch (err) {
        return this.cleanupAfterRequestFailure(err, async () => {
          try {
            await this.discardStoredSessionIfCurrent(params.sessionId, session);
          } catch (cleanupError) {
            await this.removeStoredSessionEntry(
              params.sessionId,
              session,
              [cleanupError],
              {
                shutdownConfig: false,
              },
            );
            await this.cleanupUnstoredConfig(config);
          }
        });
      }
    }

    await this.#restoreWorktreeOnResume(config, session);
    await this.#restoreBackgroundAgentsOnResume(config, session);
    this.#restoreGoalOnResume(config, session);

    const modesData = this.buildModesData(config);
    const availableModels = this.buildAvailableModels(config);
    const configOptions = this.buildConfigOptions(config);

    const response: LoadSessionResponse = {
      modes: modesData,
      models: availableModels,
      configOptions,
      ...(sessionData?.artifactSnapshot
        ? { artifactSnapshot: sessionData.artifactSnapshot }
        : {}),
    } as LoadSessionResponse;
    if (!replayEnvelope) {
      return response;
    }
    return {
      ...response,
      _meta: {
        [LOAD_REPLAY_META_KEY]: replayEnvelope,
      },
    };
  }

  async unstable_resumeSession(
    params: ResumeSessionRequest,
  ): Promise<ResumeSessionResponse> {
    // Same per-request settings discipline as `loadSession`.
    const settings = loadSettingsCached(params.cwd);
    const liveSession = this.sessions.get(params.sessionId);
    if (liveSession) {
      const liveConfig = liveSession.getConfig();
      await this.assertLiveSessionScope(liveConfig, settings, params.cwd);
      return this.withLiveSessionRestore(
        params.sessionId,
        liveSession,
        async (config, sessionData) =>
          ({
            modes: this.buildModesData(config),
            models: this.buildAvailableModels(config),
            configOptions: this.buildConfigOptions(config),
            ...(sessionData.artifactSnapshot
              ? { artifactSnapshot: sessionData.artifactSnapshot }
              : {}),
          }) as ResumeSessionResponse,
      );
    }
    const exists = await this.runWithPinnedRuntimeBaseDir(
      settings,
      params.cwd,
      async () => {
        const sessionService = new SessionService(params.cwd);
        return sessionService.sessionExists(params.sessionId);
      },
    );
    if (!exists) {
      throw RequestError.resourceNotFound(`session:${params.sessionId}`);
    }
    this.settings = settings;

    const config = await this.newSessionConfig(
      params.cwd,
      params.mcpServers ?? [],
      settings,
      params.sessionId,
      true,
    );
    let session: Session;
    try {
      await this.ensureAuthenticated(config);
      this.setupFileSystem(config);
      session = await this.createAndStoreSession(
        config,
        settings,
        config.getResumedSessionData(),
        { replayHistory: false },
      );
    } catch (error) {
      return this.cleanupAfterRequestFailure(error, async () => {
        if (this.sessions.get(config.getSessionId())?.getConfig() !== config) {
          await this.cleanupUnstoredConfig(config);
        }
      });
    }

    await this.#restoreWorktreeOnResume(config, session);
    await this.#restoreBackgroundAgentsOnResume(config, session);
    this.#restoreGoalOnResume(config, session);

    const modesData = this.buildModesData(config);
    const availableModels = this.buildAvailableModels(config);
    const configOptions = this.buildConfigOptions(config);

    const sessionData = config.getResumedSessionData();
    return {
      modes: modesData,
      models: availableModels,
      configOptions,
      ...(sessionData?.artifactSnapshot
        ? { artifactSnapshot: sessionData.artifactSnapshot }
        : {}),
    } as ResumeSessionResponse;
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

  /**
   * Re-registers the `/goal` Stop hook when a resumed transcript ends on an
   * unsatisfied goal — the daemon counterpart of the TUI's resume restore.
   * Without this the goal loop silently dies whenever a session is reloaded or
   * `qwen serve` restarts, even though the transcript still shows it as active.
   *
   * The `addItem` bridge that `restoreGoalFromHistory` takes in the TUI is not
   * used here — the daemon's terminal card goes out over the wire, not into an
   * Ink history. But restore reaches `unregisterGoalHook` on every path,
   * including the one where there was nothing to restore, and that clears the
   * observer the `Session` constructor installed. So it is put back afterwards,
   * unconditionally: without it a restored goal that later achieves or fails
   * emits no terminal update and persists no terminal card, and the next reload
   * revives a goal that already finished.
   *
   * Best-effort: a failed restore must not block session load.
   */
  #restoreGoalOnResume(config: Config, session: Session): void {
    try {
      const records = config.getResumedSessionData()?.conversation.messages;
      if (!records?.length) return;
      const restored = restoreGoalFromHistory(
        collectGoalStatusItemsFromRecords(records),
        config,
      );
      if (restored.restored) {
        debugLogger.info(
          `ACP goal restored sessionId=${config.getSessionId()} condition=${restored.condition}`,
        );
      } else if (
        restored.blockedBy &&
        restored.blockedBy !== 'condition-invalid'
      ) {
        // The transcript still holds an active goal card. `HistoryReplayer`
        // supersedes it with a `cleared` card so the client does not show a
        // goal that nothing is driving; say why on stderr.
        //
        // `condition-invalid` is excluded: `restoreGoalFromHistory` already
        // wrote a line for it (it is the only caller that knows the condition
        // is malformed). Logging here too would double-report the one case,
        // while the env gates below report once.
        writeStderrLineSafe(
          `qwen: not restoring the active goal for session ${config.getSessionId()} (${restored.blockedBy}).`,
        );
      }
    } catch (error) {
      // Not debugLogger: it no-ops unless a debug session is active, and a
      // failed restore is invisible from the outside — the transcript still
      // shows the goal as active while no hook drives it.
      writeStderrLineSafe(
        `qwen: goal restore failed for session ${config.getSessionId()}: ${error}`,
      );
    } finally {
      session.installGoalTerminalObserver();
    }
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
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Session not found for id: ${params.sessionId}`,
      );
    }
    return session.setMode(params);
  }

  async unstable_setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse | void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Session not found for id: ${params.sessionId}`,
      );
    }
    return await session.setModel(params);
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const { sessionId, configId, value } = params;

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Session not found for id: ${sessionId}`,
      );
    }

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
      default:
        throw RequestError.invalidParams(
          undefined,
          `Unsupported configId: ${configId}`,
        );
    }

    return {
      configOptions: this.buildConfigOptions(session.getConfig()),
    };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    const sanitizedParams = { ...params };
    const meta =
      params._meta && typeof params._meta === 'object'
        ? { ...params._meta }
        : {};
    const suppliedContext = meta[INVOCATION_CONTEXT_META_KEY];
    delete meta[INVOCATION_CONTEXT_META_KEY];
    delete meta[PRIVATE_PARENT_CAPABILITY_META_KEY];
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
    let settleCall = () => {};
    const call: ActivePromptCall = {
      controller: new AbortController(),
      settled: new Promise<void>((resolve) => {
        settleCall = resolve;
      }),
    };
    let calls = this.activePromptCalls.get(params.sessionId);
    if (!calls) {
      calls = new Set();
      this.activePromptCalls.set(params.sessionId, calls);
    }
    calls.add(call);
    try {
      return await session.prompt(
        sanitizedParams,
        invocationContext,
        call.controller.signal,
      );
    } finally {
      calls.delete(call);
      if (calls.size === 0) {
        this.activePromptCalls.delete(params.sessionId);
      }
      settleCall();
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    try {
      await session.cancelPendingPrompt();
    } catch (error) {
      if (!isNotCurrentlyGeneratingCancelError(error)) {
        throw error;
      }
    }
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

  private async buildWorkspaceSkillsStatus(
    config: Config,
  ): Promise<ServeWorkspaceSkillsStatus> {
    const skillManager = config.getSkillManager();
    if (!skillManager) {
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.workspaceCwd(config),
        initialized: true,
        skills: [],
      };
    }

    try {
      const disabled = config.getDisabledSkillNames();
      try {
        await config.getExtensionManager().refreshCache();
      } catch (error) {
        debugLogger.warn('Extension cache refresh failed:', error);
      }
      try {
        await skillManager.refreshCache();
      } catch (error) {
        debugLogger.warn('Skill cache refresh failed:', error);
      }
      const skills = await skillManager.listSkills();
      const inactiveSkillRefs = inactiveExtensionSkillRefs(config);
      const skillsByKey = new Map(
        skills.map((skill) => [
          `${skill.level}:${skill.extensionName ?? ''}:${skill.name}`,
          mapSkillConfigToStatus(skill, disabled, {
            disabled: isInactiveExtensionSkill(skill, inactiveSkillRefs),
          }),
        ]),
      );
      for (const extension of config.getExtensions()) {
        if (extension.isActive) continue;
        for (const skill of extension.skills ?? []) {
          const extensionName = extension.displayName ?? extension.name;
          const key = `extension:${extensionName}:${skill.name}`;
          if (
            skillsByKey.has(`extension:${extension.name}:${skill.name}`) ||
            skillsByKey.has(key)
          ) {
            continue;
          }
          skillsByKey.set(
            key,
            mapSkillConfigToStatus(
              {
                ...skill,
                level: 'extension',
                extensionName,
              },
              disabled,
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
      const models = config.getAllConfiguredModels();
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
        .getAllTools()
        .filter((tool) => !('serverName' in tool))
        .map((tool) => ({
          name: tool.name,
          displayName: tool.displayName,
          description: tool.description,
          enabled: !disabled.has(tool.name),
        }));

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
      await buildAvailableCommandsSnapshot(session.getConfig());
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
    for (const [name, m] of Object.entries(metrics.models)) {
      models[name] = {
        api: { ...m.api },
        tokens: { ...m.tokens },
      };
    }

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

  private async installSkillFromUrl(
    request: QwenSkillInstallRequest,
  ): Promise<Record<string, unknown>> {
    const skillManager = this.config.getSkillManager();
    if (!skillManager) {
      throw RequestError.invalidParams(
        undefined,
        'SkillManager is not available',
      );
    }

    const download = await downloadSkill(request.sourceUrl);
    const skillsBaseDir = path.join(Storage.getGlobalQwenDir(), 'skills');
    const skillDir = resolveManagedSkillDir(skillsBaseDir, request.slug);
    const skillFile = path.join(skillDir, 'SKILL.md');
    const parsed = skillManager.parseSkillContent(
      download.skillContent,
      skillFile,
      'user',
    );
    if (parsed.name !== request.slug) {
      throw RequestError.invalidParams(
        undefined,
        `Skill name "${parsed.name}" does not match requested slug "${request.slug}"`,
      );
    }

    // Install atomically: stage all files in a sibling temp directory, then
    // swap it in with a single rename. A mid-write failure (disk full,
    // permission error) therefore leaves the previously installed skill
    // intact instead of deleting it up front and ending up with a partial
    // install. Removing the old dir before writing also dropped orphaned
    // files from older versions; the rename preserves that property.
    const stagingDir = `${skillDir}.installing-${process.pid}-${Date.now()}`;
    try {
      await fs.rm(stagingDir, { recursive: true, force: true });
      for (const file of download.files) {
        const targetPath = resolveSkillInstallPath(
          stagingDir,
          file.relativePath,
        );
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, file.content);
      }
      // stagingDir is a sibling of skillDir (same filesystem), so the rename
      // is atomic; the only gap is between the rm and rename, during which
      // the fully-staged copy still exists for recovery.
      await fs.rm(skillDir, { recursive: true, force: true });
      await fs.rename(stagingDir, skillDir);
    } catch (error) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    await skillManager.refreshCache();

    return {
      id: request.id,
      slug: parsed.name,
      installed: true,
      installedPath: skillFile,
      sourceUrl: request.sourceUrl,
    };
  }

  private async deleteGlobalSkill(
    request: QwenSkillDeleteRequest,
  ): Promise<Record<string, unknown>> {
    const skillManager = this.config.getSkillManager();
    if (!skillManager) {
      throw RequestError.invalidParams(
        undefined,
        'SkillManager is not available',
      );
    }

    const { skillDir, skillFile, content } = await this.readManagedSkillFile(
      request.slug,
      'global',
      skillManager,
    );
    const parsed = skillManager.parseSkillContent(content, skillFile, 'user');
    if (parsed.name !== request.slug) {
      throw RequestError.invalidParams(
        undefined,
        `Skill name "${parsed.name}" does not match requested slug "${request.slug}"`,
      );
    }

    // Guard the recursive delete: readManagedSkillFile's generic fallback can
    // resolve skillDir from listSkills() to an arbitrary path. Only ever remove
    // the directory that directly contains the SKILL.md we just validated, and
    // never a filesystem root or the global Qwen dir itself, so a malformed
    // skill entry can't trigger a destructive rm of a shared/parent directory.
    const resolvedSkillDir = path.resolve(skillDir);
    const resolvedSkillFile = path.resolve(skillFile);
    const globalDir = path.resolve(Storage.getGlobalQwenDir());
    const isDedicatedSkillDir =
      resolvedSkillFile === path.join(resolvedSkillDir, 'SKILL.md');
    if (
      !isDedicatedSkillDir ||
      resolvedSkillDir === path.parse(resolvedSkillDir).root ||
      resolvedSkillDir === globalDir
    ) {
      throw RequestError.invalidParams(
        undefined,
        `Refusing to delete unexpected skill directory: ${skillDir}`,
      );
    }

    await fs.rm(skillDir, { recursive: true, force: true });
    await skillManager.refreshCache();
    return {
      slug: request.slug,
      deleted: true,
    };
  }

  private async readManagedSkillFile(
    slug: string,
    scope: QwenSkillSetEnabledRequest['scope'],
    skillManager: NonNullable<ReturnType<Config['getSkillManager']>>,
    cwd?: string,
  ): Promise<QwenManagedSkillFile> {
    if (scope === 'global') {
      const qwenSkillDir = resolveManagedSkillDir(
        path.join(Storage.getGlobalQwenDir(), 'skills'),
        slug,
      );
      const qwenSkillFile = path.join(qwenSkillDir, 'SKILL.md');
      const qwenContent = await fs
        .readFile(qwenSkillFile, 'utf8')
        .catch(() => undefined);
      if (qwenContent !== undefined) {
        return {
          skillDir: qwenSkillDir,
          skillFile: qwenSkillFile,
          content: qwenContent,
        };
      }
    }

    if (scope === 'project' && cwd?.trim()) {
      const projectSkill = await this.findProjectSkillFileFromCwd(
        slug,
        cwd,
        skillManager,
      );
      if (projectSkill) return projectSkill;
    }

    const level = scope === 'project' ? 'project' : 'user';
    const skill = (await skillManager.listSkills({ level })).find(
      (candidate) => candidate.name === slug,
    );
    const skillFile = skill?.filePath;
    if (!skillFile) {
      throw RequestError.invalidParams(
        undefined,
        `${scope === 'project' ? 'Project' : 'Global'} skill not found: ${slug}`,
      );
    }

    const content = await fs.readFile(skillFile, 'utf8').catch(() => {
      throw RequestError.invalidParams(
        undefined,
        `${scope === 'project' ? 'Project' : 'Global'} skill not found: ${slug}`,
      );
    });
    return {
      skillDir: path.dirname(skillFile),
      skillFile,
      content,
    };
  }

  private async findProjectSkillFileFromCwd(
    slug: string,
    cwd: string,
    skillManager: NonNullable<ReturnType<Config['getSkillManager']>>,
  ): Promise<QwenManagedSkillFile | undefined> {
    const projectRoot = path.resolve(cwd);
    for (const configDir of PROJECT_SKILL_DIRS) {
      const baseDir = path.join(projectRoot, configDir, SKILLS_DIR);
      const skills = await skillManager.loadSkillsFromDir(baseDir, 'project');
      const skill = skills.find((candidate) => candidate.name === slug);
      const skillFile = skill?.filePath;
      if (!skillFile) continue;

      const content = await fs.readFile(skillFile, 'utf8').catch(() => {
        throw RequestError.invalidParams(
          undefined,
          `Project skill not found: ${slug}`,
        );
      });
      return {
        skillDir: path.dirname(skillFile),
        skillFile,
        content,
      };
    }
    return undefined;
  }

  private async setGlobalSkillEnabled(
    request: QwenSkillSetEnabledRequest,
    cwd?: string,
  ): Promise<Record<string, unknown>> {
    const skillManager = this.config.getSkillManager();
    if (!skillManager) {
      throw RequestError.invalidParams(
        undefined,
        'SkillManager is not available',
      );
    }

    const { skillFile, content } = await this.readManagedSkillFile(
      request.slug,
      request.scope,
      skillManager,
      cwd,
    );
    const level = request.scope === 'project' ? 'project' : 'user';
    const parsed = skillManager.parseSkillContent(content, skillFile, level);
    if (parsed.name !== request.slug) {
      throw RequestError.invalidParams(
        undefined,
        `Skill name "${parsed.name}" does not match requested slug "${request.slug}"`,
      );
    }

    const nextContent = setSkillFrontmatterEnabled(content, request.enabled);
    skillManager.parseSkillContent(nextContent, skillFile, level);
    // Defense-in-depth (consistent with deleteGlobalSkill): readManagedSkillFile's
    // generic fallback can resolve skillFile from listSkills() to an arbitrary
    // path. We only ever write back to the SKILL.md manifest we just read and
    // whose parsed name matched the slug, so refuse to write anything else.
    if (path.basename(skillFile) !== 'SKILL.md') {
      throw RequestError.invalidParams(
        undefined,
        `Refusing to write to unexpected skill file: ${skillFile}`,
      );
    }
    await fs.writeFile(skillFile, nextContent, 'utf8');
    await skillManager.refreshCache();
    return {
      slug: request.slug,
      enabled: request.enabled,
      installedPath: skillFile,
    };
  }

  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.extMethodInternal(method, params);
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
    const SESSION_ID_RE = /^[0-9a-fA-F-]{32,36}$/;

    switch (method) {
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
        return {
          released: session.releaseTodoStopGuardQueuedPromptWait(),
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
        return this.installSkillFromUrl(readSkillInstallRequest(params));
      }
      case 'qwen/skills/delete': {
        return this.deleteGlobalSkill(readSkillSlugRequest(params));
      }
      case 'qwen/skills/setEnabled': {
        return this.setGlobalSkillEnabled(
          readSkillSetEnabledRequest(params),
          requestedCwd,
        );
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
        return {
          rssBytes,
          cpuPercent,
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
          available: this.config.isManagedMemoryAvailable(),
        };
      case SERVE_CONTROL_EXT_METHODS.workspaceMemoryRemember: {
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
              const geminiClient = liveConfig.getGeminiClient?.();
              if (geminiClient?.isInitialized?.()) {
                await geminiClient.setTools?.();
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
        const session = this.sessionOrThrow(sessionId);
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
        await this.closeStoredSession(sessionId, {
          requireFlush: params['requireFlush'] === true,
          ...(typeof rawDrainTimeoutMs === 'number'
            ? { drainTimeoutMs: rawDrainTimeoutMs }
            : {}),
        });
        return { sessionId, closed: true };
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

        const session = this.sessionOrThrow(sessionId);
        const config = session.getConfig();

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
          throw new RequestError(-32002, `Directory not found: ${targetPath}`, {
            errorKind: 'directory_not_found',
            path: targetPath,
          });
        }
        if (!stats.isDirectory()) {
          throw new RequestError(-32002, `Not a directory: ${targetPath}`, {
            errorKind: 'directory_not_found',
            path: targetPath,
          });
        }

        // Canonicalize path
        const canonicalPath = await fs.realpath(targetPath);

        // Server-controlled containment check (worktree create/restore).
        // Must run BEFORE the no-op check: a no-op cd to a directory
        // outside the allowed roots must still be rejected.
        const allowedRoots = params['allowedRoots'];
        if (Array.isArray(allowedRoots) && allowedRoots.length > 0) {
          const contained = allowedRoots.some((root: unknown) => {
            if (typeof root !== 'string') return false;
            const rel = path.relative(root, canonicalPath);
            return !rel.startsWith('..') && !path.isAbsolute(rel);
          });
          if (!contained) {
            throw new RequestError(
              -32004,
              `Path outside allowed roots: ${canonicalPath}`,
              { errorKind: 'containment_violation', path: canonicalPath },
            );
          }
        }

        // Noop check
        const previousCwd = config.getTargetDir();
        if (canonicalPath === previousCwd) {
          return { previousCwd, newCwd: canonicalPath, warnings: [] };
        }

        // Trust check
        if (isFolderTrustEnabled(this.settings.merged)) {
          const trustedFolders = loadTrustedFolders();
          if (trustedFolders.isPathTrusted(canonicalPath) !== true) {
            throw new RequestError(
              -32001,
              `Directory not trusted: ${canonicalPath}`,
              { errorKind: 'directory_not_trusted', path: canonicalPath },
            );
          }
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
        if (relocation.memoryRefreshError) {
          warnings.push(
            `Memory refresh failed: ${
              relocation.memoryRefreshError instanceof Error
                ? relocation.memoryRefreshError.message
                : String(relocation.memoryRefreshError)
            }`,
          );
        }

        // Update model context
        try {
          await config
            .getGeminiClient()
            ?.addWorkingDirectoryChangedContext(previousCwd, canonicalPath);
        } catch (error) {
          warnings.push(
            `Model context refresh failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }

        session.clearTodoStopGuardTrust();

        return { previousCwd, newCwd: canonicalPath, warnings };
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
          session.clearTodoStopGuardTrust();
        }
        return { previous, current };
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
                await cfg.getGeminiClient()?.refreshSystemInstruction();
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
            (config.getGeminiClient().getHistoryShallow() ?? []).length > 0;
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
          config.getGeminiClient().addHistory({
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
        const geminiClient = config.getGeminiClient()!;
        const outputText =
          typeof params['output'] === 'string' ? params['output'] : '';
        geminiClient.addHistory({
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
        const cleared = unregisterGoalHook(config, sessionId);
        if (cleared) {
          session.emitGoalStatus({
            kind: 'cleared',
            condition: cleared.condition,
            iterations: cleared.iterations,
            durationMs: Date.now() - cleared.setAt,
          });
        }
        debugLogger.info(
          `sessionGoalClear sessionId=${sessionId} cleared=${!!cleared} condition=${cleared?.condition ?? '(none)'}`,
        );
        return {
          cleared: !!cleared,
          condition: cleared?.condition,
        };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionGoalGet: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        // Throws when the session is not live. That is the honest answer: the
        // goal store is in-memory, so a goal only exists — and only advances —
        // while its session is resident.
        this.sessionOrThrow(sessionId);
        const active = getActiveGoal(sessionId);
        return {
          // Projected field by field: `ActiveGoal` also carries `hookId` and
          // `tokensAtStart`, which are this process's business.
          active: active
            ? {
                condition: active.condition,
                iterations: active.iterations,
                setAt: active.setAt,
                ...(active.lastReason !== undefined
                  ? { lastReason: active.lastReason }
                  : {}),
              }
            : null,
        };
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
          async () =>
            await config.getGeminiClient()?.refreshSystemInstruction(),
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

        let turnIndex: number | undefined = params['targetTurnIndex'] as
          | number
          | undefined;
        const promptId = params['promptId'] as string | undefined;

        if (promptId && (turnIndex === undefined || turnIndex === null)) {
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

        if (!Number.isInteger(turnIndex) || (turnIndex as number) < 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing targetTurnIndex',
          );
        }

        const rewindFiles = params['rewindFiles'] !== false;
        const historyBeforeRewind = session.captureHistorySnapshot();
        let rewindResult;
        try {
          rewindResult = session.rewindToTurn(turnIndex as number, {
            rewindFiles,
          });
        } catch (err) {
          if (err instanceof RequestError) {
            const msg = err.message;
            if (msg.includes('Cannot rewind while a prompt is running')) {
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
      case SERVE_CONTROL_EXT_METHODS.sessionBranch: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const name = params['name'];

        const sourceSession = this.sessions.get(sessionId);
        if (!sourceSession) {
          throw new RequestError(-32004, `Session not found: ${sessionId}`, {
            errorKind: 'session_not_found',
            sessionId,
          });
        }

        const sourceConfig = sourceSession.getConfig();
        const recording = sourceConfig.getChatRecordingService();
        if (recording) {
          await recording.flush();
        }

        const newSessionId = randomUUID();
        const sessionService = sourceConfig.getSessionService();
        await sessionService.forkSession(sessionId, newSessionId);

        let title: string;
        try {
          let baseName: string;
          if (typeof name === 'string' && name.trim().length > 0) {
            baseName = name.trim();
          } else {
            const existingTitle = recording?.getCurrentCustomTitle();
            const stripped = existingTitle
              ?.replace(/\s*\(Branch(?:\s+\d+)?\)\s*$/, '')
              .trim();
            if (stripped && stripped.length > 0) {
              baseName = stripped;
            } else {
              baseName = sessionId.slice(0, 8);
            }
          }

          title = await computeUniqueBranchTitle(baseName, sessionService);
          const renamed = await sessionService.renameSession(
            newSessionId,
            title,
            'manual',
          );
          if (!renamed) {
            throw new RequestError(
              -32603,
              `Failed to set title on forked session ${newSessionId}`,
              { errorKind: 'internal', sessionId: newSessionId },
            );
          }
        } catch (err) {
          sessionService.removeSession(newSessionId).catch((rmErr) => {
            process.stderr.write(
              `qwen serve: failed to clean up orphan session ${newSessionId}: ${rmErr instanceof Error ? rmErr.message : rmErr}\n`,
            );
          });
          throw err;
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

              const newMode = newMerged.tools?.approvalMode;
              if (
                newMode &&
                APPROVAL_MODES.includes(newMode as ApprovalMode) &&
                newMode !== config.getApprovalMode()
              ) {
                try {
                  config.setApprovalMode(newMode as ApprovalMode);
                  if (newMode === 'plan') {
                    session.clearTodoStopGuardTrust();
                  }
                } catch (err) {
                  debugLogger.warn(
                    `reload: setApprovalMode failed for session ${id}: ${err}`,
                  );
                }
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
              await config.getGeminiClient()?.refreshSystemInstruction();
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
        this.settings.reloadScopeFromDisk(SettingScope.Workspace);
        const sessions = this.getActiveSessions();
        const results = await Promise.allSettled(
          sessions.map((session) => session.refreshSkillsFromSettings()),
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
    sessionId?: string,
    resume?: boolean,
    initializeOptions: ConfigInitializeOptions = {},
    chatRecording?: boolean,
  ): Promise<Config> {
    try {
      return await this.runWithPinnedRuntimeBaseDir(settings, cwd, async () => {
        await this.retryPendingConfigCleanup(
          Storage.getRuntimeBaseDir(),
          sessionId,
        );
        return this.newSessionConfigInRuntimeContext(
          cwd,
          mcpServers,
          settings,
          sessionId,
          resume,
          initializeOptions,
          chatRecording,
        );
      });
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

  private async newSessionConfigInRuntimeContext(
    cwd: string,
    mcpServers: McpServer[],
    settings: LoadedSettings,
    sessionId?: string,
    resume?: boolean,
    initializeOptions: ConfigInitializeOptions = {},
    chatRecording?: boolean,
  ): Promise<Config> {
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
          cwd,
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

    const mergedSettings = settings.merged;

    const sessionArg =
      resume === true
        ? { resume: sessionId, sessionId: undefined }
        : { sessionId, resume: undefined };
    const argvForSession = {
      ...this.argv,
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
    );
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
      const sid = wiredSessionId;
      config.setMcpBudgetEventCallback((event) => {
        // Fire-and-forget. `.catch` suppresses unhandled rejections
        // and logs at debug level for operator visibility.
        void this.connection
          .extNotification('qwen/notify/session/mcp-budget-event', {
            v: 1,
            sessionId: sid,
            ...event,
          })
          .catch((err: unknown) => {
            debugLogger.debug(
              `MCP budget extNotification dropped ` +
                `(session=${sid}, kind=${event.kind}): ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
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
    } catch (error) {
      return this.cleanupAfterRequestFailure(error, () =>
        this.cleanupUnstoredConfig(config),
      );
    }
    // ACP sessions served to WebUI clients are interactive: MCP tools can
    // arrive progressively, but session creation/loading must not wait for a
    // slow or wedged server discovery.
    void this.surfaceMcpFailuresWhenReady(config);
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
      startPostReplayServices?: boolean;
    } = {},
  ): Promise<Session> {
    const sessionId = config.getSessionId();
    const geminiClient = config.getGeminiClient();
    const needsInitialize = !geminiClient.isInitialized();

    if (needsInitialize) {
      await geminiClient.initialize();
    }

    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} is already active.`);
    }

    const session = new Session(sessionId, config, this.connection, settings);
    this.sessions.set(sessionId, session);
    try {
      if (sessionData?.fileHistorySnapshots?.length) {
        config
          .getFileHistoryService()
          .restoreFromSnapshots(sessionData.fileHistorySnapshots);
      }

      if (sessionData?.conversation.messages) {
        config
          .getChatRecordingService()
          ?.rebuildTurnBoundaries(sessionData.conversation.messages);
      }

      if (
        options.replayHistory !== false &&
        sessionData?.conversation.messages
      ) {
        await session.replayHistory(
          sessionData.conversation.messages,
          sessionData.historyGaps,
        );
      }

      if (options.startPostReplayServices !== false) {
        // Install rewriter AFTER history replay to avoid rewriting historical messages
        session.installRewriter();

        // After replay so a durable cron fire can't interleave with it.
        session.startCronScheduler();
      }

      setTimeout(() => {
        void session.sendAvailableCommandsUpdate();
      }, 0);
      return session;
    } catch (error) {
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

    return [modeConfigOption, modelConfigOption];
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
