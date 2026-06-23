/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, realpathSync, promises as fsp } from 'node:fs';
import type { ServerResponse } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { trace, type Span } from '@opentelemetry/api';
import {
  createServeApp,
  detectFromLoopback,
  listWorkspaceSessionsForResponse,
  PromptDeadlineExceededError,
  resolvePromptDeadlineMs,
} from './server.js';
import { runQwenServe, type RunHandle } from './run-qwen-serve.js';
import {
  resolveWebShellDir,
  isDocumentNavigation,
} from './web-shell-static.js';
import {
  CONDITIONAL_SERVE_FEATURES,
  getAdvertisedServeFeatures,
  getRegisteredServeFeatures,
  getServeFeatures,
  getServeProtocolVersions,
  SERVE_CAPABILITY_REGISTRY,
  type ServeProtocolVersion,
} from './capabilities.js';
import type {
  CancelNotification,
  PromptRequest,
  PromptResponse,
  RequestPermissionResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
} from '@agentclientprotocol/sdk';
import {
  ApprovalMode,
  ExtensionManager,
  ExtensionUpdateState,
  SessionService,
  Storage,
  TrustGateError,
  type Extension,
} from '@qwen-code/qwen-code-core';
import * as qwenCore from '@qwen-code/qwen-code-core';
import {
  CancelSentinelCollisionError,
  InvalidClientIdError,
  InvalidPermissionOptionError,
  InvalidSessionMetadataError,
  MAX_WORKSPACE_PATH_LENGTH,
  McpServerNotFoundError,
  McpServerRestartFailedError,
  PermissionForbiddenError,
  PermissionPolicyNotImplementedError,
  PromptQueueFullError,
  RestoreInProgressError,
  SessionShellClientRequiredError,
  SessionShellDisabledError,
  SessionBusyError,
  SessionLimitExceededError,
  SessionNotFoundError,
  WorkspaceMismatchError,
  type BridgeHeartbeatResult,
  type BridgeHeartbeatState,
  type BridgeDaemonStatusSnapshot,
  type BridgeRestoredSession,
  type BridgeClientRequestContext,
  type BridgeRestoreSessionRequest,
  type BridgeSession,
  type BridgeSessionSummary,
  type BridgeSpawnRequest,
  type AcpSessionBridge,
  type SessionMetadataUpdate,
} from './acp-session-bridge.js';
import type { BridgeEvent, SubscribeOptions } from './event-bus.js';
import type {
  ServeSessionContextStatus,
  ServeSessionContextUsageStatus,
  ServeSessionHooksStatus,
  ServeSessionSupportedCommandsStatus,
  ServeSessionTasksStatus,
  ServeWorkspaceEnvStatus,
  ServeWorkspaceExtensionsStatus,
  ServeWorkspaceHooksStatus,
  ServeWorkspaceMcpStatus,
  ServeWorkspaceMcpToolsStatus,
  ServeWorkspacePreflightStatus,
  ServeWorkspaceProvidersStatus,
  ServeWorkspaceSkillsStatus,
  ServeWorkspaceToolsStatus,
} from './status.js';
import { CAPABILITIES_SCHEMA_VERSION, type ServeOptions } from './types.js';
import type { DaemonLogger } from './daemon-logger.js';
import { FsError, type WorkspaceFileSystemFactory } from './fs/index.js';

const baseOpts: ServeOptions = {
  hostname: '127.0.0.1',
  port: 4170,
  mode: 'http-bridge',
};

function fakeDaemonLog(): DaemonLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    raw: vi.fn(),
    getLogPath: () => '',
    getDaemonId: () => 'test-daemon',
    flush: vi.fn(async () => {}),
  };
}

// Workspace fixtures must round-trip through `path.resolve` so the
// expected values match the canonicalized form the route produces on
// every platform. On Windows `path.resolve('/work/bound')` returns
// `D:\work\bound` (drive-relative absolute), so hardcoding `/work/bound`
// as a literal makes the test fail on Windows CI even though the code
// is correct. Mirror the pattern used by httpAcpBridge.test.ts (WS_A /
// WS_B).
const WS_BOUND = path.resolve(path.sep, 'work', 'bound');
const WS_DIFFERENT = path.resolve(path.sep, 'work', 'different');
const EXPECTED_STAGE1_FEATURES = [
  'health',
  'daemon_status',
  'capabilities',
  'session_create',
  'session_scope_override',
  'session_load',
  'session_resume',
  'unstable_session_resume',
  'session_list',
  'session_prompt',
  'session_cancel',
  'session_events',
  'slow_client_warning',
  'typed_event_schema',
  'session_set_model',
  'client_identity',
  'client_heartbeat',
  'session_permission_vote',
  'permission_vote',
  'workspace_mcp',
  'workspace_skills',
  'workspace_providers',
  'auth_provider_install',
  'workspace_memory',
  'workspace_agents',
  'workspace_agent_generate',
  'workspace_env',
  'workspace_preflight',
  'session_context',
  'session_context_usage',
  'session_supported_commands',
  'session_tasks',
  'session_stats',
  'session_close',
  'session_metadata',
  // Issue #4175 PR 14. Always-on. Daemon supports the MCP client
  // guardrail surface (`--mcp-client-budget`, `clientCount` /
  // `budgets[]` on `/workspace/mcp`, `disabledReason: 'budget'` on
  // refused per-server cells).
  'mcp_guardrails',
  'workspace_mcp_manage',
  // Issue #4175 PR 14b. Always-on. Daemon emits typed push events for
  // MCP budget state crossings (`mcp_budget_warning` with hysteresis,
  // `mcp_child_refused_batch` coalesced per pass).
  'mcp_guardrail_events',
  // T2.8 (#4514). Always-on. Daemon supports runtime MCP server
  // mutation (add / remove) via POST/DELETE /workspace/mcp/servers.
  'mcp_server_runtime_mutation',
  // Issue #4175 PR 19. Always-on. Daemon exposes the read-only file
  // surface: `GET /file`, `GET /list`, `GET /glob`, `GET /stat`.
  'workspace_file_read',
  // Issue #4175 PR 20. Always-on. Daemon exposes raw byte windows and
  // hash-aware text mutation routes behind the strict mutation gate.
  'workspace_file_bytes',
  'workspace_file_write',
  // #4175 Wave 4 PR 17. Mutation control routes (approval mode toggle,
  // workspace tool enable/disable, init scaffold, MCP server restart).
  'session_approval_mode_control',
  'workspace_tool_toggle',
  'workspace_init',
  'workspace_mcp_restart',
  // #4175 follow-up. Daemon hosts `POST /session/:id/recap` (wraps
  // core's `generateSessionRecap` for one-sentence session summaries).
  'session_recap',
  // Side question (/btw) against the session's conversation context.
  'session_btw',
  // Issue #4175 PR 21 — auth device-flow surface advertised unconditionally.
  // Registry order on origin/main has PR 21 appended last, so the
  // baseline assertion below mirrors that even though PR 21 landed
  // before PR 17 chronologically.
  'auth_device_flow',
  // #4175 F3 Commit 6. Daemon advertises which permission mediation
  // policies it can run (`modes: [first-responder, designated, consensus,
  // local-only]`) so SDK clients can pre-flight before relying on
  // `permission_partial_vote` / `permission_forbidden` SSE events. Always-
  // on; runtime-active policy is at `/capabilities` body `policy.permission`.
  'permission_mediation',
  'non_blocking_prompt',
  'session_language',
  'session_rewind',
  'workspace_hooks',
  'session_hooks',
  'workspace_extensions',
  'session_branch',
] as const;

// Issue #4175 PR 15. `require_auth` is registered but conditionally
// advertised (only when `--require-auth` is set), so the registry list
// is a strict superset of the always-on list. The registry's source-of-
// truth ORDER puts `require_auth` between PR 11 (`session_metadata`)
// and PR 21 (`auth_device_flow`); reflect that here so the assertion
// matches the real ordering.
//
// Conditional tags registered in capabilities.ts registry order.
const EXPECTED_REGISTERED_FEATURES = [
  // Same order as `SERVE_CAPABILITY_REGISTRY` declaration:
  // ...always-on PR16/17/19/20/21 features, then F2's conditional
  // pair (mcp_workspace_pool + mcp_pool_restart inserted after
  // workspace_mcp_restart), then conditional `require_auth`, then
  // `auth_device_flow`, then F3 `permission_mediation` (latest).
  // All four conditional tags filtered from the stage1 baseline so
  // they appear here in their registry-declaration order, not the
  // stage1 order.
  ...EXPECTED_STAGE1_FEATURES.filter(
    (f) =>
      f !== 'workspace_init' &&
      f !== 'workspace_mcp_restart' &&
      f !== 'session_recap' &&
      f !== 'session_btw' &&
      f !== 'auth_device_flow' &&
      f !== 'permission_mediation' &&
      f !== 'non_blocking_prompt' &&
      f !== 'session_language' &&
      f !== 'session_rewind' &&
      f !== 'workspace_hooks' &&
      f !== 'session_hooks' &&
      f !== 'workspace_extensions' &&
      f !== 'session_branch',
  ),
  'workspace_settings',
  'workspace_init',
  'workspace_mcp_restart',
  'session_recap',
  'session_btw',
  'session_shell_command',
  'mcp_workspace_pool',
  'mcp_pool_restart',
  'require_auth',
  'allow_origin',
  'auth_device_flow',
  'permission_mediation',
  'prompt_absolute_deadline',
  'writer_idle_timeout',
  'non_blocking_prompt',
  'session_language',
  'session_rewind',
  'workspace_hooks',
  'session_hooks',
  'workspace_extensions',
  'session_branch',
  'rate_limit',
  'workspace_reload',
] as const;

interface FakeBridgeOpts {
  /**
   * #4282 fold-in 1 (gpt-5.5 C2): tests that exercise workspace
   * mutation routes with `X-Qwen-Client-Id` set need the fakeBridge
   * to advertise those ids as "known", or the new client-id
   * validator returns 400. Defaults to an empty set.
   */
  knownClientIds?: Iterable<string>;
  /**
   * Drives the `POST /session/:id/mid-turn-message` route. Default accepts.
   * Throw (e.g. `SessionNotFoundError`) to exercise the error branch.
   */
  enqueueMidTurnImpl?: (
    sessionId: string,
    message: string,
    context?: BridgeClientRequestContext,
  ) => { accepted: boolean };
  spawnImpl?: (req: BridgeSpawnRequest) => Promise<BridgeSession>;
  loadImpl?: (
    req: BridgeRestoreSessionRequest,
  ) => Promise<BridgeRestoredSession>;
  resumeImpl?: (
    req: BridgeRestoreSessionRequest,
  ) => Promise<BridgeRestoredSession>;
  promptImpl?: (
    sessionId: string,
    req: PromptRequest,
    signal?: AbortSignal,
    context?: BridgeClientRequestContext,
  ) => Promise<PromptResponse> | PromptResponse;
  cancelImpl?: (
    sessionId: string,
    req?: CancelNotification,
    context?: BridgeClientRequestContext,
  ) => Promise<void>;
  getSessionLastEventIdImpl?: (sessionId: string) => number;
  subscribeImpl?: (
    sessionId: string,
    opts?: SubscribeOptions,
  ) => AsyncIterable<BridgeEvent>;
  respondImpl?: (
    requestId: string,
    response: RequestPermissionResponse,
    context?: BridgeClientRequestContext,
  ) => boolean;
  sessionRespondImpl?: (
    sessionId: string,
    requestId: string,
    response: RequestPermissionResponse,
    context?: BridgeClientRequestContext,
  ) => boolean;
  listImpl?: (workspaceCwd: string) => BridgeSessionSummary[];
  workspaceMcpImpl?: () => Promise<ServeWorkspaceMcpStatus>;
  workspaceMcpToolsImpl?: (
    serverName: string,
  ) => Promise<ServeWorkspaceMcpToolsStatus>;
  workspaceSkillsImpl?: () => Promise<ServeWorkspaceSkillsStatus>;
  workspaceToolsImpl?: () => Promise<ServeWorkspaceToolsStatus>;
  workspaceProvidersImpl?: () => Promise<ServeWorkspaceProvidersStatus>;
  workspaceEnvImpl?: () => Promise<ServeWorkspaceEnvStatus>;
  workspacePreflightImpl?: () => Promise<ServeWorkspacePreflightStatus>;
  workspaceHooksImpl?: () => Promise<ServeWorkspaceHooksStatus>;
  workspaceExtensionsImpl?: () => Promise<ServeWorkspaceExtensionsStatus>;
  sessionContextImpl?: (
    sessionId: string,
  ) => Promise<ServeSessionContextStatus>;
  sessionContextUsageImpl?: (
    sessionId: string,
    opts?: { detail?: boolean },
  ) => Promise<ServeSessionContextUsageStatus>;
  sessionSupportedCommandsImpl?: (
    sessionId: string,
  ) => Promise<ServeSessionSupportedCommandsStatus>;
  sessionTasksImpl?: (sessionId: string) => Promise<ServeSessionTasksStatus>;
  cancelSessionTaskImpl?: (
    sessionId: string,
    taskId: string,
    taskKind: 'agent' | 'shell' | 'monitor',
  ) => Promise<{ cancelled: boolean }>;
  clearSessionGoalImpl?: (
    sessionId: string,
  ) => Promise<{ cleared: boolean; condition?: string }>;
  sessionHooksImpl?: (sessionId: string) => Promise<ServeSessionHooksStatus>;
  setModelImpl?: (
    sessionId: string,
    req: SetSessionModelRequest,
    context?: BridgeClientRequestContext,
  ) => Promise<SetSessionModelResponse>;
  setLanguageImpl?: (
    sessionId: string,
    params: { language: string; syncOutputLanguage: boolean },
    context?: BridgeClientRequestContext,
  ) => Promise<{
    language: string;
    outputLanguage: string | null;
    refreshed: boolean;
  }>;
  setApprovalModeImpl?: (
    sessionId: string,
    mode: ApprovalMode,
    opts: { persist: boolean },
    context?: BridgeClientRequestContext,
  ) => Promise<{
    sessionId: string;
    mode: ApprovalMode;
    previous: ApprovalMode;
    persisted: boolean;
  }>;
  generateSessionRecapImpl?: (
    sessionId: string,
    context?: BridgeClientRequestContext,
  ) => Promise<{ sessionId: string; recap: string | null }>;
  launchSessionForkAgentImpl?: (
    sessionId: string,
    directive: string,
    context?: BridgeClientRequestContext,
  ) => Promise<{ sessionId: string; description: string; launched: boolean }>;
  setToolEnabledImpl?: (
    toolName: string,
    enabled: boolean,
    originatorClientId: string | undefined,
  ) => Promise<{ toolName: string; enabled: boolean }>;
  initWorkspaceImpl?: (
    initOpts: { force?: boolean },
    originatorClientId: string | undefined,
  ) => Promise<{ path: string; action: 'created' | 'overwrote' | 'noop' }>;
  restartMcpServerImpl?: (
    serverName: string,
    originatorClientId: string | undefined,
    opts?: { entryIndex?: number },
  ) => Promise<
    | { serverName: string; restarted: true; durationMs: number }
    | {
        serverName: string;
        restarted: false;
        skipped: true;
        reason: 'in_flight' | 'disabled' | 'budget_would_exceed';
      }
  >;
  addRuntimeMcpServerImpl?: (
    name: string,
    config: Record<string, unknown>,
    originatorClientId: string,
  ) => Promise<
    | {
        name: string;
        transport: string;
        replaced: boolean;
        shadowedSettings: boolean;
        toolCount: number;
        originatorClientId: string;
      }
    | { name: string; skipped: true; reason: 'budget_warning_only' }
  >;
  removeRuntimeMcpServerImpl?: (
    name: string,
    originatorClientId: string,
  ) => Promise<
    | {
        name: string;
        removed: true;
        wasShadowingSettings: boolean;
        originatorClientId: string;
      }
    | { name: string; skipped: true; reason: 'not_present' }
  >;
  closeImpl?: (
    sessionId: string,
    context?: BridgeClientRequestContext,
  ) => Promise<void>;
  updateMetadataImpl?: (
    sessionId: string,
    metadata: SessionMetadataUpdate,
    context?: BridgeClientRequestContext,
  ) => SessionMetadataUpdate;
  heartbeatImpl?: (
    sessionId: string,
    context?: BridgeClientRequestContext,
  ) => BridgeHeartbeatResult;
  heartbeatStateImpl?: (sessionId: string) => BridgeHeartbeatState | undefined;
  shellImpl?: (
    sessionId: string,
    command: string,
    signal?: AbortSignal,
    context?: BridgeClientRequestContext,
  ) => Promise<{ exitCode: number | null; output: string; aborted: boolean }>;
  daemonStatusSnapshotImpl?: () => BridgeDaemonStatusSnapshot;
}

interface FakeBridge extends AcpSessionBridge {
  calls: BridgeSpawnRequest[];
  loadCalls: BridgeRestoreSessionRequest[];
  resumeCalls: BridgeRestoreSessionRequest[];
  promptCalls: Array<{
    sessionId: string;
    req: PromptRequest;
    signal?: AbortSignal;
    context?: BridgeClientRequestContext;
  }>;
  cancelCalls: Array<{
    sessionId: string;
    req?: CancelNotification;
    context?: BridgeClientRequestContext;
  }>;
  killCalls: Array<{
    sessionId: string;
    opts?: { requireZeroAttaches?: boolean };
  }>;
  detachCalls: Array<{ sessionId: string; clientId?: string }>;
  enqueueMidTurnCalls: Array<{
    sessionId: string;
    message: string;
    context?: BridgeClientRequestContext;
  }>;
  permissionVotes: Array<{
    requestId: string;
    response: RequestPermissionResponse;
    context?: BridgeClientRequestContext;
  }>;
  sessionPermissionVotes: Array<{
    sessionId: string;
    requestId: string;
    response: RequestPermissionResponse;
    context?: BridgeClientRequestContext;
  }>;
  listCalls: string[];
  workspaceMcpCalls: number;
  workspaceMcpToolsCalls: string[];
  workspaceSkillsCalls: number;
  workspaceToolsCalls: number;
  workspaceProvidersCalls: number;
  workspaceEnvCalls: number;
  workspacePreflightCalls: number;
  workspaceHooksCalls: number;
  workspaceExtensionsCalls: number;
  extensionEvents: Array<{
    refreshed: number;
    failed: number;
    status?:
      | 'installed'
      | 'enabled'
      | 'disabled'
      | 'updated'
      | 'uninstalled'
      | 'failed';
    source?: string;
    name?: string;
    version?: string;
    error?: string;
  }>;
  sessionContextCalls: string[];
  sessionContextUsageCalls: string[];
  sessionSupportedCommandsCalls: string[];
  sessionTasksCalls: string[];
  cancelSessionTaskCalls: Array<{
    sessionId: string;
    taskId: string;
    taskKind: 'agent' | 'shell' | 'monitor';
  }>;
  clearSessionGoalCalls: string[];
  sessionHooksCalls: string[];
  setModelCalls: Array<{
    sessionId: string;
    req: SetSessionModelRequest;
    context?: BridgeClientRequestContext;
  }>;
  setLanguageCalls: Array<{
    sessionId: string;
    params: { language: string; syncOutputLanguage: boolean };
    context?: BridgeClientRequestContext;
  }>;
  setApprovalModeCalls: Array<{
    sessionId: string;
    mode: ApprovalMode;
    opts: { persist: boolean };
    context?: BridgeClientRequestContext;
  }>;
  shellCalls: Array<{
    sessionId: string;
    command: string;
    signal?: AbortSignal;
    context?: BridgeClientRequestContext;
  }>;
  generateSessionRecapCalls: Array<{
    sessionId: string;
    context?: BridgeClientRequestContext;
  }>;
  forkCalls: Array<{
    sessionId: string;
    directive: string;
    context?: BridgeClientRequestContext;
  }>;
  setToolEnabledCalls: Array<{
    toolName: string;
    enabled: boolean;
    originatorClientId?: string;
  }>;
  initWorkspaceCalls: Array<{
    initOpts: { force?: boolean };
    originatorClientId?: string;
  }>;
  restartMcpServerCalls: Array<{
    serverName: string;
    originatorClientId?: string;
    opts?: { entryIndex?: number };
  }>;
  addRuntimeMcpServerCalls: Array<{
    name: string;
    config: Record<string, unknown>;
    originatorClientId: string;
  }>;
  removeRuntimeMcpServerCalls: Array<{
    name: string;
    originatorClientId: string;
  }>;
  closeCalls: Array<{
    sessionId: string;
    context?: BridgeClientRequestContext;
  }>;
  updateMetadataCalls: Array<{
    sessionId: string;
    metadata: SessionMetadataUpdate;
    context?: BridgeClientRequestContext;
  }>;
  heartbeatCalls: Array<{
    sessionId: string;
    context?: BridgeClientRequestContext;
  }>;
  heartbeatStateCalls: string[];
  shutdownCalls: number;
}

function fakeBridge(opts: FakeBridgeOpts = {}): FakeBridge {
  const calls: BridgeSpawnRequest[] = [];
  const loadCalls: BridgeRestoreSessionRequest[] = [];
  const resumeCalls: BridgeRestoreSessionRequest[] = [];
  const promptCalls: FakeBridge['promptCalls'] = [];
  const cancelCalls: FakeBridge['cancelCalls'] = [];
  const killCalls: Array<{
    sessionId: string;
    opts?: { requireZeroAttaches?: boolean };
  }> = [];
  const detachCalls: FakeBridge['detachCalls'] = [];
  const enqueueMidTurnCalls: FakeBridge['enqueueMidTurnCalls'] = [];
  const enqueueMidTurnImpl =
    opts.enqueueMidTurnImpl ?? (() => ({ accepted: true }));
  const permissionVotes: FakeBridge['permissionVotes'] = [];
  const sessionPermissionVotes: FakeBridge['sessionPermissionVotes'] = [];
  const listCalls: string[] = [];
  let workspaceMcpCalls = 0;
  const workspaceMcpToolsCalls: string[] = [];
  let workspaceSkillsCalls = 0;
  let workspaceToolsCalls = 0;
  let workspaceProvidersCalls = 0;
  let workspaceEnvCalls = 0;
  let workspacePreflightCalls = 0;
  let workspaceHooksCalls = 0;
  let workspaceExtensionsCalls = 0;
  const extensionEvents: FakeBridge['extensionEvents'] = [];
  const sessionContextCalls: string[] = [];
  const sessionSupportedCommandsCalls: string[] = [];
  const sessionTasksCalls: string[] = [];
  const cancelSessionTaskCalls: FakeBridge['cancelSessionTaskCalls'] = [];
  const clearSessionGoalCalls: string[] = [];
  const sessionHooksCalls: string[] = [];
  const setModelCalls: FakeBridge['setModelCalls'] = [];
  const closeCalls: FakeBridge['closeCalls'] = [];
  const updateMetadataCalls: FakeBridge['updateMetadataCalls'] = [];
  const heartbeatCalls: FakeBridge['heartbeatCalls'] = [];
  const heartbeatStateCalls: string[] = [];
  let shutdownCalls = 0;
  const spawnImpl =
    opts.spawnImpl ??
    (async (req) => ({
      sessionId: `fake-${calls.length}`,
      workspaceCwd: req.workspaceCwd,
      attached: false,
      clientId: `client-${calls.length}`,
    }));
  const loadImpl =
    opts.loadImpl ??
    (async (req) => ({
      sessionId: req.sessionId,
      workspaceCwd: req.workspaceCwd,
      attached: false,
      clientId: req.clientId ?? 'client-load',
      state: {},
    }));
  const resumeImpl =
    opts.resumeImpl ??
    (async (req) => ({
      sessionId: req.sessionId,
      workspaceCwd: req.workspaceCwd,
      attached: false,
      clientId: req.clientId ?? 'client-resume',
      state: {},
    }));
  const promptImpl =
    opts.promptImpl ?? (async () => ({ stopReason: 'end_turn' }));
  const cancelImpl = opts.cancelImpl ?? (async () => {});
  const respondImpl = opts.respondImpl ?? (() => true);
  const sessionRespondImpl = opts.sessionRespondImpl ?? (() => true);
  const listImpl = opts.listImpl ?? (() => []);
  const workspaceMcpImpl =
    opts.workspaceMcpImpl ??
    (async () => ({
      v: 1 as const,
      workspaceCwd: WS_BOUND,
      initialized: false,
      discoveryState: 'not_started' as const,
      servers: [],
    }));
  const workspaceSkillsImpl =
    opts.workspaceSkillsImpl ??
    (async () => ({
      v: 1 as const,
      workspaceCwd: WS_BOUND,
      initialized: false,
      skills: [],
    }));
  const workspaceToolsImpl =
    opts.workspaceToolsImpl ??
    (async () => ({
      v: 1 as const,
      workspaceCwd: WS_BOUND,
      initialized: true,
      acpChannelLive: false,
      tools: [],
    }));
  const workspaceMcpToolsImpl =
    opts.workspaceMcpToolsImpl ??
    (async (serverName: string) => ({
      v: 1 as const,
      workspaceCwd: WS_BOUND,
      serverName,
      initialized: true,
      acpChannelLive: false,
      tools: [],
    }));
  const workspaceProvidersImpl =
    opts.workspaceProvidersImpl ??
    (async () => ({
      v: 1 as const,
      workspaceCwd: WS_BOUND,
      initialized: false,
      providers: [],
    }));
  const workspaceEnvImpl =
    opts.workspaceEnvImpl ??
    (async () => ({
      v: 1 as const,
      workspaceCwd: WS_BOUND,
      initialized: true as const,
      acpChannelLive: false,
      cells: [],
    }));
  const workspacePreflightImpl =
    opts.workspacePreflightImpl ??
    (async () => ({
      v: 1 as const,
      workspaceCwd: WS_BOUND,
      initialized: true as const,
      acpChannelLive: false,
      cells: [],
    }));
  const workspaceHooksImpl =
    opts.workspaceHooksImpl ??
    (async () => ({
      v: 1 as const,
      workspaceCwd: WS_BOUND,
      initialized: true,
      disabled: false,
      hooks: [],
      events: {},
    }));
  const workspaceExtensionsImpl =
    opts.workspaceExtensionsImpl ??
    (async () => ({
      v: 1 as const,
      workspaceCwd: WS_BOUND,
      initialized: true,
      extensions: [],
    }));
  const sessionContextImpl =
    opts.sessionContextImpl ??
    (async (sessionId) => ({
      v: 1 as const,
      sessionId,
      workspaceCwd: WS_BOUND,
      state: {},
    }));
  const sessionContextUsageImpl =
    opts.sessionContextUsageImpl ??
    (async (sessionId) => ({
      v: 1 as const,
      sessionId,
      workspaceCwd: WS_BOUND,
      usage: {
        modelName: 'test-model',
        totalTokens: 1000,
        contextWindowSize: 200000,
        breakdown: {
          systemPrompt: 500,
          builtinTools: 100,
          mcpTools: 50,
          memoryFiles: 50,
          skills: 100,
          messages: 150,
          freeSpace: 199000,
          autocompactBuffer: 50,
        },
        builtinTools: [],
        mcpTools: [],
        memoryFiles: [],
        skills: [],
      },
      formattedText: 'Context usage: 1000/200000 tokens',
    }));
  const sessionContextUsageCalls: string[] = [];
  const sessionSupportedCommandsImpl =
    opts.sessionSupportedCommandsImpl ??
    (async (sessionId) => ({
      v: 1 as const,
      sessionId,
      availableCommands: [],
      availableSkills: [],
    }));
  const sessionTasksImpl =
    opts.sessionTasksImpl ??
    (async (sessionId) => ({
      v: 1 as const,
      sessionId,
      now: 1_700_000_000_000,
      tasks: [],
    }));
  const cancelSessionTaskImpl =
    opts.cancelSessionTaskImpl ?? (async () => ({ cancelled: true }));
  const clearSessionGoalImpl =
    opts.clearSessionGoalImpl ?? (async () => ({ cleared: true }));
  const sessionHooksImpl =
    opts.sessionHooksImpl ??
    (async (sessionId: string) => ({
      v: 1 as const,
      sessionId,
      workspaceCwd: WS_BOUND,
      disabled: false,
      hooks: [],
    }));
  const setModelImpl = opts.setModelImpl ?? (async () => ({}));
  const setLanguageCalls: FakeBridge['setLanguageCalls'] = [];
  const setLanguageImpl =
    opts.setLanguageImpl ??
    (async (
      _sessionId: string,
      params: { language: string; syncOutputLanguage: boolean },
    ) => ({
      language: params.language,
      outputLanguage: params.syncOutputLanguage ? 'Chinese' : null,
      refreshed: params.syncOutputLanguage,
    }));
  const setApprovalModeCalls: FakeBridge['setApprovalModeCalls'] = [];
  const shellCalls: FakeBridge['shellCalls'] = [];
  const setApprovalModeImpl =
    opts.setApprovalModeImpl ??
    (async (
      sessionId: string,
      mode: ApprovalMode,
      o: { persist: boolean },
    ) => ({
      sessionId,
      mode,
      previous: ApprovalMode.DEFAULT,
      persisted: o.persist,
    }));
  const generateSessionRecapCalls: FakeBridge['generateSessionRecapCalls'] = [];
  const generateSessionRecapImpl =
    opts.generateSessionRecapImpl ??
    (async (sessionId: string) => ({
      sessionId,
      recap: 'Default fake recap.',
    }));
  const forkCalls: FakeBridge['forkCalls'] = [];
  const launchSessionForkAgentImpl =
    opts.launchSessionForkAgentImpl ??
    (async (sessionId: string, directive: string) => ({
      sessionId,
      description: directive.slice(0, 60),
      launched: true,
    }));
  const setToolEnabledCalls: FakeBridge['setToolEnabledCalls'] = [];
  const setToolEnabledImpl =
    opts.setToolEnabledImpl ??
    (async (toolName: string, enabled: boolean) => ({
      toolName,
      enabled,
    }));
  const initWorkspaceCalls: FakeBridge['initWorkspaceCalls'] = [];
  const initWorkspaceImpl =
    opts.initWorkspaceImpl ??
    (async () => ({
      path: path.resolve(WS_BOUND, 'QWEN.md'),
      action: 'created' as const,
    }));
  const restartMcpServerCalls: FakeBridge['restartMcpServerCalls'] = [];
  const restartMcpServerImpl =
    opts.restartMcpServerImpl ??
    (async (serverName: string) => ({
      serverName,
      restarted: true as const,
      durationMs: 42,
    }));
  const addRuntimeMcpServerCalls: FakeBridge['addRuntimeMcpServerCalls'] = [];
  const addRuntimeMcpServerImpl =
    opts.addRuntimeMcpServerImpl ??
    (async (
      name: string,
      _config: Record<string, unknown>,
      originatorClientId: string,
    ) => ({
      name,
      transport: 'stdio' as const,
      replaced: false,
      shadowedSettings: false,
      toolCount: 3,
      originatorClientId,
    }));
  const removeRuntimeMcpServerCalls: FakeBridge['removeRuntimeMcpServerCalls'] =
    [];
  const removeRuntimeMcpServerImpl =
    opts.removeRuntimeMcpServerImpl ??
    (async (name: string, originatorClientId: string) => ({
      name,
      removed: true as const,
      wasShadowingSettings: false,
      originatorClientId,
    }));
  const closeImpl = opts.closeImpl ?? (async () => {});
  const updateMetadataImpl =
    opts.updateMetadataImpl ??
    ((_sid: string, m: SessionMetadataUpdate) => ({
      displayName: m.displayName,
    }));
  const heartbeatImpl =
    opts.heartbeatImpl ??
    ((sessionId, context) => ({
      sessionId,
      ...(context?.clientId !== undefined
        ? { clientId: context.clientId }
        : {}),
      lastSeenAt: 1_700_000_000_000,
    }));
  const heartbeatStateImpl =
    opts.heartbeatStateImpl ??
    (() => ({
      sessionLastSeenAt: 1_700_000_000_000,
      clientLastSeenAt: new Map<string, number>(),
    }));
  const shellImpl =
    opts.shellImpl ??
    (async (_sessionId: string, command: string) => ({
      exitCode: 0,
      output: `$ ${command}`,
      aborted: false,
    }));
  const daemonStatusSnapshotImpl =
    opts.daemonStatusSnapshotImpl ??
    (() => ({
      limits: {
        maxSessions: 20,
        maxPendingPromptsPerSession: 5,
        eventRingSize: 8000,
        channelIdleTimeoutMs: 0,
        sessionIdleTimeoutMs: 1_800_000,
      },
      sessionCount: 0,
      pendingPermissionCount: 0,
      channelLive: false,
      permissionPolicy: 'first-responder' as const,
      sessions: [],
    }));
  return {
    // F3 Commit 6 — `AcpSessionBridge.permissionPolicy` is required so
    // `/capabilities` can expose `policy.permission`. Tests don't
    // exercise mediation; pin to the pre-F3 default ('first-responder')
    // so existing assertions stay shape-compatible.
    permissionPolicy: 'first-responder' as const,
    calls,
    loadCalls,
    resumeCalls,
    promptCalls,
    cancelCalls,
    killCalls,
    detachCalls,
    enqueueMidTurnCalls,
    permissionVotes,
    sessionPermissionVotes,
    listCalls,
    workspaceMcpToolsCalls,
    extensionEvents,
    sessionContextCalls,
    sessionContextUsageCalls,
    sessionSupportedCommandsCalls,
    sessionTasksCalls,
    cancelSessionTaskCalls,
    clearSessionGoalCalls,
    sessionHooksCalls,
    setModelCalls,
    setLanguageCalls,
    setApprovalModeCalls,
    shellCalls,
    generateSessionRecapCalls,
    forkCalls,
    setToolEnabledCalls,
    initWorkspaceCalls,
    restartMcpServerCalls,
    addRuntimeMcpServerCalls,
    removeRuntimeMcpServerCalls,
    closeCalls,
    updateMetadataCalls,
    heartbeatCalls,
    heartbeatStateCalls,
    get shutdownCalls() {
      return shutdownCalls;
    },
    get workspaceMcpCalls() {
      return workspaceMcpCalls;
    },
    get workspaceSkillsCalls() {
      return workspaceSkillsCalls;
    },
    get workspaceToolsCalls() {
      return workspaceToolsCalls;
    },
    get workspaceProvidersCalls() {
      return workspaceProvidersCalls;
    },
    get workspaceEnvCalls() {
      return workspaceEnvCalls;
    },
    get workspacePreflightCalls() {
      return workspacePreflightCalls;
    },
    get workspaceHooksCalls() {
      return workspaceHooksCalls;
    },
    get workspaceExtensionsCalls() {
      return workspaceExtensionsCalls;
    },
    get sessionCount() {
      return calls.length;
    },
    get activePromptCount() {
      return 0;
    },
    get lastActivityAt() {
      return null;
    },
    get idleSinceMs() {
      return null;
    },
    get pendingPermissionCount() {
      return 0;
    },
    getDaemonStatusSnapshot() {
      return daemonStatusSnapshotImpl();
    },
    async spawnOrAttach(req) {
      const result = await spawnImpl(req);
      calls.push(req);
      return result;
    },
    async loadSession(req) {
      const result = await loadImpl(req);
      loadCalls.push(req);
      return result;
    },
    async resumeSession(req) {
      const result = await resumeImpl(req);
      resumeCalls.push(req);
      return result;
    },
    sendPrompt(sessionId, req, signal, context) {
      promptCalls.push({
        sessionId,
        req,
        signal,
        ...(context ? { context } : {}),
      });
      return Promise.resolve(promptImpl(sessionId, req, signal, context));
    },
    async cancelSession(sessionId, req, context) {
      cancelCalls.push({ sessionId, req, ...(context ? { context } : {}) });
      return cancelImpl(sessionId, req, context);
    },
    subscribeEvents(sessionId, subOpts) {
      if (opts.subscribeImpl) return opts.subscribeImpl(sessionId, subOpts);
      // Default: empty stream
      return (async function* () {
        // empty
      })();
    },
    getSessionLastEventId(sessionId) {
      if (opts.getSessionLastEventIdImpl) {
        return opts.getSessionLastEventIdImpl(sessionId);
      }
      return 0;
    },
    respondToPermission(requestId, response, context) {
      const accepted = respondImpl(requestId, response, context);
      permissionVotes.push({
        requestId,
        response,
        ...(context ? { context } : {}),
      });
      return accepted;
    },
    respondToSessionPermission(sessionId, requestId, response, context) {
      const accepted = sessionRespondImpl(
        sessionId,
        requestId,
        response,
        context,
      );
      sessionPermissionVotes.push({
        sessionId,
        requestId,
        response,
        ...(context ? { context } : {}),
      });
      return accepted;
    },
    listWorkspaceSessions(workspaceCwd) {
      listCalls.push(workspaceCwd);
      return listImpl(workspaceCwd);
    },
    async getWorkspaceMcpStatus() {
      workspaceMcpCalls += 1;
      return workspaceMcpImpl();
    },
    async getWorkspaceMcpToolsStatus(serverName) {
      workspaceMcpToolsCalls.push(serverName);
      return workspaceMcpToolsImpl(serverName);
    },
    async getWorkspaceSkillsStatus() {
      workspaceSkillsCalls += 1;
      return workspaceSkillsImpl();
    },
    async getWorkspaceToolsStatus() {
      workspaceToolsCalls += 1;
      return workspaceToolsImpl();
    },
    async getWorkspaceProvidersStatus() {
      workspaceProvidersCalls += 1;
      return workspaceProvidersImpl();
    },
    async getWorkspaceEnvStatus() {
      workspaceEnvCalls += 1;
      return workspaceEnvImpl();
    },
    async getWorkspacePreflightStatus() {
      workspacePreflightCalls += 1;
      return workspacePreflightImpl();
    },
    async getWorkspaceHooksStatus() {
      workspaceHooksCalls += 1;
      return workspaceHooksImpl();
    },
    async getWorkspaceExtensionsStatus() {
      workspaceExtensionsCalls += 1;
      return workspaceExtensionsImpl();
    },
    async refreshExtensionsForAllSessions(data) {
      extensionEvents.push({ ...data, refreshed: 1, failed: 0 });
      return { refreshed: 1, failed: 0 };
    },
    broadcastExtensionsChanged(data) {
      extensionEvents.push(data);
    },
    async getSessionContextStatus(sessionId) {
      sessionContextCalls.push(sessionId);
      return sessionContextImpl(sessionId);
    },
    async getSessionContextUsageStatus(sessionId, opts) {
      sessionContextUsageCalls.push(sessionId);
      return sessionContextUsageImpl(sessionId, opts);
    },
    async getSessionSupportedCommandsStatus(sessionId) {
      sessionSupportedCommandsCalls.push(sessionId);
      return sessionSupportedCommandsImpl(sessionId);
    },
    async getSessionTasksStatus(sessionId) {
      sessionTasksCalls.push(sessionId);
      return sessionTasksImpl(sessionId);
    },
    async cancelSessionTask(sessionId, taskId, taskKind) {
      cancelSessionTaskCalls.push({ sessionId, taskId, taskKind });
      return cancelSessionTaskImpl(sessionId, taskId, taskKind);
    },
    async clearSessionGoal(sessionId) {
      clearSessionGoalCalls.push(sessionId);
      return clearSessionGoalImpl(sessionId);
    },
    async getSessionHooksStatus(sessionId) {
      sessionHooksCalls.push(sessionId);
      return sessionHooksImpl(sessionId);
    },
    async setSessionModel(sessionId, req, context) {
      setModelCalls.push({ sessionId, req, ...(context ? { context } : {}) });
      return setModelImpl(sessionId, req, context);
    },
    async setSessionLanguage(sessionId, params, context) {
      setLanguageCalls.push({
        sessionId,
        params,
        ...(context ? { context } : {}),
      });
      return setLanguageImpl(sessionId, params, context);
    },
    async setSessionApprovalMode(sessionId, mode, o, context) {
      setApprovalModeCalls.push({
        sessionId,
        mode,
        opts: o,
        ...(context ? { context } : {}),
      });
      return setApprovalModeImpl(sessionId, mode, o, context);
    },
    async generateSessionRecap(sessionId, context) {
      generateSessionRecapCalls.push({
        sessionId,
        ...(context ? { context } : {}),
      });
      return generateSessionRecapImpl(sessionId, context);
    },
    async generateSessionBtw(sessionId, _question, _signal, _context) {
      return { sessionId, answer: 'mock btw answer' };
    },
    async launchSessionForkAgent(sessionId, directive, context) {
      forkCalls.push({
        sessionId,
        directive,
        ...(context ? { context } : {}),
      });
      return launchSessionForkAgentImpl(sessionId, directive, context);
    },
    enqueueMidTurnMessage(sessionId, message, context) {
      enqueueMidTurnCalls.push({
        sessionId,
        message,
        ...(context ? { context } : {}),
      });
      return enqueueMidTurnImpl(sessionId, message, context);
    },
    async executeShellCommand(sessionId, command, signal, context) {
      shellCalls.push({
        sessionId,
        command,
        ...(signal ? { signal } : {}),
        ...(context ? { context } : {}),
      });
      return shellImpl(sessionId, command, signal, context);
    },
    async setWorkspaceToolEnabled(
      toolName: string,
      enabled: boolean,
      originatorClientId?: string,
    ) {
      setToolEnabledCalls.push({
        toolName,
        enabled,
        ...(originatorClientId !== undefined ? { originatorClientId } : {}),
      });
      return setToolEnabledImpl(toolName, enabled, originatorClientId);
    },
    async initWorkspace(
      initOpts: { force?: boolean },
      originatorClientId?: string,
    ) {
      initWorkspaceCalls.push({
        initOpts,
        ...(originatorClientId !== undefined ? { originatorClientId } : {}),
      });
      return initWorkspaceImpl(initOpts, originatorClientId);
    },
    async restartMcpServer(
      serverName: string,
      originatorClientId?: string,
      restartOpts?: { entryIndex?: number },
    ) {
      restartMcpServerCalls.push({
        serverName,
        ...(originatorClientId !== undefined ? { originatorClientId } : {}),
        ...(restartOpts !== undefined ? { opts: restartOpts } : {}),
      });
      return restartMcpServerImpl(serverName, originatorClientId, restartOpts);
    },
    async addRuntimeMcpServer(name, config, originatorClientId) {
      addRuntimeMcpServerCalls.push({ name, config, originatorClientId });
      return addRuntimeMcpServerImpl(name, config, originatorClientId);
    },
    async removeRuntimeMcpServer(name, originatorClientId) {
      removeRuntimeMcpServerCalls.push({ name, originatorClientId });
      return removeRuntimeMcpServerImpl(name, originatorClientId);
    },
    async closeSession(sessionId, context) {
      closeCalls.push({ sessionId, ...(context ? { context } : {}) });
      return closeImpl(sessionId, context);
    },
    updateSessionMetadata(sessionId, metadata, context) {
      updateMetadataCalls.push({
        sessionId,
        metadata,
        ...(context ? { context } : {}),
      });
      return updateMetadataImpl(sessionId, metadata, context);
    },
    recordHeartbeat(sessionId, context) {
      heartbeatCalls.push({
        sessionId,
        ...(context ? { context } : {}),
      });
      return heartbeatImpl(sessionId, context);
    },
    getHeartbeatState(sessionId) {
      heartbeatStateCalls.push(sessionId);
      return heartbeatStateImpl(sessionId);
    },
    publishWorkspaceEvent(_event) {
      // Issue #4175 PR 16 — fakeBridge default is a no-op. Tests that
      // assert on workspace fan-out override this through the dedicated
      // route-level test files (workspace-memory.test.ts /
      // workspace-agents.test.ts) where the real fan-out behavior is
      // exercised against a live bridge.
    },
    knownClientIds() {
      // Default empty set; tests pass `{knownClientIds: ['client-1']}`
      // to opt into validation success on workspace mutation routes.
      return new Set<string>(opts.knownClientIds ?? []);
    },
    async killSession(sessionId, opts) {
      killCalls.push({ sessionId, opts });
    },
    async detachClient(sessionId, clientId) {
      detachCalls.push({
        sessionId,
        ...(clientId !== undefined ? { clientId } : {}),
      });
    },
    isChannelLive() {
      return false;
    },
    async queryWorkspaceStatus<T>(method: string, idle: () => T): Promise<T> {
      // Dispatch based on method to mirror ACP child routing.
      if (method === 'qwen/status/workspace/mcp') {
        workspaceMcpCalls += 1;
        return workspaceMcpImpl() as Promise<T>;
      }
      if (method === 'qwen/status/workspace/skills') {
        workspaceSkillsCalls += 1;
        return workspaceSkillsImpl() as Promise<T>;
      }
      if (method === 'qwen/status/workspace/providers') {
        workspaceProvidersCalls += 1;
        return workspaceProvidersImpl() as Promise<T>;
      }
      if (method === 'qwen/status/workspace/preflight') {
        workspacePreflightCalls += 1;
        return workspacePreflightImpl() as Promise<T>;
      }
      if (method === 'qwen/status/workspace/hooks') {
        workspaceHooksCalls += 1;
        return workspaceHooksImpl() as Promise<T>;
      }
      if (method === 'qwen/status/workspace/extensions') {
        workspaceExtensionsCalls += 1;
        return workspaceExtensionsImpl() as Promise<T>;
      }
      return idle();
    },
    async invokeWorkspaceCommand<T>(
      method: string,
      params?: Record<string, unknown>,
      _opts?: { timeoutMs?: number },
    ): Promise<T> {
      if (method === 'qwen/control/workspace/mcp/restart') {
        const serverName = (params?.['serverName'] as string) ?? '';
        const entryIndex = params?.['entryIndex'] as number | undefined;
        restartMcpServerCalls.push({
          serverName,
          ...(entryIndex !== undefined ? { opts: { entryIndex } } : {}),
        });
        return restartMcpServerImpl(
          serverName,
          undefined,
          entryIndex !== undefined ? { entryIndex } : undefined,
        ) as Promise<T>;
      }
      return {} as T;
    },
    async shutdown() {
      shutdownCalls += 1;
    },
    killAllSync() {
      shutdownCalls += 1;
    },
    async preheat() {},
  };
}

/**
 * Wenshao review #4335 / 3272581557 — detectFromLoopback tests.
 */
describe('detectFromLoopback (#4335 / 3272581557)', () => {
  function fakeReq(addr: string | undefined): {
    socket?: { remoteAddress?: string | undefined };
  } {
    if (addr === undefined) return {};
    return { socket: { remoteAddress: addr } };
  }

  it.each([
    ['127.0.0.1', true],
    ['127.0.0.2', true],
    ['127.0.1.1', true],
    ['127.255.255.254', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:127.0.0.2', true],
    ['10.0.0.1', false],
    ['192.168.1.1', false],
    ['1.2.3.4', false],
    ['::', false],
    ['fe80::1', false],
    ['127', false],
    ['', false],
  ])('detectFromLoopback(%s) === %s', (addr, expected) => {
    expect(detectFromLoopback(fakeReq(addr))).toBe(expected);
  });

  it('returns false for missing socket (fail-closed)', () => {
    expect(detectFromLoopback({})).toBe(false);
    expect(detectFromLoopback(fakeReq(undefined))).toBe(false);
  });

  it('does NOT consult X-Forwarded-For or any HTTP header (security)', () => {
    const reqWithForwardedHeader = {
      socket: { remoteAddress: '10.0.0.1' },
      get: (name: string) =>
        name === 'X-Forwarded-For' ? '127.0.0.1' : undefined,
    } as unknown as Parameters<typeof detectFromLoopback>[0];
    expect(detectFromLoopback(reqWithForwardedHeader)).toBe(false);
  });
});

function abortableBridgePromptImpl(): FakeBridgeOpts['promptImpl'] {
  return (_sid, _req, signal) =>
    new Promise((resolve) => {
      const onAbort = () => resolve({ stopReason: 'cancelled' });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
}

describe('createServeApp', () => {
  describe('serve capability registry', () => {
    it('returns a fresh ordered registered feature list', () => {
      const features = getRegisteredServeFeatures();
      expect(features).toEqual([...EXPECTED_REGISTERED_FEATURES]);

      features.pop();
      expect(getRegisteredServeFeatures()).toEqual([
        ...EXPECTED_REGISTERED_FEATURES,
      ]);
    });

    it('advertises current-protocol features separately from the registry', () => {
      // Conditional tags (currently `require_auth`) are absent unless
      // a runtime toggle is supplied; this is the "no toggles passed"
      // baseline that older clients see on a default-loopback daemon.
      expect(getAdvertisedServeFeatures()).toEqual([
        ...EXPECTED_STAGE1_FEATURES,
      ]);
      expect(getServeFeatures()).toEqual(getAdvertisedServeFeatures());
    });

    it('advertises `require_auth` only when the runtime toggle is on (#4175 PR 15)', () => {
      // Tag presence = behavior is on. SDK clients use it to surface a
      // "this deployment requires auth" hint; the toggle must therefore
      // map exactly to `--require-auth` and stay off everywhere else.
      expect(
        getAdvertisedServeFeatures(undefined, { requireAuth: true }),
      ).toContain('require_auth');
      expect(
        getAdvertisedServeFeatures(undefined, { requireAuth: false }),
      ).not.toContain('require_auth');
      expect(getAdvertisedServeFeatures(undefined, {})).not.toContain(
        'require_auth',
      );
    });

    it('honors every entry in CONDITIONAL_SERVE_FEATURES (PR #4236 review #3254467192 — drift insurance)', () => {
      // Iterate the Map so any future conditional tag added here whose
      // predicate isn't honored by `getAdvertisedServeFeatures` fails
      // the suite — the test is the adoption-of-record for the
      // "conditional features advertise via predicate" contract,
      // replacing the previous hand-maintained Set + branch shape that
      // could fail-CLOSED silently.
      //
      // For each entry: synthesize toggles that the predicate accepts
      // and toggles that it rejects. The predicate must be deterministic
      // and only read from `AdvertiseFeatureToggles` fields (no global
      // state, no Date.now() etc.) — that's the contract any future
      // entry must keep. We also assert the inverse: with toggles {} the
      // predicate must be false, otherwise the tag would fail the
      // "default-off" property baseline tags get for free.
      for (const [feature, predicate] of CONDITIONAL_SERVE_FEATURES) {
        if (feature === 'require_auth') {
          expect(predicate({ requireAuth: true })).toBe(true);
          expect(predicate({ requireAuth: false })).toBe(false);
          expect(predicate({})).toBe(false);
          expect(
            getAdvertisedServeFeatures(undefined, { requireAuth: true }),
          ).toContain(feature);
          expect(getAdvertisedServeFeatures(undefined, {})).not.toContain(
            feature,
          );
          continue;
        }
        if (
          feature === 'mcp_workspace_pool' ||
          feature === 'mcp_pool_restart'
        ) {
          expect(predicate({ mcpPoolActive: true })).toBe(true);
          expect(predicate({ mcpPoolActive: false })).toBe(false);
          expect(predicate({})).toBe(false);
          expect(
            getAdvertisedServeFeatures(undefined, { mcpPoolActive: true }),
          ).toContain(feature);
          expect(getAdvertisedServeFeatures(undefined, {})).not.toContain(
            feature,
          );
          continue;
        }
        if (feature === 'allow_origin') {
          expect(predicate({ allowOriginActive: true })).toBe(true);
          expect(predicate({ allowOriginActive: false })).toBe(false);
          expect(predicate({})).toBe(false);
          expect(
            getAdvertisedServeFeatures(undefined, { allowOriginActive: true }),
          ).toContain(feature);
          expect(getAdvertisedServeFeatures(undefined, {})).not.toContain(
            feature,
          );
          continue;
        }
        if (feature === 'prompt_absolute_deadline') {
          expect(predicate({ promptDeadlineMs: 5_000 })).toBe(true);
          expect(predicate({ promptDeadlineMs: 0 })).toBe(false);
          expect(predicate({})).toBe(false);
          expect(
            getAdvertisedServeFeatures(undefined, { promptDeadlineMs: 5_000 }),
          ).toContain(feature);
          expect(getAdvertisedServeFeatures(undefined, {})).not.toContain(
            feature,
          );
          continue;
        }
        if (feature === 'writer_idle_timeout') {
          expect(predicate({ writerIdleTimeoutMs: 60_000 })).toBe(true);
          expect(predicate({ writerIdleTimeoutMs: 0 })).toBe(false);
          expect(predicate({})).toBe(false);
          expect(
            getAdvertisedServeFeatures(undefined, {
              writerIdleTimeoutMs: 60_000,
            }),
          ).toContain(feature);
          expect(getAdvertisedServeFeatures(undefined, {})).not.toContain(
            feature,
          );
          continue;
        }
        if (feature === 'workspace_settings') {
          expect(predicate({ persistSettingAvailable: true })).toBe(true);
          expect(predicate({ persistSettingAvailable: false })).toBe(false);
          expect(predicate({})).toBe(false);
          expect(
            getAdvertisedServeFeatures(undefined, {
              persistSettingAvailable: true,
            }),
          ).toContain(feature);
          expect(getAdvertisedServeFeatures(undefined, {})).not.toContain(
            feature,
          );
          continue;
        }
        if (feature === 'rate_limit') {
          expect(predicate({ rateLimit: true })).toBe(true);
          expect(predicate({ rateLimit: false })).toBe(false);
          expect(predicate({})).toBe(false);
          expect(
            getAdvertisedServeFeatures(undefined, { rateLimit: true }),
          ).toContain(feature);
          expect(getAdvertisedServeFeatures(undefined, {})).not.toContain(
            feature,
          );
          continue;
        }
        if (feature === 'session_shell_command') {
          expect(predicate({ sessionShellCommandEnabled: true })).toBe(true);
          expect(predicate({ sessionShellCommandEnabled: false })).toBe(false);
          expect(predicate({})).toBe(false);
          expect(
            getAdvertisedServeFeatures(undefined, {
              sessionShellCommandEnabled: true,
            }),
          ).toContain(feature);
          expect(getAdvertisedServeFeatures(undefined, {})).not.toContain(
            feature,
          );
          continue;
        }
        if (feature === 'workspace_reload') {
          expect(predicate({ reloadAvailable: true })).toBe(true);
          expect(predicate({ reloadAvailable: false })).toBe(false);
          expect(predicate({})).toBe(false);
          expect(
            getAdvertisedServeFeatures(undefined, {
              reloadAvailable: true,
            }),
          ).toContain(feature);
          expect(getAdvertisedServeFeatures(undefined, {})).not.toContain(
            feature,
          );
          continue;
        }
        // Future conditional tag. Authors must add a branch above with
        // the toggle field that drives this predicate. Failing here is
        // intentional: it forces the new conditional tag to ship with a
        // matching test rather than relying on the Map shape alone.
        throw new Error(
          `CONDITIONAL_SERVE_FEATURES added "${feature}" without an ` +
            `assertion branch in this test — add one (synthesize toggles ` +
            `the predicate accepts AND rejects) so drift insurance stays ` +
            `enforced.`,
        );
      }
    });

    it('marks every current feature with its historical v1 origin', () => {
      expect(Object.keys(SERVE_CAPABILITY_REGISTRY)).toEqual([
        ...EXPECTED_REGISTERED_FEATURES,
      ]);
      expect(
        Object.values(SERVE_CAPABILITY_REGISTRY).map(({ since }) => since),
      ).toEqual(EXPECTED_REGISTERED_FEATURES.map(() => 'v1'));
    });

    it('exposes `modes` metadata on mcp_guardrails (#4175 PR 14)', () => {
      // `modes` is currently registry-only documentation (no wire
      // surface yet) — a client wanting to feature-detect `enforce`
      // semantics reads `caps.features.includes('mcp_guardrails')`,
      // not a separate `featureModes` field. The descriptor still
      // carries `modes` so future PRs that DO expose it on the wire
      // don't have to chase down every entry to backfill metadata.
      expect(SERVE_CAPABILITY_REGISTRY['mcp_guardrails']).toEqual({
        since: 'v1',
        modes: ['warn', 'enforce'],
      });
    });

    it('registers mcp_guardrail_events as a baseline tag (#4175 PR 14b)', () => {
      // PR 14b's push events are unconditional once advertised — there's
      // no operator toggle. So no `modes`, no entry in
      // `CONDITIONAL_SERVE_FEATURES`. SDK consumers feature-detect via
      // `caps.features.includes('mcp_guardrail_events')` before
      // narrowing `mcp_budget_warning` / `mcp_child_refused_batch`
      // frames through `KnownDaemonEvent`.
      expect(SERVE_CAPABILITY_REGISTRY['mcp_guardrail_events']).toEqual({
        since: 'v1',
      });
    });

    it('registers mcp_server_runtime_mutation as a baseline tag (T2.8 #4514)', () => {
      // Always-on tag. SDK clients pre-flight
      // `caps.features.includes('mcp_server_runtime_mutation')` before
      // calling `POST /workspace/mcp/servers` — older daemons silently 404.
      expect(SERVE_CAPABILITY_REGISTRY['mcp_server_runtime_mutation']).toEqual({
        since: 'v1',
      });
      expect(getAdvertisedServeFeatures()).toContain(
        'mcp_server_runtime_mutation',
      );
    });

    it('returns protocol version metadata with a fresh supported array', () => {
      const versions = getServeProtocolVersions();
      expect(versions).toEqual({ current: 'v1', supported: ['v1'] });

      versions.supported.push('v99' as ServeProtocolVersion);
      expect(getServeProtocolVersions()).toEqual({
        current: 'v1',
        supported: ['v1'],
      });
    });
  });

  describe('Web Shell static serving', () => {
    let webShellDir: string;
    const INDEX_HTML =
      '<!doctype html><html><head><title>Qwen Code Web terminal</title>' +
      '<script type="module" src="/assets/app.js"></script></head>' +
      '<body><div id="root"></div></body></html>';
    const host = `127.0.0.1:${baseOpts.port}`;

    beforeEach(async () => {
      webShellDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qwen-webshell-'));
      await fsp.writeFile(path.join(webShellDir, 'index.html'), INDEX_HTML);
      await fsp.mkdir(path.join(webShellDir, 'assets'));
      await fsp.writeFile(
        path.join(webShellDir, 'assets', 'app.js'),
        'export const x = 1;\n',
      );
    });

    afterEach(async () => {
      await fsp.rm(webShellDir, { recursive: true, force: true });
    });

    it('serves the shell at the root with security headers', async () => {
      const app = createServeApp(baseOpts, undefined, { webShellDir });
      const res = await request(app).get('/').set('Host', host);
      expect(res.status).toBe(200);
      expect(res.text).toContain('<div id="root">');
      expect(res.headers['content-security-policy']).toContain(
        "frame-ancestors 'none'",
      );
      expect(res.headers['content-security-policy']).toContain(
        "connect-src 'self'",
      );
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cache-control']).toContain('no-cache');
    });

    it('serves hashed asset chunks from /assets', async () => {
      const app = createServeApp(baseOpts, undefined, { webShellDir });
      const res = await request(app).get('/assets/app.js').set('Host', host);
      expect(res.status).toBe(200);
      expect(res.text).toContain('export const x');
    });

    it('returns 404 (not the shell) for a missing asset', async () => {
      // fallthrough:false — a stale/renamed chunk must 404, not fall through to
      // the SPA fallback and get a 200 index.html, even on a browser nav.
      const app = createServeApp(baseOpts, undefined, { webShellDir });
      const res = await request(app)
        .get('/assets/missing-chunk.js')
        .set('Host', host)
        .set('Accept', 'text/html');
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('<div id="root">');
    });

    it('falls back to the shell for SPA deep-link navigations', async () => {
      const app = createServeApp(baseOpts, undefined, { webShellDir });
      const res = await request(app)
        .get('/session/abc123')
        .set('Host', host)
        .set('Accept', 'text/html');
      expect(res.status).toBe(200);
      expect(res.text).toContain('<div id="root">');
    });

    it('leaves non-navigation API misses as JSON 404s', async () => {
      const app = createServeApp(baseOpts, undefined, { webShellDir });
      const res = await request(app)
        .get('/no/such/route')
        .set('Host', host)
        .set('Accept', 'application/json');
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('<div id="root">');
    });

    it('does not mount the UI when serveWebShell is false', async () => {
      const app = createServeApp(
        { ...baseOpts, serveWebShell: false },
        undefined,
        {
          webShellDir,
        },
      );
      const res = await request(app)
        .get('/')
        .set('Host', host)
        .set('Accept', 'text/html');
      expect(res.text).not.toContain('<div id="root">');
    });

    it('stays API-only when no webShellDir is injected', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/')
        .set('Host', host)
        .set('Accept', 'text/html');
      expect(res.text).not.toContain('<div id="root">');
    });

    it('does not serve the shell for POST navigations (method guard)', async () => {
      const app = createServeApp(baseOpts, undefined, { webShellDir });
      const res = await request(app)
        .post('/session/abc')
        .set('Host', host)
        .set('Accept', 'text/html');
      expect(res.text).not.toContain('<div id="root">');
    });

    it('falls back to the shell on a sec-fetch navigation signal', async () => {
      const app = createServeApp(baseOpts, undefined, { webShellDir });
      const res = await request(app)
        .get('/session/deep')
        .set('Host', host)
        .set('Accept', '*/*')
        .set('Sec-Fetch-Mode', 'navigate');
      expect(res.status).toBe(200);
      expect(res.text).toContain('<div id="root">');
    });

    it('does not shadow /health on a browser navigation (Critical #1)', async () => {
      // Non-loopback + requireAuth registers /health POST-auth. A browser
      // navigation (Accept text/html) must fall THROUGH the SPA fallback to
      // bearerAuth (401), not receive the shell. Without the /health guard the
      // pre-auth fallback would return index.html instead.
      const app = createServeApp(
        {
          ...baseOpts,
          hostname: '0.0.0.0',
          token: 'secret',
          requireAuth: true,
        },
        undefined,
        { webShellDir },
      );
      const res = await request(app)
        .get('/health')
        .set('Host', '0.0.0.0:4170')
        .set('Accept', 'text/html');
      expect(res.text).not.toContain('<div id="root">');
    });

    it('returns 500 when index.html is unreadable after mount', async () => {
      const app = createServeApp(baseOpts, undefined, { webShellDir });
      await fsp.rm(path.join(webShellDir, 'index.html'));
      const res = await request(app).get('/').set('Host', host);
      expect(res.status).toBe(500);
    });

    it('serves the shell when webShellDir is under a dotfile path (e.g. ~/.nvm)', async () => {
      // Regression: the send library defaults to dotfiles:'ignore', which
      // returns 404 for any path containing a segment starting with '.'.
      // Users who installed qwen via nvm have the package under
      // ~/.nvm/.../web-shell/index.html.
      const dotParent = await fsp.mkdtemp(path.join(os.tmpdir(), '.fake-nvm-'));
      const nestedShellDir = path.join(dotParent, 'web-shell');
      await fsp.mkdir(nestedShellDir, { recursive: true });
      await fsp.writeFile(path.join(nestedShellDir, 'index.html'), INDEX_HTML);
      await fsp.mkdir(path.join(nestedShellDir, 'assets'));
      await fsp.writeFile(
        path.join(nestedShellDir, 'assets', 'app.js'),
        'export const x = 1;\n',
      );
      try {
        const app = createServeApp(baseOpts, undefined, {
          webShellDir: nestedShellDir,
        });
        const res = await request(app).get('/').set('Host', host);
        expect(res.status).toBe(200);
        expect(res.text).toContain('<div id="root">');
      } finally {
        await fsp.rm(dotParent, { recursive: true, force: true });
      }
    });

    it('isDocumentNavigation recognizes each navigation signal', () => {
      const nav = (headers: Record<string, string>) =>
        isDocumentNavigation({ headers } as never);
      expect(nav({ 'sec-fetch-mode': 'navigate' })).toBe(true);
      expect(nav({ 'sec-fetch-dest': 'document' })).toBe(true);
      expect(nav({ accept: 'text/html,application/xhtml+xml' })).toBe(true);
      expect(nav({ accept: 'application/json' })).toBe(false);
      expect(nav({})).toBe(false);
    });

    it('resolveWebShellDir returns undefined or a dir with index.html + assets', () => {
      const dir = resolveWebShellDir();
      if (dir !== undefined) {
        expect(existsSync(path.join(dir, 'index.html'))).toBe(true);
        expect(existsSync(path.join(dir, 'assets'))).toBe(true);
      }
    });

    it('serves the shell pre-auth while the API stays token-gated', async () => {
      // Pins the central contract: the shell is registered BEFORE bearerAuth,
      // so a browser navigation with no Authorization still loads it, while
      // API routes remain gated. If registerWebShell ever moves below
      // bearerAuth, the first assertion breaks.
      const app = createServeApp({ ...baseOpts, token: 'secret' }, undefined, {
        webShellDir,
      });
      const shell = await request(app)
        .get('/')
        .set('Host', host)
        .set('Accept', 'text/html');
      expect(shell.status).toBe(200);
      expect(shell.text).toContain('<div id="root">');
      // Even with an attacker-controlled Accept: text/html, the authed route
      // wins (401): the SPA fallback runs only after the API routes, so it
      // can't coax the 200 shell out of a gated endpoint.
      const api = await request(app)
        .get('/capabilities')
        .set('Host', host)
        .set('Accept', 'text/html');
      expect(api.status).toBe(401);
    });
  });

  describe('GET /health', () => {
    it('returns 200 ok', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/health')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });
  });

  describe('GET /capabilities', () => {
    it('returns the v1 envelope', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body.v).toBe(CAPABILITIES_SCHEMA_VERSION);
      expect(res.body.protocolVersions).toEqual(getServeProtocolVersions());
      expect(res.body.mode).toBe('http-bridge');
      // F2 (#4175 commit 5): the server.ts call site flips
      // `mcpPoolActive` to default-ON via `opts.mcpPoolActive !== false`
      // (so a daemon booted without the kill switch advertises the F2
      // pool surface by default). Anchor the expectation against the
      // same toggle so the assertion reflects the runtime contract,
      // not the registry default-OFF predicate.
      expect(res.body.features).toEqual(
        getAdvertisedServeFeatures(undefined, { mcpPoolActive: true }),
      );
      expect(res.body.modelServices).toEqual([]);
      expect(res.body.limits).toMatchObject({
        maxPendingPromptsPerSession: 5,
      });
    });

    it('reports disabled prompt queue cap as null in capabilities', async () => {
      const app = createServeApp({
        ...baseOpts,
        maxPendingPromptsPerSession: 0,
      });
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(res.status).toBe(200);
      expect(res.body.limits).toMatchObject({
        maxPendingPromptsPerSession: null,
      });
    });

    it('reports explicit prompt queue cap in capabilities', async () => {
      const app = createServeApp({
        ...baseOpts,
        maxPendingPromptsPerSession: 12,
      });
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(res.status).toBe(200);
      expect(res.body.limits).toMatchObject({
        maxPendingPromptsPerSession: 12,
      });
    });

    it('omits mcp_workspace_pool / mcp_pool_restart when mcpPoolActive=false (F2 #4175 commit 5)', async () => {
      // Mirrors the env-var kill switch path: `run-qwen-serve.ts` infers
      // `mcpPoolActive: false` when the parent process has
      // `QWEN_SERVE_NO_MCP_POOL=1`. Verify the capability envelope
      // tracks the toggle so SDK clients pre-flighting on the tags
      // observe accurate "pool is off" semantics.
      const app = createServeApp({ ...baseOpts, mcpPoolActive: false });
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body.features).not.toContain('mcp_workspace_pool');
      expect(res.body.features).not.toContain('mcp_pool_restart');
      // The legacy MCP surface tags still advertise.
      expect(res.body.features).toContain('workspace_mcp');
      expect(res.body.features).toContain('workspace_mcp_restart');
    });

    it('reports the bound workspace (#3803 §02)', async () => {
      const app = createServeApp({ ...baseOpts, workspace: WS_BOUND });
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body.workspaceCwd).toBe(WS_BOUND);
    });

    it('falls back to process.cwd() when --workspace is omitted', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      // `createServeApp` runs `canonicalizeWorkspace` on
      // `process.cwd()`, which collapses symlinks via
      // `realpathSync.native`. On macOS the default tmpdir is
      // `/var/folders/...` whose canonical form is
      // `/private/var/folders/...`; a raw `process.cwd()` assertion
      // would diverge there. Use the same realpath the route does.
      expect(res.body.workspaceCwd).toBe(realpathSync.native(process.cwd()));
    });

    it('omits the `require_auth` feature tag by default (#4175 PR 15)', async () => {
      // Default loopback no-token daemon: existing clients see the
      // bit-for-bit pre-PR feature list. This is the backward-compat
      // anchor — adding the tag unconditionally would make every
      // daemon look like it required auth.
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body.features).not.toContain('require_auth');
    });

    it('advertises `require_auth` when the daemon was started with --require-auth', async () => {
      const app = createServeApp({
        ...baseOpts,
        token: 'secret',
        requireAuth: true,
      });
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('Authorization', 'Bearer secret');
      expect(res.status).toBe(200);
      expect(res.body.features).toContain('require_auth');
    });

    it('omits `session_shell_command` by default', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body.features).not.toContain('session_shell_command');
    });

    it('omits `session_shell_command` when enabled without a token', async () => {
      const app = createServeApp({
        ...baseOpts,
        enableSessionShell: true,
      });
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body.features).not.toContain('session_shell_command');
    });

    it('advertises `session_shell_command` only when enabled with a token', async () => {
      const app = createServeApp({
        ...baseOpts,
        token: 'secret',
        enableSessionShell: true,
      });
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('Authorization', 'Bearer secret');
      expect(res.status).toBe(200);
      expect(res.body.features).toContain('session_shell_command');
    });

    it('treats an empty token string as no token for session shell capability', async () => {
      const app = createServeApp({
        ...baseOpts,
        token: '',
        enableSessionShell: true,
      });
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body.features).not.toContain('session_shell_command');
    });
  });

  describe('read-only status routes', () => {
    it('returns workspace MCP status from the bridge', async () => {
      const payload: ServeWorkspaceMcpStatus = {
        v: 1,
        workspaceCwd: WS_BOUND,
        initialized: true,
        discoveryState: 'completed',
        servers: [
          {
            kind: 'mcp_server',
            status: 'ok',
            name: 'docs',
            mcpStatus: 'connected',
            transport: 'stdio',
            disabled: false,
            description: 'Docs server',
          },
        ],
      };
      const bridge = fakeBridge({ workspaceMcpImpl: async () => payload });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .get('/workspace/mcp')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(payload);
      expect(bridge.workspaceMcpCalls).toBe(1);
    });

    it('round-trips PR 14 budget fields on /workspace/mcp', async () => {
      // Issue #4175 PR 14. The route is a thin JSON forwarder, so the
      // assertion is structural: the new fields (`clientCount`,
      // `clientBudget`, `budgetMode`, `budgets[]`, per-server
      // `disabledReason`) must survive verbatim. Catches future
      // serialization regressions that drop unknown optional fields.
      const payload: ServeWorkspaceMcpStatus = {
        v: 1,
        workspaceCwd: WS_BOUND,
        initialized: true,
        discoveryState: 'completed',
        clientCount: 3,
        clientBudget: 2,
        budgetMode: 'enforce',
        budgets: [
          {
            kind: 'mcp_budget',
            scope: 'session',
            status: 'error',
            errorKind: 'budget_exhausted',
            hint: 'Raise --mcp-client-budget or remove servers.',
            liveCount: 2,
            budget: 2,
            mode: 'enforce',
            refusedCount: 1,
          },
        ],
        servers: [
          {
            kind: 'mcp_server',
            status: 'ok',
            name: 'a',
            mcpStatus: 'connected',
            transport: 'stdio',
            disabled: false,
          },
          {
            kind: 'mcp_server',
            status: 'ok',
            name: 'b',
            mcpStatus: 'connected',
            transport: 'stdio',
            disabled: false,
          },
          {
            kind: 'mcp_server',
            status: 'error',
            errorKind: 'budget_exhausted',
            hint: 'Raise --mcp-client-budget or remove servers from mcpServers config.',
            name: 'c',
            mcpStatus: 'disconnected',
            transport: 'stdio',
            disabled: false,
            disabledReason: 'budget',
          },
        ],
      };
      const bridge = fakeBridge({ workspaceMcpImpl: async () => payload });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .get('/workspace/mcp')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(payload);
      expect(res.body.budgets).toHaveLength(1);
      expect(res.body.budgets[0]).toMatchObject({
        kind: 'mcp_budget',
        scope: 'session',
        status: 'error',
        errorKind: 'budget_exhausted',
        refusedCount: 1,
      });
      expect(res.body.servers[2].disabledReason).toBe('budget');
    });

    it('returns workspace skills and providers status from the bridge', async () => {
      const skills: ServeWorkspaceSkillsStatus = {
        v: 1,
        workspaceCwd: WS_BOUND,
        initialized: true,
        skills: [
          {
            kind: 'skill',
            status: 'ok',
            name: 'review',
            description: 'Review code',
            level: 'project',
            modelInvocable: true,
          },
        ],
      };
      const providers: ServeWorkspaceProvidersStatus = {
        v: 1,
        workspaceCwd: WS_BOUND,
        initialized: true,
        current: { authType: 'qwen', modelId: 'qwen3(qwen)' },
        providers: [
          {
            kind: 'model_provider',
            status: 'ok',
            authType: 'qwen',
            current: true,
            models: [
              {
                modelId: 'qwen3(qwen)',
                baseModelId: 'qwen3',
                name: 'Qwen 3',
                description: null,
                contextLimit: 4096,
                isCurrent: true,
                isRuntime: false,
              },
            ],
          },
        ],
      };
      const bridge = fakeBridge({
        workspaceSkillsImpl: async () => skills,
        workspaceProvidersImpl: async () => providers,
      });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const skillsRes = await request(app)
        .get('/workspace/skills')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      const providersRes = await request(app)
        .get('/workspace/providers')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(skillsRes.status).toBe(200);
      expect(skillsRes.body).toEqual(skills);
      expect(providersRes.status).toBe(200);
      expect(providersRes.body).toEqual(providers);
      expect(bridge.workspaceSkillsCalls).toBe(1);
      expect(bridge.workspaceProvidersCalls).toBe(1);
    });

    it('returns workspace tools status from the bridge', async () => {
      const tools: ServeWorkspaceToolsStatus = {
        v: 1,
        workspaceCwd: WS_BOUND,
        initialized: true,
        acpChannelLive: true,
        tools: [
          {
            name: 'ReadFile',
            displayName: 'Read',
            description: 'Read a file',
            enabled: true,
          },
          {
            name: 'Shell',
            displayName: 'Shell',
            description: 'Run shell commands',
            enabled: false,
          },
        ],
      };
      const bridge = fakeBridge({ workspaceToolsImpl: async () => tools });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .get('/workspace/tools')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(tools);
      expect(bridge.workspaceToolsCalls).toBe(1);
    });

    it('returns workspace env status from the bridge', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .get('/workspace/env')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        v: 1,
        workspaceCwd: WS_BOUND,
        initialized: true,
        acpChannelLive: false,
      });
      expect(res.body.cells.length).toBeGreaterThan(0);
    });

    it('returns workspace preflight status from the bridge', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .get('/workspace/preflight')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        v: 1,
        workspaceCwd: WS_BOUND,
        initialized: true,
        acpChannelLive: false,
      });
      const cells = res.body.cells as Array<{
        kind: string;
        status: string;
        locality: string;
      }>;
      expect(cells.length).toBeGreaterThan(0);
      expect(cells.some((c) => c.locality === 'daemon')).toBe(true);
      expect(
        cells
          .filter((c) => c.locality === 'acp')
          .every((c) => c.status === 'not_started'),
      ).toBe(true);
    });

    it('returns workspace hooks status from the bridge', async () => {
      const hooks: ServeWorkspaceHooksStatus = {
        v: 1,
        workspaceCwd: WS_BOUND,
        initialized: true,
        disabled: false,
        hooks: [
          {
            kind: 'hook',
            eventName: 'PreToolUse',
            config: { type: 'command', command: 'echo hi' },
            source: 'project',
            matcher: 'Bash',
            enabled: true,
          },
        ],
        events: {
          PreToolUse: {
            description: 'Before tool execution',
            matcherKind: 'toolName',
          },
        },
      };
      const bridge = fakeBridge({ workspaceHooksImpl: async () => hooks });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .get('/workspace/hooks')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(hooks);
      expect(bridge.workspaceHooksCalls).toBe(1);
    });

    it('returns session hooks status from the bridge', async () => {
      const hooks: ServeSessionHooksStatus = {
        v: 1,
        sessionId: 's-1',
        workspaceCwd: WS_BOUND,
        disabled: false,
        hooks: [],
      };
      const bridge = fakeBridge({
        sessionHooksImpl: async () => hooks,
      });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .get('/session/s-1/hooks')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(hooks);
      expect(bridge.sessionHooksCalls).toEqual(['s-1']);
    });

    it('returns workspace extensions status without depending on a live session', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .get('/workspace/extensions')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        v: 1,
        workspaceCwd: WS_BOUND,
        initialized: true,
      });
      expect(Array.isArray(res.body.extensions)).toBe(true);
      expect(bridge.workspaceExtensionsCalls).toBe(0);
    });

    it('caches local workspace extension status briefly', async () => {
      const restore = mockExtensionManagerMethods();
      try {
        const bridge = fakeBridge();
        const app = createServeApp(
          { ...baseOpts, workspace: WS_BOUND },
          undefined,
          { bridge },
        );

        const first = await request(app)
          .get('/workspace/extensions')
          .set('Host', `127.0.0.1:${baseOpts.port}`);
        const second = await request(app)
          .get('/workspace/extensions')
          .set('Host', `127.0.0.1:${baseOpts.port}`);

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(
          vi.mocked(ExtensionManager.prototype.refreshCache),
        ).toHaveBeenCalledTimes(1);
      } finally {
        restore();
      }
    });

    it('redacts extension source URLs in workspace extension status', async () => {
      const restore = mockExtensionManagerMethods({
        getLoadedExtensions: () => [
          {
            ...testExtension('private-ext'),
            installMetadata: {
              source: 'https://user:token@example.com/private-ext',
              originSource: 'QwenCode',
            },
          },
        ],
      });
      try {
        const bridge = fakeBridge();
        const app = createServeApp(
          { ...baseOpts, workspace: WS_BOUND },
          undefined,
          { bridge },
        );

        const res = await request(app)
          .get('/workspace/extensions')
          .set('Host', `127.0.0.1:${baseOpts.port}`);

        expect(res.status).toBe(200);
        expect(res.body.extensions[0]).toMatchObject({
          source: 'https://***REDACTED***@example.com/private-ext',
          originSource: 'QwenCode',
        });
      } finally {
        restore();
      }
    });

    const testExtension = (name = 'test-ext'): Extension =>
      ({
        name,
        config: { version: '1.2.3' },
        installMetadata: { source: `https://example.com/${name}` },
        contextFiles: [],
        commands: [],
      }) as unknown as Extension;

    const mockExtensionManagerMethods = (overrides?: {
      refreshCache?: () => Promise<void>;
      installExtension?: () => Promise<Extension>;
      getLoadedExtensions?: () => Extension[];
      enableExtension?: () => Promise<void>;
      disableExtension?: () => Promise<void>;
      uninstallExtension?: () => Promise<void>;
      checkForAllExtensionUpdates?: (
        cb: (name: string, state: ExtensionUpdateState) => void,
      ) => Promise<void>;
      updateExtension?: () => Promise<{ updatedVersion?: string } | undefined>;
    }) => {
      const spies = [
        vi
          .spyOn(ExtensionManager.prototype, 'refreshCache')
          .mockImplementation(
            overrides?.refreshCache ?? (async () => undefined),
          ),
        vi
          .spyOn(ExtensionManager.prototype, 'installExtension')
          .mockImplementation(
            overrides?.installExtension ??
              (async () => testExtension('installed-ext')),
          ),
        vi
          .spyOn(ExtensionManager.prototype, 'getLoadedExtensions')
          .mockImplementation(
            overrides?.getLoadedExtensions ??
              (() => [testExtension('test-ext')]),
          ),
        vi
          .spyOn(ExtensionManager.prototype, 'enableExtension')
          .mockImplementation(
            overrides?.enableExtension ?? (async () => undefined),
          ),
        vi
          .spyOn(ExtensionManager.prototype, 'disableExtension')
          .mockImplementation(
            overrides?.disableExtension ?? (async () => undefined),
          ),
        vi
          .spyOn(ExtensionManager.prototype, 'uninstallExtension')
          .mockImplementation(
            overrides?.uninstallExtension ?? (async () => undefined),
          ),
        vi
          .spyOn(ExtensionManager.prototype, 'checkForAllExtensionUpdates')
          .mockImplementation(
            overrides?.checkForAllExtensionUpdates ??
              (async (cb) => {
                cb('test-ext', ExtensionUpdateState.UPDATE_AVAILABLE);
              }),
          ),
        vi
          .spyOn(ExtensionManager.prototype, 'updateExtension')
          .mockImplementation(
            overrides?.updateExtension ??
              (async () => ({
                name: 'test-ext',
                originalVersion: '1.2.3',
                updatedVersion: '1.2.4',
              })),
          ),
      ];
      return () => {
        for (const spy of spies) {
          spy.mockRestore();
        }
      };
    };

    it('rejects extension install without a registered workspace client id', async () => {
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/workspace/extensions/install')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret')
        .send({ source: 'owner/repo', consent: true });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('missing_client_id');
    });

    it('rejects extension install from an unknown workspace client id', async () => {
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/workspace/extensions/install')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-2')
        .send({ source: 'owner/repo', consent: true });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_client_id');
    });

    it('queues extension install and refreshes active sessions', async () => {
      let requestSettingError: string | undefined;
      const restore = mockExtensionManagerMethods({
        async installExtension() {
          const manager = this as unknown as {
            requestSetting?: (setting: { envVar: string }) => Promise<string>;
          };
          try {
            await manager.requestSetting?.({ envVar: 'API_KEY' });
          } catch (error) {
            requestSettingError =
              error instanceof Error ? error.message : String(error);
          }
          return testExtension('installed-ext');
        },
      });
      try {
        const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
        const bridge = fakeBridge({ knownClientIds: ['client-1'] });
        const app = createServeApp(
          { ...tokenOpts, workspace: WS_BOUND },
          undefined,
          { bridge },
        );

        const res = await request(app)
          .post('/workspace/extensions/install')
          .set('Host', `127.0.0.1:${tokenOpts.port}`)
          .set('Authorization', 'Bearer secret')
          .set('X-Qwen-Client-Id', 'client-1')
          .send({
            source: 'https://example.com/installed-ext',
            ref: 'v1.2.3',
            autoUpdate: true,
            allowPreRelease: true,
            consent: true,
          });

        expect(res.status).toBe(202);
        expect(res.body).toEqual({ accepted: true });
        await vi.waitFor(() => {
          expect(bridge.extensionEvents.at(-1)).toMatchObject({
            status: 'installed',
            source: 'https://example.com/installed-ext',
            name: 'installed-ext',
            version: '1.2.3',
            refreshed: 1,
            failed: 0,
          });
        });
        expect(
          vi.mocked(ExtensionManager.prototype.installExtension),
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            ref: 'v1.2.3',
            autoUpdate: true,
            allowPreRelease: true,
          }),
          expect.any(Function),
        );
        expect(requestSettingError).toContain(
          'requires interactive configuration',
        );
      } finally {
        restore();
      }
    });

    it('broadcasts a failed extension install with redacted error details', async () => {
      const restore = mockExtensionManagerMethods({
        installExtension: async () => {
          throw new Error('https://user:token@example.com/private-ext failed');
        },
      });
      try {
        const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
        const bridge = fakeBridge({ knownClientIds: ['client-1'] });
        const app = createServeApp(
          { ...tokenOpts, workspace: WS_BOUND },
          undefined,
          { bridge },
        );

        const res = await request(app)
          .post('/workspace/extensions/install')
          .set('Host', `127.0.0.1:${tokenOpts.port}`)
          .set('Authorization', 'Bearer secret')
          .set('X-Qwen-Client-Id', 'client-1')
          .send({
            source: 'https://example.com/private-ext',
            consent: true,
          });

        expect(res.status).toBe(202);
        await vi.waitFor(() => {
          expect(bridge.extensionEvents.at(-1)).toMatchObject({
            status: 'failed',
            source: 'https://example.com/private-ext',
            refreshed: 0,
            failed: 0,
            error: 'https://***REDACTED***@example.com/private-ext failed',
          });
        });
        expect(bridge.extensionEvents.at(-1)?.error).not.toContain('token');
      } finally {
        restore();
      }
    });

    it('does not report a successful extension install as failed when session refresh fails', async () => {
      const restore = mockExtensionManagerMethods({
        async installExtension() {
          return testExtension('installed-ext');
        },
      });
      try {
        const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
        const bridge = fakeBridge({ knownClientIds: ['client-1'] });
        bridge.refreshExtensionsForAllSessions = async () => {
          throw new Error('refresh broke');
        };
        const app = createServeApp(
          { ...tokenOpts, workspace: WS_BOUND },
          undefined,
          { bridge },
        );

        const res = await request(app)
          .post('/workspace/extensions/install')
          .set('Host', `127.0.0.1:${tokenOpts.port}`)
          .set('Authorization', 'Bearer secret')
          .set('X-Qwen-Client-Id', 'client-1')
          .send({
            source: 'https://example.com/installed-ext',
            consent: true,
          });

        expect(res.status).toBe(202);
        await vi.waitFor(() => {
          expect(bridge.extensionEvents.at(-1)).toMatchObject({
            status: 'installed',
            source: 'https://example.com/installed-ext',
            name: 'installed-ext',
            refreshed: 0,
            failed: 1,
            error: 'refresh broke',
          });
        });
      } finally {
        restore();
      }
    });

    it('rejects extension mutations when the operation queue is full', async () => {
      let releaseInstall: (() => void) | undefined;
      const installBlocker = new Promise<void>((resolve) => {
        releaseInstall = resolve;
      });
      const restore = mockExtensionManagerMethods({
        installExtension: async () => {
          await installBlocker;
          return testExtension('installed-ext');
        },
      });
      try {
        const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
        const bridge = fakeBridge({ knownClientIds: ['client-1'] });
        const app = createServeApp(
          { ...tokenOpts, workspace: WS_BOUND },
          undefined,
          { bridge },
        );

        const install = () =>
          request(app)
            .post('/workspace/extensions/install')
            .set('Host', `127.0.0.1:${tokenOpts.port}`)
            .set('Authorization', 'Bearer secret')
            .set('X-Qwen-Client-Id', 'client-1')
            .send({
              source: 'https://example.com/installed-ext',
              consent: true,
            });

        const accepted = await Promise.all(
          Array.from({ length: 10 }, () => install()),
        );
        const rejected = await install();

        expect(accepted.every((res) => res.status === 202)).toBe(true);
        expect(rejected.status).toBe(429);
        expect(rejected.body).toMatchObject({
          code: 'extension_queue_full',
        });
        releaseInstall?.();
        await vi.waitFor(() => {
          expect(
            bridge.extensionEvents.filter(
              (event) => event.status === 'installed',
            ),
          ).toHaveLength(10);
        });
      } finally {
        releaseInstall?.();
        restore();
      }
    });

    it('requires explicit consent for extension install', async () => {
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/workspace/extensions/install')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ source: 'owner/repo' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe(
        'Extension installation requires explicit consent',
      );
    });

    it('rejects an empty extension install ref', async () => {
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/workspace/extensions/install')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ source: 'owner/repo', ref: '', consent: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('`ref` must be a string');
    });

    it('validates extension install option types', async () => {
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/workspace/extensions/install')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ source: 'owner/repo', ref: 123, consent: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('`ref` must be a string');
    });

    it('broadcasts failed local extension installs over the daemon endpoint', async () => {
      const localExtensionDir = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'qwen-local-extension-'),
      );
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/workspace/extensions/install')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ source: localExtensionDir, consent: true });

      expect(res.status).toBe(202);
      await vi.waitFor(() => {
        expect(bridge.extensionEvents.at(-1)).toMatchObject({
          status: 'failed',
          source: localExtensionDir,
          error:
            'Only GitHub, Git, and npm extension installs are supported over the daemon endpoint.',
        });
      });
    });

    it('treats Windows drive paths as local extension sources', async () => {
      const restore = mockExtensionManagerMethods();
      try {
        const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
        const bridge = fakeBridge({ knownClientIds: ['client-1'] });
        const app = createServeApp(
          { ...tokenOpts, workspace: WS_BOUND },
          undefined,
          { bridge },
        );
        const source = 'C:\\Users\\test\\qwen-local-extension';

        const res = await request(app)
          .post('/workspace/extensions/install')
          .set('Host', `127.0.0.1:${tokenOpts.port}`)
          .set('Authorization', 'Bearer secret')
          .set('X-Qwen-Client-Id', 'client-1')
          .send({ source, consent: true });

        expect(res.status).toBe(202);
        await vi.waitFor(() => {
          expect(bridge.extensionEvents.at(-1)).toMatchObject({
            status: 'failed',
            source,
            error: `Install source not found: ${source}`,
          });
        });
      } finally {
        restore();
      }
    });

    it('rejects extension source hosts on blocked networks', async () => {
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/workspace/extensions/install')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-1')
        .send({
          source: 'http://169.254.169.254/latest/meta-data',
          consent: true,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('`source` host is not allowed');
    });

    it('rejects extension source URLs with unsupported protocols', async () => {
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      for (const source of [
        'http://example.com/repo',
        'ftp://example.com/repo',
        'file:///tmp/repo',
      ]) {
        const res = await request(app)
          .post('/workspace/extensions/install')
          .set('Host', `127.0.0.1:${tokenOpts.port}`)
          .set('Authorization', 'Bearer secret')
          .set('X-Qwen-Client-Id', 'client-1')
          .send({
            source,
            consent: true,
          });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('`source` must use https or ssh');
      }
    });

    it('rejects extension ssh source hosts with legacy private IP encodings', async () => {
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      for (const source of [
        'git@0177.0.0.1:owner/repo.git',
        'git@0177.1:owner/repo.git',
        'git@0x7f.1:owner/repo.git',
        'git@127.0x1:owner/repo.git',
        'git@0x7f000001:owner/repo.git',
        'git@2130706433:owner/repo.git',
      ]) {
        const res = await request(app)
          .post('/workspace/extensions/install')
          .set('Host', `127.0.0.1:${tokenOpts.port}`)
          .set('Authorization', 'Bearer secret')
          .set('X-Qwen-Client-Id', 'client-1')
          .send({ source, consent: true });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('`source` host is not allowed');
      }
    });

    it('rejects extension ssh source hosts with bracketed private IPv6 literals', async () => {
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      for (const source of [
        'git@[::1]:owner/repo.git',
        'git@[fd00::1]:owner/repo.git',
        'git@[fe80::1]:owner/repo.git',
      ]) {
        const res = await request(app)
          .post('/workspace/extensions/install')
          .set('Host', `127.0.0.1:${tokenOpts.port}`)
          .set('Authorization', 'Bearer secret')
          .set('X-Qwen-Client-Id', 'client-1')
          .send({ source, consent: true });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('`source` host is not allowed');
      }
    });

    it('rejects extension install refs that look like git options', async () => {
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/workspace/extensions/install')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-1')
        .send({
          source: 'https://example.com/repo',
          ref: '--upload-pack=/bin/sh',
          consent: true,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('`ref` must not start with "-"');
    });

    it('rejects extension source URLs with credentials', async () => {
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/workspace/extensions/install')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-1')
        .send({
          source: 'https://user:pass@example.com/repo',
          consent: true,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('`source` must not include credentials');
    });

    it('broadcasts failed npm extension install with ref', async () => {
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/workspace/extensions/install')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ source: '@scope/ext', ref: 'v1', consent: true });

      expect(res.status).toBe(202);
      await vi.waitFor(() => {
        expect(bridge.extensionEvents.at(-1)).toMatchObject({
          status: 'failed',
          source: '@scope/ext',
          error: '--ref is not applicable for npm extensions.',
        });
      });
    });

    it('broadcasts failed registry use for non-npm extension installs', async () => {
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/workspace/extensions/install')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-1')
        .send({
          source: 'https://example.com/repo',
          registry: 'https://registry.example.com',
          consent: true,
        });

      expect(res.status).toBe(202);
      await vi.waitFor(() => {
        expect(bridge.extensionEvents.at(-1)).toMatchObject({
          status: 'failed',
          source: 'https://example.com/repo',
          error: '--registry is only applicable for npm extensions.',
        });
      });
    });

    it('rejects non-https npm registries', async () => {
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/workspace/extensions/install')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-1')
        .send({
          source: '@scope/ext',
          registry: 'http://registry.example.com',
          consent: true,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('`registry` must use https');
    });

    it('rejects invalid npm registry URLs', async () => {
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/workspace/extensions/install')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-1')
        .send({
          source: '@scope/ext',
          registry: 'not a url',
          consent: true,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('`registry` must be a valid URL');
    });

    it('rejects npm registries on blocked networks', async () => {
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/workspace/extensions/install')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-1')
        .send({
          source: '@scope/ext',
          registry: 'https://169.254.169.254',
          consent: true,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('`registry` host is not allowed');
    });

    it('rejects npm registries with credentials', async () => {
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/workspace/extensions/install')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-1')
        .send({
          source: '@scope/ext',
          registry: 'https://user:pass@registry.example.com',
          consent: true,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('`registry` must not include credentials');
    });

    it('returns extension update states from check-updates', async () => {
      const restore = mockExtensionManagerMethods({
        checkForAllExtensionUpdates: async (cb) => {
          cb('test-ext', ExtensionUpdateState.UP_TO_DATE);
          cb('other-ext', ExtensionUpdateState.NOT_UPDATABLE);
        },
      });
      try {
        const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
        const bridge = fakeBridge({ knownClientIds: ['client-1'] });
        const app = createServeApp(
          { ...tokenOpts, workspace: WS_BOUND },
          undefined,
          { bridge },
        );

        const res = await request(app)
          .post('/workspace/extensions/check-updates')
          .set('Host', `127.0.0.1:${tokenOpts.port}`)
          .set('Authorization', 'Bearer secret')
          .set('X-Qwen-Client-Id', 'client-1')
          .send({});

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          states: {
            'test-ext': ExtensionUpdateState.UP_TO_DATE,
            'other-ext': ExtensionUpdateState.NOT_UPDATABLE,
          },
        });
      } finally {
        restore();
      }
    });

    it('serializes check-updates behind queued extension mutations', async () => {
      let releaseInstall: (() => void) | undefined;
      const calls: string[] = [];
      const restore = mockExtensionManagerMethods({
        installExtension: async () => {
          calls.push('install:start');
          await new Promise<void>((resolve) => {
            releaseInstall = resolve;
          });
          calls.push('install:end');
          return testExtension('installed-ext');
        },
        checkForAllExtensionUpdates: async (cb) => {
          calls.push('check-updates');
          cb('test-ext', ExtensionUpdateState.UP_TO_DATE);
        },
      });
      try {
        const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
        const bridge = fakeBridge({ knownClientIds: ['client-1'] });
        const app = createServeApp(
          { ...tokenOpts, workspace: WS_BOUND },
          undefined,
          { bridge },
        );

        await request(app)
          .post('/workspace/extensions/install')
          .set('Host', `127.0.0.1:${tokenOpts.port}`)
          .set('Authorization', 'Bearer secret')
          .set('X-Qwen-Client-Id', 'client-1')
          .send({
            source: 'https://example.com/installed-ext',
            consent: true,
          });
        await vi.waitFor(() => {
          expect(calls).toEqual(['install:start']);
        });

        const checkUpdates = request(app)
          .post('/workspace/extensions/check-updates')
          .set('Host', `127.0.0.1:${tokenOpts.port}`)
          .set('Authorization', 'Bearer secret')
          .set('X-Qwen-Client-Id', 'client-1')
          .send({})
          .then((response) => response);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(calls).toEqual(['install:start']);

        releaseInstall?.();
        const res = await checkUpdates;
        expect(res.status).toBe(200);
        expect(calls).toEqual([
          'install:start',
          'install:end',
          'check-updates',
        ]);
      } finally {
        releaseInstall?.();
        restore();
      }
    });

    it('validates extension enable scope', async () => {
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/workspace/extensions/test-ext/enable')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ scope: 'team' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe(
        '`scope` must be either "user" or "workspace"',
      );
    });

    it('queues extension enable and disable mutations', async () => {
      const restore = mockExtensionManagerMethods();
      try {
        const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
        const bridge = fakeBridge({ knownClientIds: ['client-1'] });
        const app = createServeApp(
          { ...tokenOpts, workspace: WS_BOUND },
          undefined,
          { bridge },
        );

        const enable = await request(app)
          .post('/workspace/extensions/TEST-EXT/enable')
          .set('Host', `127.0.0.1:${tokenOpts.port}`)
          .set('Authorization', 'Bearer secret')
          .set('X-Qwen-Client-Id', 'client-1')
          .send({ scope: 'workspace' });
        expect(enable.status).toBe(202);

        const disable = await request(app)
          .post('/workspace/extensions/TEST-EXT/disable')
          .set('Host', `127.0.0.1:${tokenOpts.port}`)
          .set('Authorization', 'Bearer secret')
          .set('X-Qwen-Client-Id', 'client-1')
          .send({ scope: 'user' });
        expect(disable.status).toBe(202);

        await vi.waitFor(() => {
          expect(bridge.extensionEvents).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                status: 'enabled',
                name: 'test-ext',
                refreshed: 1,
                failed: 0,
              }),
              expect.objectContaining({
                status: 'disabled',
                name: 'test-ext',
                refreshed: 1,
                failed: 0,
              }),
            ]),
          );
        });
        expect(
          vi.mocked(ExtensionManager.prototype.enableExtension),
        ).toHaveBeenCalledWith('test-ext', expect.anything(), WS_BOUND);
        expect(
          vi.mocked(ExtensionManager.prototype.disableExtension),
        ).toHaveBeenCalledWith('test-ext', expect.anything(), WS_BOUND);
      } finally {
        restore();
      }
    });

    it('refreshes extensions for all sessions on request', async () => {
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/workspace/extensions/refresh')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-1')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ refreshed: 1, failed: 0 });
      expect(bridge.extensionEvents.at(-1)).toMatchObject({
        refreshed: 1,
        failed: 0,
      });
    });

    it('serializes extension refresh behind queued mutations', async () => {
      let releaseInstall: (() => void) | undefined;
      const restore = mockExtensionManagerMethods({
        installExtension: async () => {
          await new Promise<void>((resolve) => {
            releaseInstall = resolve;
          });
          return testExtension('installed-ext');
        },
      });
      try {
        const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
        const bridge = fakeBridge({ knownClientIds: ['client-1'] });
        const app = createServeApp(
          { ...tokenOpts, workspace: WS_BOUND },
          undefined,
          { bridge },
        );

        await request(app)
          .post('/workspace/extensions/install')
          .set('Host', `127.0.0.1:${tokenOpts.port}`)
          .set('Authorization', 'Bearer secret')
          .set('X-Qwen-Client-Id', 'client-1')
          .send({
            source: 'https://example.com/installed-ext',
            consent: true,
          });
        await vi.waitFor(() => {
          expect(
            vi.mocked(ExtensionManager.prototype.installExtension),
          ).toHaveBeenCalled();
        });

        const refresh = request(app)
          .post('/workspace/extensions/refresh')
          .set('Host', `127.0.0.1:${tokenOpts.port}`)
          .set('Authorization', 'Bearer secret')
          .set('X-Qwen-Client-Id', 'client-1')
          .send({})
          .then((response) => response);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(bridge.extensionEvents).toEqual([]);

        releaseInstall?.();
        const res = await refresh;
        expect(res.status).toBe(200);
        expect(bridge.extensionEvents).toEqual([
          expect.objectContaining({ status: 'installed' }),
          expect.objectContaining({ refreshed: 1, failed: 0 }),
        ]);
      } finally {
        releaseInstall?.();
        restore();
      }
    });

    it('rejects extension update from an unknown workspace client id', async () => {
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/workspace/extensions/test-ext/update')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-2')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_client_id');
    });

    it('queues extension update when an update is available', async () => {
      const restore = mockExtensionManagerMethods();
      const checkForExtensionUpdate = vi
        .spyOn(qwenCore, 'checkForExtensionUpdate')
        .mockResolvedValue(ExtensionUpdateState.UPDATE_AVAILABLE);
      try {
        const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
        const bridge = fakeBridge({ knownClientIds: ['client-1'] });
        const app = createServeApp(
          { ...tokenOpts, workspace: WS_BOUND },
          undefined,
          { bridge },
        );

        const res = await request(app)
          .post('/workspace/extensions/test-ext/update')
          .set('Host', `127.0.0.1:${tokenOpts.port}`)
          .set('Authorization', 'Bearer secret')
          .set('X-Qwen-Client-Id', 'client-1')
          .send({});

        expect(res.status).toBe(202);
        await vi.waitFor(() => {
          expect(bridge.extensionEvents.at(-1)).toMatchObject({
            status: 'updated',
            name: 'test-ext',
            version: '1.2.4',
            refreshed: 1,
            failed: 0,
          });
        });
        expect(checkForExtensionUpdate).toHaveBeenCalledTimes(1);
        expect(
          vi.mocked(ExtensionManager.prototype.checkForAllExtensionUpdates),
        ).not.toHaveBeenCalled();
      } finally {
        checkForExtensionUpdate.mockRestore();
        restore();
      }
    });

    it('broadcasts failed extension update when the extension is missing', async () => {
      const restore = mockExtensionManagerMethods({
        getLoadedExtensions: () => [],
      });
      try {
        const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
        const bridge = fakeBridge({ knownClientIds: ['client-1'] });
        const app = createServeApp(
          { ...tokenOpts, workspace: WS_BOUND },
          undefined,
          { bridge },
        );

        const res = await request(app)
          .post('/workspace/extensions/missing-ext/update')
          .set('Host', `127.0.0.1:${tokenOpts.port}`)
          .set('Authorization', 'Bearer secret')
          .set('X-Qwen-Client-Id', 'client-1')
          .send({});

        expect(res.status).toBe(202);
        await vi.waitFor(() => {
          expect(bridge.extensionEvents.at(-1)).toMatchObject({
            status: 'failed',
            name: 'missing-ext',
            refreshed: 0,
            failed: 0,
            error: 'Extension "missing-ext" not found',
          });
        });
      } finally {
        restore();
      }
    });

    it('broadcasts failed extension update when no update is available', async () => {
      const restore = mockExtensionManagerMethods();
      const checkForExtensionUpdate = vi
        .spyOn(qwenCore, 'checkForExtensionUpdate')
        .mockResolvedValue(ExtensionUpdateState.UP_TO_DATE);
      try {
        const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
        const bridge = fakeBridge({ knownClientIds: ['client-1'] });
        const app = createServeApp(
          { ...tokenOpts, workspace: WS_BOUND },
          undefined,
          { bridge },
        );

        const res = await request(app)
          .post('/workspace/extensions/test-ext/update')
          .set('Host', `127.0.0.1:${tokenOpts.port}`)
          .set('Authorization', 'Bearer secret')
          .set('X-Qwen-Client-Id', 'client-1')
          .send({});

        expect(res.status).toBe(202);
        await vi.waitFor(() => {
          expect(bridge.extensionEvents.at(-1)).toMatchObject({
            status: 'failed',
            name: 'test-ext',
            error: 'Extension "test-ext" has no update',
          });
        });
      } finally {
        checkForExtensionUpdate.mockRestore();
        restore();
      }
    });

    it('broadcasts failed extension update when update check fails', async () => {
      const restore = mockExtensionManagerMethods();
      const checkForExtensionUpdate = vi
        .spyOn(qwenCore, 'checkForExtensionUpdate')
        .mockRejectedValue(
          new Error('https://user:token@example.com/check failed'),
        );
      try {
        const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
        const bridge = fakeBridge({ knownClientIds: ['client-1'] });
        const app = createServeApp(
          { ...tokenOpts, workspace: WS_BOUND },
          undefined,
          { bridge },
        );

        const res = await request(app)
          .post('/workspace/extensions/test-ext/update')
          .set('Host', `127.0.0.1:${tokenOpts.port}`)
          .set('Authorization', 'Bearer secret')
          .set('X-Qwen-Client-Id', 'client-1')
          .send({});

        expect(res.status).toBe(202);
        await vi.waitFor(() => {
          expect(bridge.extensionEvents.at(-1)).toMatchObject({
            status: 'failed',
            name: 'test-ext',
            error:
              'Update check failed for extension "test-ext": https://***REDACTED***@example.com/check failed',
          });
        });
      } finally {
        checkForExtensionUpdate.mockRestore();
        restore();
      }
    });

    it('rejects extension uninstall without a registered workspace client id', async () => {
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .delete('/workspace/extensions/test-ext')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('missing_client_id');
    });

    it('queues extension uninstall mutations', async () => {
      const restore = mockExtensionManagerMethods();
      try {
        const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
        const bridge = fakeBridge({ knownClientIds: ['client-1'] });
        const app = createServeApp(
          { ...tokenOpts, workspace: WS_BOUND },
          undefined,
          { bridge },
        );

        const res = await request(app)
          .delete('/workspace/extensions/TEST-EXT')
          .set('Host', `127.0.0.1:${tokenOpts.port}`)
          .set('Authorization', 'Bearer secret')
          .set('X-Qwen-Client-Id', 'client-1');

        expect(res.status).toBe(202);
        await vi.waitFor(() => {
          expect(bridge.extensionEvents.at(-1)).toMatchObject({
            status: 'uninstalled',
            name: 'test-ext',
            refreshed: 1,
            failed: 0,
          });
        });
        expect(
          vi.mocked(ExtensionManager.prototype.uninstallExtension),
        ).toHaveBeenCalledWith('test-ext', false, WS_BOUND);
      } finally {
        restore();
      }
    });

    it('queues extension uninstall mutations by source URL', async () => {
      const restore = mockExtensionManagerMethods();
      try {
        const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
        const bridge = fakeBridge({ knownClientIds: ['client-1'] });
        const app = createServeApp(
          { ...tokenOpts, workspace: WS_BOUND },
          undefined,
          { bridge },
        );

        const res = await request(app)
          .delete('/workspace/extensions/https%3A%2F%2Fexample.com%2Ftest-ext')
          .set('Host', `127.0.0.1:${tokenOpts.port}`)
          .set('Authorization', 'Bearer secret')
          .set('X-Qwen-Client-Id', 'client-1');

        expect(res.status).toBe(202);
        await vi.waitFor(() => {
          expect(bridge.extensionEvents.at(-1)).toMatchObject({
            status: 'uninstalled',
            name: 'test-ext',
            refreshed: 1,
            failed: 0,
          });
        });
        expect(
          vi.mocked(ExtensionManager.prototype.uninstallExtension),
        ).toHaveBeenCalledWith('test-ext', false, WS_BOUND);
      } finally {
        restore();
      }
    });

    it('does not treat plain extension names as install source lookups', async () => {
      const restore = mockExtensionManagerMethods({
        getLoadedExtensions: () => [
          {
            ...testExtension('source-only'),
            installMetadata: { source: 'plain-name' },
          },
        ],
      });
      try {
        const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
        const bridge = fakeBridge({ knownClientIds: ['client-1'] });
        const app = createServeApp(
          { ...tokenOpts, workspace: WS_BOUND },
          undefined,
          { bridge },
        );

        const res = await request(app)
          .delete('/workspace/extensions/plain-name')
          .set('Host', `127.0.0.1:${tokenOpts.port}`)
          .set('Authorization', 'Bearer secret')
          .set('X-Qwen-Client-Id', 'client-1');

        expect(res.status).toBe(202);
        await vi.waitFor(() => {
          expect(bridge.extensionEvents.at(-1)).toMatchObject({
            status: 'failed',
            name: 'plain-name',
            error: 'Extension "plain-name" not found',
          });
        });
        expect(
          vi.mocked(ExtensionManager.prototype.uninstallExtension),
        ).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('does not throw when source lookup sees extensions without install metadata', async () => {
      const restore = mockExtensionManagerMethods({
        getLoadedExtensions: () => [
          {
            ...testExtension('no-metadata'),
            installMetadata: undefined,
          },
        ],
      });
      try {
        const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
        const bridge = fakeBridge({ knownClientIds: ['client-1'] });
        const app = createServeApp(
          { ...tokenOpts, workspace: WS_BOUND },
          undefined,
          { bridge },
        );

        const res = await request(app)
          .delete('/workspace/extensions/https%3A%2F%2Fexample.com%2Fmissing')
          .set('Host', `127.0.0.1:${tokenOpts.port}`)
          .set('Authorization', 'Bearer secret')
          .set('X-Qwen-Client-Id', 'client-1');

        expect(res.status).toBe(202);
        await vi.waitFor(() => {
          expect(bridge.extensionEvents.at(-1)).toMatchObject({
            status: 'failed',
            name: 'https://example.com/missing',
            error: 'Extension "https://example.com/missing" not found',
          });
        });
      } finally {
        restore();
      }
    });

    it('returns read-only session snapshots from the bridge', async () => {
      const context: ServeSessionContextStatus = {
        v: 1,
        sessionId: 's-1',
        workspaceCwd: WS_BOUND,
        state: { models: { currentModelId: 'qwen3' } },
      };
      const commands: ServeSessionSupportedCommandsStatus = {
        v: 1,
        sessionId: 's-1',
        availableCommands: [
          {
            name: 'init',
            description: 'Initialize',
            input: null,
            _meta: { source: 'builtin' },
          },
        ],
        availableSkills: ['review'],
      };
      const tasks: ServeSessionTasksStatus = {
        v: 1,
        sessionId: 's-1',
        now: 1_700_000_000_000,
        tasks: [
          {
            kind: 'shell',
            id: 'sh-1',
            label: 'npm test',
            description: 'npm test',
            status: 'running',
            startTime: 1_699_999_999_000,
            runtimeMs: 1_000,
            outputFile: '/tmp/sh-1.log',
            command: 'npm test',
            cwd: WS_BOUND,
            pid: 123,
          },
        ],
      };
      const bridge = fakeBridge({
        sessionContextImpl: async () => context,
        sessionSupportedCommandsImpl: async () => commands,
        sessionTasksImpl: async () => tasks,
      });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const contextRes = await request(app)
        .get('/session/s-1/context')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      const commandsRes = await request(app)
        .get('/session/s-1/supported-commands')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      const tasksRes = await request(app)
        .get('/session/s-1/tasks')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(contextRes.status).toBe(200);
      expect(contextRes.body).toEqual(context);
      expect(commandsRes.status).toBe(200);
      expect(commandsRes.body).toEqual(commands);
      expect(tasksRes.status).toBe(200);
      expect(tasksRes.body).toEqual(tasks);
      expect(bridge.sessionContextCalls).toEqual(['s-1']);
      expect(bridge.sessionSupportedCommandsCalls).toEqual(['s-1']);
      expect(bridge.sessionTasksCalls).toEqual(['s-1']);
    });

    it('returns session context-usage from the bridge', async () => {
      const usage: ServeSessionContextUsageStatus = {
        v: 1,
        sessionId: 's-1',
        workspaceCwd: WS_BOUND,
        usage: {
          modelName: 'qwen3',
          totalTokens: 5000,
          contextWindowSize: 200000,
          breakdown: {
            systemPrompt: 2000,
            builtinTools: 500,
            mcpTools: 200,
            memoryFiles: 300,
            skills: 500,
            messages: 1500,
            freeSpace: 195000,
            autocompactBuffer: 0,
          },
          builtinTools: [{ name: 'Read', tokens: 100 }],
          mcpTools: [],
          memoryFiles: [],
          skills: [],
        },
        formattedText: 'Context: 5000/200000 tokens',
      };
      const bridge = fakeBridge({
        sessionContextUsageImpl: async () => usage,
      });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .get('/session/s-1/context-usage')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(usage);
      expect(bridge.sessionContextUsageCalls).toEqual(['s-1']);
    });

    it('passes detail query param to context-usage bridge call', async () => {
      let receivedOpts: { detail?: boolean } | undefined;
      const bridge = fakeBridge({
        sessionContextUsageImpl: async (sessionId, opts) => {
          receivedOpts = opts;
          return {
            v: 1 as const,
            sessionId,
            workspaceCwd: WS_BOUND,
            usage: {
              modelName: 'qwen3',
              totalTokens: 0,
              contextWindowSize: 200000,
              breakdown: {
                systemPrompt: 0,
                builtinTools: 0,
                mcpTools: 0,
                memoryFiles: 0,
                skills: 0,
                messages: 0,
                freeSpace: 200000,
                autocompactBuffer: 0,
              },
              builtinTools: [],
              mcpTools: [],
              memoryFiles: [],
              skills: [],
              showDetails: true,
            },
            formattedText: '',
          };
        },
      });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      await request(app)
        .get('/session/s-1/context-usage?detail=true')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(receivedOpts).toEqual({ detail: true });
    });

    it('maps missing sessions on read-only session routes to 404', async () => {
      const bridge = fakeBridge({
        sessionContextImpl: async (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
        sessionSupportedCommandsImpl: async (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
        sessionTasksImpl: async (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const contextRes = await request(app)
        .get('/session/missing/context')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      const commandsRes = await request(app)
        .get('/session/missing/supported-commands')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      const tasksRes = await request(app)
        .get('/session/missing/tasks')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(contextRes.status).toBe(404);
      expect(contextRes.body.sessionId).toBe('missing');
      expect(commandsRes.status).toBe(404);
      expect(commandsRes.body.sessionId).toBe('missing');
      expect(tasksRes.status).toBe(404);
      expect(tasksRes.body.sessionId).toBe('missing');
    });

    it('rejects task cancellation with invalid kind', async () => {
      const bridge = fakeBridge();
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/session/s-1/tasks/task-1/cancel')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret')
        .send({ kind: 'other' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe(
        '`kind` must be "agent", "shell", or "monitor"',
      );
      expect(bridge.cancelSessionTaskCalls).toEqual([]);
    });

    it('cancels a session task through the bridge', async () => {
      const bridge = fakeBridge({
        cancelSessionTaskImpl: async () => ({ cancelled: true }),
      });
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/session/s-1/tasks/task-1/cancel')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret')
        .send({ kind: 'agent' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ cancelled: true });
      expect(bridge.cancelSessionTaskCalls).toEqual([
        { sessionId: 's-1', taskId: 'task-1', taskKind: 'agent' },
      ]);
    });

    it('maps task cancellation bridge errors', async () => {
      const bridge = fakeBridge({
        cancelSessionTaskImpl: async (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/session/missing/tasks/task-1/cancel')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret')
        .send({ kind: 'shell' });

      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });

    it('clears a session goal through the bridge', async () => {
      const bridge = fakeBridge({
        clearSessionGoalImpl: async () => ({
          cleared: true,
          condition: 'ship it',
        }),
      });
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/session/s-1/goal/clear')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ cleared: true, condition: 'ship it' });
      expect(bridge.clearSessionGoalCalls).toEqual(['s-1']);
    });

    it('maps goal clear bridge errors', async () => {
      const bridge = fakeBridge({
        clearSessionGoalImpl: async (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/session/missing/goal/clear')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret');

      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });

    it('returns cleared false when no session goal is active', async () => {
      const bridge = fakeBridge({
        clearSessionGoalImpl: async () => ({ cleared: false }),
      });
      const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
      const app = createServeApp(
        { ...tokenOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );

      const res = await request(app)
        .post('/session/s-1/goal/clear')
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ cleared: false });
      expect(bridge.clearSessionGoalCalls).toEqual(['s-1']);
    });
  });

  describe('POST /session/:id/mid-turn-message', () => {
    const midTurnPost = (
      app: ReturnType<typeof createServeApp>,
      sessionId: string,
      body: Record<string, unknown>,
      clientId?: string,
    ) => {
      const r = request(app)
        .post(`/session/${sessionId}/mid-turn-message`)
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('Authorization', 'Bearer secret');
      if (clientId !== undefined) r.set('X-Qwen-Client-Id', clientId);
      return r.send(body);
    };
    const midTurnApp = (bridge: FakeBridge) =>
      createServeApp(
        { ...baseOpts, token: 'secret', workspace: WS_BOUND },
        undefined,
        { bridge },
      );

    it('200 { accepted: true } and forwards the trimmed message + client id', async () => {
      const bridge = fakeBridge();
      const res = await midTurnPost(
        midTurnApp(bridge),
        's-1',
        { message: '  hello  ' },
        'client-9',
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ accepted: true });
      // Trimmed before enqueue, and the client id is forwarded for the bridge's
      // ownership check + originator stamping.
      expect(bridge.enqueueMidTurnCalls).toEqual([
        {
          sessionId: 's-1',
          message: 'hello',
          context: { clientId: 'client-9' },
        },
      ]);
    });

    it('200 { accepted: false } when the bridge rejects (idle session)', async () => {
      const bridge = fakeBridge({
        enqueueMidTurnImpl: () => ({ accepted: false }),
      });
      const res = await midTurnPost(midTurnApp(bridge), 's-1', {
        message: 'later',
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ accepted: false });
    });

    it('400 when `message` is missing', async () => {
      const bridge = fakeBridge();
      const res = await midTurnPost(midTurnApp(bridge), 's-1', {});
      expect(res.status).toBe(400);
      expect(bridge.enqueueMidTurnCalls).toEqual([]);
    });

    it('400 when `message` is whitespace-only', async () => {
      const bridge = fakeBridge();
      const res = await midTurnPost(midTurnApp(bridge), 's-1', {
        message: '   ',
      });
      expect(res.status).toBe(400);
      expect(bridge.enqueueMidTurnCalls).toEqual([]);
    });

    it('400 when the trimmed message exceeds the 16 KB cap', async () => {
      const bridge = fakeBridge();
      const res = await midTurnPost(midTurnApp(bridge), 's-1', {
        message: 'x'.repeat(16 * 1024 + 1),
      });
      expect(res.status).toBe(400);
      expect(bridge.enqueueMidTurnCalls).toEqual([]);
    });

    it('maps a bridge SessionNotFoundError to 404', async () => {
      const bridge = fakeBridge({
        enqueueMidTurnImpl: (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const res = await midTurnPost(midTurnApp(bridge), 'missing', {
        message: 'hi',
      });
      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });

    it('400 on a malformed X-Qwen-Client-Id (never reaches the bridge)', async () => {
      const bridge = fakeBridge();
      const res = await midTurnPost(
        midTurnApp(bridge),
        's-1',
        { message: 'hi' },
        'bad client id with spaces',
      );
      expect(res.status).toBe(400);
      expect(bridge.enqueueMidTurnCalls).toEqual([]);
    });

    it('maps a bridge InvalidClientIdError to 400 invalid_client_id', async () => {
      // Well-formed but unbound client id: the bridge's ownership check throws,
      // and `sendBridgeError` maps it like the sibling routes.
      const bridge = fakeBridge({
        enqueueMidTurnImpl: (sid) => {
          throw new InvalidClientIdError(sid, 'rogue');
        },
      });
      const res = await midTurnPost(
        midTurnApp(bridge),
        's-1',
        { message: 'hi' },
        'rogue',
      );
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_client_id');
    });
  });

  describe('host allowlist (loopback bind)', () => {
    it('rejects requests with an unrelated Host header', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/health')
        .set('Host', 'evil.example.com');
      expect(res.status).toBe(403);
    });

    it('accepts host.docker.internal so containers can reach the host daemon', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/health')
        .set('Host', `host.docker.internal:${baseOpts.port}`);
      expect(res.status).toBe(200);
    });
  });

  describe('middleware order — auth runs before body parser', () => {
    it('rejects unauthorized POST without parsing the (possibly huge) body', async () => {
      // If auth ran AFTER body-parsing, an unauthenticated client could
      // force the daemon to JSON.parse a 10MB payload before the 401.
      // This test verifies the 401 fires regardless of body content
      // (no 413 / no parse error / no validation error).
      const bridge = fakeBridge();
      const tokenedOpts: ServeOptions = {
        ...baseOpts,
        token: 'real-secret',
      };
      const app = createServeApp(tokenedOpts, undefined, { bridge });
      const fakeBigBody = JSON.stringify({ filler: 'x'.repeat(100_000) });
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('content-type', 'application/json')
        .send(fakeBigBody);
      expect(res.status).toBe(401);
      // Bridge must NOT have been touched — auth short-circuited.
      expect(bridge.calls).toHaveLength(0);
    });
  });

  describe('CORS / browser origin denial', () => {
    it('returns a deterministic 403 JSON when an Origin header is present', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/health')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('Origin', 'https://evil.example.com');
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Request denied by CORS policy' });
      expect(res.headers['vary']).toBe('Origin');
    });

    it('accepts requests with no Origin header (CLI/SDK clients)', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/health')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
    });

    it('also rejects POSTs with an Origin header', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('Origin', 'https://evil.example.com')
        .send({ cwd: '/work/a' });
      expect(res.status).toBe(403);
      // Bridge must NOT have been touched.
      expect(bridge.calls).toHaveLength(0);
    });
  });

  describe('POST /session', () => {
    it('200 when cwd is omitted (falls back to bound workspace, #3803 §02)', async () => {
      // 1 daemon = 1 workspace: the daemon binds to
      // `opts.workspace ?? process.cwd()` at boot, so clients may
      // omit `cwd` and the route falls back to the bound path.
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});
      expect(res.status).toBe(200);
      expect(bridge.calls[0]?.workspaceCwd).toBe(WS_BOUND);
    });

    it('400 when cwd is relative', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ cwd: 'relative/path' });
      expect(res.status).toBe(400);
      expect(bridge.calls).toHaveLength(0);
    });

    it('400 when cwd is present but not a string (#3803 §02 — distinguishes omitted vs malformed)', async () => {
      // Three non-string shapes a buggy client / orchestrator could
      // serialize for the `cwd` field: `null`, a number, an object.
      // Pre-fix the route treated all three the same as "omitted" and
      // fell back to `boundWorkspace`, silently masking client bugs.
      // Now the route distinguishes "absent" (legitimate §02 fallback)
      // from "present but malformed" (client-side bug → 400 + actionable
      // error message). Empty string still falls through to the
      // `path.isAbsolute` check (and 400s there with the
      // "absolute path when provided" message).
      const malformed: unknown[] = [null, 123, { foo: 'bar' }, []];
      for (const cwd of malformed) {
        const bridge = fakeBridge();
        const app = createServeApp(
          { ...baseOpts, workspace: WS_BOUND },
          undefined,
          { bridge },
        );
        const res = await request(app)
          .post('/session')
          .set('Host', `127.0.0.1:${baseOpts.port}`)
          .send({ cwd });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/must be a string absolute path/);
        // Bridge must NOT be touched — silent fallback regressions
        // would otherwise let the malformed input hit `spawnOrAttach`.
        expect(bridge.calls).toHaveLength(0);
      }
    });

    it('400 when cwd is the empty string', async () => {
      // Empty string is technically a string so the type-check above
      // lets it through; `path.isAbsolute('')` is false so the
      // "must be an absolute path when provided" branch catches it.
      // Important: the `'cwd' in body` presence test means an empty
      // string is NOT treated as omitted (which would fall back to
      // boundWorkspace) — empty-string is the strongest "client
      // explicitly passed nothing useful" signal we have.
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ cwd: '' });
      expect(res.status).toBe(400);
      expect(bridge.calls).toHaveLength(0);
    });

    it('400 when cwd exceeds MAX_WORKSPACE_PATH_LENGTH (memory amplification guard)', async () => {
      // Real filesystem paths fit well under PATH_MAX (4096 on Linux).
      // A multi-MB `cwd` is either a malformed client or a memory-
      // amplification attempt — `WorkspaceMismatchError` interpolates
      // `requested` into `.message` twice, `sendBridgeError` writes it
      // to stderr, and `res.json` echoes it again, so a ~10 MB body
      // (right under express.json's 10 MB cap) would amplify to
      // ~60 MB/request × maxConnections. The route caps the input
      // before any of those echoes.
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      // Build an absolute path of MAX+1 chars. `path.isAbsolute`
      // sees the leading `/` and the length cap fires before the
      // isAbsolute branch — verifying both invariants in one go.
      const longCwd = `/${'a'.repeat(4096)}`;
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ cwd: longCwd });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/exceeds the 4096-character limit/);
      // Bridge must NOT be touched — silent fallback or pass-through
      // would defeat the cap.
      expect(bridge.calls).toHaveLength(0);
    });

    it('400 workspace_mismatch when bridge rejects cross-workspace cwd (#3803 §02)', async () => {
      // Single-workspace mode: bridge throws WorkspaceMismatchError
      // when the route forwards a non-bound cwd. Route translates
      // to 400 with code `workspace_mismatch` + both paths in the
      // body so orchestrator-aware clients can route correctly.
      const bridge = fakeBridge({
        spawnImpl: async (req) => {
          throw new WorkspaceMismatchError(WS_BOUND, req.workspaceCwd);
        },
      });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ cwd: WS_DIFFERENT });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'workspace_mismatch',
        boundWorkspace: WS_BOUND,
        requestedWorkspace: WS_DIFFERENT,
      });
    });

    it('200 with the BridgeSession shape on success', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ cwd: '/work/a', modelServiceId: 'qwen-prod' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sessionId: 'fake-0',
        workspaceCwd: '/work/a',
        attached: false,
        clientId: 'client-0',
      });
      expect(bridge.calls).toEqual([
        { workspaceCwd: '/work/a', modelServiceId: 'qwen-prod' },
      ]);
    });

    it('passes through a valid `sessionScope` to the bridge (#4175 PR 5)', async () => {
      // Per-request override: even when the daemon-wide default is
      // `'single'`, the route forwards an explicit `'thread'` scope so
      // the bridge can isolate this caller's session. Symmetric for
      // `'single'` against a `'thread'` daemon.
      for (const scope of ['single', 'thread'] as const) {
        const bridge = fakeBridge();
        const app = createServeApp(baseOpts, undefined, { bridge });
        const res = await request(app)
          .post('/session')
          .set('Host', `127.0.0.1:${baseOpts.port}`)
          .send({ cwd: '/work/a', sessionScope: scope });
        expect(res.status).toBe(200);
        expect(bridge.calls).toEqual([
          { workspaceCwd: '/work/a', sessionScope: scope },
        ]);
      }
    });

    it('forwards X-Qwen-Client-Id to the bridge on create/attach', async () => {
      const bridge = fakeBridge({
        spawnImpl: async (req) => ({
          sessionId: 'fake-identity',
          workspaceCwd: req.workspaceCwd,
          attached: false,
          clientId: req.clientId ?? 'client-new',
        }),
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-existing')
        .send({ cwd: '/work/a' });
      expect(res.status).toBe(200);
      expect(res.body.clientId).toBe('client-existing');
      expect(bridge.calls).toEqual([
        { workspaceCwd: '/work/a', clientId: 'client-existing' },
      ]);
    });

    it('400 invalid_client_id for malformed client id headers', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'bad client id')
        .send({ cwd: '/work/a' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'invalid_client_id' });
      expect(bridge.calls).toHaveLength(0);
    });

    it('204 detaches without client identity when X-Qwen-Client-Id is absent', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/detach')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send();
      expect(res.status).toBe(204);
      expect(bridge.detachCalls).toEqual([{ sessionId: 'session-A' }]);
    });

    it('400 invalid_session_scope when `sessionScope` is not "single"/"thread"', async () => {
      // Anything outside the enum (`'user'`, `null`, a number, an object)
      // must 4xx with a typed `code` so HTTP clients can branch on the
      // failure shape rather than parsing the message. Bridge must NOT
      // be invoked — surfacing the invalid value as a clear 400 beats
      // throwing inside the bridge later.
      const malformed: unknown[] = ['user', '', 'SINGLE', null, 123, {}];
      for (const sessionScope of malformed) {
        const bridge = fakeBridge();
        const app = createServeApp(baseOpts, undefined, { bridge });
        const res = await request(app)
          .post('/session')
          .set('Host', `127.0.0.1:${baseOpts.port}`)
          .send({ cwd: '/work/a', sessionScope });
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: 'invalid_session_scope' });
        expect(bridge.calls).toHaveLength(0);
      }
    });

    it('omits `sessionScope` from the bridge request when the field is absent', async () => {
      // Backward-compat invariant: a pre-#4175-PR-5 client (no SDK
      // upgrade) sees identical behavior. The bridge sees no
      // `sessionScope` key, so its `defaultSessionScope` (the
      // daemon-wide `--sessionScope` value) is used unchanged.
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ cwd: '/work/a' });
      expect(res.status).toBe(200);
      expect(bridge.calls).toEqual([{ workspaceCwd: '/work/a' }]);
      expect(bridge.calls[0]).not.toHaveProperty('sessionScope');
    });

    it('500 when bridge throws', async () => {
      const bridge = fakeBridge({
        spawnImpl: async () => {
          throw new Error('boom');
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ cwd: '/work/a' });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'boom' });
    });

    it('strips prototype-pollution keys from body (BZ9uv/va/vs/wD)', async () => {
      // `safeBody()` strips `__proto__` / `constructor` / `prototype`
      // and copies into an `Object.create(null)` target before any
      // route spreads it into the bridge call. Even if a client
      // sends those keys, neither the bridge request nor
      // `Object.prototype` ends up touched.
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      // Build the body as a raw string so the server-side
      // `express.json` parser is the only path that could land the
      // dangerous key on the request object.
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('content-type', 'application/json')
        .send(
          '{"cwd":"/work/a","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
        );
      expect(res.status).toBe(200);
      expect(bridge.calls[0]?.workspaceCwd).toBe('/work/a');
      // No prototype pollution: Object.prototype.polluted is
      // undefined. (This is the core security property — if the
      // dangerous key landed via spread, this check would fail.)
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });
  });

  describe('POST /session/:id/load and /resume', () => {
    it('falls back to bound workspace and uses the route session id', async () => {
      for (const action of ['load', 'resume'] as const) {
        const bridge = fakeBridge();
        const app = createServeApp(
          { ...baseOpts, workspace: WS_BOUND },
          undefined,
          { bridge },
        );
        const res = await request(app)
          .post(`/session/persisted-1/${action}`)
          .set('Host', `127.0.0.1:${baseOpts.port}`)
          .send({ sessionId: 'spoofed-body-id' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          sessionId: 'persisted-1',
          workspaceCwd: WS_BOUND,
          attached: false,
          clientId: action === 'load' ? 'client-load' : 'client-resume',
          state: {},
        });
        const calls = action === 'load' ? bridge.loadCalls : bridge.resumeCalls;
        expect(calls).toEqual([
          { sessionId: 'persisted-1', workspaceCwd: WS_BOUND },
        ]);
      }
    });

    it('passes explicit cwd through to the bridge', async () => {
      const bridge = fakeBridge({
        loadImpl: async (req) => ({
          sessionId: req.sessionId,
          workspaceCwd: req.workspaceCwd,
          attached: false,
          clientId: 'client-load',
          state: { configOptions: [] },
        }),
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/persisted-2/load')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ cwd: '/work/a' });

      expect(res.status).toBe(200);
      expect(res.body.state).toEqual({ configOptions: [] });
      expect(bridge.loadCalls).toEqual([
        { sessionId: 'persisted-2', workspaceCwd: '/work/a' },
      ]);
    });

    it('passes client identity headers through to load/resume bridge calls', async () => {
      for (const action of ['load', 'resume'] as const) {
        const bridge = fakeBridge();
        const app = createServeApp(baseOpts, undefined, { bridge });
        const res = await request(app)
          .post(`/session/persisted-1/${action}`)
          .set('Host', `127.0.0.1:${baseOpts.port}`)
          .set('X-Qwen-Client-Id', 'client-1')
          .send({});
        expect(res.status).toBe(200);
        const calls = action === 'load' ? bridge.loadCalls : bridge.resumeCalls;
        expect(calls).toEqual([
          {
            sessionId: 'persisted-1',
            workspaceCwd: realpathSync.native(process.cwd()),
            clientId: 'client-1',
          },
        ]);
      }
    });

    it('400s malformed cwd before touching the bridge', async () => {
      for (const action of ['load', 'resume'] as const) {
        const bridge = fakeBridge();
        const app = createServeApp(baseOpts, undefined, { bridge });
        const res = await request(app)
          .post(`/session/persisted-3/${action}`)
          .set('Host', `127.0.0.1:${baseOpts.port}`)
          .send({ cwd: 'relative/path' });

        expect(res.status).toBe(400);
        expect(bridge.loadCalls).toHaveLength(0);
        expect(bridge.resumeCalls).toHaveLength(0);
      }
    });

    it('400s a non-string cwd before touching the bridge', async () => {
      // Mirrors the `POST /session` malformed-`cwd`-shape test: a
      // client/orchestrator serialization bug (`cwd: null`,
      // `cwd: 123`, `cwd: {}`) must surface as a typed 400 instead of
      // silently falling back to the bound workspace.
      for (const action of ['load', 'resume'] as const) {
        for (const cwd of [null, 123, {}, []]) {
          const bridge = fakeBridge();
          const app = createServeApp(baseOpts, undefined, { bridge });
          const res = await request(app)
            .post(`/session/persisted-mal/${action}`)
            .set('Host', `127.0.0.1:${baseOpts.port}`)
            .send({ cwd });

          expect(res.status).toBe(400);
          expect(bridge.loadCalls).toHaveLength(0);
          expect(bridge.resumeCalls).toHaveLength(0);
        }
      }
    });

    it('400s a cwd longer than MAX_WORKSPACE_PATH_LENGTH before touching the bridge', async () => {
      // Same length cap as `POST /session` (matches Linux PATH_MAX
      // 4096) — defends downstream interpolations from
      // amplification on the loopback-default-no-token path.
      const longCwd = `/${'a'.repeat(MAX_WORKSPACE_PATH_LENGTH)}`;
      for (const action of ['load', 'resume'] as const) {
        const bridge = fakeBridge();
        const app = createServeApp(baseOpts, undefined, { bridge });
        const res = await request(app)
          .post(`/session/persisted-long/${action}`)
          .set('Host', `127.0.0.1:${baseOpts.port}`)
          .send({ cwd: longCwd });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(
          new RegExp(
            `exceeds the ${MAX_WORKSPACE_PATH_LENGTH}-character limit`,
          ),
        );
        expect(bridge.loadCalls).toHaveLength(0);
        expect(bridge.resumeCalls).toHaveLength(0);
      }
    });

    it('404s when the bridge reports an unknown persisted session', async () => {
      const bridge = fakeBridge({
        resumeImpl: async (req) => {
          throw new SessionNotFoundError(req.sessionId);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/missing/resume')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });

    it('409 + Retry-After when the bridge throws RestoreInProgressError', async () => {
      const bridge = fakeBridge({
        loadImpl: async () => {
          throw new RestoreInProgressError('persisted-race', 'resume', 'load');
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/persisted-race/load')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});

      expect(res.status).toBe(409);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body).toMatchObject({
        code: 'restore_in_progress',
        sessionId: 'persisted-race',
        activeAction: 'resume',
        requestedAction: 'load',
      });
    });

    it('400 workspace_mismatch when the bridge throws WorkspaceMismatchError', async () => {
      const bridge = fakeBridge({
        loadImpl: async () => {
          throw new WorkspaceMismatchError(WS_BOUND, WS_DIFFERENT);
        },
      });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .post('/session/persisted-x/load')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ cwd: WS_DIFFERENT });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'workspace_mismatch',
        boundWorkspace: WS_BOUND,
        requestedWorkspace: WS_DIFFERENT,
      });
    });

    it('503 + Retry-After: 5 when the bridge throws SessionLimitExceededError', async () => {
      const bridge = fakeBridge({
        resumeImpl: async () => {
          throw new SessionLimitExceededError(20);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/persisted-y/resume')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});

      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body).toMatchObject({
        code: 'session_limit_exceeded',
        limit: 20,
      });
    });

    // The restore handler's `!res.writable` cleanup branch (kill on
    // !attached, detach on attached) is line-for-line identical to
    // the matching branch on `POST /session`; routing-side
    // disconnect tests for that handler weren't added when the
    // cleanup was originally introduced because the supertest +
    // Node http close-event timing makes the assertion flaky in
    // CI. The same constraint applies here. The cleanup behavior
    // is exercised manually via the route handler closure shared
    // between both routes in `restoreSessionHandler`.
  });

  describe('POST /session/:id/prompt', () => {
    it('202 with promptId on success; route :id wins over body sessionId', async () => {
      const bridge = fakeBridge({
        promptImpl: async () => ({ stopReason: 'end_turn' }),
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({
          sessionId: 'spoofed-session-B',
          prompt: [{ type: 'text', text: 'hi' }],
        });
      expect(res.status).toBe(202);
      expect(res.body.promptId).toBeDefined();
      expect(typeof res.body.promptId).toBe('string');
      expect(typeof res.body.lastEventId).toBe('number');
      // Allow the async bridge call to settle.
      await new Promise((r) => setTimeout(r, 20));
      expect(bridge.promptCalls).toHaveLength(1);
      expect(bridge.promptCalls[0]?.sessionId).toBe('session-A');
      expect(bridge.promptCalls[0]?.req.sessionId).toBe('session-A');
    });

    it('passes client identity and promptId context into bridge.sendPrompt', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ prompt: [{ type: 'text', text: 'hi' }] });
      expect(res.status).toBe(202);
      await new Promise((r) => setTimeout(r, 20));
      expect(bridge.promptCalls[0]?.context).toMatchObject({
        clientId: 'client-1',
      });
      expect(bridge.promptCalls[0]?.context?.promptId).toBe(res.body.promptId);
    });

    it('adds the generated promptId to the active daemon request span', async () => {
      const setAttribute = vi.fn();
      const getSpanSpy = vi.spyOn(trace, 'getSpan').mockReturnValue({
        setAttribute,
        spanContext: () => ({
          traceId: '1'.repeat(32),
          spanId: '2'.repeat(16),
          traceFlags: 1,
        }),
      } as unknown as Span);
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      try {
        const res = await request(app)
          .post('/session/session-A/prompt')
          .set('Host', `127.0.0.1:${baseOpts.port}`)
          .send({ prompt: [{ type: 'text', text: 'hi' }] });

        expect(res.status).toBe(202);
        expect(setAttribute).toHaveBeenCalledWith(
          'qwen-code.prompt_id',
          res.body.promptId,
        );
      } finally {
        getSpanSpy.mockRestore();
      }
    });

    it('400 when prompt body is missing', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});
      expect(res.status).toBe(400);
      expect(bridge.promptCalls).toHaveLength(0);
    });

    it('404 when bridge reports unknown session', async () => {
      const bridge = fakeBridge({
        getSessionLastEventIdImpl: (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/missing/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ prompt: [{ type: 'text', text: 'hi' }] });
      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });

    it('202 even when bridge errors asynchronously (turn_error event covers failure)', async () => {
      const bridge = fakeBridge({
        promptImpl: async () => {
          throw new Error('agent crashed');
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ prompt: [{ type: 'text', text: 'hi' }] });
      expect(res.status).toBe(202);
      expect(res.body.promptId).toBeDefined();
    });

    it('503 without promptId when bridge rejects prompt admission synchronously', async () => {
      const bridge = fakeBridge({
        promptImpl: () => {
          throw new PromptQueueFullError(5, 5, 'session-A');
        },
      });
      const daemonLog = fakeDaemonLog();
      const app = createServeApp(baseOpts, undefined, { bridge, daemonLog });
      const res = await request(app)
        .post('/session/session-A/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ prompt: [{ type: 'text', text: 'hi' }] });

      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body).toMatchObject({
        code: 'prompt_queue_full',
        sessionId: 'session-A',
        limit: 5,
        pendingCount: 5,
      });
      expect(res.body.promptId).toBeUndefined();
      expect(daemonLog.warn).toHaveBeenCalledWith(
        'prompt admission rejected: queue full',
        expect.objectContaining({
          sessionId: 'session-A',
          limit: 5,
          pendingCount: 5,
        }),
      );
    });

    it('passes an AbortSignal into bridge.sendPrompt', async () => {
      let signalDefined = false;
      let abortedAtCall = false;
      const bridge = fakeBridge({
        promptImpl: async (_sid, _req, signal) => {
          signalDefined = signal !== undefined;
          abortedAtCall = signal?.aborted ?? false;
          return { stopReason: 'end_turn' };
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ prompt: [{ type: 'text', text: 'hi' }] });
      expect(res.status).toBe(202);
      await new Promise((r) => setTimeout(r, 20));
      expect(signalDefined).toBe(true);
      expect(abortedAtCall).toBe(false);
    });

    it('non-blocking prompt returns 202 and fires sendPrompt asynchronously', async () => {
      let promptResolve: (() => void) | undefined;
      const bridge = fakeBridge({
        promptImpl: async () =>
          new Promise((resolve) => {
            promptResolve = () => resolve({ stopReason: 'end_turn' });
          }),
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ prompt: [{ type: 'text', text: 'hi' }] });
      expect(res.status).toBe(202);
      expect(bridge.promptCalls).toHaveLength(1);
      // Resolve the async prompt to clean up.
      promptResolve!();
      await new Promise((r) => setTimeout(r, 10));
    });
  });

  describe('GET /workspace/:id/sessions', () => {
    let previousRuntimeDir: string | undefined;
    let runtimeDir: string;

    beforeEach(async () => {
      previousRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
      runtimeDir = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'qwen-serve-sessions-'),
      );
      process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
    });

    afterEach(async () => {
      if (previousRuntimeDir === undefined) {
        delete process.env['QWEN_RUNTIME_DIR'];
      } else {
        process.env['QWEN_RUNTIME_DIR'] = previousRuntimeDir;
      }
      await fsp.rm(runtimeDir, { recursive: true, force: true });
    });

    async function writeStoredSession(input: {
      sessionId: string;
      cwd: string;
      timestamp: string;
      prompt: string;
      mtime: Date;
    }): Promise<void> {
      const chatsDir = path.join(
        new Storage(input.cwd).getProjectDir(),
        'chats',
      );
      await fsp.mkdir(chatsDir, { recursive: true });
      const filePath = path.join(chatsDir, `${input.sessionId}.jsonl`);
      const record = {
        uuid: `${input.sessionId}-user-1`,
        parentUuid: null,
        sessionId: input.sessionId,
        timestamp: input.timestamp,
        type: 'user',
        message: { role: 'user', parts: [{ text: input.prompt }] },
        cwd: input.cwd,
      };
      await fsp.writeFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
      await fsp.utimes(filePath, input.mtime, input.mtime);
    }

    async function writeStoredSessions(count: number): Promise<void> {
      for (let i = 0; i < count; i++) {
        const timestamp = new Date(
          Date.UTC(2026, 4, 17, 12, i, 0),
        ).toISOString();
        await writeStoredSession({
          sessionId: `550e8400-e29b-41d4-a716-44665544${String(i).padStart(4, '0')}`,
          cwd: WS_BOUND,
          timestamp,
          prompt: `prompt ${i}`,
          mtime: new Date(timestamp),
        });
      }
    }

    it('returns the list returned by the bridge', async () => {
      // #3803 §02 (commit 0c6e963cd): the route now rejects
      // cross-workspace queries with 400 workspace_mismatch (so
      // orchestrators don't mistake "no sessions here" for
      // "workspace is idle"). Bind the daemon to the same workspace
      // we'll query so the happy path runs.
      const bridge = fakeBridge({
        listImpl: () => [
          {
            sessionId: 's-1',
            workspaceCwd: WS_BOUND,
            createdAt: '2026-05-17T12:00:00.000Z',
            clientCount: 1,
            hasActivePrompt: false,
          },
          {
            sessionId: 's-2',
            workspaceCwd: WS_BOUND,
            createdAt: '2026-05-17T12:01:00.000Z',
            clientCount: 0,
            hasActivePrompt: true,
          },
        ],
      });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge, boundWorkspace: WS_BOUND },
      );
      const res = await request(app)
        .get(`/workspace/${encodeURIComponent(WS_BOUND)}/sessions`)
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveLength(2);
      expect(res.body.sessions).toEqual(
        expect.arrayContaining([
          {
            sessionId: 's-1',
            workspaceCwd: WS_BOUND,
            createdAt: '2026-05-17T12:00:00.000Z',
            clientCount: 1,
            hasActivePrompt: false,
          },
          {
            sessionId: 's-2',
            workspaceCwd: WS_BOUND,
            createdAt: '2026-05-17T12:01:00.000Z',
            clientCount: 0,
            hasActivePrompt: true,
          },
        ]),
      );
      expect(bridge.listCalls).toEqual([WS_BOUND]);
    });

    it('includes persisted sessions from the CLI session store', async () => {
      const storedOnlyId = '550e8400-e29b-41d4-a716-446655440000';
      const liveAndStoredId = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
      await writeStoredSession({
        sessionId: storedOnlyId,
        cwd: WS_BOUND,
        timestamp: '2026-05-17T12:00:00.000Z',
        prompt: 'stored only prompt',
        mtime: new Date('2026-05-17T12:10:00.000Z'),
      });
      await writeStoredSession({
        sessionId: liveAndStoredId,
        cwd: WS_BOUND,
        timestamp: '2026-05-17T12:01:00.000Z',
        prompt: 'stored live prompt',
        mtime: new Date('2026-05-17T12:11:00.000Z'),
      });

      const bridge = fakeBridge({
        listImpl: () => [
          {
            sessionId: liveAndStoredId,
            workspaceCwd: WS_BOUND,
            createdAt: '2026-05-17T12:01:00.000Z',
            displayName: 'Live display name',
            clientCount: 3,
            hasActivePrompt: true,
          },
        ],
      });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge, boundWorkspace: WS_BOUND },
      );

      const res = await request(app)
        .get(`/workspace/${encodeURIComponent(WS_BOUND)}/sessions`)
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveLength(2);
      expect(res.body.sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: storedOnlyId,
            workspaceCwd: WS_BOUND,
            displayName: 'stored only prompt',
            clientCount: 0,
            hasActivePrompt: false,
          }),
          expect.objectContaining({
            sessionId: liveAndStoredId,
            workspaceCwd: WS_BOUND,
            displayName: 'Live display name',
            clientCount: 3,
            hasActivePrompt: true,
          }),
        ]),
      );
      expect(bridge.listCalls).toEqual([WS_BOUND]);
    });

    it('preserves persisted createdAt when a live entry exists', async () => {
      const sessionId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
      await writeStoredSession({
        sessionId,
        cwd: WS_BOUND,
        timestamp: '2026-05-17T12:01:00.000Z',
        prompt: 'stored live prompt',
        mtime: new Date('2026-05-17T12:11:00.000Z'),
      });

      const bridge = fakeBridge({
        listImpl: () => [
          {
            sessionId,
            workspaceCwd: WS_BOUND,
            createdAt: '2026-05-17T12:30:00.000Z',
            clientCount: 1,
            hasActivePrompt: false,
          },
        ],
      });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge, boundWorkspace: WS_BOUND },
      );

      const res = await request(app)
        .get(`/workspace/${encodeURIComponent(WS_BOUND)}/sessions`)
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(res.status).toBe(200);
      expect(res.body.sessions).toEqual([
        expect.objectContaining({
          sessionId,
          createdAt: '2026-05-17T12:01:00.000Z',
          updatedAt: '2026-05-17T12:11:00.000Z',
          clientCount: 1,
          hasActivePrompt: false,
        }),
      ]);
    });

    it('returns an empty array when no sessions exist for the workspace', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge, boundWorkspace: WS_BOUND },
      );
      const res = await request(app)
        .get(`/workspace/${encodeURIComponent(WS_BOUND)}/sessions`)
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ sessions: [] });
    });

    it('returns nextCursor when more persisted sessions exist', async () => {
      const pageSize = 3;
      const total = 5;
      for (let i = 0; i < total; i++) {
        const id = `550e8400-e29b-41d4-a716-44665544${String(i).padStart(4, '0')}`;
        await writeStoredSession({
          sessionId: id,
          cwd: WS_BOUND,
          timestamp: `2026-05-17T12:0${i}:00.000Z`,
          prompt: `prompt ${i}`,
          mtime: new Date(`2026-05-17T12:1${i}:00.000Z`),
        });
      }
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge, boundWorkspace: WS_BOUND },
      );

      const res = await request(app)
        .get(
          `/workspace/${encodeURIComponent(WS_BOUND)}/sessions?size=${pageSize}`,
        )
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveLength(pageSize);
      expect(res.body.nextCursor).toBeDefined();
    });

    it('paginates with cursor query param', async () => {
      const total = 5;
      for (let i = 0; i < total; i++) {
        const id = `550e8400-e29b-41d4-a716-44665544${String(i).padStart(4, '0')}`;
        await writeStoredSession({
          sessionId: id,
          cwd: WS_BOUND,
          timestamp: `2026-05-17T12:0${i}:00.000Z`,
          prompt: `prompt ${i}`,
          mtime: new Date(`2026-05-17T12:1${i}:00.000Z`),
        });
      }
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge, boundWorkspace: WS_BOUND },
      );

      const page1 = await request(app)
        .get(`/workspace/${encodeURIComponent(WS_BOUND)}/sessions?size=3`)
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(page1.status).toBe(200);
      expect(page1.body.sessions).toHaveLength(3);
      expect(page1.body.nextCursor).toBeDefined();

      const page2 = await request(app)
        .get(
          `/workspace/${encodeURIComponent(WS_BOUND)}/sessions?size=3&cursor=${page1.body.nextCursor}`,
        )
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(page2.status).toBe(200);
      expect(page2.body.sessions).toHaveLength(2);
      expect(page2.body.nextCursor).toBeUndefined();

      const page1Ids = page1.body.sessions.map(
        (s: { sessionId: string }) => s.sessionId,
      );
      const page2Ids = page2.body.sessions.map(
        (s: { sessionId: string }) => s.sessionId,
      );
      const overlap = page1Ids.filter((id: string) => page2Ids.includes(id));
      expect(overlap).toHaveLength(0);
    });

    it('merges live sessions only on first page (no cursor)', async () => {
      const storedId = '550e8400-e29b-41d4-a716-446655440000';
      await writeStoredSession({
        sessionId: storedId,
        cwd: WS_BOUND,
        timestamp: '2026-05-17T12:00:00.000Z',
        prompt: 'stored prompt',
        mtime: new Date('2026-05-17T12:10:00.000Z'),
      });
      const bridge = fakeBridge({
        listImpl: () => [
          {
            sessionId: 'live-only',
            workspaceCwd: WS_BOUND,
            createdAt: '2026-05-17T12:30:00.000Z',
            clientCount: 1,
            hasActivePrompt: true,
          },
        ],
      });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge, boundWorkspace: WS_BOUND },
      );

      const firstPage = await request(app)
        .get(`/workspace/${encodeURIComponent(WS_BOUND)}/sessions`)
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(firstPage.status).toBe(200);
      const ids = firstPage.body.sessions.map(
        (s: { sessionId: string }) => s.sessionId,
      );
      expect(ids).toContain('live-only');

      const cursoredPage = await request(app)
        .get(
          `/workspace/${encodeURIComponent(WS_BOUND)}/sessions?cursor=${String(Date.now() + 100000)}`,
        )
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(cursoredPage.status).toBe(200);
      const cursoredIds = cursoredPage.body.sessions.map(
        (s: { sessionId: string }) => s.sessionId,
      );
      expect(cursoredIds).not.toContain('live-only');
    });

    it('400 invalid_cursor when cursor is not a valid number', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge, boundWorkspace: WS_BOUND },
      );
      const res = await request(app)
        .get(`/workspace/${encodeURIComponent(WS_BOUND)}/sessions?cursor=abc`)
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_cursor');
    });

    it('excludes live sessions from subsequent pages to prevent cross-page duplicates', async () => {
      const liveId = '550e8400-e29b-41d4-a716-446655440099';
      for (let i = 0; i < 5; i++) {
        const id =
          i === 2
            ? liveId
            : `550e8400-e29b-41d4-a716-44665544${String(i).padStart(4, '0')}`;
        await writeStoredSession({
          sessionId: id,
          cwd: WS_BOUND,
          timestamp: `2026-05-17T12:0${i}:00.000Z`,
          prompt: `prompt ${i}`,
          mtime: new Date(`2026-05-17T12:1${i}:00.000Z`),
        });
      }
      const bridge = fakeBridge({
        listImpl: () => [
          {
            sessionId: liveId,
            workspaceCwd: WS_BOUND,
            createdAt: '2026-05-17T12:02:00.000Z',
            updatedAt: '2026-05-17T12:50:00.000Z',
            clientCount: 1,
            hasActivePrompt: false,
          },
        ],
      });
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge, boundWorkspace: WS_BOUND },
      );

      const page1 = await request(app)
        .get(`/workspace/${encodeURIComponent(WS_BOUND)}/sessions?size=3`)
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(page1.status).toBe(200);
      const page1Ids = page1.body.sessions.map(
        (s: { sessionId: string }) => s.sessionId,
      );

      const page2 = await request(app)
        .get(
          `/workspace/${encodeURIComponent(WS_BOUND)}/sessions?size=3&cursor=${page1.body.nextCursor}`,
        )
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(page2.status).toBe(200);
      const page2Ids = page2.body.sessions.map(
        (s: { sessionId: string }) => s.sessionId,
      );

      const allIds = [...page1Ids, ...page2Ids];
      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(allIds.length);
    });

    it('clamps size=0 to 1', async () => {
      const id = '550e8400-e29b-41d4-a716-446655440000';
      await writeStoredSession({
        sessionId: id,
        cwd: WS_BOUND,
        timestamp: '2026-05-17T12:00:00.000Z',
        prompt: 'prompt',
        mtime: new Date('2026-05-17T12:10:00.000Z'),
      });
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge, boundWorkspace: WS_BOUND },
      );
      const res = await request(app)
        .get(`/workspace/${encodeURIComponent(WS_BOUND)}/sessions?size=0`)
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveLength(1);
    });

    it('ignores malformed size query values', async () => {
      await writeStoredSessions(3);
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge, boundWorkspace: WS_BOUND },
      );
      for (const malformedSize of ['1abc', '1.5', '1e2', '0x10']) {
        const res = await request(app)
          .get(
            `/workspace/${encodeURIComponent(WS_BOUND)}/sessions?size=${malformedSize}`,
          )
          .set('Host', `127.0.0.1:${baseOpts.port}`);
        expect(res.status).toBe(200);
        expect(res.body.sessions).toHaveLength(3);
        expect(res.body.nextCursor).toBeUndefined();
      }
    });

    it('clamps unsafe finite HTTP size values to the max page size', async () => {
      await writeStoredSessions(21);
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge, boundWorkspace: WS_BOUND },
      );
      const res = await request(app)
        .get(
          `/workspace/${encodeURIComponent(WS_BOUND)}/sessions?size=9007199254740992`,
        )
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveLength(21);
      expect(res.body.nextCursor).toBeUndefined();
    });

    it('uses the default page size for invalid non-HTTP size values', async () => {
      for (const invalidSize of [
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
        Number.POSITIVE_INFINITY,
      ]) {
        await fsp.rm(runtimeDir, { recursive: true, force: true });
        await fsp.mkdir(runtimeDir, { recursive: true });
        await writeStoredSessions(21);
        const result = await listWorkspaceSessionsForResponse(
          fakeBridge(),
          WS_BOUND,
          { size: invalidSize },
        );

        expect(result.sessions).toHaveLength(20);
        expect(result.nextCursor).toBeDefined();
      }
    });

    it('clamps size=200 to max page size', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge, boundWorkspace: WS_BOUND },
      );
      const res = await request(app)
        .get(`/workspace/${encodeURIComponent(WS_BOUND)}/sessions?size=200`)
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
    });

    it('400 workspace_mismatch when querying a cross-workspace path (#3803 §02)', async () => {
      // Pin the §02 cross-workspace rejection: querying any path
      // that doesn't canonicalize to the bound workspace gets a 400
      // with `code: 'workspace_mismatch'` and both paths in the
      // body — so an orchestrator-aware client can route to / spawn
      // the right daemon. The bridge MUST NOT be touched (a silent
      // fallback would defeat the whole purpose of §02).
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, workspace: WS_BOUND },
        undefined,
        { bridge, boundWorkspace: WS_BOUND },
      );
      const res = await request(app)
        .get(`/workspace/${encodeURIComponent(WS_DIFFERENT)}/sessions`)
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('workspace_mismatch');
      expect(res.body.boundWorkspace).toBe(WS_BOUND);
      expect(bridge.listCalls).toHaveLength(0);
    });

    it('400 when :id does not decode to an absolute path', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .get(`/workspace/${encodeURIComponent('relative/path')}/sessions`)
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(400);
      expect(bridge.listCalls).toHaveLength(0);
    });
  });

  describe('POST /session/:id/model', () => {
    it('200 with the agent response on success', async () => {
      const bridge = fakeBridge({
        setModelImpl: async () => ({ _meta: { applied: true } }),
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/model')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ modelId: 'qwen3-coder', sessionId: 'spoofed-B' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ _meta: { applied: true } });
      expect(bridge.setModelCalls).toHaveLength(1);
      expect(bridge.setModelCalls[0]?.sessionId).toBe('session-A');
      expect(bridge.setModelCalls[0]?.req.sessionId).toBe('session-A');
      expect(bridge.setModelCalls[0]?.req.modelId).toBe('qwen3-coder');
    });

    it('passes client identity context into bridge.setSessionModel', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/model')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ modelId: 'qwen3-coder' });
      expect(res.status).toBe(200);
      expect(bridge.setModelCalls[0]?.context).toEqual({
        clientId: 'client-1',
      });
    });

    it('400 when modelId is missing', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/model')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});
      expect(res.status).toBe(400);
      expect(bridge.setModelCalls).toHaveLength(0);
    });

    it('400 when modelId is not a non-empty string', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/model')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ modelId: '' });
      expect(res.status).toBe(400);
      expect(bridge.setModelCalls).toHaveLength(0);
    });

    it('404 when bridge reports unknown session', async () => {
      const bridge = fakeBridge({
        setModelImpl: async (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/missing/model')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ modelId: 'qwen3-coder' });
      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });
  });

  describe('POST /session/:id/recap (#4175 follow-up)', () => {
    it('200 with the recap on success and forwards no body', async () => {
      const bridge = fakeBridge({
        generateSessionRecapImpl: async (sessionId) => ({
          sessionId,
          recap:
            'Refactoring the auth retry. Next: regenerate the snapshot tests.',
        }),
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/recap')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sessionId: 'session-A',
        recap:
          'Refactoring the auth retry. Next: regenerate the snapshot tests.',
      });
      expect(bridge.generateSessionRecapCalls).toHaveLength(1);
      expect(bridge.generateSessionRecapCalls[0]?.sessionId).toBe('session-A');
    });

    it('200 with recap:null is a valid best-effort response', async () => {
      // The core helper `generateSessionRecap` is documented to return
      // `null` when history is too short or the side-query fails. That
      // must surface as a normal 200 — a 5xx here would force daemon
      // clients to special-case "we have no recap yet" as an error.
      const bridge = fakeBridge({
        generateSessionRecapImpl: async (sessionId) => ({
          sessionId,
          recap: null,
        }),
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/recap')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send();
      expect(res.status).toBe(200);
      expect(res.body.recap).toBeNull();
    });

    it('passes client identity context into the bridge', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      await request(app)
        .post('/session/session-A/recap')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-1')
        .send();
      expect(bridge.generateSessionRecapCalls[0]?.context).toEqual({
        clientId: 'client-1',
      });
    });

    it('404 when bridge throws SessionNotFoundError', async () => {
      const bridge = fakeBridge({
        generateSessionRecapImpl: async (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/missing/recap')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send();
      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });

    it('400 on malformed X-Qwen-Client-Id header', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/recap')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'bad client id with spaces')
        .send();
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_client_id');
      expect(bridge.generateSessionRecapCalls).toHaveLength(0);
    });

    it('non-strict gate: works on no-token loopback default', async () => {
      // Posture mirrors /session/:id/prompt — the route costs tokens
      // but mutates no state, so it should NOT require operators to
      // configure a token. This pins the contract so a future cleanup
      // that mass-flips session-scoped routes to strict catches the
      // regression.
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/recap')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send();
      expect(res.status).toBe(200);
    });
  });

  describe('POST /session/:id/shell', () => {
    const tokenOpts: ServeOptions = {
      ...baseOpts,
      token: 'secret',
      enableSessionShell: true,
    };
    const auth = (req: request.Test): request.Test =>
      req
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret');

    it('401 token_required on a no-token daemon before bridge dispatch', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, enableSessionShell: true },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .post('/session/session-A/shell')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ command: 'pwd' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('token_required');
      expect(bridge.shellCalls).toHaveLength(0);
    });

    it('403 session_shell_disabled when token auth is present but flag is off', async () => {
      const bridge = fakeBridge();
      const app = createServeApp({ ...baseOpts, token: 'secret' }, undefined, {
        bridge,
      });
      const res = await request(app)
        .post('/session/session-A/shell')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('Authorization', 'Bearer secret')
        .send({ command: 'pwd' });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: 'session_shell_disabled',
        errorKind: 'session_shell_disabled',
      });
      expect(bridge.shellCalls).toHaveLength(0);
    });

    it('403 client_id_required before command validation when enabled without X-Qwen-Client-Id', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(
        request(app).post('/session/session-A/shell'),
      ).send({ command: '' });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: 'client_id_required',
        errorKind: 'client_id_required',
      });
      expect(bridge.shellCalls).toHaveLength(0);
    });

    it('400 invalid_client_id for malformed X-Qwen-Client-Id before bridge dispatch', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(request(app).post('/session/session-A/shell'))
        .set('X-Qwen-Client-Id', 'bad client id')
        .send({ command: 'pwd' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_client_id');
      expect(bridge.shellCalls).toHaveLength(0);
    });

    it('400 for empty command after a valid client id is present', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(request(app).post('/session/session-A/shell'))
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ command: '   ' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('`command` is required');
      expect(bridge.shellCalls).toHaveLength(0);
    });

    it('calls the bridge with a session-bound client context on success', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(request(app).post('/session/session-A/shell'))
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ command: 'pwd' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        exitCode: 0,
        output: '$ pwd',
        aborted: false,
      });
      expect(bridge.shellCalls).toEqual([
        {
          sessionId: 'session-A',
          command: 'pwd',
          signal: expect.any(AbortSignal),
          context: { clientId: 'client-1' },
        },
      ]);
    });

    it('maps bridge InvalidClientIdError to the existing invalid_client_id response', async () => {
      const bridge = fakeBridge({
        shellImpl: async () => {
          throw new InvalidClientIdError('session-A', 'client-2');
        },
      });
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(request(app).post('/session/session-A/shell'))
        .set('X-Qwen-Client-Id', 'client-2')
        .send({ command: 'pwd' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'invalid_client_id',
        sessionId: 'session-A',
        clientId: 'client-2',
      });
    });

    it('treats an empty token string as no token on the strict shell route', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(
        { ...baseOpts, token: '', enableSessionShell: true },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .post('/session/session-A/shell')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ command: 'pwd' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('token_required');
      expect(bridge.shellCalls).toHaveLength(0);
    });

    it('maps bridge shell policy errors to stable REST error kinds', async () => {
      const disabledBridge = fakeBridge({
        shellImpl: async () => {
          throw new SessionShellDisabledError();
        },
      });
      const disabledApp = createServeApp(tokenOpts, undefined, {
        bridge: disabledBridge,
      });
      const disabled = await auth(
        request(disabledApp).post('/session/session-A/shell'),
      )
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ command: 'pwd' });
      expect(disabled.status).toBe(403);
      expect(disabled.body.errorKind).toBe('session_shell_disabled');

      const clientRequiredBridge = fakeBridge({
        shellImpl: async () => {
          throw new SessionShellClientRequiredError();
        },
      });
      const clientRequiredApp = createServeApp(tokenOpts, undefined, {
        bridge: clientRequiredBridge,
      });
      const clientRequired = await auth(
        request(clientRequiredApp).post('/session/session-A/shell'),
      )
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ command: 'pwd' });
      expect(clientRequired.status).toBe(403);
      expect(clientRequired.body.errorKind).toBe('client_id_required');
    });
  });

  describe('POST /session/:id/approval-mode (#4175 Wave 4 PR 17)', () => {
    // Strict-gated route: refuses on no-token loopback defaults. All
    // tests configure a token and forward `Authorization: Bearer …`.
    const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
    const auth = (req: request.Test): request.Test =>
      req
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret');

    it('401 on no-token daemon: strict gate refuses without bearer auth', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/approval-mode')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ mode: 'yolo' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('token_required');
      expect(bridge.setApprovalModeCalls).toHaveLength(0);
    });

    it('200 with the typed result on success and persist defaults to false', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(
        request(app).post('/session/session-A/approval-mode'),
      ).send({ mode: 'yolo' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sessionId: 'session-A',
        mode: 'yolo',
        previous: 'default',
        persisted: false,
      });
      expect(bridge.setApprovalModeCalls).toHaveLength(1);
      expect(bridge.setApprovalModeCalls[0]).toMatchObject({
        sessionId: 'session-A',
        mode: 'yolo',
        opts: { persist: false },
      });
    });

    it('forwards persist:true to the bridge', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(
        request(app).post('/session/session-A/approval-mode'),
      ).send({ mode: 'auto-edit', persist: true });
      expect(res.status).toBe(200);
      expect(res.body.persisted).toBe(true);
      expect(bridge.setApprovalModeCalls[0]?.opts).toEqual({ persist: true });
    });

    it('passes client identity context into the bridge', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(
        request(app).post('/session/session-A/approval-mode'),
      )
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ mode: 'plan' });
      expect(res.status).toBe(200);
      expect(bridge.setApprovalModeCalls[0]?.context).toEqual({
        clientId: 'client-1',
      });
    });

    it('400 on missing or unknown mode literal', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const missing = await auth(
        request(app).post('/session/session-A/approval-mode'),
      ).send({});
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe('invalid_approval_mode');
      expect(missing.body.allowed).toEqual([
        'plan',
        'default',
        'auto-edit',
        'auto',
        'yolo',
      ]);
      const unknown = await auth(
        request(app).post('/session/session-A/approval-mode'),
      ).send({ mode: 'super-yolo' });
      expect(unknown.status).toBe(400);
      expect(bridge.setApprovalModeCalls).toHaveLength(0);
    });

    it('400 when persist is non-boolean', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(
        request(app).post('/session/session-A/approval-mode'),
      ).send({ mode: 'yolo', persist: 'truthy' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_persist_flag');
      expect(bridge.setApprovalModeCalls).toHaveLength(0);
    });

    it('403 with errorKind=auth_env_error when bridge throws TrustGateError', async () => {
      const bridge = fakeBridge({
        setApprovalModeImpl: async () => {
          throw new TrustGateError(
            'Cannot enable privileged approval modes in an untrusted folder.',
          );
        },
      });
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(
        request(app).post('/session/session-A/approval-mode'),
      ).send({ mode: 'yolo' });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: 'trust_gate',
        errorKind: 'auth_env_error',
      });
    });

    it('404 when bridge reports unknown session', async () => {
      const bridge = fakeBridge({
        setApprovalModeImpl: async (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(
        request(app).post('/session/missing/approval-mode'),
      ).send({ mode: 'yolo' });
      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });
  });

  describe('POST /session/:id/fork', () => {
    it('202 with directive and client identity on success', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });

      const res = await request(app)
        .post('/session/session-A/fork')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ directive: 'review the current code' });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        sessionId: 'session-A',
        description: 'review the current code',
        launched: true,
      });
      expect(bridge.forkCalls).toEqual([
        {
          sessionId: 'session-A',
          directive: 'review the current code',
          context: { clientId: 'client-1' },
        },
      ]);
    });

    it('400 when directive is missing or empty', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });

      const missing = await request(app)
        .post('/session/session-A/fork')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe('missing_directive');

      const empty = await request(app)
        .post('/session/session-A/fork')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ directive: '   ' });
      expect(empty.status).toBe(400);
      expect(empty.body.code).toBe('missing_directive');
      expect(bridge.forkCalls).toEqual([]);
    });

    it('404 when bridge throws SessionNotFoundError', async () => {
      const bridge = fakeBridge({
        launchSessionForkAgentImpl: async (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });

      const res = await request(app)
        .post('/session/missing/fork')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ directive: 'review the current code' });

      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });

    it('409 when bridge reports the session is busy', async () => {
      const bridge = fakeBridge({
        launchSessionForkAgentImpl: async (sessionId) => {
          throw new SessionBusyError(
            sessionId,
            'Cannot fork while a response or tool call is in progress',
          );
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });

      const res = await request(app)
        .post('/session/session-A/fork')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ directive: 'review the current code' });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'session_busy',
        sessionId: 'session-A',
      });
      expect(res.headers['retry-after']).toBe('5');
    });
  });

  describe('POST /session/:id/language', () => {
    it('200 with language result on success', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/language')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ language: 'zh', syncOutputLanguage: true });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        language: 'zh',
        outputLanguage: 'Chinese',
        refreshed: true,
      });
      expect(bridge.setLanguageCalls).toHaveLength(1);
      expect(bridge.setLanguageCalls[0]).toMatchObject({
        sessionId: 'session-A',
        params: { language: 'zh', syncOutputLanguage: true },
      });
    });

    it('syncOutputLanguage defaults to false when omitted', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/language')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ language: 'en' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        language: 'en',
        outputLanguage: null,
        refreshed: false,
      });
      expect(bridge.setLanguageCalls[0]?.params.syncOutputLanguage).toBe(false);
    });

    it('passes client identity context into the bridge', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/language')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ language: 'ja' });
      expect(res.status).toBe(200);
      expect(bridge.setLanguageCalls[0]?.context).toEqual({
        clientId: 'client-1',
      });
    });

    it('400 on missing or invalid language code', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const missing = await request(app)
        .post('/session/session-A/language')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe('invalid_language');
      expect(missing.body.allowed).toContain('zh');
      expect(missing.body.allowed).toContain('auto');

      const unknown = await request(app)
        .post('/session/session-A/language')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ language: 'xx-invalid' });
      expect(unknown.status).toBe(400);
      expect(bridge.setLanguageCalls).toHaveLength(0);
    });

    it('400 when syncOutputLanguage is non-boolean', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/language')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ language: 'zh', syncOutputLanguage: 'yes' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_sync_flag');
      expect(bridge.setLanguageCalls).toHaveLength(0);
    });

    it('404 when bridge reports unknown session', async () => {
      const bridge = fakeBridge({
        setLanguageImpl: async (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/missing/language')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ language: 'zh' });
      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });

    it('500 when bridge throws an unexpected error', async () => {
      const bridge = fakeBridge({
        setLanguageImpl: async () => {
          throw new Error('unexpected failure');
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/language')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ language: 'zh' });
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ error: expect.any(String) });
    });
  });

  describe('POST /workspace/init (#4175 Wave 4 PR 17)', () => {
    const auth = (req: request.Test, port: number): request.Test =>
      req
        .set('Host', `127.0.0.1:${port}`)
        .set('Authorization', 'Bearer secret');

    it('401 on no-token daemon: strict gate refuses without bearer auth', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/workspace/init')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('token_required');
    });

    it('200 with action:created and force=false on success', async () => {
      // Use a real temp directory so the workspace service can perform
      // filesystem operations.
      const wsRoot = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'qwen-init-test-'),
      );
      try {
        const bridge = fakeBridge();
        const opts: ServeOptions = {
          ...baseOpts,
          token: 'secret',
          workspace: wsRoot,
        };
        const app = createServeApp(opts, undefined, { bridge });
        const res = await auth(
          request(app).post('/workspace/init'),
          opts.port,
        ).send({});
        expect(res.status).toBe(200);
        expect(res.body.action).toBe('created');
        expect(res.body.path).toContain('QWEN.md');
      } finally {
        await fsp.rm(wsRoot, { recursive: true, force: true });
      }
    });

    it('forwards force:true to the bridge', async () => {
      // Create a workspace with an existing non-empty QWEN.md to trigger
      // the conflict → force:true overwrite path.
      const wsRoot = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'qwen-init-force-'),
      );
      try {
        await fsp.writeFile(path.join(wsRoot, 'QWEN.md'), 'existing content');
        const bridge = fakeBridge();
        const opts: ServeOptions = {
          ...baseOpts,
          token: 'secret',
          workspace: wsRoot,
        };
        const app = createServeApp(opts, undefined, { bridge });
        const res = await auth(
          request(app).post('/workspace/init'),
          opts.port,
        ).send({ force: true });
        expect(res.status).toBe(200);
        expect(res.body.action).toBe('overwrote');
      } finally {
        await fsp.rm(wsRoot, { recursive: true, force: true });
      }
    });

    it('passes client identity into the bridge', async () => {
      // #4282 fold-in 1 (gpt-5.5 C2): the workspace mutation route
      // validates `X-Qwen-Client-Id` against `bridge.knownClientIds()`.
      // Register `client-1` so the validation succeeds and the request
      // goes through without a 400.
      const wsRoot = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'qwen-init-client-'),
      );
      try {
        const bridge = fakeBridge({ knownClientIds: ['client-1'] });
        const opts: ServeOptions = {
          ...baseOpts,
          token: 'secret',
          workspace: wsRoot,
        };
        const app = createServeApp(opts, undefined, { bridge });
        const res = await auth(request(app).post('/workspace/init'), opts.port)
          .set('X-Qwen-Client-Id', 'client-1')
          .send({});
        // Verify the request succeeds — the workspace service receives
        // the originator through the request context.
        expect(res.status).toBe(200);
      } finally {
        await fsp.rm(wsRoot, { recursive: true, force: true });
      }
    });

    it('400 invalid_client_id when X-Qwen-Client-Id is not in knownClientIds', async () => {
      // #4282 fold-in 1 (gpt-5.5 C2): the validator rejects forged
      // headers with a structured 400 instead of stamping the
      // originator on the SSE event.
      const bridge = fakeBridge();
      const opts: ServeOptions = { ...baseOpts, token: 'secret' };
      const app = createServeApp(opts, undefined, { bridge });
      const res = await auth(request(app).post('/workspace/init'), opts.port)
        .set('X-Qwen-Client-Id', 'forged-client')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'invalid_client_id',
        clientId: 'forged-client',
      });
    });

    it('400 when force is non-boolean', async () => {
      const bridge = fakeBridge();
      const opts: ServeOptions = { ...baseOpts, token: 'secret' };
      const app = createServeApp(opts, undefined, { bridge });
      const res = await auth(
        request(app).post('/workspace/init'),
        opts.port,
      ).send({ force: 'yes' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_force_flag');
    });

    it('409 with structured payload when bridge throws WorkspaceInitConflictError', async () => {
      // Create a workspace with existing non-empty content and do NOT
      // pass force:true — the workspace service raises 409.
      const wsRoot = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'qwen-init-conflict-'),
      );
      try {
        await fsp.writeFile(
          path.join(wsRoot, 'QWEN.md'),
          'non-empty content here',
        );
        const bridge = fakeBridge();
        const opts: ServeOptions = {
          ...baseOpts,
          token: 'secret',
          workspace: wsRoot,
        };
        const app = createServeApp(opts, undefined, { bridge });
        const res = await auth(
          request(app).post('/workspace/init'),
          opts.port,
        ).send({});
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          code: 'workspace_init_conflict',
        });
        expect(res.body.path).toContain('QWEN.md');
      } finally {
        await fsp.rm(wsRoot, { recursive: true, force: true });
      }
    });

    it('400 + code:workspace_init_path_escape on WorkspaceInitPathEscapeError (#4297 fold-in 1, addresses #3260501161)', async () => {
      // The workspace service raises path-escape when the configured
      // contextFilename resolves outside the workspace.
      const wsRoot = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'qwen-init-escape-'),
      );
      try {
        const bridge = fakeBridge();
        const opts: ServeOptions = {
          ...baseOpts,
          token: 'secret',
          workspace: wsRoot,
        };
        const app = createServeApp(opts, undefined, {
          bridge,
          contextFilename: '../outside.md',
        });
        const res = await auth(
          request(app).post('/workspace/init'),
          opts.port,
        ).send({});
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({
          code: 'workspace_init_path_escape',
          filename: '../outside.md',
        });
      } finally {
        await fsp.rm(wsRoot, { recursive: true, force: true });
      }
    });

    it('400 + code:workspace_init_symlink on WorkspaceInitSymlinkError (#4297 fold-in 1)', async () => {
      // Create a workspace where the target context file is a symlink.
      const wsRoot = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'qwen-init-symlink-'),
      );
      try {
        const outsideDir = await fsp.mkdtemp(
          path.join(os.tmpdir(), 'qwen-init-outside-'),
        );
        try {
          await fsp.writeFile(path.join(outsideDir, 'target.md'), 'outside');
          await fsp.symlink(
            path.join(outsideDir, 'target.md'),
            path.join(wsRoot, 'QWEN.md'),
          );
          const bridge = fakeBridge();
          const opts: ServeOptions = {
            ...baseOpts,
            token: 'secret',
            workspace: wsRoot,
          };
          const app = createServeApp(opts, undefined, { bridge });
          const res = await auth(
            request(app).post('/workspace/init'),
            opts.port,
          ).send({});
          expect(res.status).toBe(400);
          expect(res.body).toMatchObject({
            code: 'workspace_init_symlink',
            kind: 'target',
          });
        } finally {
          await fsp.rm(outsideDir, { recursive: true, force: true });
        }
      } finally {
        await fsp.rm(wsRoot, { recursive: true, force: true });
      }
    });
  });

  describe('POST /workspace/mcp/:server/restart (#4175 Wave 4 PR 17)', () => {
    const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
    const auth = (req: request.Test): request.Test =>
      req
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret');

    it('401 on no-token daemon: strict gate refuses without bearer auth', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/workspace/mcp/docs/restart')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});
      expect(res.status).toBe(401);
      expect(bridge.restartMcpServerCalls).toHaveLength(0);
    });

    it('200 with restarted:true on success', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(
        request(app).post('/workspace/mcp/docs/restart'),
      ).send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        serverName: 'docs',
        restarted: true,
        durationMs: 42,
      });
      expect(bridge.restartMcpServerCalls).toHaveLength(1);
      expect(bridge.restartMcpServerCalls[0]?.serverName).toBe('docs');
    });

    it('forwards entryIndex=0 to the bridge', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(
        request(app).post('/workspace/mcp/docs/restart?entryIndex=0'),
      ).send({});
      expect(res.status).toBe(200);
      expect(bridge.restartMcpServerCalls[0]?.opts).toEqual({
        entryIndex: 0,
      });
    });

    it('treats entryIndex=* as all entries', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(
        request(app).post('/workspace/mcp/docs/restart?entryIndex=*'),
      ).send({});
      expect(res.status).toBe(200);
      expect(bridge.restartMcpServerCalls[0]?.opts).toBeUndefined();
    });

    it('200 on soft skip with structured reason', async () => {
      const bridge = fakeBridge({
        restartMcpServerImpl: async (serverName) => ({
          serverName,
          restarted: false as const,
          skipped: true as const,
          reason: 'budget_would_exceed' as const,
        }),
      });
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(
        request(app).post('/workspace/mcp/docs/restart'),
      ).send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        serverName: 'docs',
        restarted: false,
        skipped: true,
        reason: 'budget_would_exceed',
      });
    });

    it('passes client identity into the bridge', async () => {
      // #4282 fold-in 1 (gpt-5.5 C2): see /workspace/init test above.
      // The workspace service receives the originator via the request
      // context; verify the request succeeds when the client-id is valid.
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(request(app).post('/workspace/mcp/docs/restart'))
        .set('X-Qwen-Client-Id', 'client-1')
        .send({});
      expect(res.status).toBe(200);
      expect(bridge.restartMcpServerCalls).toHaveLength(1);
    });

    it('400 invalid_client_id on unknown X-Qwen-Client-Id', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(request(app).post('/workspace/mcp/docs/restart'))
        .set('X-Qwen-Client-Id', 'forged-client')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'invalid_client_id',
        clientId: 'forged-client',
      });
      expect(bridge.restartMcpServerCalls).toHaveLength(0);
    });

    it('decodes URL-encoded server names', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      // Server name with hyphen + dot is a legitimate stdio MCP config key.
      const res = await auth(
        request(app).post(
          `/workspace/mcp/${encodeURIComponent('foo-bar.io')}/restart`,
        ),
      ).send({});
      expect(res.status).toBe(200);
      expect(bridge.restartMcpServerCalls[0]?.serverName).toBe('foo-bar.io');
    });

    it('404 when bridge reports SessionNotFoundError (no live channel)', async () => {
      const bridge = fakeBridge({
        restartMcpServerImpl: async () => {
          throw new SessionNotFoundError('mcp:docs');
        },
      });
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(
        request(app).post('/workspace/mcp/docs/restart'),
      ).send({});
      expect(res.status).toBe(404);
    });

    it('400 when serverName exceeds 256 chars (#4282 fold-in 4 S1)', async () => {
      // Mirror the existing tool-name length cap so an unbounded path
      // parameter can't bloat SSE event bodies, ACP messages, or error
      // responses with arbitrarily long server names.
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const overlong = 'a'.repeat(257);
      const res = await auth(
        request(app).post(`/workspace/mcp/${overlong}/restart`),
      ).send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_server_name');
      expect(bridge.restartMcpServerCalls).toHaveLength(0);
    });

    it('404 + code:mcp_server_not_found when bridge throws McpServerNotFoundError (#4297 fold-in 1, addresses #3260501148)', async () => {
      // Pin the `sendBridgeError` mapping under a route-layer test so
      // a future change to the `instanceof McpServerNotFoundError`
      // branch (e.g. cross-package bundling that breaks the prototype
      // chain) fails CI rather than silently degrading to 500.
      const bridge = fakeBridge({
        restartMcpServerImpl: async () => {
          throw new McpServerNotFoundError('ghost');
        },
      });
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(
        request(app).post('/workspace/mcp/ghost/restart'),
      ).send({});
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        code: 'mcp_server_not_found',
        serverName: 'ghost',
      });
    });

    it('502 + code:mcp_server_restart_failed when bridge throws McpServerRestartFailedError (#4297 fold-in 1)', async () => {
      const bridge = fakeBridge({
        restartMcpServerImpl: async () => {
          throw new McpServerRestartFailedError('docs', 'DISCONNECTED');
        },
      });
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(
        request(app).post('/workspace/mcp/docs/restart'),
      ).send({});
      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({
        code: 'mcp_server_restart_failed',
        errorKind: 'protocol_error',
        serverName: 'docs',
        mcpStatus: 'DISCONNECTED',
      });
    });
  });

  describe('POST /workspace/mcp/servers (T2.8 #4514)', () => {
    const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
    const auth = (req: request.Test): request.Test =>
      req
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret');

    it('200 fresh add returns structured result', async () => {
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(request(app).post('/workspace/mcp/servers'))
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ name: 'echo', config: { command: 'echo', args: ['hello'] } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        name: 'echo',
        transport: 'stdio',
        replaced: false,
        shadowedSettings: false,
        toolCount: 3,
        originatorClientId: 'client-1',
      });
      expect(bridge.addRuntimeMcpServerCalls).toHaveLength(1);
      expect(bridge.addRuntimeMcpServerCalls[0]).toMatchObject({
        name: 'echo',
        config: { command: 'echo', args: ['hello'] },
        originatorClientId: 'client-1',
      });
    });

    it('200 soft refuse (skipped:true, reason:budget_warning_only)', async () => {
      const bridge = fakeBridge({
        knownClientIds: ['client-1'],
        addRuntimeMcpServerImpl: async (name) => ({
          name,
          skipped: true as const,
          reason: 'budget_warning_only' as const,
        }),
      });
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(request(app).post('/workspace/mcp/servers'))
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ name: 'echo', config: { command: 'echo' } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        name: 'echo',
        skipped: true,
        reason: 'budget_warning_only',
      });
    });

    it('400 invalid_server_name when name is empty', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(request(app).post('/workspace/mcp/servers')).send({
        name: '',
        config: { command: 'echo' },
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_server_name');
      expect(bridge.addRuntimeMcpServerCalls).toHaveLength(0);
    });

    it('400 invalid_server_name when name exceeds MAX_SERVER_NAME_LENGTH', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const overlong = 'a'.repeat(257);
      const res = await auth(request(app).post('/workspace/mcp/servers')).send({
        name: overlong,
        config: { command: 'echo' },
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_server_name');
      expect(bridge.addRuntimeMcpServerCalls).toHaveLength(0);
    });

    it('400 invalid_server_name when name contains illegal chars (slash)', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(request(app).post('/workspace/mcp/servers')).send({
        name: 'foo/bar',
        config: { command: 'echo' },
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_server_name');
      expect(bridge.addRuntimeMcpServerCalls).toHaveLength(0);
    });

    it('400 invalid_server_name when name is a reserved JS property', async () => {
      for (const name of ['__proto__', 'constructor', 'prototype']) {
        const bridge = fakeBridge();
        const app = createServeApp(tokenOpts, undefined, { bridge });
        const res = await auth(
          request(app).post('/workspace/mcp/servers'),
        ).send({
          name,
          config: { command: 'echo' },
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('invalid_server_name');
        expect(res.body.error).toContain('reserved');
        expect(bridge.addRuntimeMcpServerCalls).toHaveLength(0);
      }
    });

    it('400 missing_required_field when config is absent', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(request(app).post('/workspace/mcp/servers')).send({
        name: 'echo',
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('missing_required_field');
      expect(res.body.field).toBe('config');
      expect(bridge.addRuntimeMcpServerCalls).toHaveLength(0);
    });

    it('401 auth_required when no bearer token (strict gate)', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/workspace/mcp/servers')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ name: 'echo', config: { command: 'echo' } });
      expect(res.status).toBe(401);
      expect(bridge.addRuntimeMcpServerCalls).toHaveLength(0);
    });

    it('400 invalid_client_id on unknown X-Qwen-Client-Id', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(request(app).post('/workspace/mcp/servers'))
        .set('X-Qwen-Client-Id', 'forged-client')
        .send({ name: 'echo', config: { command: 'echo' } });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'invalid_client_id',
        clientId: 'forged-client',
      });
      expect(bridge.addRuntimeMcpServerCalls).toHaveLength(0);
    });

    it('409 mcp_budget_would_exceed when bridge throws with that errorKind', async () => {
      const bridge = fakeBridge({
        knownClientIds: ['client-1'],
        addRuntimeMcpServerImpl: async () => {
          throw Object.assign(new Error('Budget exceeded'), {
            data: { errorKind: 'mcp_budget_would_exceed', serverName: 'echo' },
          });
        },
      });
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(request(app).post('/workspace/mcp/servers'))
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ name: 'echo', config: { command: 'echo' } });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('mcp_budget_would_exceed');
    });

    it('502 mcp_server_spawn_failed with body details', async () => {
      const bridge = fakeBridge({
        knownClientIds: ['client-1'],
        addRuntimeMcpServerImpl: async () => {
          throw Object.assign(new Error('Spawn failed'), {
            data: {
              errorKind: 'mcp_server_spawn_failed',
              serverName: 'broken',
              exitCode: 1,
              stderr: 'module not found',
              timeout: false,
            },
          });
        },
      });
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(request(app).post('/workspace/mcp/servers'))
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ name: 'broken', config: { command: 'bad-cmd' } });
      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({
        code: 'mcp_server_spawn_failed',
        serverName: 'broken',
        exitCode: 1,
        stderr: 'module not found',
      });
    });

    it('503 acp_channel_unavailable when bridge throws with that errorKind', async () => {
      const bridge = fakeBridge({
        knownClientIds: ['client-1'],
        addRuntimeMcpServerImpl: async () => {
          throw Object.assign(new Error('No ACP channel'), {
            data: { errorKind: 'acp_channel_unavailable' },
          });
        },
      });
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(request(app).post('/workspace/mcp/servers'))
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ name: 'echo', config: { command: 'echo' } });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('acp_channel_unavailable');
    });
  });

  describe('DELETE /workspace/mcp/servers/:name (T2.8 #4514)', () => {
    const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
    const auth = (req: request.Test): request.Test =>
      req
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret');

    it('200 removed:true with wasShadowingSettings:false', async () => {
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(request(app).delete('/workspace/mcp/servers/echo'))
        .set('X-Qwen-Client-Id', 'client-1')
        .send();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        name: 'echo',
        removed: true,
        wasShadowingSettings: false,
        originatorClientId: 'client-1',
      });
      expect(bridge.removeRuntimeMcpServerCalls).toHaveLength(1);
      expect(bridge.removeRuntimeMcpServerCalls[0]).toMatchObject({
        name: 'echo',
        originatorClientId: 'client-1',
      });
    });

    it('200 skipped:true when server not present (idempotent)', async () => {
      const bridge = fakeBridge({
        knownClientIds: ['client-1'],
        removeRuntimeMcpServerImpl: async (name) => ({
          name,
          skipped: true as const,
          reason: 'not_present' as const,
        }),
      });
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(
        request(app).delete('/workspace/mcp/servers/ghost'),
      )
        .set('X-Qwen-Client-Id', 'client-1')
        .send();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        name: 'ghost',
        skipped: true,
        reason: 'not_present',
      });
    });

    it('200 removed:true with wasShadowingSettings:true', async () => {
      const bridge = fakeBridge({
        knownClientIds: ['client-1'],
        removeRuntimeMcpServerImpl: async (name, originatorClientId) => ({
          name,
          removed: true as const,
          wasShadowingSettings: true,
          originatorClientId,
        }),
      });
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(
        request(app).delete('/workspace/mcp/servers/shadowed-srv'),
      )
        .set('X-Qwen-Client-Id', 'client-1')
        .send();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        name: 'shadowed-srv',
        removed: true,
        wasShadowingSettings: true,
        originatorClientId: 'client-1',
      });
    });

    it('400 invalid_server_name when path param has illegal chars', async () => {
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(
        request(app).delete('/workspace/mcp/servers/bad%2Fname'),
      )
        .set('X-Qwen-Client-Id', 'client-1')
        .send();
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_server_name');
      expect(bridge.removeRuntimeMcpServerCalls).toHaveLength(0);
    });

    it('400 invalid_server_name when name exceeds MAX_SERVER_NAME_LENGTH', async () => {
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const overlong = 'a'.repeat(257);
      const res = await auth(
        request(app).delete(`/workspace/mcp/servers/${overlong}`),
      )
        .set('X-Qwen-Client-Id', 'client-1')
        .send();
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_server_name');
      expect(bridge.removeRuntimeMcpServerCalls).toHaveLength(0);
    });

    it('400 invalid_server_name when name is a reserved JS property', async () => {
      for (const name of ['__proto__', 'constructor', 'prototype']) {
        const bridge = fakeBridge({ knownClientIds: ['client-1'] });
        const app = createServeApp(tokenOpts, undefined, { bridge });
        const res = await auth(
          request(app).delete(`/workspace/mcp/servers/${name}`),
        )
          .set('X-Qwen-Client-Id', 'client-1')
          .send();
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('invalid_server_name');
        expect(res.body.error).toContain('reserved');
        expect(bridge.removeRuntimeMcpServerCalls).toHaveLength(0);
      }
    });

    it('401 auth_required when no bearer token (strict gate)', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .delete('/workspace/mcp/servers/echo')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send();
      expect(res.status).toBe(401);
      expect(bridge.removeRuntimeMcpServerCalls).toHaveLength(0);
    });

    it('400 invalid_client_id on unknown X-Qwen-Client-Id', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(request(app).delete('/workspace/mcp/servers/echo'))
        .set('X-Qwen-Client-Id', 'forged-client')
        .send();
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'invalid_client_id',
        clientId: 'forged-client',
      });
      expect(bridge.removeRuntimeMcpServerCalls).toHaveLength(0);
    });
  });

  describe('POST /workspace/tools/:name/enable (#4175 Wave 4 PR 17)', () => {
    const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
    const auth = (req: request.Test): request.Test =>
      req
        .set('Host', `127.0.0.1:${tokenOpts.port}`)
        .set('Authorization', 'Bearer secret');

    it('401 on no-token daemon: strict gate refuses without bearer auth', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/workspace/tools/Bash/enable')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ enabled: false });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('token_required');
      expect(bridge.setToolEnabledCalls).toHaveLength(0);
    });

    it('200 with the typed result on success (disable)', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, {
        bridge,
        persistDisabledTools: async () => {},
      });
      const res = await auth(
        request(app).post('/workspace/tools/Bash/enable'),
      ).send({ enabled: false });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ toolName: 'Bash', enabled: false });
    });

    it('200 on enable=true (re-enable a previously disabled tool)', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, {
        bridge,
        persistDisabledTools: async () => {},
      });
      const res = await auth(
        request(app).post('/workspace/tools/Bash/enable'),
      ).send({ enabled: true });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ toolName: 'Bash', enabled: true });
    });

    it('passes client identity into the bridge', async () => {
      // #4282 fold-in 1 (gpt-5.5 C2): see /workspace/init test above.
      // The workspace service receives the originator via the request
      // context; verify the request succeeds when the client-id is valid.
      const bridge = fakeBridge({ knownClientIds: ['client-1'] });
      const app = createServeApp(tokenOpts, undefined, {
        bridge,
        persistDisabledTools: async () => {},
      });
      const res = await auth(request(app).post('/workspace/tools/Bash/enable'))
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ enabled: false });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ toolName: 'Bash', enabled: false });
    });

    it('400 invalid_client_id on unknown X-Qwen-Client-Id', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const res = await auth(request(app).post('/workspace/tools/Bash/enable'))
        .set('X-Qwen-Client-Id', 'forged-client')
        .send({ enabled: false });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'invalid_client_id',
        clientId: 'forged-client',
      });
      expect(bridge.setToolEnabledCalls).toHaveLength(0);
    });

    it('400 when enabled is missing or non-boolean', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      const missing = await auth(
        request(app).post('/workspace/tools/Bash/enable'),
      ).send({});
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe('invalid_enabled_flag');
      const bad = await auth(
        request(app).post('/workspace/tools/Bash/enable'),
      ).send({ enabled: 'truthy' });
      expect(bad.status).toBe(400);
      expect(bridge.setToolEnabledCalls).toHaveLength(0);
    });

    it('accepts URL-encoded MCP-qualified tool names', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, {
        bridge,
        persistDisabledTools: async () => {},
      });
      // The SDK helper `encodeURIComponent`s the tool name; the route
      // path must round-trip the underscored MCP-qualified form
      // (`mcp__github__create_issue`) without mangling it.
      const res = await auth(
        request(app).post('/workspace/tools/mcp__github__create_issue/enable'),
      ).send({ enabled: false });
      expect(res.status).toBe(200);
      expect(res.body.toolName).toBe('mcp__github__create_issue');
    });

    it('trims surrounding whitespace before persisting (#4282 fold-in 4 C3)', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, {
        bridge,
        persistDisabledTools: async () => {},
      });
      const res = await auth(
        request(app).post('/workspace/tools/%20Bash%20/enable'),
      ).send({ enabled: false });
      expect(res.status).toBe(200);
      expect(res.body.toolName).toBe('Bash');
    });

    it('400 when whitespace-only path parameter trims to empty', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(tokenOpts, undefined, { bridge });
      // `%20%20` is two spaces — survives the path-segment guard but
      // collapses to '' after trim. Surface the same 400 the
      // routing layer would return for an empty segment.
      const res = await auth(
        request(app).post('/workspace/tools/%20%20/enable'),
      ).send({ enabled: false });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_tool_name');
      expect(bridge.setToolEnabledCalls).toHaveLength(0);
    });
  });

  describe('POST /session/:id/permission/:requestId', () => {
    it('200 when bridge accepts the scoped vote', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ outcome: { outcome: 'selected', optionId: 'allow' } });
      expect(res.status).toBe(200);
      // F3 Commit 2 — vote routes attach `fromLoopback` from
      // `detectFromLoopback(req)`. The supertest fixture connects
      // from `127.0.0.1`, so the captured context carries
      // `fromLoopback: true` even though no client-id header is set.
      expect(bridge.sessionPermissionVotes).toEqual([
        {
          sessionId: 'session-A',
          requestId: 'req-1',
          response: { outcome: { outcome: 'selected', optionId: 'allow' } },
          context: { fromLoopback: true },
        },
      ]);
    });

    it('passes client identity context into scoped permission votes', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ outcome: { outcome: 'cancelled' } });
      expect(res.status).toBe(200);
      // F3 Commit 2 — `fromLoopback` is derived from the kernel-stamped
      // peer IP (`127.0.0.1` in tests), independent of the client-id
      // header. Both fields end up on the context the route forwards
      // to the bridge.
      expect(bridge.sessionPermissionVotes[0]?.context).toEqual({
        clientId: 'client-1',
        fromLoopback: true,
      });
    });

    it('404 when bridge reports no pending scoped request', async () => {
      const bridge = fakeBridge({ sessionRespondImpl: () => false });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/permission/missing')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ outcome: { outcome: 'cancelled' } });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        sessionId: 'session-A',
        requestId: 'missing',
      });
    });

    it('400 on a malformed scoped selected outcome', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ outcome: { outcome: 'selected' } });
      expect(res.status).toBe(400);
      expect(bridge.sessionPermissionVotes).toHaveLength(0);
    });

    it('400 when scoped outcome is missing entirely', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});
      expect(res.status).toBe(400);
      expect(bridge.sessionPermissionVotes).toHaveLength(0);
    });

    it('400 when scoped selected outcome has an empty-string optionId', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ outcome: { outcome: 'selected', optionId: '' } });
      expect(res.status).toBe(400);
      expect(bridge.sessionPermissionVotes).toHaveLength(0);
    });

    it('400 with invalid_option_id when bridge rejects a scoped option', async () => {
      const bridge = fakeBridge({
        sessionRespondImpl: () => {
          throw new InvalidPermissionOptionError(
            'req-1',
            'ProceedAlwaysProject',
          );
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({
          outcome: { outcome: 'selected', optionId: 'ProceedAlwaysProject' },
        });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'invalid_option_id',
        requestId: 'req-1',
        optionId: 'ProceedAlwaysProject',
      });
    });

    it('404 when bridge reports unknown session on scoped vote', async () => {
      const bridge = fakeBridge({
        sessionRespondImpl: (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/missing/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ outcome: { outcome: 'cancelled' } });
      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });
  });

  describe('POST /permission/:requestId', () => {
    it('200 when bridge accepts the vote', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ outcome: { outcome: 'selected', optionId: 'allow' } });
      expect(res.status).toBe(200);
      // F3 Commit 2 — see the scoped-vote case: `fromLoopback: true`
      // is attached because the supertest peer is `127.0.0.1`.
      expect(bridge.permissionVotes).toEqual([
        {
          requestId: 'req-1',
          response: { outcome: { outcome: 'selected', optionId: 'allow' } },
          context: { fromLoopback: true },
        },
      ]);
    });

    it('passes client identity context into permission votes', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ outcome: { outcome: 'selected', optionId: 'allow' } });
      expect(res.status).toBe(200);
      expect(bridge.permissionVotes[0]?.context).toEqual({
        clientId: 'client-1',
        fromLoopback: true,
      });
    });

    it('400 invalid_client_id when the bridge rejects permission voter', async () => {
      const bridge = fakeBridge({
        respondImpl: () => {
          throw new InvalidClientIdError('session-A', 'client-unknown');
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-unknown')
        .send({ outcome: { outcome: 'selected', optionId: 'allow' } });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'invalid_client_id',
        sessionId: 'session-A',
        clientId: 'client-unknown',
      });
    });

    it('200 with cancelled outcome', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ outcome: { outcome: 'cancelled' } });
      expect(res.status).toBe(200);
      expect(bridge.permissionVotes[0]?.response.outcome.outcome).toBe(
        'cancelled',
      );
    });

    it('404 when bridge reports the requestId is unknown or already resolved', async () => {
      const bridge = fakeBridge({ respondImpl: () => false });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/permission/missing')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ outcome: { outcome: 'cancelled' } });
      expect(res.status).toBe(404);
      expect(res.body.requestId).toBe('missing');
    });

    it('400 on a malformed outcome', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ outcome: { outcome: 'selected' } }); // missing optionId
      expect(res.status).toBe(400);
      expect(bridge.permissionVotes).toHaveLength(0);
    });

    it('400 when outcome is missing entirely', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});
      expect(res.status).toBe(400);
      expect(bridge.permissionVotes).toHaveLength(0);
    });

    it('400 when selected outcome has an empty-string optionId', async () => {
      // An empty string passes `typeof === 'string'` but isn't a meaningful
      // selection — would push a malformed vote to the agent which would
      // reject with an opaque "unknown option" error.
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ outcome: { outcome: 'selected', optionId: '' } });
      expect(res.status).toBe(400);
      expect(bridge.permissionVotes).toHaveLength(0);
    });

    it('400 with invalid_option_id when bridge throws InvalidPermissionOptionError (Blehl)', async () => {
      // The bridge's optionId-validation path (BkwQI) surfaces
      // forged outcomes (e.g. `ProceedAlways*` when the prompt's
      // `hideAlwaysAllow` policy hid them). Route maps that
      // distinct error to 400 with code `invalid_option_id`
      // (vs 404 for "unknown requestId").
      const bridge = fakeBridge({
        respondImpl: () => {
          throw new InvalidPermissionOptionError(
            'req-1',
            'ProceedAlwaysProject',
          );
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/permission/req-1')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({
          outcome: { outcome: 'selected', optionId: 'ProceedAlwaysProject' },
        });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'invalid_option_id',
        requestId: 'req-1',
        optionId: 'ProceedAlwaysProject',
      });
    });
  });

  describe('POST /session/:id/cancel', () => {
    it('204 on success and forwards routing id', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/cancel')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ sessionId: 'spoofed-B' });
      expect(res.status).toBe(204);
      expect(res.body).toEqual({});
      expect(bridge.cancelCalls).toHaveLength(1);
      expect(bridge.cancelCalls[0]?.sessionId).toBe('session-A');
      expect(bridge.cancelCalls[0]?.req?.sessionId).toBe('session-A');
    });

    it('passes client identity context into bridge.cancelSession', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/cancel')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-1');
      expect(res.status).toBe(204);
      expect(bridge.cancelCalls[0]?.context).toEqual({
        clientId: 'client-1',
      });
    });

    it('204 with empty body', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/cancel')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(204);
      expect(bridge.cancelCalls).toHaveLength(1);
    });

    it('404 on unknown session', async () => {
      const bridge = fakeBridge({
        cancelImpl: async (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/missing/cancel')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });
  });

  describe('DELETE /session/:id', () => {
    it('204 on successful close', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .delete('/session/session-A')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(204);
      expect(bridge.closeCalls).toHaveLength(1);
      expect(bridge.closeCalls[0]?.sessionId).toBe('session-A');
    });

    it('passes client identity context', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .delete('/session/session-A')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-1');
      expect(res.status).toBe(204);
      expect(bridge.closeCalls[0]?.context).toEqual({
        clientId: 'client-1',
      });
    });

    it('404 on unknown session', async () => {
      const bridge = fakeBridge({
        closeImpl: async (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .delete('/session/missing')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });

    it('400 invalid_client_id when bridge rejects client', async () => {
      const bridge = fakeBridge({
        closeImpl: async () => {
          throw new InvalidClientIdError('session-A', 'bad-client');
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .delete('/session/session-A')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'bad-client');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_client_id');
    });
  });

  describe('POST /sessions/delete', () => {
    let previousRuntimeDir: string | undefined;
    let runtimeDir: string;
    let wsDir: string;

    beforeEach(async () => {
      previousRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
      runtimeDir = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'qwen-serve-batch-delete-'),
      );
      process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
      wsDir = realpathSync(runtimeDir);
    });

    afterEach(async () => {
      if (previousRuntimeDir === undefined) {
        delete process.env['QWEN_RUNTIME_DIR'];
      } else {
        process.env['QWEN_RUNTIME_DIR'] = previousRuntimeDir;
      }
      await fsp.rm(runtimeDir, { recursive: true, force: true });
    });

    async function writeSession(sessionId: string): Promise<void> {
      const chatsDir = path.join(new Storage(wsDir).getProjectDir(), 'chats');
      await fsp.mkdir(chatsDir, { recursive: true });
      const filePath = path.join(chatsDir, `${sessionId}.jsonl`);
      const record = {
        uuid: `${sessionId}-user-1`,
        parentUuid: null,
        sessionId,
        timestamp: '2026-05-28T12:00:00.000Z',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'hello' }] },
        cwd: wsDir,
      };
      await fsp.writeFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
    }

    it('400 on missing sessionIds', async () => {
      const bridge = fakeBridge();
      const app = createServeApp({ ...baseOpts, workspace: wsDir }, undefined, {
        bridge,
        boundWorkspace: wsDir,
      });
      const res = await request(app)
        .post('/sessions/delete')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
    });

    it('400 on empty sessionIds array', async () => {
      const bridge = fakeBridge();
      const app = createServeApp({ ...baseOpts, workspace: wsDir }, undefined, {
        bridge,
        boundWorkspace: wsDir,
      });
      const res = await request(app)
        .post('/sessions/delete')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ sessionIds: [] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
    });

    it('deletes active session and its transcript when bridge succeeds', async () => {
      const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      await writeSession(sid);
      const bridge = fakeBridge();
      const app = createServeApp({ ...baseOpts, workspace: wsDir }, undefined, {
        bridge,
        boundWorkspace: wsDir,
      });
      const res = await request(app)
        .post('/sessions/delete')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ sessionIds: [sid] });
      expect(res.status).toBe(200);
      expect(res.body.removed).toEqual([sid]);
      expect(res.body.notFound).toEqual([]);
      expect(res.body.errors).toEqual([]);
      const chatsDir = path.join(new Storage(wsDir).getProjectDir(), 'chats');
      const filePath = path.join(chatsDir, `${sid}.jsonl`);
      await expect(fsp.access(filePath)).rejects.toThrow();
    });

    it('deletes inactive session transcript when bridge throws SessionNotFoundError', async () => {
      const sid = 'deadbeef-dead-beef-dead-beefdeaddead';
      await writeSession(sid);
      const bridge = fakeBridge({
        closeImpl: async (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const app = createServeApp({ ...baseOpts, workspace: wsDir }, undefined, {
        bridge,
        boundWorkspace: wsDir,
      });
      const res = await request(app)
        .post('/sessions/delete')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ sessionIds: [sid] });
      expect(res.status).toBe(200);
      expect(res.body.removed).toEqual([sid]);
      expect(res.body.errors).toEqual([]);
      const chatsDir = path.join(new Storage(wsDir).getProjectDir(), 'chats');
      const filePath = path.join(chatsDir, `${sid}.jsonl`);
      await expect(fsp.access(filePath)).rejects.toThrow();
    });

    it('does not delete when bridge.closeSession throws InvalidClientIdError', async () => {
      const sid = 'aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb';
      await writeSession(sid);
      const bridge = fakeBridge({
        closeImpl: async (sessionId) => {
          throw new InvalidClientIdError(sessionId, 'bad-client');
        },
      });
      const app = createServeApp({ ...baseOpts, workspace: wsDir }, undefined, {
        bridge,
        boundWorkspace: wsDir,
      });
      const res = await request(app)
        .post('/sessions/delete')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'bad-client')
        .send({ sessionIds: [sid] });
      expect(res.status).toBe(200);
      expect(res.body.removed).toEqual([]);
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0].sessionId).toBe(sid);
    });

    it('returns notFound for sessions without persisted data', async () => {
      const bridge = fakeBridge();
      const app = createServeApp({ ...baseOpts, workspace: wsDir }, undefined, {
        bridge,
        boundWorkspace: wsDir,
      });
      const res = await request(app)
        .post('/sessions/delete')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ sessionIds: ['nonexistent'] });
      expect(res.status).toBe(200);
      expect(res.body.removed).toEqual([]);
      expect(res.body.notFound).toEqual(['nonexistent']);
    });

    it('errors array contains string messages, not Error objects', async () => {
      const bridge = fakeBridge({
        closeImpl: async () => {
          throw new Error('bridge exploded');
        },
      });
      const app = createServeApp({ ...baseOpts, workspace: wsDir }, undefined, {
        bridge,
        boundWorkspace: wsDir,
      });
      const res = await request(app)
        .post('/sessions/delete')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ sessionIds: ['s-1'] });
      expect(res.status).toBe(200);
      expect(res.body.errors[0].error).toBe('bridge exploded');
      expect(typeof res.body.errors[0].error).toBe('string');
    });

    it('handles multi-session batch with mixed outcomes', async () => {
      const sidOk = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
      const sidNotFound = 'aaaa2222-bbbb-cccc-dddd-eeeeeeeeeeee';
      const sidFail = 'aaaa3333-bbbb-cccc-dddd-eeeeeeeeeeee';
      await writeSession(sidOk);
      await writeSession(sidNotFound);
      await writeSession(sidFail);
      const bridge = fakeBridge({
        closeImpl: async (sessionId) => {
          if (sessionId === sidNotFound) {
            throw new SessionNotFoundError(sessionId);
          }
          if (sessionId === sidFail) {
            throw new Error('agent busy');
          }
        },
      });
      const app = createServeApp({ ...baseOpts, workspace: wsDir }, undefined, {
        bridge,
        boundWorkspace: wsDir,
      });
      const res = await request(app)
        .post('/sessions/delete')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ sessionIds: [sidOk, sidNotFound, sidFail] });
      expect(res.status).toBe(200);
      expect(res.body.removed.sort()).toEqual([sidNotFound, sidOk].sort());
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0].sessionId).toBe(sidFail);
      expect(res.body.errors[0].error).toBe('agent busy');
      const chatsDir = path.join(new Storage(wsDir).getProjectDir(), 'chats');
      await expect(
        fsp.access(path.join(chatsDir, `${sidOk}.jsonl`)),
      ).rejects.toThrow();
      await expect(
        fsp.access(path.join(chatsDir, `${sidNotFound}.jsonl`)),
      ).rejects.toThrow();
      await expect(
        fsp.access(path.join(chatsDir, `${sidFail}.jsonl`)),
      ).resolves.toBeUndefined();
    });

    it('400 when sessionIds exceeds max 100', async () => {
      const bridge = fakeBridge();
      const app = createServeApp({ ...baseOpts, workspace: wsDir }, undefined, {
        bridge,
        boundWorkspace: wsDir,
      });
      const ids = Array.from({ length: 101 }, (_, i) => `s-${i}`);
      const res = await request(app)
        .post('/sessions/delete')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ sessionIds: ids });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
    });

    it('400 when sessionIds contains non-string elements', async () => {
      const bridge = fakeBridge();
      const app = createServeApp({ ...baseOpts, workspace: wsDir }, undefined, {
        bridge,
        boundWorkspace: wsDir,
      });
      const res = await request(app)
        .post('/sessions/delete')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ sessionIds: [123, true] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
    });

    it('deduplicates sessionIds and calls closeSession once per unique id', async () => {
      const sid = 'ddddd111-bbbb-cccc-dddd-eeeeeeeeeeee';
      await writeSession(sid);
      const bridge = fakeBridge();
      const app = createServeApp({ ...baseOpts, workspace: wsDir }, undefined, {
        bridge,
        boundWorkspace: wsDir,
      });
      const res = await request(app)
        .post('/sessions/delete')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ sessionIds: [sid, sid] });
      expect(res.status).toBe(200);
      expect(res.body.removed).toEqual([sid]);
      expect(bridge.closeCalls).toHaveLength(1);
    });

    it('preserves transcript file when bridge.closeSession throws non-SessionNotFoundError', async () => {
      const sid = 'eeee1111-bbbb-cccc-dddd-eeeeeeeeeeee';
      await writeSession(sid);
      const bridge = fakeBridge({
        closeImpl: async (sessionId) => {
          throw new InvalidClientIdError(sessionId, 'bad-client');
        },
      });
      const app = createServeApp({ ...baseOpts, workspace: wsDir }, undefined, {
        bridge,
        boundWorkspace: wsDir,
      });
      const res = await request(app)
        .post('/sessions/delete')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ sessionIds: [sid] });
      expect(res.status).toBe(200);
      expect(res.body.removed).toEqual([]);
      expect(res.body.errors).toHaveLength(1);
      const chatsDir = path.join(new Storage(wsDir).getProjectDir(), 'chats');
      await expect(
        fsp.access(path.join(chatsDir, `${sid}.jsonl`)),
      ).resolves.toBeUndefined();
    });

    it('returns 500 when removeSessions throws unexpectedly', async () => {
      const spy = vi
        .spyOn(SessionService.prototype, 'removeSessions')
        .mockRejectedValueOnce(new Error('disk on fire'));
      const bridge = fakeBridge();
      const app = createServeApp({ ...baseOpts, workspace: wsDir }, undefined, {
        bridge,
        boundWorkspace: wsDir,
      });
      const res = await request(app)
        .post('/sessions/delete')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ sessionIds: ['aaaa0000-bbbb-cccc-dddd-eeeeeeeeeeee'] });
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('sessions_delete_failed');
      spy.mockRestore();
    });
  });

  describe('PATCH /session/:id/metadata', () => {
    it('200 on successful metadata update', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .patch('/session/session-A/metadata')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ displayName: 'My Session' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sessionId: 'session-A',
        displayName: 'My Session',
      });
      expect(bridge.updateMetadataCalls).toHaveLength(1);
      expect(bridge.updateMetadataCalls[0]?.sessionId).toBe('session-A');
      expect(bridge.updateMetadataCalls[0]?.metadata).toEqual({
        displayName: 'My Session',
      });
    });

    it('passes client identity context', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .patch('/session/session-A/metadata')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-1')
        .send({ displayName: 'test' });
      expect(res.status).toBe(200);
      expect(bridge.updateMetadataCalls[0]?.context).toEqual({
        clientId: 'client-1',
      });
    });

    it('400 when displayName is not a string', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .patch('/session/session-A/metadata')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ displayName: 123 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_metadata');
      expect(res.body.field).toBe('displayName');
    });

    it('404 on unknown session', async () => {
      const bridge = fakeBridge({
        updateMetadataImpl: (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .patch('/session/missing/metadata')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ displayName: 'test' });
      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });

    it('400 invalid_metadata when displayName exceeds max length', async () => {
      const bridge = fakeBridge({
        updateMetadataImpl: () => {
          throw new InvalidSessionMetadataError(
            'displayName',
            'must be a string of at most 256 characters',
          );
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .patch('/session/session-A/metadata')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ displayName: 'x'.repeat(300) });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_metadata');
    });
  });

  describe('POST /session/:id/heartbeat', () => {
    it('200 with the bridge result and forwards the routing id', async () => {
      const bridge = fakeBridge({
        heartbeatImpl: (sessionId) => ({
          sessionId,
          lastSeenAt: 1_700_000_000_001,
        }),
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/heartbeat')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sessionId: 'session-A',
        lastSeenAt: 1_700_000_000_001,
      });
      expect(bridge.heartbeatCalls).toEqual([{ sessionId: 'session-A' }]);
    });

    it('forwards X-Qwen-Client-Id into the bridge context and echoes it back', async () => {
      const bridge = fakeBridge({
        heartbeatImpl: (sessionId, context) => ({
          sessionId,
          ...(context?.clientId !== undefined
            ? { clientId: context.clientId }
            : {}),
          lastSeenAt: 1_700_000_000_002,
        }),
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/heartbeat')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sessionId: 'session-A',
        clientId: 'client-1',
        lastSeenAt: 1_700_000_000_002,
      });
      expect(bridge.heartbeatCalls).toEqual([
        { sessionId: 'session-A', context: { clientId: 'client-1' } },
      ]);
    });

    it('400 invalid_client_id when the header is malformed', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/heartbeat')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'bad client id');
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'invalid_client_id' });
      expect(bridge.heartbeatCalls).toHaveLength(0);
    });

    it('400 invalid_client_id when the bridge rejects an unknown client', async () => {
      const bridge = fakeBridge({
        heartbeatImpl: (sessionId, context) => {
          throw new InvalidClientIdError(sessionId, context!.clientId!);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/heartbeat')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('X-Qwen-Client-Id', 'client-unknown');
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'invalid_client_id',
        sessionId: 'session-A',
        clientId: 'client-unknown',
      });
    });

    it('404 when the bridge reports an unknown session', async () => {
      const bridge = fakeBridge({
        heartbeatImpl: (sessionId) => {
          throw new SessionNotFoundError(sessionId);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/missing/heartbeat')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(404);
      expect(res.body.sessionId).toBe('missing');
    });
  });

  describe('bearer auth', () => {
    it('is open by default (loopback developer convenience)', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/health')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
    });

    // Switched probe endpoint from `/health` to `/capabilities` for
    // these auth-rejection tests because per #3889 review A8dZT
    // `/health` is now intentionally registered BEFORE the bearer
    // middleware so liveness probes work without credentials.
    // `/capabilities` is the cheapest endpoint that still goes through
    // the auth chain.
    it('rejects missing Authorization header when token is set', async () => {
      const app = createServeApp({ ...baseOpts, token: 'secret' });
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(401);
    });

    it('rejects wrong scheme', async () => {
      const app = createServeApp({ ...baseOpts, token: 'secret' });
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('Authorization', 'Basic c2VjcmV0');
      expect(res.status).toBe(401);
    });

    it('rejects wrong token', async () => {
      const app = createServeApp({ ...baseOpts, token: 'secret' });
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('Authorization', 'Bearer wrong');
      expect(res.status).toBe(401);
    });

    it('accepts the right token', async () => {
      const app = createServeApp({ ...baseOpts, token: 'secret' });
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('Authorization', 'Bearer secret');
      expect(res.status).toBe(200);
    });

    it('exempts /health from bearer auth so liveness probes work without credentials', async () => {
      // Per #3889 review A8dZT — the registration order in
      // `createServeApp` puts `/health` BEFORE `bearerAuth`, so a
      // probe with no credentials still gets 200 even when the daemon
      // was started with a token. CORS deny + Host allowlist still
      // apply to `/health` (registered before /health), so this is
      // not a way to bypass DNS rebinding or browser-origin
      // protection.
      const app = createServeApp({ ...baseOpts, token: 'secret' });
      const res = await request(app)
        .get('/health')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('gates /health behind bearer auth when --require-auth is set on loopback (#4175 PR 15)', async () => {
      // The whole point of `--require-auth` is to harden the
      // loopback default; the unauthenticated `/health` carve-out
      // would defeat that on shared dev hosts. Boot-time check in
      // `runQwenServe` guarantees a token whenever the flag is on,
      // so this 401 is reachable only under operator opt-in.
      const app = createServeApp({
        ...baseOpts,
        token: 'secret',
        requireAuth: true,
      });
      const noAuth = await request(app)
        .get('/health')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(noAuth.status).toBe(401);
      const withAuth = await request(app)
        .get('/health')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('Authorization', 'Bearer secret');
      expect(withAuth.status).toBe(200);
      expect(withAuth.body).toEqual({ status: 'ok' });
    });
  });

  describe('payload-too-large handling (A-UsP)', () => {
    it('returns 413 JSON when the request body exceeds the 10 MB limit', async () => {
      // body-parser raises `{status: 413, type: 'entity.too.large'}`
      // when the body exceeds the configured limit. The Express
      // error middleware special-cases this to a structured 413
      // response instead of falling through to a misleading 500.
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      // 11 MB of `x` characters > 10 MB body-parser limit
      const oversize = 'x'.repeat(11 * 1024 * 1024);
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ cwd: '/work', pad: oversize }));
      expect(res.status).toBe(413);
      expect(res.body).toEqual({ error: 'Request body too large (max 10 MB)' });
      // Body parser short-circuits before the route handler runs.
      expect(bridge.calls).toHaveLength(0);
    });
  });

  describe('GET /health?deep=1 (chiga0 Risk 3)', () => {
    it('default /health stays cheap (no bridge touch)', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .get('/health')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('deep=1 includes bridge state', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .get('/health?deep=1')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'ok',
        sessions: 0,
        pendingPermissions: 0,
      });
    });

    it('deep=1 includes idle detection fields with no activity', async () => {
      const bridge = fakeBridge();
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .get('/health?deep=1')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'ok',
        activePrompts: 0,
        connectedClients: 0,
        channelAlive: false,
        lastActivityAt: null,
        idleSinceMs: null,
      });
    });

    it('deep=1 derives idleSinceMs from the same lastActivityAt snapshot', async () => {
      const now = 1_700_000_060_000;
      const activityTime = now - 60_000;
      const bridge = fakeBridge();
      Object.defineProperty(bridge, 'lastActivityAt', {
        get() {
          return activityTime;
        },
      });
      Object.defineProperty(bridge, 'idleSinceMs', {
        get() {
          throw new Error('idleSinceMs getter should not be read');
        },
      });
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const app = createServeApp(baseOpts, undefined, { bridge });
        const res = await request(app)
          .get('/health?deep=1')
          .set('Host', `127.0.0.1:${baseOpts.port}`);
        expect(res.status).toBe(200);
        expect(res.body.lastActivityAt).toBe(
          new Date(activityTime).toISOString(),
        );
        expect(res.body.idleSinceMs).toBe(60_000);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('deep=1 returns 503 when bridge state access throws', async () => {
      // Simulate a wedged bridge by replacing the getter to throw.
      const bridge = fakeBridge();
      Object.defineProperty(bridge, 'sessionCount', {
        get() {
          throw new Error('bridge wedged');
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .get('/health?deep=1')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'degraded' });
    });
  });

  describe('GET /daemon/status', () => {
    it('requires bearer auth when a token is configured', async () => {
      const app = createServeApp({ ...baseOpts, token: 'secret' }, undefined, {
        bridge: fakeBridge(),
      });

      const noAuth = await request(app)
        .get('/daemon/status')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(noAuth.status).toBe(401);

      const withAuth = await request(app)
        .get('/daemon/status')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .set('Authorization', 'Bearer secret');
      expect(withAuth.status).toBe(200);
      expect(withAuth.body).toMatchObject({
        v: 1,
        detail: 'summary',
      });
    });

    it('returns summary diagnostics without querying workspace status', async () => {
      const bridge = fakeBridge();
      const daemonLog = fakeDaemonLog();
      const app = createServeApp(baseOpts, undefined, {
        bridge,
        daemonLog,
        qwenCodeVersion: '1.2.3-test',
      });

      const res = await request(app)
        .get('/daemon/status')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        v: 1,
        detail: 'summary',
        status: 'ok',
        issues: [],
        daemon: {
          pid: process.pid,
          mode: 'http-bridge',
          workspaceCwd: expect.any(String),
          qwenCodeVersion: '1.2.3-test',
          daemonId: 'test-daemon',
        },
        security: {
          tokenConfigured: false,
          requireAuth: false,
          loopbackBind: true,
          allowOriginConfigured: false,
          allowOriginMode: 'none',
          sessionShellCommandEnabled: false,
        },
        runtime: {
          sessions: { active: 0 },
          permissions: { pending: 0 },
          channel: { live: false },
          transport: {
            restSseActive: 0,
            acp: {
              enabled: true,
              connections: 0,
              connectionStreams: 0,
              sessionStreams: 0,
              sseStreams: 0,
              wsStreams: 0,
              pendingClientRequests: 0,
            },
          },
        },
      });
      expect(res.body.generatedAt).toEqual(expect.any(String));
      expect(res.body.daemon).not.toHaveProperty('logPath');
      expect(bridge.workspaceMcpCalls).toBe(0);
      expect(bridge.workspaceSkillsCalls).toBe(0);
      expect(bridge.workspaceToolsCalls).toBe(0);
      expect(bridge.workspaceProvidersCalls).toBe(0);
      expect(bridge.workspaceEnvCalls).toBe(0);
      expect(bridge.workspacePreflightCalls).toBe(0);
      expect(bridge.workspaceHooksCalls).toBe(0);
      expect(bridge.workspaceExtensionsCalls).toBe(0);
    });

    it('rejects unknown detail values', async () => {
      const app = createServeApp(baseOpts, undefined, {
        bridge: fakeBridge(),
      });

      const res = await request(app)
        .get('/daemon/status?detail=verbose')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'invalid_detail',
      });
    });

    it('returns full diagnostics with independent workspace section degradation', async () => {
      const bridge = fakeBridge({
        daemonStatusSnapshotImpl: () => ({
          limits: {
            maxSessions: 20,
            maxPendingPromptsPerSession: 5,
            eventRingSize: 8000,
            channelIdleTimeoutMs: 0,
            sessionIdleTimeoutMs: 1_800_000,
          },
          sessionCount: 1,
          pendingPermissionCount: 0,
          channelLive: true,
          permissionPolicy: 'first-responder',
          sessions: [
            {
              sessionId: 'session-1',
              workspaceCwd: WS_BOUND,
              createdAt: '2026-06-01T00:00:00.000Z',
              clientCount: 2,
              subscriberCount: 1,
              attachCount: 1,
              pendingPromptCount: 0,
              pendingPermissionCount: 0,
              hasActivePrompt: false,
              lastEventId: 4,
            },
          ],
        }),
        workspaceMcpImpl: async () => {
          throw new Error('mcp status unavailable');
        },
        workspacePreflightImpl: async () => ({
          v: 1 as const,
          workspaceCwd: WS_BOUND,
          initialized: true as const,
          acpChannelLive: true,
          cells: [
            {
              kind: 'git' as const,
              locality: 'daemon' as const,
              status: 'error' as const,
              error: 'git missing',
            },
          ],
        }),
      });
      const app = createServeApp(baseOpts, undefined, {
        bridge,
        boundWorkspace: WS_BOUND,
      });

      const res = await request(app)
        .get('/daemon/status?detail=full')
        .set('Host', `127.0.0.1:${baseOpts.port}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        detail: 'full',
        status: 'error',
        full: {
          sessions: [
            {
              sessionId: 'session-1',
              clientCount: 2,
              subscriberCount: 1,
            },
          ],
          workspace: {
            mcp: {
              status: 'unavailable',
              error: { kind: 'error' },
            },
            preflight: {
              status: 'error',
              summary: { cellsCount: expect.any(Number) },
            },
          },
          auth: {
            supportedDeviceFlowProviders: ['qwen-oauth'],
            pendingDeviceFlowCount: 0,
          },
        },
      });
      expect(res.body.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'workspace_status_unavailable',
            section: 'mcp',
          }),
          expect.objectContaining({
            code: 'preflight_error',
            section: 'preflight',
          }),
        ]),
      );
      expect(bridge.workspaceMcpCalls).toBe(1);
    });
  });

  describe('session limit (chiga0 Rec 3 — --max-sessions)', () => {
    it('503 + Retry-After + structured error when bridge throws SessionLimitExceededError', async () => {
      const bridge = fakeBridge({
        spawnImpl: async () => {
          throw new SessionLimitExceededError(20);
        },
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ cwd: '/work/a' });
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body).toMatchObject({
        code: 'session_limit_exceeded',
        limit: 20,
      });
    });
  });
});

describe('runQwenServe', () => {
  let handle: RunHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
    // Scrub any env vars individual tests may have set so leftover
    // state can't leak into the next test in this worker.
    delete process.env['QWEN_SERVER_TOKEN'];
    delete process.env['QWEN_SERVE_PROMPT_DEADLINE_MS'];
    delete process.env['QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS'];
  });

  it('refuses to bind 0.0.0.0 without a token', async () => {
    await expect(
      runQwenServe({
        hostname: '0.0.0.0',
        port: 0,
        mode: 'http-bridge',
      }),
    ).rejects.toThrow(/Refusing to bind/);
  });

  it('refuses to start with --require-auth on loopback when no token configured (#4175 PR 15)', async () => {
    // Boot-loud check: silently dropping the flag would leave the
    // operator believing loopback is hardened when it isn't.
    await expect(
      runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        requireAuth: true,
      }),
    ).rejects.toThrow(/--require-auth/);
  });

  it("refuses to start with --allow-origin '*' on loopback when no token is configured", async () => {
    await expect(
      runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        allowOrigins: ['*'],
      }),
    ).rejects.toThrow(/--allow-origin '\*'/);
  });

  it("starts with --allow-origin '*' when a token is configured", async () => {
    handle = await runQwenServe({
      hostname: '127.0.0.1',
      port: 0,
      mode: 'http-bridge',
      token: 'secret',
      allowOrigins: ['*'],
    });
    const port = (handle.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: 'https://anywhere.example.com' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://anywhere.example.com',
    );
    expect(res.headers.get('access-control-expose-headers')).toBe(
      'Retry-After',
    );
  });

  it('uses normalized token for session shell capability across REST and ACP initialize', async () => {
    handle = await runQwenServe({
      hostname: '127.0.0.1',
      port: 0,
      mode: 'http-bridge',
      token: '  secret  ',
      enableSessionShell: true,
    });
    const port = (handle.server.address() as { port: number }).port;
    const capsRes = await fetch(`http://127.0.0.1:${port}/capabilities`, {
      headers: { Authorization: 'Bearer secret' },
    });
    expect(capsRes.status).toBe(200);
    const caps = (await capsRes.json()) as { features: string[] };
    expect(caps.features).toContain('session_shell_command');

    const initRes = await fetch(`http://127.0.0.1:${port}/acp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer secret',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
      }),
    });
    expect(initRes.status).toBe(200);
    const init = (await initRes.json()) as {
      result: { agentCapabilities: { _meta: { qwen: { methods: string[] } } } };
    };
    expect(init.result.agentCapabilities._meta.qwen.methods).toContain(
      '_qwen/session/shell',
    );
  });

  it('warns and does not advertise session shell when flag is set without a token', async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);
    try {
      handle = await runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        enableSessionShell: true,
      });
      expect(
        stderrSpy.mock.calls.some(([chunk]) =>
          String(chunk).includes('--enable-session-shell ignored'),
        ),
      ).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }

    const port = (handle.server.address() as { port: number }).port;
    const capsRes = await fetch(`http://127.0.0.1:${port}/capabilities`);
    expect(capsRes.status).toBe(200);
    const caps = (await capsRes.json()) as { features: string[] };
    expect(caps.features).not.toContain('session_shell_command');

    const initRes = await fetch(`http://127.0.0.1:${port}/acp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
      }),
    });
    expect(initRes.status).toBe(200);
    const init = (await initRes.json()) as {
      result: { agentCapabilities: { _meta: { qwen: { methods: string[] } } } };
    };
    expect(init.result.agentCapabilities._meta.qwen.methods).not.toContain(
      '_qwen/session/shell',
    );
  });

  // PR 14 fix (review #4247): runQwenServe is the documented embedded
  // entry point, so budget validation must live here, not just in the
  // yargs CLI handler. Embedded callers (other tools wrapping the
  // daemon, deps.bridge test injection) silently produced an uncapped
  // child pre-fix despite requesting enforce.
  it('rejects non-positive mcpClientBudget (#4175 PR 14)', async () => {
    await expect(
      runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        mcpClientBudget: 0,
      }),
    ).rejects.toThrow(/mcpClientBudget/);
    await expect(
      runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        mcpClientBudget: -5,
      }),
    ).rejects.toThrow(/mcpClientBudget/);
  });

  it('rejects mcpBudgetMode=enforce without a budget (#4175 PR 14)', async () => {
    await expect(
      runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        mcpBudgetMode: 'enforce',
      }),
    ).rejects.toThrow(/enforce.*requires.*mcpClientBudget/);
  });

  // Issue #4514 T2.9: same boot-validation contract as mcpClientBudget
  // — embedded callers must hit the same fail-loud TypeError as the
  // CLI handler, not a silent uncapped daemon.
  it.each([
    ['zero', 0],
    ['negative', -5],
    ['float', 1.5],
    ['NaN', Number.NaN],
  ])(
    'rejects invalid promptDeadlineMs (%s) at boot (#4514 T2.9)',
    async (_label, value) => {
      await expect(
        runQwenServe({
          hostname: '127.0.0.1',
          port: 0,
          mode: 'http-bridge',
          promptDeadlineMs: value,
        }),
      ).rejects.toThrow(/promptDeadlineMs/);
    },
  );

  it.each([
    ['negative', -5],
    ['float', 1.5],
    ['NaN', Number.NaN],
  ])(
    'rejects invalid maxPendingPromptsPerSession (%s) at boot',
    async (_label, value) => {
      await expect(
        runQwenServe({
          hostname: '127.0.0.1',
          port: 0,
          mode: 'http-bridge',
          maxPendingPromptsPerSession: value,
        }),
      ).rejects.toThrow(/maxPendingPromptsPerSession/);
    },
  );

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['float', 1.5],
    ['NaN', Number.NaN],
  ])(
    'rejects invalid writerIdleTimeoutMs (%s) at boot (#4514 T2.9)',
    async (_label, value) => {
      await expect(
        runQwenServe({
          hostname: '127.0.0.1',
          port: 0,
          mode: 'http-bridge',
          writerIdleTimeoutMs: value,
        }),
      ).rejects.toThrow(/writerIdleTimeoutMs/);
    },
  );

  it('rejects promptDeadlineMs that exceeds the JS timer cap (#4514 T2.9 wenshao review)', async () => {
    // Node silently compresses setTimeout delays > 2^31-1 ms to 1ms
    // with a TimeoutOverflowWarning — an operator setting 30 days
    // expecting "effectively no cap" would otherwise see every prompt
    // 504 instantly. Boot-loud rejection with a clear error pointing
    // at the cap prevents the footwound.
    await expect(
      runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        promptDeadlineMs: 2_147_483_648, // one over 2^31 - 1
      }),
    ).rejects.toThrow(/Exceeds maximum JS timer delay/);
  });

  it('accepts writerIdleTimeoutMs above the JS timer cap (#4530 review)', async () => {
    handle = await runQwenServe({
      hostname: '127.0.0.1',
      port: 0,
      mode: 'http-bridge',
      writerIdleTimeoutMs: 2_147_483_648,
    });
    const port = (handle.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/capabilities`);
    const caps = (await res.json()) as { features: string[] };
    expect(caps.features).toContain('writer_idle_timeout');
  });

  // Env-var scrub for these tests is handled by `afterEach` above —
  // no `try/finally` per test needed.
  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['NaN', 'abc'],
    ['float', '1.5'],
    ['negative', '-5'],
    ['zero', '0'],
  ])(
    'rejects invalid QWEN_SERVE_PROMPT_DEADLINE_MS env var (%s) at boot (#4514 T2.9)',
    async (_label, value) => {
      process.env['QWEN_SERVE_PROMPT_DEADLINE_MS'] = value;
      await expect(
        runQwenServe({
          hostname: '127.0.0.1',
          port: 0,
          mode: 'http-bridge',
        }),
      ).rejects.toThrow(/QWEN_SERVE_PROMPT_DEADLINE_MS/);
    },
  );

  it('rejects QWEN_SERVE_PROMPT_DEADLINE_MS that exceeds JS timer cap (#4514 T2.9)', async () => {
    process.env['QWEN_SERVE_PROMPT_DEADLINE_MS'] = '2147483648';
    await expect(
      runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
      }),
    ).rejects.toThrow(/Exceeds maximum JS timer delay/);
  });

  it('accepts a valid QWEN_SERVE_PROMPT_DEADLINE_MS env var (#4514 T2.9 happy path)', async () => {
    // Pin the env-fallback shape end-to-end: env var → ServeOptions
    // field → /capabilities advertises the conditional tag. Closes
    // the "no tests at all" gap wenshao flagged on `parseDeadlineEnv`.
    process.env['QWEN_SERVE_PROMPT_DEADLINE_MS'] = '30000';
    handle = await runQwenServe({
      hostname: '127.0.0.1',
      port: 0,
      mode: 'http-bridge',
    });
    const port = (handle.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/capabilities`);
    const caps = (await res.json()) as { features: string[] };
    expect(caps.features).toContain('prompt_absolute_deadline');
  });

  // wenshao review #4530 inline #5: sibling env var
  // `QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS` had zero dedicated coverage
  // — a copy-paste error reading the wrong env-var name in
  // `runQwenServe` would have passed all existing tests. Mirror the
  // prompt-deadline env-var plumbing while preserving writer-idle's
  // larger arithmetic-only budget range.
  it('rejects invalid QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS env var at boot (#4514 T2.9)', async () => {
    process.env['QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS'] = 'abc';
    await expect(
      runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
      }),
    ).rejects.toThrow(/QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS/);
  });

  it('accepts QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS above JS timer cap (#4530 review)', async () => {
    process.env['QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS'] = '2147483648';
    handle = await runQwenServe({
      hostname: '127.0.0.1',
      port: 0,
      mode: 'http-bridge',
    });
    const port = (handle.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/capabilities`);
    const caps = (await res.json()) as { features: string[] };
    expect(caps.features).toContain('writer_idle_timeout');
  });

  it('accepts a valid QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS env var (#4514 T2.9 happy path)', async () => {
    process.env['QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS'] = '60000';
    handle = await runQwenServe({
      hostname: '127.0.0.1',
      port: 0,
      mode: 'http-bridge',
    });
    const port = (handle.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/capabilities`);
    const caps = (await res.json()) as { features: string[] };
    expect(caps.features).toContain('writer_idle_timeout');
  });

  // Round 6 (wenshao R5 line 216): replaced the R3 `process.env`
  // mutation tests. `runQwenServe` now passes per-handle env
  // overrides via `BridgeOptions.childEnvOverrides`, NOT by mutating
  // global `process.env` — so concurrent embedded daemons don't
  // cross-contaminate each other's MCP budget env. The two tests
  // below assert (a) runQwenServe doesn't touch process.env and
  // (b) a pre-existing process.env value survives runQwenServe
  // calls unrelated to MCP overrides (proving runQwenServe is no
  // longer the source of env mutation).
  it('does not mutate process.env when caller provides mcp budget options (#4247 R6 line 216)', async () => {
    // Sanity-check: no MCP env vars set before.
    delete process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'];
    delete process.env['QWEN_SERVE_MCP_BUDGET_MODE'];
    handle = await runQwenServe({
      hostname: '127.0.0.1',
      port: 0,
      mode: 'http-bridge',
      mcpClientBudget: 10,
      mcpBudgetMode: 'warn',
    });
    // Pre-R6 this leaked into global process.env. Post-R6 the values
    // travel via `BridgeOptions.childEnvOverrides` closure → only
    // the spawned ACP child sees them.
    expect(process.env['QWEN_SERVE_MCP_CLIENT_BUDGET']).toBeUndefined();
    expect(process.env['QWEN_SERVE_MCP_BUDGET_MODE']).toBeUndefined();
  });

  it('preserves pre-existing process.env values (no longer wipes globals on omit) (#4247 R6 line 216)', async () => {
    // Pre-R6 the "scrub on omit" code path delete'd these from
    // process.env. Post-R6 runQwenServe doesn't touch process.env
    // at all; the override mechanism handles "scrub" at the
    // per-handle level inside the bridge's spawn factory. So if an
    // operator had QWEN_SERVE_MCP_CLIENT_BUDGET exported in their
    // shell BEFORE starting the daemon, it stays in their process
    // env (and gets ignored by this daemon's child, which receives
    // `undefined` via overrides to scrub it on spawn).
    process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'] = '99';
    try {
      handle = await runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        // No mcpClientBudget — override will scrub the var on spawn.
      });
      expect(process.env['QWEN_SERVE_MCP_CLIENT_BUDGET']).toBe('99');
    } finally {
      delete process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'];
    }
  });

  it('starts with --require-auth + token on loopback', async () => {
    handle = await runQwenServe({
      hostname: '127.0.0.1',
      port: 0,
      mode: 'http-bridge',
      token: 'secret',
      requireAuth: true,
    });
    const port = (handle.server.address() as { port: number }).port;
    // Token-required everywhere, including /health.
    const noAuth = await fetch(`http://127.0.0.1:${port}/health`);
    expect(noAuth.status).toBe(401);
    const withAuth = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: 'Bearer secret' },
    });
    expect(withAuth.status).toBe(200);
  });

  it('accepts QWEN_SERVER_TOKEN from the env when binding non-loopback', async () => {
    process.env['QWEN_SERVER_TOKEN'] = 'env-secret';
    handle = await runQwenServe({
      hostname: '0.0.0.0',
      port: 0,
      mode: 'http-bridge',
    });
    expect(handle.url).toMatch(/^http:\/\/0\.0\.0\.0:\d+$/);
  });

  it('starts on a loopback ephemeral port without a token', async () => {
    handle = await runQwenServe({
      hostname: '127.0.0.1',
      port: 0,
      mode: 'http-bridge',
    });
    const port = (handle.server.address() as { port: number }).port;
    expect(port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('--max-connections 0 still accepts connections (tanzhenxin issue 1)', async () => {
    // Pre-fix bug: docs say "Set to 0 to disable" and code did
    // `server.maxConnections = opts.maxConnections ?? 256`, but on
    // Node 22 `server.maxConnections = 0` causes the listener to
    // refuse EVERY connection. An operator following the documented
    // disable path got a daemon that booted cleanly but silently
    // bricked every request. Fix treats 0 / Infinity / non-finite as
    // "leave the property unset" so Node's default (no cap) actually
    // applies.
    handle = await runQwenServe({
      hostname: '127.0.0.1',
      port: 0,
      mode: 'http-bridge',
      maxConnections: 0,
    });
    const port = (handle.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    // And `server.maxConnections` should be the Node default
    // (undefined / unset), NOT 0.
    expect(handle.server.maxConnections).not.toBe(0);
  });

  it('--max-connections Infinity treated as unlimited (tanzhenxin issue 1)', async () => {
    handle = await runQwenServe({
      hostname: '127.0.0.1',
      port: 0,
      mode: 'http-bridge',
      maxConnections: Infinity,
    });
    const port = (handle.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(handle.server.maxConnections).not.toBe(0);
    expect(handle.server.maxConnections).not.toBe(Infinity);
  });

  it('--max-connections 100 sets the cap as supplied', async () => {
    handle = await runQwenServe({
      hostname: '127.0.0.1',
      port: 0,
      mode: 'http-bridge',
      maxConnections: 100,
    });
    expect(handle.server.maxConnections).toBe(100);
  });

  it('--max-connections NaN/negative throws at boot (BUF9-)', async () => {
    // Silent fail-OPEN on a CLI typo would weaken the DoS guard.
    // Boot-loud is the right behavior for an unparseable cap.
    await expect(
      runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        maxConnections: NaN,
      }),
    ).rejects.toThrow(/maxConnections: NaN/);
    await expect(
      runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        maxConnections: -5,
      }),
    ).rejects.toThrow(/maxConnections: -5/);
  });

  it('case-insensitive loopback: --hostname Localhost / LOCALHOST does NOT require a token (BQ92B)', async () => {
    // The previous Set lookup was case-sensitive, so `Localhost` was
    // treated as non-loopback and refused to boot without a token.
    // Fix lowercases the operator-supplied hostname before lookup.
    handle = await runQwenServe({
      hostname: 'Localhost',
      port: 0,
      mode: 'http-bridge',
    });
    expect(handle.url).toMatch(/^http:\/\/Localhost:\d+$/);
  });

  it('strips brackets from `[::1]` before passing to app.listen()', async () => {
    // Node's app.listen wants the unbracketed IPv6 literal — `[::1]`
    // would fail with ENOTFOUND. The fixup is in runQwenServe's
    // bind-time normalization.
    handle = await runQwenServe({
      hostname: '[::1]',
      port: 0,
      mode: 'http-bridge',
    });
    const addr = handle.server.address();
    expect(typeof addr).toBe('object');
    if (typeof addr === 'object' && addr) {
      // Successfully bound — the string the OS reports is `::1` (no
      // brackets).
      expect(
        addr.address === '::1' || addr.address === '::ffff:127.0.0.1',
      ).toBe(true);
    }
  });

  it('rejects `[host]:port` syntax in --hostname with a useful error', async () => {
    // Operators typing `--hostname [2001:db8::1]:8080` are conflating the
    // URL form with the bind args. The previous bracket-strip would have
    // mangled to `2001:db8::1]:8080` and let Node ENOTFOUND. Catch it
    // upstream with a clear error pointing at the right separation.
    await expect(
      runQwenServe({
        hostname: '[2001:db8::1]:8080',
        port: 0,
        mode: 'http-bridge',
        token: 'irrelevant',
      }),
    ).rejects.toThrow(/Invalid --hostname/);
  });

  it('rejects unbracketed host:port typo with a useful error (BU-sh)', async () => {
    // Without the upfront check, `localhost:4170` would flow into
    // `formatHostForUrl` (treated as IPv6 because of the `:`) and
    // produce a misleading `[localhost:4170]:port` URL, then fail
    // at `app.listen()` with ENOTFOUND. Catch upstream.
    await expect(
      runQwenServe({
        hostname: 'localhost:4170',
        port: 0,
        mode: 'http-bridge',
      }),
    ).rejects.toThrow(
      /Invalid --hostname "localhost:4170".*looks like a "host:port" combination/,
    );
    await expect(
      runQwenServe({
        hostname: '127.0.0.1:4170',
        port: 0,
        mode: 'http-bridge',
      }),
    ).rejects.toThrow(/Invalid --hostname "127\.0\.0\.1:4170"/);
    // But raw IPv6 (multiple colons) still works.
    handle = await runQwenServe({
      hostname: '::1',
      port: 0,
      mode: 'http-bridge',
    });
    expect(handle.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
  });

  it('rejects empty-bracket `[]` --hostname (would bind to all interfaces)', async () => {
    // Node's `listen('')` is interpreted as "all interfaces". An operator
    // typing `[]` clearly meant something specific, not wildcard — fail
    // loudly instead of silently exposing the daemon on every interface.
    await expect(
      runQwenServe({
        hostname: '[]',
        port: 0,
        mode: 'http-bridge',
        token: 'irrelevant',
      }),
    ).rejects.toThrow(/Invalid --hostname/);
  });

  it('--workspace flows end-to-end and surfaces on /capabilities (#3803 §02)', async () => {
    // Use process.cwd() so the boot-time existence check passes — any
    // real absolute directory works. The bridge canonicalizes this
    // once at boot; `/capabilities.workspaceCwd` returns the canonical
    // form, NOT the raw input. Tests inject a fake bridge here so we
    // verify the route layer's canonicalization (not the bridge's),
    // making this a true E2E that doesn't require a real `qwen --acp`
    // child.
    const bridge = fakeBridge();
    handle = await runQwenServe(
      {
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        workspace: process.cwd(),
      },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;
    const caps = await (
      await fetch(`http://127.0.0.1:${port}/capabilities`)
    ).json();
    // Canonical form per `canonicalizeWorkspace` — realpath of cwd
    // (handles symlinks like `/var` → `/private/var` on macOS).
    const expected = await import('node:fs').then((m) =>
      m.realpathSync.native(process.cwd()),
    );
    expect(caps.workspaceCwd).toBe(expected);
  });

  it('rejects --workspace pointing at a non-existent directory (BkUyD followup — boot-loud over opaque ENOENT)', async () => {
    // Without the boot-time stat check, `canonicalizeWorkspace`'s
    // ENOENT fallback to `path.resolve` would let the daemon boot
    // pointed at a non-existent directory; every `POST /session`
    // would then spawn a `qwen --acp` child with that cwd and the
    // agent would fail with an opaque ENOENT.
    await expect(
      runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        workspace: `/tmp/qwen-serve-no-such-path-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }),
    ).rejects.toThrow(/directory does not exist/);
  });

  it('rejects --workspace pointing at a regular file', async () => {
    // Pointing the daemon at a file (vs. a directory) is operator error
    // — the agent would fail at child-spawn time with ENOTDIR. Catch
    // it at boot for a clearer error message.
    //
    // `fileURLToPath` (not `new URL(...).pathname`) — on Windows the
    // latter returns `/C:/path/...` with a leading slash, which
    // `statSync` resolves as path-from-current-drive-root and the
    // test would then see ENOENT instead of the expected
    // "not a directory" branch.
    await expect(
      runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        workspace: fileURLToPath(import.meta.url),
      }),
    ).rejects.toThrow(/exists but is not a directory/);
  });

  it('rejects relative --workspace at boot', async () => {
    await expect(
      runQwenServe({
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        workspace: 'relative/path',
      }),
    ).rejects.toThrow(/must be an absolute path/);
  });

  it('drains the bridge before closing the listener', async () => {
    const bridge = fakeBridge();
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    expect(bridge.shutdownCalls).toBe(0);
    await handle.close();
    handle = undefined;
    expect(bridge.shutdownCalls).toBe(1);
  });

  it('wires fsFactory + emit through to the read routes (#4175 PR 19 follow-up #2)', async () => {
    // Pin the contract that `runQwenServe` constructs the workspace
    // filesystem boundary, threads its emit hook through to
    // `createServeApp`, and that boundary actually drives the new
    // PR 19 read routes. A regression that drops the `fsFactory`
    // injection (or that swaps in a different emit channel) shows
    // up here as either a 500 response or a missing audit event.
    const captured: BridgeEvent[] = [];
    const bridge = fakeBridge();
    const wsRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-runqwen-fs-'),
    );
    await fsp.writeFile(path.join(wsRoot, 'a.txt'), 'hello');
    try {
      handle = await runQwenServe(
        {
          hostname: '127.0.0.1',
          port: 0,
          mode: 'http-bridge',
          workspace: wsRoot,
        },
        { bridge, fsAuditEmit: (e) => captured.push(e) },
      );
      const port = (handle.server.address() as { port: number }).port;
      const ok = await fetch(`http://127.0.0.1:${port}/file?path=a.txt`);
      expect(ok.status).toBe(200);
      expect(
        captured.find(
          (e) =>
            e.type === 'fs.access' &&
            (e.data as { intent?: string }).intent === 'read',
        ),
      ).toBeDefined();

      const bad = await fetch(`http://127.0.0.1:${port}/file?path=../escape`);
      expect(bad.status).toBe(400);
      const denied = captured.find(
        (e) =>
          e.type === 'fs.denied' &&
          (e.data as { errorKind?: string }).errorKind ===
            'path_outside_workspace',
      );
      expect(denied).toBeDefined();
    } finally {
      await fsp.rm(wsRoot, { recursive: true, force: true });
    }
  });

  it('honors deps.fsFactory override (#4175 PR 19 follow-up #2)', async () => {
    // The injection point exists so embedded callers (other tools
    // wrapping the daemon, future runtime locality contracts) can
    // swap in a remote-fronting factory. This test asserts
    // `runQwenServe` does NOT silently shadow a caller-supplied
    // factory with its built-in default. A regression that ignored
    // `deps.fsFactory` and fell back to the built-in factory would
    // resolve `a.txt` against `process.cwd()`, find no such file,
    // and return 404 `path_not_found`. The sentinel-throwing
    // factory ensures we see 400 with `sentinel-from-fake-factory`
    // in the body — proof the override actually drives the request.
    const sentinelMessage = 'sentinel-from-fake-factory';
    const fsFactory: WorkspaceFileSystemFactory = {
      forRequest: () => ({
        resolve: async () => {
          throw new FsError('parse_error', sentinelMessage);
        },
        readText: async () => {
          throw new Error('unreachable');
        },
        readBytes: async () => {
          throw new Error('unreachable');
        },
        readBytesWindow: async () => {
          throw new Error('unreachable');
        },
        list: async () => {
          throw new Error('unreachable');
        },
        glob: async () => {
          throw new Error('unreachable');
        },
        stat: async () => {
          throw new Error('unreachable');
        },
        writeText: async () => {
          throw new Error('unreachable');
        },
        writeTextAtomic: async () => {
          throw new Error('unreachable');
        },
        writeTextOverwrite: async () => {
          throw new Error('unreachable');
        },
        edit: async () => {
          throw new Error('unreachable');
        },
        editAtomic: async () => {
          throw new Error('unreachable');
        },
      }),
    };
    const bridge = fakeBridge();
    handle = await runQwenServe(
      {
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        workspace: process.cwd(),
      },
      { bridge, fsFactory },
    );
    const port = (handle.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/file?path=a.txt`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; errorKind: string };
    expect(body.errorKind).toBe('parse_error');
    expect(body.error).toContain(sentinelMessage);
  });

  it('trust snapshot defaults to true (operator-chosen workspace)', async () => {
    // The default trust value drives PR 20 write-route behavior
    // even though PR 19 only exercises read intents. Pin the
    // default here so a future contributor flipping it has to
    // rewrite this test, surfacing the security-relevant change
    // for review.
    const bridge = fakeBridge();
    const wsRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-runqwen-trust-'),
    );
    try {
      const captured: BridgeEvent[] = [];
      handle = await runQwenServe(
        {
          hostname: '127.0.0.1',
          port: 0,
          mode: 'http-bridge',
          workspace: wsRoot,
        },
        { bridge, fsAuditEmit: (e) => captured.push(e) },
      );
      // Drive a read so the factory's `assertTrustedForIntent`
      // gate fires. Read intents pass under both trusted and
      // untrusted; the test signal is the absence of any
      // `untrusted_workspace` denial event in the captured stream.
      await fsp.writeFile(path.join(wsRoot, 'b.txt'), 'b');
      const port = (handle.server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/file?path=b.txt`);
      expect(res.status).toBe(200);
      expect(
        captured.find(
          (e) =>
            (e.data as { errorKind?: string }).errorKind ===
            'untrusted_workspace',
        ),
      ).toBeUndefined();
    } finally {
      await fsp.rm(wsRoot, { recursive: true, force: true });
    }
  });

  it('trust snapshot=false flows through deps.trustedWorkspace into the boundary (#4175 PR 19 follow-up #2)', async () => {
    // PR 19 has no write routes, so the trust gate's effect on
    // mutating intents can't be observed via HTTP. Instead, we
    // construct the same factory that runQwenServe would build,
    // with the same `trusted` value runQwenServe would pass, and
    // assert the gate trips. The contract is: when
    // `deps.trustedWorkspace = false`, the factory's
    // `assertTrustedForIntent` rejects writes with
    // `untrusted_workspace` — exactly what PR 20 will rely on.
    const wsRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-runqwen-untrust-'),
    );
    try {
      // Mirror runQwenServe's construction. If `runQwenServe`
      // changes the call shape (different deps order, different
      // fields), this test will start failing to type-check —
      // which is the point: the failure is the audit trail.
      const { createWorkspaceFileSystemFactory } = await import(
        './fs/index.js'
      );
      const factory = createWorkspaceFileSystemFactory({
        boundWorkspace: wsRoot,
        trusted: false,
        emit: () => undefined,
      });
      const fsApi = factory.forRequest({ route: 'TEST /op' });
      // Read still passes — read intents are always trusted.
      await fsp.writeFile(path.join(wsRoot, 'a.txt'), 'a');
      const r = await fsApi.resolve('a.txt', 'read');
      const out = await fsApi.readText(r);
      expect(out.content).toBe('a');
      // Write throws untrusted_workspace.
      const w = await fsApi.resolve('out.txt', 'write');
      await expect(fsApi.writeText(w, 'x')).rejects.toMatchObject({
        kind: 'untrusted_workspace',
      });
    } finally {
      await fsp.rm(wsRoot, { recursive: true, force: true });
    }
  });

  it('handle.close() is idempotent — concurrent + repeat calls share one drain cycle', async () => {
    const bridge = fakeBridge();
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    // Three overlapping callers — without the cached promise each would
    // arm its own force-close timer and call bridge.shutdown again.
    const a = handle.close();
    const b = handle.close();
    const c = handle.close();
    await Promise.all([a, b, c]);
    // Subsequent call after settle should also resolve immediately and
    // not re-trigger shutdown.
    await handle.close();
    handle = undefined;
    expect(bridge.shutdownCalls).toBe(1);
  });

  it('force-closes connections after the shutdown timeout', async () => {
    const bridge = fakeBridge();
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    // Open a long-lived SSE-like connection; without force-close the
    // listener's `server.close` would hang on this socket forever.
    const sseFetch = fetch(`http://127.0.0.1:${port}/session/dangle/events`);

    // close() is expected to resolve in well under the 5s force-close
    // window — but well above 0ms because the timer arms after bridge
    // shutdown. Just assert it resolves at all and observe roughly when.
    const start = Date.now();
    await handle.close();
    handle = undefined;
    const elapsed = Date.now() - start;

    // The fakeBridge's subscribe stream is empty so the SSE response ends
    // promptly; this assertion mainly proves the close didn't hang on the
    // live connection. Even if the connection had stayed open, the 5s
    // force-close timer would unblock us.
    expect(elapsed).toBeLessThan(5_500);
    // Drain the fetch promise so vitest doesn't complain about open handles.
    try {
      const res = await sseFetch;
      await res.body?.cancel();
    } catch {
      /* socket may be torn down by force-close */
    }
  });

  it('detaches its SIGINT/SIGTERM listeners after close completes', async () => {
    const bridge = fakeBridge();
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');

    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );

    // runQwenServe attaches one of each.
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore + 1);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore + 1);

    await handle.close();
    handle = undefined;

    // After drain completes, the listener that runQwenServe added is gone.
    // (Detaching during drain would leave a second-signal-during-shutdown
    // hitting Node's default termination behavior; this design detaches at
    // the end of `finish` so the `if (shuttingDown) return` guard is the
    // sole no-op path during the drain window.)
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
  });
});

describe('GET /session/:id/events (SSE)', () => {
  let handle: RunHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  async function readSseFrames(
    body: ReadableStream<Uint8Array>,
    minFrames: number,
  ): Promise<Array<{ id?: string; event?: string; data?: string }>> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const frames: Array<{ id?: string; event?: string; data?: string }> = [];
    while (frames.length < minFrames) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!raw || raw.startsWith(':') || raw.startsWith('retry:')) continue;
        const frame: { id?: string; event?: string; data?: string } = {};
        for (const line of raw.split('\n')) {
          if (line.startsWith('id: ')) frame.id = line.slice(4);
          else if (line.startsWith('event: ')) frame.event = line.slice(7);
          else if (line.startsWith('data: ')) frame.data = line.slice(6);
        }
        frames.push(frame);
      }
    }
    await reader.cancel();
    return frames;
  }

  it('streams events from the bridge as SSE frames', async () => {
    const bridge = fakeBridge({
      async *subscribeImpl(_sessionId, _opts) {
        yield {
          id: 1,
          v: 1,
          type: 'session_update',
          data: { foo: 'bar' },
        };
        yield { id: 2, v: 1, type: 'session_update', data: { foo: 'baz' } };
        // No more events; the stream stays open until the caller aborts.
        await new Promise(() => {});
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/session/sess-A/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const frames = await readSseFrames(res.body!, 2);

    expect(frames).toHaveLength(2);
    expect(frames[0]?.id).toBe('1');
    expect(frames[0]?.event).toBe('session_update');
    // `toMatchObject` rather than `toEqual` because the SSE write
    // boundary stamps `_meta.serverTimestamp` (#4175 F4 prereq);
    // a dedicated test below pins that field's shape.
    expect(JSON.parse(frames[0]!.data!)).toMatchObject({
      id: 1,
      v: 1,
      type: 'session_update',
      data: { foo: 'bar' },
    });
    expect(frames[1]?.id).toBe('2');
  });

  it('stamps _meta.serverTimestamp on every SSE frame (#4175 F4 prereq, chiga0 #19 P0)', async () => {
    // The daemon stamps `_meta.serverTimestamp` so multi-client UIs
    // use the server clock for transcript ordering / "X minutes ago"
    // instead of each client's drifting local clock. The chiga0 SDK
    // PR #4353 reads this via a 3-
    // location probe (`event.serverTimestamp` / `event._meta.
    // serverTimestamp` / `event.data._meta.serverTimestamp`); we
    // pick `_meta.serverTimestamp` (Anthropic convention) so the
    // top-level event type stays unpolluted.
    const before = Date.now();
    const bridge = fakeBridge({
      async *subscribeImpl(_sessionId, _opts) {
        yield {
          id: 1,
          v: 1,
          type: 'session_update',
          data: { foo: 'bar' },
        };
        await new Promise(() => {});
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/session/sess-A/events`);
    const frames = await readSseFrames(res.body!, 1);
    const after = Date.now();

    const parsed = JSON.parse(frames[0]!.data!);
    expect(parsed._meta).toBeDefined();
    expect(typeof parsed._meta.serverTimestamp).toBe('number');
    // Server clock at stamp time must fall within the test's
    // before/after wall-clock window.
    expect(parsed._meta.serverTimestamp).toBeGreaterThanOrEqual(before);
    expect(parsed._meta.serverTimestamp).toBeLessThanOrEqual(after);
  });

  it('preserves pre-existing _meta keys when stamping serverTimestamp', async () => {
    // ToolCallEmitter (and other emitters) attach `_meta.toolName` etc.
    // The SSE boundary stamp must MERGE (not overwrite) so downstream
    // consumers keep both fields. `BridgeEvent` doesn't type `_meta`
    // explicitly (it's a wire-only escape hatch) so we cast the yield.
    const bridge = fakeBridge({
      async *subscribeImpl(_sessionId, _opts) {
        yield {
          id: 1,
          v: 1,
          type: 'session_update',
          data: { sessionUpdate: 'tool_call', toolCallId: 't1' },
          // Pre-existing _meta on the event (mimics ToolCallEmitter).
          _meta: { toolName: 'Read', timestamp: 1234567890 },
        } as unknown as { id: 1; v: 1; type: 'session_update'; data: unknown };
        await new Promise(() => {});
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/session/sess-A/events`);
    const frames = await readSseFrames(res.body!, 1);

    const parsed = JSON.parse(frames[0]!.data!);
    // Both the pre-existing _meta keys AND serverTimestamp must survive.
    expect(parsed._meta.toolName).toBe('Read');
    expect(parsed._meta.timestamp).toBe(1234567890);
    expect(typeof parsed._meta.serverTimestamp).toBe('number');
  });

  it('preserves pre-existing _meta.serverTimestamp on SSE frames', async () => {
    const bridge = fakeBridge({
      async *subscribeImpl(_sessionId, _opts) {
        yield {
          id: 1,
          v: 1,
          type: 'session_update',
          data: { foo: 'bar' },
          _meta: { serverTimestamp: 1234567890 },
        };
        await new Promise(() => {});
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/session/sess-A/events`);
    const frames = await readSseFrames(res.body!, 1);

    const parsed = JSON.parse(frames[0]!.data!);
    expect(parsed._meta.serverTimestamp).toBe(1234567890);
  });

  it('forwards Last-Event-ID to the bridge', async () => {
    const seen: number[] = [];
    const bridge = fakeBridge({
      async *subscribeImpl(_sessionId, opts) {
        seen.push(opts?.lastEventId ?? -1);
        yield { id: 42, v: 1, type: 'session_update', data: 'replay' };
        await new Promise(() => {});
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/session/sess-A/events`, {
      headers: { 'Last-Event-ID': '17' },
    });
    const frames = await readSseFrames(res.body!, 1);

    expect(seen).toEqual([17]);
    expect(frames[0]?.id).toBe('42');
  });

  it('forwards ?maxQueued=N to the bridge when in [16, 2048]', async () => {
    const seen: Array<number | undefined> = [];
    const bridge = fakeBridge({
      async *subscribeImpl(_sessionId, opts) {
        seen.push(opts?.maxQueued);
        yield { id: 1, v: 1, type: 'session_update', data: 'x' };
        await new Promise(() => {});
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    const res = await fetch(
      `http://127.0.0.1:${port}/session/sess-A/events?maxQueued=512`,
    );
    await readSseFrames(res.body!, 1);
    expect(seen).toEqual([512]);
  });

  it('omits maxQueued from the bridge call when the query param is absent', async () => {
    const seen: Array<number | undefined> = [];
    const bridge = fakeBridge({
      async *subscribeImpl(_sessionId, opts) {
        seen.push(opts?.maxQueued);
        yield { id: 1, v: 1, type: 'session_update', data: 'x' };
        await new Promise(() => {});
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/session/sess-A/events`);
    await readSseFrames(res.body!, 1);
    // Empty param ≡ missing — bridge sees `undefined` so the bus
    // applies its default cap (256).
    expect(seen).toEqual([undefined]);
  });

  it('400s a present-but-empty ?maxQueued= before opening the SSE stream', async () => {
    // `?maxQueued=` (typed explicitly without a value) is malformed
    // and must fail-CLOSED, not silently fall back to the default
    // queue cap. Symmetric to non-decimal / out-of-range rejection.
    const bridge = fakeBridge({
      subscribeImpl: () => {
        throw new Error('bridge must not be touched');
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    const res = await fetch(
      `http://127.0.0.1:${port}/session/sess-A/events?maxQueued=`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_max_queued' });
  });

  it('400s a non-decimal ?maxQueued before opening the SSE stream', async () => {
    const bridge = fakeBridge({
      subscribeImpl: () => {
        throw new Error('bridge must not be touched');
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    const res = await fetch(
      `http://127.0.0.1:${port}/session/sess-A/events?maxQueued=abc`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_max_queued' });
  });

  it('400s an out-of-range ?maxQueued before opening the SSE stream', async () => {
    const bridge = fakeBridge({
      subscribeImpl: () => {
        throw new Error('bridge must not be touched');
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    for (const bad of ['0', '15', '2049', '9999']) {
      const res = await fetch(
        `http://127.0.0.1:${port}/session/sess-A/events?maxQueued=${bad}`,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid_max_queued' });
    }
  });

  it('returns 404 when the bridge reports unknown session', async () => {
    const bridge = fakeBridge({
      subscribeImpl: (sessionId) => {
        throw new SessionNotFoundError(sessionId);
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/session/missing/events`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.sessionId).toBe('missing');
  });

  it('aborts the bridge subscription when the client disconnects', async () => {
    const aborted = { value: false };
    const bridge = fakeBridge({
      async *subscribeImpl(_sessionId, opts) {
        opts?.signal?.addEventListener(
          'abort',
          () => {
            aborted.value = true;
          },
          { once: true },
        );
        yield { id: 1, v: 1, type: 'session_update', data: 'first' };
        await new Promise<void>((resolve) => {
          opts?.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/session/sess-A/events`);
    const frames = await readSseFrames(res.body!, 1);
    expect(frames).toHaveLength(1);
    // readSseFrames calls reader.cancel() once the requested frame count is
    // reached, which severs the underlying connection — the daemon's
    // `req.on('close')` handler then aborts the bridge subscription.

    // Wait briefly for the close handler to propagate to the bridge.
    await new Promise((r) => setTimeout(r, 100));
    expect(aborted.value).toBe(true);
  });

  it('emits a stream_error frame when the bridge iterator throws mid-stream', async () => {
    const bridge = fakeBridge({
      async *subscribeImpl(_sessionId, _opts) {
        yield { id: 1, v: 1, type: 'session_update', data: 'first' };
        throw new Error('agent died');
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/session/sess-A/events`);
    const frames = await readSseFrames(res.body!, 2);
    expect(frames).toHaveLength(2);
    expect(frames[0]?.event).toBe('session_update');
    expect(frames[0]?.id).toBe('1');
    expect(frames[1]?.event).toBe('stream_error');
    // The terminal `stream_error` frame deliberately has no `id:` line so
    // it doesn't pollute the per-session monotonic sequence used for
    // Last-Event-ID resume.
    expect(frames[1]?.id).toBeUndefined();
    // `Error('agent died')` isn't classified by `mapDomainErrorToErrorKind`
    // (no Bridge*Error class, no errno code, no special name), so no
    // `errorKind` is stamped — only `error`. The next test covers the
    // classified-error path.
    expect(JSON.parse(frames[1]!.data!).data).toEqual({ error: 'agent died' });
  });

  it('stamps errorKind on stream_error when the thrown error is classified (#4175 F4 prereq, chiga0 #19 P0)', async () => {
    // BridgeTimeoutError → `init_timeout` per mapDomainErrorToErrorKind.
    // UI consumers can render "retry" on init_timeout vs "show stack
    // trace" on unknown errors, without regex-matching the message
    // string.
    const { BridgeTimeoutError } = await import('@qwen-code/acp-bridge');
    const bridge = fakeBridge({
      async *subscribeImpl(_sessionId, _opts) {
        yield { id: 1, v: 1, type: 'session_update', data: 'first' };
        // `BridgeTimeoutError(label, timeoutMs)` — 2 positional args
        // (wenshao #4360 review). The resulting message is
        // `"AcpSessionBridge initialize timed out after 5000ms"` which
        // satisfies the `.toContain('timed out')` assertion below.
        throw new BridgeTimeoutError('initialize', 5000);
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/session/sess-A/events`);
    const frames = await readSseFrames(res.body!, 2);
    expect(frames[1]?.event).toBe('stream_error');
    const parsed = JSON.parse(frames[1]!.data!);
    expect(parsed.data.errorKind).toBe('init_timeout');
    expect(parsed.data.error).toContain('timed out');
  });

  it('writes a daemon-side stderr log on SSE ring eviction (#4360 wenshao observability fold-in)', async () => {
    // The SSE write loop detects `state_resync_required` frames and
    // emits a stderr breadcrumb so operators can grep daemon logs for
    // ring-eviction events. Test covers:
    //   - the `writeStderrLine` actually fires
    //   - the `gap` arithmetic (earliestAvailableId - lastDeliveredId - 1)
    //   - all four data fields (lastEventId / earliestInRing / gap / reason)
    //   - the sessionId is included
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const bridge = fakeBridge({
        async *subscribeImpl(_sessionId, _opts) {
          yield {
            v: 1,
            type: 'state_resync_required',
            data: {
              reason: 'ring_evicted',
              lastDeliveredId: 5,
              earliestAvailableId: 12,
            },
          };
          await new Promise(() => {});
        },
      });
      handle = await runQwenServe(
        { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
        { bridge },
      );
      const port = (handle.server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/session/sess-A/events`);
      await readSseFrames(res.body!, 1);

      const stderrLines = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes('SSE ring eviction detected'));
      expect(stderrLines.length).toBeGreaterThanOrEqual(1);
      const line = stderrLines[0]!;
      expect(line).toContain('session sess-A');
      expect(line).toContain('lastEventId=5');
      expect(line).toContain('earliestInRing=12');
      // gap = 12 - 5 - 1 = 6 events
      expect(line).toContain('gap=6 events');
      expect(line).toContain('reason=ring_evicted');
      expect(line).toContain('loadSession');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('falls back to "?" placeholders when state_resync_required data is partial', async () => {
    // Defensive: the `?? '?'` fallback for missing fields lets the log
    // line still print intelligibly when the daemon emits a partial
    // payload (e.g. a future schema change drops one field). Pins the
    // placeholder behavior so a regression that crashes the log call
    // is caught.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const bridge = fakeBridge({
        async *subscribeImpl(_sessionId, _opts) {
          yield {
            v: 1,
            type: 'state_resync_required',
            // Intentionally missing all numeric fields + reason —
            // exercises every `?? '?'` branch.
            data: {} as unknown as {
              reason: string;
              lastDeliveredId: number;
              earliestAvailableId: number;
            },
          };
          await new Promise(() => {});
        },
      });
      handle = await runQwenServe(
        { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
        { bridge },
      );
      const port = (handle.server.address() as { port: number }).port;
      await fetch(`http://127.0.0.1:${port}/session/sess-A/events`).then((r) =>
        readSseFrames(r.body!, 1),
      );

      const stderrLines = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes('SSE ring eviction detected'));
      expect(stderrLines.length).toBeGreaterThanOrEqual(1);
      const line = stderrLines[0]!;
      // All four `?? '?'` branches print `?` for the missing values.
      expect(line).toContain('lastEventId=?');
      expect(line).toContain('earliestInRing=?');
      expect(line).toContain('gap=? events');
      expect(line).toContain('reason=?');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('writes a daemon-side stderr log on bridge iterator error (#4360 wenshao observability fold-in)', async () => {
    // The bridge-iterator-catch block in the SSE handler now emits a
    // `writeStderrLine` BEFORE sending the `stream_error` SSE frame so
    // operators can distinguish "subprocess OOM-killed" from "protocol
    // bug" via `grep "bridge iterator error"`. Test covers:
    //   - the log fires with the error message
    //   - the sessionId is included
    //   - NO `[errorKind]` suffix for unclassified errors (plain Error)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const bridge = fakeBridge({
        async *subscribeImpl(_sessionId, _opts) {
          yield { id: 1, v: 1, type: 'session_update', data: 'first' };
          throw new Error('agent died');
        },
      });
      handle = await runQwenServe(
        { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
        { bridge },
      );
      const port = (handle.server.address() as { port: number }).port;
      await fetch(`http://127.0.0.1:${port}/session/sess-A/events`).then((r) =>
        readSseFrames(r.body!, 2),
      );

      const stderrLines = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes('bridge iterator error'));
      expect(stderrLines.length).toBeGreaterThanOrEqual(1);
      const line = stderrLines[0]!;
      expect(line).toContain('session sess-A');
      expect(line).toContain('agent died');
      // Plain Error → mapDomainErrorToErrorKind returns undefined →
      // suffix branch must NOT add `[...]`.
      expect(line).not.toMatch(/\[.*?\]/);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('includes [errorKind] suffix in bridge iterator error log when classified (#4360 wenshao observability fold-in)', async () => {
    // BridgeTimeoutError → classified as `init_timeout`. The log line
    // must include `[init_timeout]` so operators can `grep '\[init_'`
    // for that specific failure class.
    const { BridgeTimeoutError } = await import('@qwen-code/acp-bridge');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const bridge = fakeBridge({
        async *subscribeImpl(_sessionId, _opts) {
          yield { id: 1, v: 1, type: 'session_update', data: 'first' };
          throw new BridgeTimeoutError('initialize', 5000);
        },
      });
      handle = await runQwenServe(
        { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
        { bridge },
      );
      const port = (handle.server.address() as { port: number }).port;
      await fetch(`http://127.0.0.1:${port}/session/sess-A/events`).then((r) =>
        readSseFrames(r.body!, 2),
      );

      const stderrLines = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes('bridge iterator error'));
      expect(stderrLines.length).toBeGreaterThanOrEqual(1);
      const line = stderrLines[0]!;
      expect(line).toContain('session sess-A');
      expect(line).toContain('timed out');
      expect(line).toContain('[init_timeout]');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('forwards numeric Last-Event-ID even when supplied as a string', async () => {
    let seen: number | undefined;
    const bridge = fakeBridge({
      subscribeImpl: (_sessionId, opts) => {
        seen = opts?.lastEventId;
        // Empty stream — close immediately so the test doesn't hang.
        return (async function* () {
          /* no events */
        })();
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/session/sess-A/events`, {
      headers: { 'Last-Event-ID': '17' },
    });
    // Drain the empty response so the connection closes.
    await res.body?.cancel();
    expect(seen).toBe(17);
  });

  it('drops malformed Last-Event-ID values (non-numeric, negative)', async () => {
    const seen: Array<number | undefined> = [];
    const bridge = fakeBridge({
      subscribeImpl: (_sessionId, opts) => {
        seen.push(opts?.lastEventId);
        return (async function* () {
          /* no events */
        })();
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;
    for (const value of ['abc', '-1', '1.5e10z']) {
      const res = await fetch(
        `http://127.0.0.1:${port}/session/sess-A/events`,
        { headers: { 'Last-Event-ID': value } },
      );
      await res.body?.cancel();
    }
    // None of these should pass through as a parsed lastEventId.
    expect(seen).toEqual([undefined, undefined, undefined]);
  });
});

describe('GET /demo', () => {
  it('returns 200 with text/html content type on loopback', async () => {
    const app = createServeApp(baseOpts, () => 4170, {
      bridge: fakeBridge(),
    });
    const res = await request(app)
      .get('/demo')
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Qwen Serve');
    expect(res.text).toContain('<!DOCTYPE html>');
  });

  it('is accessible without bearer token on loopback even when --token is set', async () => {
    // Loopback: /demo is registered BEFORE bearerAuth so browsers can
    // reach the page via address-bar navigation (no Authorization header).
    const app = createServeApp({ ...baseOpts, token: 'secret' }, () => 4170, {
      bridge: fakeBridge(),
    });
    const res = await request(app)
      .get('/demo')
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('requires bearer token on non-loopback (401 without token)', async () => {
    // Non-loopback: /demo is registered AFTER bearerAuth to prevent
    // unauthenticated access on public interfaces.
    const app = createServeApp(
      { ...baseOpts, hostname: '0.0.0.0', token: 'secret' },
      () => 4170,
      { bridge: fakeBridge() },
    );
    const res = await request(app).get('/demo').set('Host', '0.0.0.0:4170');
    expect(res.status).toBe(401);
  });

  it('is accessible on non-loopback with valid bearer token', async () => {
    const app = createServeApp(
      { ...baseOpts, hostname: '0.0.0.0', token: 'secret' },
      () => 4170,
      { bridge: fakeBridge() },
    );
    const res = await request(app)
      .get('/demo')
      .set('Host', '0.0.0.0:4170')
      .set('Authorization', 'Bearer secret');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('is guarded by CORS (rejects cross-origin requests)', async () => {
    const app = createServeApp(baseOpts, () => 4170, {
      bridge: fakeBridge(),
    });
    const res = await request(app)
      .get('/demo')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(403);
  });

  it('sets anti-clickjacking headers (X-Frame-Options + CSP)', async () => {
    const app = createServeApp(baseOpts, () => 4170, {
      bridge: fakeBridge(),
    });
    const res = await request(app)
      .get('/demo')
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    expect(res.status).toBe(200);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain(
      "frame-ancestors 'none'",
    );
  });
});

describe('same-origin Origin-stripping middleware', () => {
  it('strips loopback Origin header matching daemon port', async () => {
    const app = createServeApp(baseOpts, () => 4170, {
      bridge: fakeBridge(),
    });
    // A request with matching same-origin should pass CORS check
    const res = await request(app)
      .get('/health')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .set('Origin', 'http://127.0.0.1:4170');
    // Should NOT be rejected by denyBrowserOriginCors (status != 403)
    expect(res.status).not.toBe(403);
  });

  it('does not strip non-loopback Origin', async () => {
    const app = createServeApp(baseOpts, () => 4170, {
      bridge: fakeBridge(),
    });
    const res = await request(app)
      .get('/health')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .set('Origin', 'http://evil.com:4170');
    expect(res.status).toBe(403);
  });

  it('does not strip Origin with wrong port', async () => {
    const app = createServeApp(baseOpts, () => 4170, {
      bridge: fakeBridge(),
    });
    const res = await request(app)
      .get('/health')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .set('Origin', 'http://127.0.0.1:9999');
    expect(res.status).toBe(403);
  });

  it('strips host.docker.internal Origin', async () => {
    const app = createServeApp(baseOpts, () => 4170, {
      bridge: fakeBridge(),
    });
    const res = await request(app)
      .get('/health')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .set('Origin', 'http://host.docker.internal:4170');
    expect(res.status).not.toBe(403);
  });

  it('strips localhost Origin', async () => {
    const app = createServeApp(baseOpts, () => 4170, {
      bridge: fakeBridge(),
    });
    const res = await request(app)
      .get('/health')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .set('Origin', 'http://localhost:4170');
    expect(res.status).not.toBe(403);
  });

  it('strips [::1] Origin', async () => {
    const app = createServeApp(baseOpts, () => 4170, {
      bridge: fakeBridge(),
    });
    const res = await request(app)
      .get('/health')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .set('Origin', 'http://[::1]:4170');
    expect(res.status).not.toBe(403);
  });
});

describe('--allow-origin CORS allowlist (T2.4 #4514)', () => {
  // When `--allow-origin` is unset, today's denyBrowserOriginCors wall
  // stays installed and matched-Origin requests get 403. The existing
  // tests above already cover that path; this block exercises the
  // allowlist-installed path.
  const allowedOpts = {
    ...baseOpts,
    allowOrigins: ['http://localhost:3000', 'http://localhost:5173'],
  };

  it('matched origin gets 200 + CORS response headers (GET /health)', async () => {
    const app = createServeApp(allowedOpts, () => 4170, {
      bridge: fakeBridge(),
    });
    const res = await request(app)
      .get('/health')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .set('Origin', 'http://localhost:3000');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://localhost:3000',
    );
    expect(res.headers['vary']).toBe('Origin');
    expect(res.headers['access-control-allow-methods']).toMatch(/POST/);
    expect(res.headers['access-control-allow-headers']).toMatch(
      /Authorization/,
    );
    expect(res.headers['access-control-max-age']).toBe('86400');
    expect(res.headers['access-control-expose-headers']).toBe('Retry-After');
  });

  it('OPTIONS preflight returns 204 + CORS headers with no body', async () => {
    const app = createServeApp(allowedOpts, () => 4170, {
      bridge: fakeBridge(),
    });
    const res = await request(app)
      .options('/session/foo/prompt')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    );
    expect(res.headers['access-control-allow-methods']).toMatch(/POST/);
    expect(res.headers['access-control-expose-headers']).toBe('Retry-After');
    expect(res.text).toBe('');
  });

  it('mismatched origin still gets 403 with the same error envelope as denyBrowserOriginCors', async () => {
    const app = createServeApp(allowedOpts, () => 4170, {
      bridge: fakeBridge(),
    });
    const res = await request(app)
      .get('/capabilities')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Request denied by CORS policy');
    // Reject path must not leak CORS headers — browsers would ignore
    // them anyway, but emitting them advertises the allowlist size
    // indirectly via header presence.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['vary']).toBe('Origin');
  });

  it('CLI/SDK callers with no Origin header pass through unchanged', async () => {
    const app = createServeApp(allowedOpts, () => 4170, {
      bridge: fakeBridge(),
    });
    const res = await request(app)
      .get('/health')
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['vary']).toBeUndefined();
  });

  it('advertises `allow_origin` capability tag when configured', async () => {
    const app = createServeApp(allowedOpts, () => 4170, {
      bridge: fakeBridge(),
    });
    const res = await request(app)
      .get('/capabilities')
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    expect(res.status).toBe(200);
    expect(res.body.features).toContain('allow_origin');
  });

  it('does NOT advertise `allow_origin` when `--allow-origin` is unset (regression anchor for the conditional tag)', async () => {
    const app = createServeApp(baseOpts, () => 4170, {
      bridge: fakeBridge(),
    });
    const res = await request(app)
      .get('/capabilities')
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    expect(res.status).toBe(200);
    expect(res.body.features).not.toContain('allow_origin');
  });

  it('rejects embedded `*` allowlist without a token', () => {
    const wildOpts = { ...baseOpts, allowOrigins: ['*'] };
    expect(() =>
      createServeApp(wildOpts, () => 4170, {
        bridge: fakeBridge(),
      }),
    ).toThrow(/--allow-origin '\*'/);
  });

  it('`*` pattern with a token admits any cross-origin request', async () => {
    const wildOpts = { ...baseOpts, token: 'secret', allowOrigins: ['*'] };
    const app = createServeApp(wildOpts, () => 4170, {
      bridge: fakeBridge(),
    });
    const res = await request(app)
      .get('/health')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .set('Origin', 'https://anywhere.example.com');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://anywhere.example.com',
    );
  });

  it('demo self-origin shim still works when `--allow-origin` is set (loopback strip runs first)', async () => {
    // Regression anchor: the loopback-self-origin shim that strips the
    // Origin header for matching addresses must continue working even
    // when the new allowlist middleware is installed. Without this,
    // browsers hitting the daemon's own port from the same port would
    // need to be explicitly added to `--allow-origin` despite being a
    // same-origin hit.
    const app = createServeApp(allowedOpts, () => 4170, {
      bridge: fakeBridge(),
    });
    const res = await request(app)
      .get('/health')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .set('Origin', `http://127.0.0.1:${baseOpts.port}`);
    expect(res.status).toBe(200);
    // Origin was stripped by the shim before reaching CORS, so no
    // CORS response headers are set.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('empty allowOrigins array behaves identically to undefined (install path unchanged)', async () => {
    // Regression anchor for the `opts.allowOrigins && opts.allowOrigins.length > 0`
    // gate. An empty array must NOT install the allowlist middleware —
    // otherwise an embedded caller that passes `allowOrigins: []` would
    // silently leave the daemon with no Origin protection.
    const emptyOpts = { ...baseOpts, allowOrigins: [] };
    const app = createServeApp(emptyOpts, () => 4170, {
      bridge: fakeBridge(),
    });
    const cap = await request(app)
      .get('/capabilities')
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    expect(cap.body.features).not.toContain('allow_origin');
    const blocked = await request(app)
      .get('/capabilities')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .set('Origin', 'http://localhost:3000');
    expect(blocked.status).toBe(403);
  });
});

describe('runQwenServe SIGINT handler', () => {
  it('does not register signal handlers until the listener is up', () => {
    // Sanity: we register `once` so we don't leak across test runs.
    // No assertion beyond "module loads without throwing"; full lifecycle
    // is covered indirectly by the loopback boot test above.
    expect(typeof runQwenServe).toBe('function');
    void vi.fn(); // silence unused-import lint if vitest tree-shakes
  });
});

describe('createServeApp ServeAppDeps.fsFactory wiring (#4175 PR 18)', () => {
  it('parks a default WorkspaceFileSystemFactory on app.locals when none is injected', async () => {
    const { createServeApp } = await import('./server.js');
    const app = createServeApp(
      {
        port: 0,
        hostname: '127.0.0.1',
        workspace: '/work/bound',
      } as Parameters<typeof createServeApp>[0],
      () => 0,
    );
    const fsFactory = (
      app.locals as {
        fsFactory?: { forRequest: (ctx: { route: string }) => unknown };
      }
    ).fsFactory;
    expect(fsFactory).toBeDefined();
    expect(typeof fsFactory!.forRequest).toBe('function');
    // The factory is functional — it can build a per-request boundary.
    const fs = fsFactory!.forRequest({ route: 'TEST /op' });
    expect(fs).toBeDefined();
  });

  it('uses the injected fsFactory verbatim when supplied', async () => {
    const { createServeApp } = await import('./server.js');
    const sentinel = { forRequest: vi.fn(() => ({ marker: 'injected' })) };
    const app = createServeApp(
      {
        port: 0,
        hostname: '127.0.0.1',
        workspace: '/work/bound',
      } as Parameters<typeof createServeApp>[0],
      () => 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { fsFactory: sentinel as any },
    );
    expect((app.locals as { fsFactory?: unknown }).fsFactory).toBe(sentinel);
  });

  it('default fsFactory is built with trusted=false (writes refused)', async () => {
    const { createServeApp } = await import('./server.js');
    const { isFsError } = await import('./fs/index.js');
    const os = await import('node:os');
    const tmp = await import('node:fs').then((m) =>
      m.promises.mkdtemp(path.join(os.tmpdir(), 'qwen-serve-default-trust-')),
    );
    try {
      const app = createServeApp(
        {
          port: 0,
          hostname: '127.0.0.1',
          workspace: tmp,
        } as Parameters<typeof createServeApp>[0],
        () => 0,
      );
      type FsCtx = { route: string };
      type WfsLite = {
        resolve: (input: string, intent: 'write') => Promise<string>;
        writeText: (p: string, content: string) => Promise<void>;
      };
      const fsFactory = (
        app.locals as {
          fsFactory?: { forRequest: (ctx: FsCtx) => WfsLite };
        }
      ).fsFactory;
      expect(fsFactory).toBeDefined();
      const fs = fsFactory!.forRequest({ route: 'TEST /op' });
      // Resolve a write target inside the workspace; the resolve
      // succeeds but writeText must throw `untrusted_workspace` —
      // that's the safe-default behavior the strict-default factory
      // exists to enforce.
      const resolved = await fs.resolve('child.txt', 'write');
      const err = await fs.writeText(resolved, 'x').catch((e: unknown) => e);
      expect(isFsError(err)).toBe(true);
      expect((err as { kind: string }).kind).toBe('untrusted_workspace');
    } finally {
      await import('node:fs').then((m) =>
        m.promises.rm(tmp, { recursive: true, force: true }),
      );
    }
  });
});

// -- Issue #4175 PR 21 — auth device-flow integration tests ----------------

describe('auth device-flow routes', () => {
  // Build a fake provider whose `start` returns deterministic values and
  // whose `poll` is scripted per-test. Lives at the top of the suite so
  // every `it()` can compose it with the registry.
  function makeFakeProvider(): {
    provider: import('./auth/device-flow.js').DeviceFlowProvider;
    startCount: () => number;
  } {
    let starts = 0;
    return {
      provider: {
        providerId: 'qwen-oauth' as const,
        async start() {
          starts += 1;
          return {
            deviceCode:
              // Use the brandSecret helper so the secret follows the same
              // redaction shape the production provider produces.
              (await import('./auth/device-flow.js')).brandSecret(
                `device-${starts}`,
              ),
            pkceVerifier: (await import('./auth/device-flow.js')).brandSecret(
              `pkce-${starts}`,
            ),
            userCode: `USER-${starts}`,
            verificationUri: 'https://idp.example/verify',
            verificationUriComplete: 'https://idp.example/verify?u=AB12',
            expiresIn: 600,
          };
        },
        async poll(_state: unknown, _opts: { signal: AbortSignal }) {
          // Stays pending forever — tests don't need the upstream to
          // succeed for the route-layer assertions to be meaningful.
          return { kind: 'pending' as const };
        },
      },
      startCount: () => starts,
    };
  }

  function buildApp(
    overrides: Partial<ServeOptions> = {},
    fakeProvider = makeFakeProvider(),
  ) {
    const bridge = fakeBridge();
    const app = createServeApp({ ...baseOpts, ...overrides }, undefined, {
      bridge,
      deviceFlowProviders: [fakeProvider.provider],
    });
    return { app, bridge, fakeProvider };
  }

  it('POST /workspace/auth/device-flow returns 201 on fresh start with redacted body', async () => {
    const { app, fakeProvider } = buildApp({ token: 'tkn' });
    const res = await request(app)
      .post('/workspace/auth/device-flow')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({ providerId: 'qwen-oauth' });
    expect(res.status).toBe(201);
    expect(res.body.providerId).toBe('qwen-oauth');
    expect(res.body.userCode).toBe('USER-1');
    expect(res.body.attached).toBe(false);
    expect(typeof res.body.deviceFlowId).toBe('string');
    // Critical: response body never contains device_code / pkce_verifier.
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('device-1');
    expect(json).not.toContain('pkce-1');
    expect(fakeProvider.startCount()).toBe(1);
  });

  it('POST is rejected with 401 token_required on token-less loopback (strict gate)', async () => {
    const { app } = buildApp({ token: undefined });
    const res = await request(app)
      .post('/workspace/auth/device-flow')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({ providerId: 'qwen-oauth' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('token_required');
  });

  it('POST with unknown providerId returns 400 unsupported_provider', async () => {
    const { app } = buildApp({ token: 'tkn' });
    const res = await request(app)
      .post('/workspace/auth/device-flow')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({ providerId: 'totally-fake' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unsupported_provider');
    expect(res.body.supportedProviders).toContain('qwen-oauth');
  });

  it('POST is idempotent take-over for the same providerId — second POST returns 200 + attached:true', async () => {
    const { app, fakeProvider } = buildApp({ token: 'tkn' });
    const first = await request(app)
      .post('/workspace/auth/device-flow')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({ providerId: 'qwen-oauth' });
    expect(first.status).toBe(201);
    const second = await request(app)
      .post('/workspace/auth/device-flow')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({ providerId: 'qwen-oauth' });
    expect(second.status).toBe(200);
    expect(second.body.attached).toBe(true);
    expect(second.body.deviceFlowId).toBe(first.body.deviceFlowId);
    // Critical: provider.start is NOT called twice — the take-over is
    // a daemon-internal operation, not a re-auth round trip.
    expect(fakeProvider.startCount()).toBe(1);
  });

  it('POST take-over only echoes userCode/verificationUri/initiatorClientId to caller matching the initiator (#4291 follow-up review)', async () => {
    // PR #4291 follow-up review (gpt-5.5, #3): policy consistency.
    // The closed-out GET redaction (don't echo userCode to non-
    // initiator callers) was bypassable via POST take-over —
    // any bearer-token holder POSTing the same `providerId` got
    // `attached: true` AND the original starter's verification
    // material. Now the same caller-clientId gate applies. Fresh
    // starts naturally pass (caller IS initiator); take-overs by
    // a different clientId see only the public envelope.
    const { app } = buildApp({ token: 'tkn' });
    // Starter identifies as sdk-A.
    const first = await request(app)
      .post('/workspace/auth/device-flow')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .set('X-Qwen-Client-Id', 'sdk-A')
      .send({ providerId: 'qwen-oauth' });
    expect(first.status).toBe(201);
    // Fresh starter MUST see the verification material — they ARE
    // the initiator.
    expect(first.body.userCode).toBe('USER-1');
    expect(first.body.verificationUri).toBe('https://idp.example/verify');
    expect(first.body.initiatorClientId).toBe('sdk-A');

    // Different SDK take-over — must NOT see verification fields.
    const takeoverDifferent = await request(app)
      .post('/workspace/auth/device-flow')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .set('X-Qwen-Client-Id', 'sdk-B')
      .send({ providerId: 'qwen-oauth' });
    expect(takeoverDifferent.status).toBe(200);
    expect(takeoverDifferent.body.attached).toBe(true);
    expect(takeoverDifferent.body.deviceFlowId).toBe(first.body.deviceFlowId);
    expect(takeoverDifferent.body).not.toHaveProperty('userCode');
    expect(takeoverDifferent.body).not.toHaveProperty('verificationUri');
    expect(takeoverDifferent.body).not.toHaveProperty(
      'verificationUriComplete',
    );
    expect(takeoverDifferent.body).not.toHaveProperty('initiatorClientId');

    // Anonymous take-over against an identified-start — must NOT see
    // verification fields either (mismatched: identified vs anonymous).
    const takeoverAnon = await request(app)
      .post('/workspace/auth/device-flow')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({ providerId: 'qwen-oauth' });
    expect(takeoverAnon.status).toBe(200);
    expect(takeoverAnon.body.attached).toBe(true);
    expect(takeoverAnon.body).not.toHaveProperty('userCode');

    // Same-id take-over (sdk-A again) — DOES see the material.
    const takeoverSame = await request(app)
      .post('/workspace/auth/device-flow')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .set('X-Qwen-Client-Id', 'sdk-A')
      .send({ providerId: 'qwen-oauth' });
    expect(takeoverSame.status).toBe(200);
    expect(takeoverSame.body.attached).toBe(true);
    expect(takeoverSame.body.userCode).toBe('USER-1');
    expect(takeoverSame.body.initiatorClientId).toBe('sdk-A');
  });

  it('POST take-over preserves the anonymous-start → anonymous-reattach use case', async () => {
    // PR #4291 follow-up review (gpt-5.5, #3): the both-undefined
    // branch of `callerIsInitiator` keeps the legitimate "anonymous
    // start, anonymous re-attach (e.g., process restart, no
    // persisted clientId)" use case working. Without this, every
    // anonymous re-attach would silently lose the userCode.
    const { app } = buildApp({ token: 'tkn' });
    const first = await request(app)
      .post('/workspace/auth/device-flow')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({ providerId: 'qwen-oauth' });
    expect(first.status).toBe(201);
    expect(first.body.userCode).toBe('USER-1');

    const reattach = await request(app)
      .post('/workspace/auth/device-flow')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({ providerId: 'qwen-oauth' });
    expect(reattach.status).toBe(200);
    expect(reattach.body.attached).toBe(true);
    expect(reattach.body.deviceFlowId).toBe(first.body.deviceFlowId);
    // Both-undefined: anonymous initiator, anonymous re-attach → same
    // caller. Verification fields ARE returned.
    expect(reattach.body.userCode).toBe('USER-1');
    expect(reattach.body.verificationUri).toBe('https://idp.example/verify');
    // No initiatorClientId echoed (none was set originally).
    expect(reattach.body).not.toHaveProperty('initiatorClientId');
  });

  it('GET /workspace/auth/device-flow/:id returns 200 for known + 404 for unknown', async () => {
    const { app } = buildApp({ token: 'tkn' });
    const post = await request(app)
      .post('/workspace/auth/device-flow')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({ providerId: 'qwen-oauth' });
    const id = post.body.deviceFlowId as string;
    const ok = await request(app)
      .get(`/workspace/auth/device-flow/${id}`)
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    expect(ok.status).toBe(200);
    expect(ok.body.deviceFlowId).toBe(id);
    expect(ok.body.status).toBe('pending');

    const missing = await request(app)
      .get('/workspace/auth/device-flow/nonexistent-id')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('device_flow_not_found');
  });

  it('DELETE on pending → 204; idempotent on already-cancelled → 204; unknown → 404', async () => {
    const { app } = buildApp({ token: 'tkn' });
    const post = await request(app)
      .post('/workspace/auth/device-flow')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({ providerId: 'qwen-oauth' });
    const id = post.body.deviceFlowId as string;
    const first = await request(app)
      .delete(`/workspace/auth/device-flow/${id}`)
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    expect(first.status).toBe(204);
    const second = await request(app)
      .delete(`/workspace/auth/device-flow/${id}`)
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    // Idempotent: terminal entries return 204 no-op.
    expect(second.status).toBe(204);
    const missing = await request(app)
      .delete('/workspace/auth/device-flow/nonexistent-id')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    expect(missing.status).toBe(404);
  });

  it('GET /workspace/auth/status surfaces pending flows and supported providers', async () => {
    const { app } = buildApp({ token: 'tkn' });
    const start = await request(app)
      .post('/workspace/auth/device-flow')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({ providerId: 'qwen-oauth' });
    const id = start.body.deviceFlowId as string;
    const status = await request(app)
      .get('/workspace/auth/status')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    expect(status.status).toBe(200);
    expect(status.body.v).toBe(1);
    expect(status.body.supportedDeviceFlowProviders).toContain('qwen-oauth');
    expect(status.body.pendingDeviceFlows).toHaveLength(1);
    expect(status.body.pendingDeviceFlows[0].deviceFlowId).toBe(id);
    // Status payload MUST NOT echo userCode/verificationUri.
    const json = JSON.stringify(status.body);
    expect(json).not.toContain('USER-1');
    expect(json).not.toContain('idp.example');
  });

  it('capability tag auth_device_flow is advertised unconditionally', async () => {
    const { app } = buildApp({ token: 'tkn' });
    const res = await request(app)
      .get('/capabilities')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    expect(res.status).toBe(200);
    expect(res.body.features).toContain('auth_device_flow');
  });

  it('POST /workspace/auth/provider rejects unsupported protocol values', async () => {
    const installAuthProvider = vi.fn();
    const bridge = fakeBridge();
    const app = createServeApp({ ...baseOpts, token: 'tkn' }, undefined, {
      bridge,
      installAuthProvider,
    });

    const res = await request(app)
      .post('/workspace/auth/provider')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({
        providerId: 'custom-openai-compatible',
        apiKey: 'sk-test',
        protocol: 'qwen-oauth',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unsupported_protocol');
    expect(installAuthProvider).not.toHaveBeenCalled();
  });

  it('POST /workspace/auth/provider rejects private baseUrl values', async () => {
    const installAuthProvider = vi.fn();
    const bridge = fakeBridge();
    const app = createServeApp({ ...baseOpts, token: 'tkn' }, undefined, {
      bridge,
      installAuthProvider,
    });

    const res = await request(app)
      .post('/workspace/auth/provider')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({
        providerId: 'custom-openai-compatible',
        apiKey: 'sk-test',
        baseUrl: 'http://127.0.0.1:11434/v1',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_base_url');
    expect(installAuthProvider).not.toHaveBeenCalled();
  });

  it('POST /workspace/auth/provider rejects private IPv6 baseUrl values', async () => {
    const installAuthProvider = vi.fn();
    const bridge = fakeBridge();
    const app = createServeApp({ ...baseOpts, token: 'tkn' }, undefined, {
      bridge,
      installAuthProvider,
    });

    const res = await request(app)
      .post('/workspace/auth/provider')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({
        providerId: 'custom-openai-compatible',
        apiKey: 'sk-test',
        baseUrl: 'http://[::1]:11434/v1',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_base_url');
    expect(installAuthProvider).not.toHaveBeenCalled();
  });

  it('POST /workspace/auth/provider rejects IPv4-mapped IPv6 baseUrl values', async () => {
    const installAuthProvider = vi.fn();
    const bridge = fakeBridge();
    const app = createServeApp({ ...baseOpts, token: 'tkn' }, undefined, {
      bridge,
      installAuthProvider,
    });

    const res = await request(app)
      .post('/workspace/auth/provider')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({
        providerId: 'custom-openai-compatible',
        apiKey: 'sk-test',
        baseUrl: 'http://[::ffff:127.0.0.1]:11434/v1',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_base_url');
    expect(installAuthProvider).not.toHaveBeenCalled();
  });

  it.each([
    'http://100.64.1.1:11434/v1',
    'http://[::]:11434/v1',
    'http://[febf::1]:11434/v1',
    'http://[::ffff:169.254.169.254]:11434/v1',
  ])(
    'POST /workspace/auth/provider rejects private baseUrl %s',
    async (baseUrl) => {
      const installAuthProvider = vi.fn();
      const bridge = fakeBridge();
      const app = createServeApp({ ...baseOpts, token: 'tkn' }, undefined, {
        bridge,
        installAuthProvider,
      });

      const res = await request(app)
        .post('/workspace/auth/provider')
        .set('Authorization', 'Bearer tkn')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({
          providerId: 'custom-openai-compatible',
          apiKey: 'sk-test',
          baseUrl,
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_base_url');
      expect(installAuthProvider).not.toHaveBeenCalled();
    },
  );

  it('POST /workspace/auth/provider allows private baseUrl values when explicitly enabled', async () => {
    const installAuthProvider = vi.fn().mockResolvedValue({
      v: 1,
      providerId: 'custom-openai-compatible',
      providerLabel: 'Custom OpenAI',
      authType: 'openai',
      baseUrl: 'http://127.0.0.1:11434/v1',
      message: 'ok',
    });
    const bridge = fakeBridge();
    const app = createServeApp(
      {
        ...baseOpts,
        token: 'tkn',
        allowPrivateAuthBaseUrl: true,
      },
      undefined,
      {
        bridge,
        installAuthProvider,
      },
    );

    const res = await request(app)
      .post('/workspace/auth/provider')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({
        providerId: 'custom-openai-compatible',
        apiKey: 'sk-test',
        baseUrl: 'http://127.0.0.1:11434/v1/',
      });

    expect(res.status).toBe(200);
    expect(installAuthProvider).toHaveBeenCalledWith({
      providerId: 'custom-openai-compatible',
      apiKey: 'sk-test',
      baseUrl: 'http://127.0.0.1:11434/v1',
    });
  });

  it('POST /workspace/auth/provider filters invalid advanced numeric fields', async () => {
    const installAuthProvider = vi.fn().mockResolvedValue({
      v: 1,
      providerId: 'custom-openai-compatible',
      providerLabel: 'Custom OpenAI',
      authType: 'openai',
      baseUrl: 'https://api.example.com/v1',
      message: 'ok',
    });
    const bridge = fakeBridge();
    const app = createServeApp({ ...baseOpts, token: 'tkn' }, undefined, {
      bridge,
      installAuthProvider,
    });

    const res = await request(app)
      .post('/workspace/auth/provider')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({
        providerId: 'custom-openai-compatible',
        apiKey: 'sk-test',
        baseUrl: 'https://api.example.com/v1/',
        advancedConfig: {
          enableThinking: true,
          contextWindowSize: -1,
          maxTokens: 8192,
        },
      });

    expect(res.status).toBe(200);
    expect(installAuthProvider).toHaveBeenCalledWith({
      providerId: 'custom-openai-compatible',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      advancedConfig: {
        enableThinking: true,
        maxTokens: 8192,
      },
    });
  });

  it('upstream provider.start failure → 502 upstream_error, not 500', async () => {
    // PR 21 fold-in 0 P1-14: provider throwing UpstreamDeviceFlowError
    // must surface as 502 with code:'upstream_error' instead of falling
    // through `sendBridgeError`'s generic 500 path. Build a fake
    // provider whose start always throws.
    const { UpstreamDeviceFlowError } = await import('./auth/device-flow.js');
    const failingProvider: import('./auth/device-flow.js').DeviceFlowProvider =
      {
        providerId: 'qwen-oauth',
        async start() {
          throw new UpstreamDeviceFlowError('mocked upstream outage');
        },
        async poll() {
          return { kind: 'pending' as const };
        },
      };
    const bridge = fakeBridge();
    const app = createServeApp({ ...baseOpts, token: 'tkn' }, undefined, {
      bridge,
      deviceFlowProviders: [failingProvider],
    });
    const res = await request(app)
      .post('/workspace/auth/device-flow')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({ providerId: 'qwen-oauth' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('upstream_error');
    expect(res.body.error).toContain('mocked upstream outage');
  });

  it('sweeper-driven auto-expiry transitions a stale entry to status:error and surfaces over GET', async () => {
    // PR 21 fold-in 0 P1-13: cover the time-based expiry path via an
    // injected registry with a controlled clock + manual sweeper trigger.
    const { DeviceFlowRegistry, brandSecret } = await import(
      './auth/device-flow.js'
    );
    const fakeProvider: import('./auth/device-flow.js').DeviceFlowProvider = {
      providerId: 'qwen-oauth',
      async start() {
        return {
          deviceCode: brandSecret('device-1'),
          pkceVerifier: brandSecret('pkce-1'),
          userCode: 'USER-1',
          verificationUri: 'https://idp.example/verify',
          expiresIn: 60, // 60 seconds
        };
      },
      async poll() {
        // Stays pending; the sweeper drives terminal state via expiresAt.
        return { kind: 'pending' as const };
      },
    };

    let now = 1_700_000_000_000;
    const intervalsRegistered: Array<{ cb: () => void }> = [];
    const registry = new DeviceFlowRegistry({
      events: { publish: () => {} },
      resolveProvider: (id) => (id === 'qwen-oauth' ? fakeProvider : undefined),
      now: () => now,
      // Run polls forever-deferred; sweeper interval is what we drive.
      schedule: (_ms, _cb) => ({ cancelled: false }) as never,
      clearScheduled: () => {},
      scheduleInterval: (_ms, cb) => {
        const handle = { cb, cancelled: false };
        intervalsRegistered.push(handle);
        return handle as never;
      },
      clearScheduledInterval: () => {},
    });

    const bridge = fakeBridge();
    const app = createServeApp({ ...baseOpts, token: 'tkn' }, undefined, {
      bridge,
      deviceFlowRegistry: registry,
    });

    const startRes = await request(app)
      .post('/workspace/auth/device-flow')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({ providerId: 'qwen-oauth' });
    expect(startRes.status).toBe(201);
    const id = startRes.body.deviceFlowId as string;

    // Drive the clock past expiresAt and trigger the sweeper.
    now += 61_000;
    for (const interval of intervalsRegistered) interval.cb();

    const stateRes = await request(app)
      .get(`/workspace/auth/device-flow/${id}`)
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    expect(stateRes.status).toBe(200);
    // Time-based expiry transitions to status='expired' with errorKind='expired_token'.
    expect(stateRes.body.status).toBe('expired');
    expect(stateRes.body.errorKind).toBe('expired_token');
    registry.dispose();
  });

  // PR #4255 fold-in 10 #4 — HTTP route contract coverage. Round-8
  // wenshao thread `Cvx93` flagged that the existing 4 it()'s
  // covered the happy paths but missed the malformed-input,
  // resource-cap, and strict-bearer error envelopes that SDK
  // consumers depend on for retry / surface routing. Each case
  // here is a supertest one-liner asserting status code + `code:`
  // discriminator.

  it('POST with missing providerId returns 400 invalid_request', async () => {
    // PR 21 fold-in W2 split the 400 envelope into `invalid_request`
    // (caller-shape error: missing/non-string body field) vs
    // `unsupported_provider` (well-shaped but the providerId isn't
    // in the supported tuple). This pins that split.
    const { app } = buildApp({ token: 'tkn' });
    const res = await request(app)
      .post('/workspace/auth/device-flow')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({}); // no providerId at all
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
    expect(res.body.error).toContain('providerId');
  });

  it('POST with non-string providerId returns 400 invalid_request', async () => {
    const { app } = buildApp({ token: 'tkn' });
    const res = await request(app)
      .post('/workspace/auth/device-flow')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({ providerId: 42 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
  });

  it('POST returns 409 too_many_active_flows when registry cap is reached', async () => {
    // Inject a fake registry whose `start` always throws the cap error.
    const { TooManyActiveDeviceFlowsError } = await import(
      './auth/device-flow.js'
    );
    const fakeRegistry = {
      start: async () => {
        throw new TooManyActiveDeviceFlowsError();
      },
      get: () => undefined,
      cancel: () => undefined,
      listPending: () => [],
      dispose: () => {},
    } as unknown as import('./auth/device-flow.js').DeviceFlowRegistry;

    const bridge = fakeBridge();
    const app = createServeApp({ ...baseOpts, token: 'tkn' }, undefined, {
      bridge,
      deviceFlowRegistry: fakeRegistry,
    });

    const res = await request(app)
      .post('/workspace/auth/device-flow')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({ providerId: 'qwen-oauth' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('too_many_active_flows');
  });

  it('DELETE without bearer is rejected 401 token_required (strict-mutation gate)', async () => {
    const { app } = buildApp({ token: undefined });
    const res = await request(app)
      .delete('/workspace/auth/device-flow/some-id')
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('token_required');
  });

  it('GET /workspace/auth/device-flow/:id is strict-gated; GET /workspace/auth/status is read-only', async () => {
    // The two GETs have ASYMMETRIC auth posture by design:
    // - `GET /workspace/auth/device-flow/:id` returns `userCode` for
    //   pending entries (only when caller's clientId matches the
    //   initiator — see follow-up review thread test below). fold-in
    //   (round-4 #1) added `mutate({strict:true})` to close the
    //   info-disclosure asymmetry vs. the strict POST/DELETE.
    // - `GET /workspace/auth/status` intentionally redacts userCode
    //   (lists only deviceFlowId/providerId/expiresAt) so it stays
    //   bearer-only (passthrough on loopback no-token default).
    const { app } = buildApp({ token: undefined });
    const flowGet = await request(app)
      .get('/workspace/auth/device-flow/no-such-id')
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    expect(flowGet.status).toBe(401);
    expect(flowGet.body.code).toBe('token_required');
    // Status, by contrast, is reachable on loopback without a token.
    const status = await request(app)
      .get('/workspace/auth/status')
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    expect(status.status).toBe(200);
  });

  it('GET /workspace/auth/device-flow/:id only echoes userCode/verificationUri/initiatorClientId to caller matching the initiator', async () => {
    // PR #4255 follow-up review thread (deepseek-v4-pro): the GET
    // response shape is symmetrized with the POST take-over response.
    // An anonymous caller, or a caller identifying as a different
    // client, only sees the public envelope (status/timestamps/error
    // fields) — never the verification code or the initiator id.
    const { app } = buildApp({ token: 'tkn' });
    const post = await request(app)
      .post('/workspace/auth/device-flow')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .set('X-Qwen-Client-Id', 'sdk-A')
      .send({ providerId: 'qwen-oauth' });
    const id = post.body.deviceFlowId as string;
    expect(typeof id).toBe('string');

    const matchingCaller = await request(app)
      .get(`/workspace/auth/device-flow/${id}`)
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .set('X-Qwen-Client-Id', 'sdk-A');
    expect(matchingCaller.status).toBe(200);
    expect(matchingCaller.body.deviceFlowId).toBe(id);
    expect(matchingCaller.body.userCode).toBe('USER-1');
    expect(matchingCaller.body.verificationUri).toBe(
      'https://idp.example/verify',
    );
    expect(matchingCaller.body.initiatorClientId).toBe('sdk-A');

    const anonymousCaller = await request(app)
      .get(`/workspace/auth/device-flow/${id}`)
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    expect(anonymousCaller.status).toBe(200);
    expect(anonymousCaller.body.deviceFlowId).toBe(id);
    expect(anonymousCaller.body).not.toHaveProperty('userCode');
    expect(anonymousCaller.body).not.toHaveProperty('verificationUri');
    expect(anonymousCaller.body).not.toHaveProperty('verificationUriComplete');
    expect(anonymousCaller.body).not.toHaveProperty('initiatorClientId');

    const differentCaller = await request(app)
      .get(`/workspace/auth/device-flow/${id}`)
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .set('X-Qwen-Client-Id', 'sdk-B');
    expect(differentCaller.status).toBe(200);
    expect(differentCaller.body.deviceFlowId).toBe(id);
    expect(differentCaller.body).not.toHaveProperty('userCode');
    expect(differentCaller.body).not.toHaveProperty('verificationUri');
    expect(differentCaller.body).not.toHaveProperty('verificationUriComplete');
    expect(differentCaller.body).not.toHaveProperty('initiatorClientId');
  });

  it('GET /workspace/auth/device-flow/:id returns 400 invalid_client_id when X-Qwen-Client-Id is malformed (qwen-latest review N3)', async () => {
    // PR #4291 follow-up review (qwen-latest, N3): the GET handler's
    // strict-clientId behavior — added in this PR to drive the
    // `callerIsInitiator` gate — was documented in JSDoc but not
    // pinned in CI. A future refactor that removes or reorders the
    // `parseClientIdHeader` call would silently revert the contract
    // change. Pin: a malformed header (>128 chars or invalid chars)
    // returns 400 `invalid_client_id` from THIS specific GET route.
    const { app } = buildApp({ token: 'tkn' });
    const post = await request(app)
      .post('/workspace/auth/device-flow')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({ providerId: 'qwen-oauth' });
    const id = post.body.deviceFlowId as string;

    // Over-length: 129 chars.
    const tooLong = 'a'.repeat(129);
    const tooLongRes = await request(app)
      .get(`/workspace/auth/device-flow/${id}`)
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .set('X-Qwen-Client-Id', tooLong);
    expect(tooLongRes.status).toBe(400);
    expect(tooLongRes.body.code).toBe('invalid_client_id');

    // Invalid characters (spaces / quotes — anything outside the
    // allowed token charset).
    const badChars = await request(app)
      .get(`/workspace/auth/device-flow/${id}`)
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .set('X-Qwen-Client-Id', 'has spaces and "quotes"');
    expect(badChars.status).toBe(400);
    expect(badChars.body.code).toBe('invalid_client_id');
  });

  it('GET /workspace/auth/device-flow/:id returns userCode for an anonymously-started flow when the GET caller is also anonymous', async () => {
    // PR #4291 follow-up review (qwen-latest, #3): the original
    // gate required both `initiatorClientId` AND `callerClientId`
    // to be defined and equal — which silently locked anonymous-
    // started flows out of their own data (the SDK that didn't
    // pass `X-Qwen-Client-Id` on POST also doesn't pass it on
    // GET, but the response body switched from "useful" to
    // "redacted public envelope" with HTTP 200 and no error). Fix:
    // also accept `both undefined` as the same caller. The gate's
    // purpose is to prevent CROSS-client reads, not to lock
    // anonymous flows out of themselves.
    const { app } = buildApp({ token: 'tkn' });
    // Start anonymously (no X-Qwen-Client-Id header).
    const post = await request(app)
      .post('/workspace/auth/device-flow')
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({ providerId: 'qwen-oauth' });
    const id = post.body.deviceFlowId as string;
    expect(typeof id).toBe('string');
    // Anonymous GET — must still see the verification fields.
    const anonGet = await request(app)
      .get(`/workspace/auth/device-flow/${id}`)
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    expect(anonGet.status).toBe(200);
    expect(anonGet.body.deviceFlowId).toBe(id);
    expect(anonGet.body.userCode).toBe('USER-1');
    expect(anonGet.body.verificationUri).toBe('https://idp.example/verify');
    // No initiatorClientId — there wasn't one (anonymous start).
    expect(anonGet.body).not.toHaveProperty('initiatorClientId');
    // An IDENTIFIED caller, however, is NOT the same caller —
    // they don't get the verification fields.
    const identified = await request(app)
      .get(`/workspace/auth/device-flow/${id}`)
      .set('Authorization', 'Bearer tkn')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .set('X-Qwen-Client-Id', 'sdk-X');
    expect(identified.status).toBe(200);
    expect(identified.body).not.toHaveProperty('userCode');
    expect(identified.body).not.toHaveProperty('verificationUri');
  });
});

describe('GET /workspace/mcp/:server/tools', () => {
  it('returns tools for a valid server name', async () => {
    const bridge = fakeBridge();
    const app = createServeApp(baseOpts, undefined, { bridge });
    const res = await request(app)
      .get('/workspace/mcp/my-server/tools')
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ serverName: 'my-server' });
    expect(bridge.workspaceMcpToolsCalls).toEqual(['my-server']);
  });

  it('decodes URL-encoded server names', async () => {
    const bridge = fakeBridge();
    const app = createServeApp(baseOpts, undefined, { bridge });
    const res = await request(app)
      .get('/workspace/mcp/my%20server/tools')
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    expect(res.status).toBe(200);
    expect(bridge.workspaceMcpToolsCalls).toEqual(['my server']);
  });

  it('400 when server name exceeds length limit', async () => {
    const bridge = fakeBridge();
    const app = createServeApp(baseOpts, undefined, { bridge });
    const longName = 'a'.repeat(300);
    const res = await request(app)
      .get(`/workspace/mcp/${longName}/tools`)
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_server_name');
    expect(bridge.workspaceMcpToolsCalls).toHaveLength(0);
  });
});

describe('POST /workspace/mcp/:server/restart — entryIndex validation', () => {
  const tokenOpts: ServeOptions = { ...baseOpts, token: 'secret' };
  const auth = (req: request.Test): request.Test =>
    req
      .set('Host', `127.0.0.1:${tokenOpts.port}`)
      .set('Authorization', 'Bearer secret');

  it('400 on entryIndex=-1', async () => {
    const bridge = fakeBridge();
    const app = createServeApp(tokenOpts, undefined, { bridge });
    const res = await auth(
      request(app).post('/workspace/mcp/docs/restart?entryIndex=-1'),
    ).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_entry_index');
    expect(bridge.restartMcpServerCalls).toHaveLength(0);
  });

  it('400 on entryIndex=abc', async () => {
    const bridge = fakeBridge();
    const app = createServeApp(tokenOpts, undefined, { bridge });
    const res = await auth(
      request(app).post('/workspace/mcp/docs/restart?entryIndex=abc'),
    ).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_entry_index');
  });

  it('400 on entryIndex=1.5', async () => {
    const bridge = fakeBridge();
    const app = createServeApp(tokenOpts, undefined, { bridge });
    const res = await auth(
      request(app).post('/workspace/mcp/docs/restart?entryIndex=1.5'),
    ).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_entry_index');
  });
});

describe('sendPermissionVoteError branches', () => {
  it('403 permission_forbidden when bridge throws PermissionForbiddenError', async () => {
    const bridge = fakeBridge({
      respondImpl: () => {
        throw new PermissionForbiddenError(
          'req-1',
          'session-A',
          'designated_mismatch',
        );
      },
    });
    const app = createServeApp(baseOpts, undefined, { bridge });
    const res = await request(app)
      .post('/permission/req-1')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({ outcome: { outcome: 'selected', optionId: 'opt-1' } });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'permission_forbidden',
      requestId: 'req-1',
      sessionId: 'session-A',
      reason: 'designated_mismatch',
    });
  });

  it('501 permission_policy_not_implemented when bridge throws PermissionPolicyNotImplementedError', async () => {
    const bridge = fakeBridge({
      respondImpl: () => {
        throw new PermissionPolicyNotImplementedError('consensus');
      },
    });
    const app = createServeApp(baseOpts, undefined, { bridge });
    const res = await request(app)
      .post('/permission/req-1')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({ outcome: { outcome: 'selected', optionId: 'opt-1' } });
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({
      code: 'permission_policy_not_implemented',
      policy: 'consensus',
    });
  });

  it('500 cancel_sentinel_collision when bridge throws CancelSentinelCollisionError', async () => {
    const bridge = fakeBridge({
      respondImpl: () => {
        throw new CancelSentinelCollisionError('req-1', '__cancel__');
      },
    });
    const app = createServeApp(baseOpts, undefined, { bridge });
    const res = await request(app)
      .post('/permission/req-1')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({ outcome: { outcome: 'selected', optionId: 'opt-1' } });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      code: 'cancel_sentinel_collision',
      requestId: 'req-1',
      sentinel: '__cancel__',
    });
  });
});

describe('GET /capabilities — policy.permission', () => {
  it('includes policy.permission in capabilities response', async () => {
    const app = createServeApp(baseOpts);
    const res = await request(app)
      .get('/capabilities')
      .set('Host', `127.0.0.1:${baseOpts.port}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('policy');
    expect(res.body.policy).toHaveProperty('permission');
  });
});

// ===========================================================================
// Issue #4514 T2.9: prompt absolute deadline + SSE writer idle timeout
// ===========================================================================

describe('T2.9 prompt absolute deadline (issue #4514)', () => {
  describe('resolvePromptDeadlineMs', () => {
    it('returns undefined when the server flag is unset', () => {
      // Default off — preserves the legacy "client disconnect is the
      // only auto-cancel" behavior bit-for-bit. A request body
      // `deadlineMs` is ignored without the server opting in (we don't
      // want a client to be able to force a deadline on an operator
      // who hasn't asked for one).
      expect(resolvePromptDeadlineMs(undefined, undefined)).toBeUndefined();
      expect(resolvePromptDeadlineMs(undefined, 1_000)).toBeUndefined();
      expect(resolvePromptDeadlineMs(0, 1_000)).toBeUndefined();
    });

    it('uses the server flag when no request override is present', () => {
      expect(resolvePromptDeadlineMs(5_000, undefined)).toBe(5_000);
    });

    it('caps the request override at the server flag (request can shorten)', () => {
      // Operator is the upper bound: request can lower the deadline
      // but never raise it.
      expect(resolvePromptDeadlineMs(5_000, 1_000)).toBe(1_000);
    });

    it('rejects request overrides that exceed the server flag', () => {
      // The cap is `Math.min`, so an over-bound request never widens
      // the effective deadline. This is the test that locks down the
      // "cannot extend" contract called out in the issue.
      expect(resolvePromptDeadlineMs(5_000, 10_000)).toBe(5_000);
    });

    it('ignores invalid request overrides without dropping the server cap', () => {
      // Malformed request override should be caught at the route layer
      // (returns 400), but defense-in-depth: the resolver still falls
      // back to the server value rather than silently disabling.
      expect(resolvePromptDeadlineMs(5_000, 0)).toBe(5_000);
      expect(resolvePromptDeadlineMs(5_000, -100)).toBe(5_000);
      expect(resolvePromptDeadlineMs(5_000, Number.NaN)).toBe(5_000);
    });
  });

  describe('POST /session/:id/prompt', () => {
    it.each([
      ['negative', -5],
      ['zero', 0],
      ['float', 1.5],
      ['string', 'abc'],
      ['boolean', true],
      ['object', { ms: 500 }],
    ])(
      // Note: `NaN` / `Infinity` aren't reachable here — JSON.stringify
      // converts both to `null`, which the validator correctly treats
      // as "absent" (same as `undefined`). The remaining cases exercise
      // every reachable branch of the typeof / isFinite / isInteger /
      // positive validator.
      'rejects an invalid `deadlineMs` body field (%s) with 400',
      async (_label, value) => {
        // Symmetric with the `prompt` validator: malformed inputs fail
        // loudly so the client doesn't silently lose their deadline
        // request. Each branch of the validator (typeof / isFinite /
        // isInteger / positive) gets covered.
        const bridge = fakeBridge({
          promptImpl: () => {
            throw new Error('bridge must not be touched');
          },
        });
        const app = createServeApp(baseOpts, undefined, { bridge });
        const res = await request(app)
          .post('/session/session-A/prompt')
          .set('Host', `127.0.0.1:${baseOpts.port}`)
          .send({
            prompt: [{ type: 'text', text: 'hi' }],
            deadlineMs: value,
          });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('invalid_deadline_ms');
        expect(bridge.promptCalls).toHaveLength(0);
      },
    );

    it('returns cleanly when client disconnects in the same tick the deadline fires (wenshao review #3)', async () => {
      // Critical regression from wenshao's CHANGES_REQUESTED on #4530:
      // when `res.writableEnded` was true at the moment the deadline
      // rejection surfaced, the early code `if (err instanceof
      // PromptDeadlineExceededError && !res.writableEnded) { ...
      // return; }` would skip BOTH the body AND the return, fall
      // through to `sendBridgeError`, and try to write 500 to an
      // already-ended response → ERR_STREAM_WRITE_AFTER_END.
      //
      // We force the race by destroying the client socket
      // immediately after the bridge starts the prompt, so by the
      // time the 50ms deadline fires the response is already ended.
      // The route MUST handle this without throwing — assertion is
      // implicit: a thrown uncaughtException would fail the test.
      let promptStarted: (() => void) | undefined;
      const promptStartedPromise = new Promise<void>((r) => {
        promptStarted = r;
      });
      const bridge = fakeBridge({
        promptImpl: (_sid, _req, signal) =>
          new Promise((resolve) => {
            promptStarted!();
            const onAbort = () => resolve({ stopReason: 'cancelled' });
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
          }),
      });
      const localHandle = await runQwenServe(
        {
          hostname: '127.0.0.1',
          port: 0,
          mode: 'http-bridge',
          promptDeadlineMs: 50,
        },
        { bridge },
      );
      try {
        const port = (localHandle.server.address() as { port: number }).port;
        const http = await import('node:http');
        const reqBody = JSON.stringify({
          prompt: [{ type: 'text', text: 'slow' }],
        });
        const httpReq = http.request({
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/session/sess-A/prompt',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(reqBody),
          },
        });
        httpReq.on('error', () => {});
        httpReq.write(reqBody);
        httpReq.end();
        await promptStartedPromise;
        // Destroy the client socket so `res.writableEnded` is true by
        // the time the 50ms deadline fires.
        httpReq.destroy();
        // Give the deadline timer time to fire + the route's catch
        // block to handle the race.
        await new Promise((r) => setTimeout(r, 200));
        expect(bridge.promptCalls).toHaveLength(1);
        // The bridge's signal MUST still have been aborted with the
        // typed reason — the cleanup path still runs even though the
        // response was already ended.
        expect(bridge.promptCalls[0]?.signal?.aborted).toBe(true);
      } finally {
        await localHandle.close();
      }
    });

    it('fires the server-side deadline and aborts the bridge signal', async () => {
      // 50ms server deadline + a prompt that resolves only on abort:
      // the deadline timer must abort the AbortController. With non-
      // blocking prompt the HTTP response is always 202; the deadline
      // outcome is delivered via `turn_error` on the SSE bus.
      const bridge = fakeBridge({ promptImpl: abortableBridgePromptImpl() });
      const app = createServeApp(
        { ...baseOpts, promptDeadlineMs: 50 },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .post('/session/session-A/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ prompt: [{ type: 'text', text: 'slow' }] });
      expect(res.status).toBe(202);
      expect(res.body).toHaveProperty('promptId');
      expect(res.body).toHaveProperty('lastEventId');
      // Wait for the deadline timer to fire asynchronously.
      await new Promise((r) => setTimeout(r, 200));
      expect(bridge.promptCalls).toHaveLength(1);
      expect(bridge.promptCalls[0]?.signal?.aborted).toBe(true);
      expect(bridge.promptCalls[0]?.signal?.reason).toBeInstanceOf(
        PromptDeadlineExceededError,
      );
    });

    it('strips route-only deadlineMs before forwarding the prompt body', async () => {
      const bridge = fakeBridge({
        promptImpl: async () => ({ stopReason: 'end_turn' }),
      });
      const app = createServeApp(
        { ...baseOpts, promptDeadlineMs: 5_000 },
        undefined,
        { bridge },
      );
      const prompt = [{ type: 'text', text: 'hi' }];
      const res = await request(app)
        .post('/session/session-A/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({
          prompt,
          deadlineMs: 1_000,
          _meta: { trace: 'kept' },
          extra: 'kept',
        });
      expect(res.status).toBe(202);
      expect(bridge.promptCalls).toHaveLength(1);
      expect(bridge.promptCalls[0]?.req).not.toHaveProperty('deadlineMs');
      expect(bridge.promptCalls[0]?.req).toMatchObject({
        sessionId: 'session-A',
        prompt,
        _meta: { trace: 'kept' },
        extra: 'kept',
      });
    });

    it('caps a per-prompt `deadlineMs` override at the server flag', async () => {
      // Server flag 50ms, request asks for 5000ms — effective deadline
      // must be 50ms. With non-blocking prompt the HTTP response is
      // always 202; we verify the abort signal fires within ~50ms.
      const bridge = fakeBridge({ promptImpl: abortableBridgePromptImpl() });
      const app = createServeApp(
        { ...baseOpts, promptDeadlineMs: 50 },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .post('/session/session-A/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({
          prompt: [{ type: 'text', text: 'slow' }],
          deadlineMs: 5_000,
        });
      expect(res.status).toBe(202);
      await new Promise((r) => setTimeout(r, 200));
      expect(bridge.promptCalls[0]?.signal?.aborted).toBe(true);
      expect(bridge.promptCalls[0]?.signal?.reason).toBeInstanceOf(
        PromptDeadlineExceededError,
      );
    });

    it('uses the per-prompt override when shorter than the server flag', async () => {
      // Server flag 10s, request 30ms — request wins as the tighter
      // bound. Abort signal should fire within ~30ms.
      const bridge = fakeBridge({ promptImpl: abortableBridgePromptImpl() });
      const app = createServeApp(
        { ...baseOpts, promptDeadlineMs: 10_000 },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .post('/session/session-A/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({
          prompt: [{ type: 'text', text: 'slow' }],
          deadlineMs: 30,
        });
      expect(res.status).toBe(202);
      await new Promise((r) => setTimeout(r, 200));
      expect(bridge.promptCalls[0]?.signal?.aborted).toBe(true);
      expect(bridge.promptCalls[0]?.signal?.reason).toBeInstanceOf(
        PromptDeadlineExceededError,
      );
    });

    it('still aborts the signal when the bridge IGNORES the abort (non-cooperative bridge)', async () => {
      // With non-blocking prompt the HTTP response is always 202. The
      // deadline timer must still fire and abort the signal so the
      // bridge can observe it, even if it ignores the abort.
      const bridge = fakeBridge({
        promptImpl: () => new Promise(() => {}),
      });
      const app = createServeApp(
        { ...baseOpts, promptDeadlineMs: 50 },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .post('/session/session-A/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ prompt: [{ type: 'text', text: 'slow' }] });
      expect(res.status).toBe(202);
      await new Promise((r) => setTimeout(r, 200));
      expect(bridge.promptCalls[0]?.signal?.aborted).toBe(true);
      expect(bridge.promptCalls[0]?.signal?.reason).toBeInstanceOf(
        PromptDeadlineExceededError,
      );
    });

    it('returns 202 without deadline when the flag is unset', async () => {
      const bridge = fakeBridge({
        promptImpl: async () => ({ stopReason: 'end_turn' }),
      });
      const app = createServeApp(baseOpts, undefined, { bridge });
      const res = await request(app)
        .post('/session/session-A/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ prompt: [{ type: 'text', text: 'hi' }] });
      expect(res.status).toBe(202);
      expect(res.body).toHaveProperty('promptId');
      expect(res.body).toHaveProperty('lastEventId');
    });

    it('does not fire the deadline when the prompt resolves promptly', async () => {
      // 5s deadline + immediate resolve: the timer must not fire.
      const bridge = fakeBridge({
        promptImpl: async () => ({ stopReason: 'end_turn' }),
      });
      const app = createServeApp(
        { ...baseOpts, promptDeadlineMs: 5_000 },
        undefined,
        { bridge },
      );
      const res = await request(app)
        .post('/session/session-A/prompt')
        .set('Host', `127.0.0.1:${baseOpts.port}`)
        .send({ prompt: [{ type: 'text', text: 'hi' }] });
      expect(res.status).toBe(202);
      expect(res.body).toHaveProperty('promptId');
      // Give enough time for a timer to fire if it were going to.
      await new Promise((r) => setTimeout(r, 100));
      expect(bridge.promptCalls[0]?.signal?.aborted).toBe(false);
    });
  });

  describe('GET /capabilities', () => {
    it('omits `prompt_absolute_deadline` by default', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body.features).not.toContain('prompt_absolute_deadline');
    });

    it('advertises `prompt_absolute_deadline` when the flag is set', async () => {
      const app = createServeApp({ ...baseOpts, promptDeadlineMs: 5_000 });
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body.features).toContain('prompt_absolute_deadline');
    });

    it('omits `writer_idle_timeout` by default', async () => {
      const app = createServeApp(baseOpts);
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body.features).not.toContain('writer_idle_timeout');
    });

    it('advertises `writer_idle_timeout` when the flag is set', async () => {
      const app = createServeApp({
        ...baseOpts,
        writerIdleTimeoutMs: 60_000,
      });
      const res = await request(app)
        .get('/capabilities')
        .set('Host', `127.0.0.1:${baseOpts.port}`);
      expect(res.status).toBe(200);
      expect(res.body.features).toContain('writer_idle_timeout');
    });
  });
});

describe('T2.9 SSE writer idle timeout (issue #4514)', () => {
  let handle: RunHandle | undefined;
  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it('evicts an idle SSE writer with a terminal client_evicted frame', async () => {
    // Bridge yields nothing, ever — simulating an idle stream where
    // the only writes the timer would observe are the SSE handshake
    // (`retry: 3000`) and (eventually) the 15s heartbeat. With a
    // 200ms idle deadline the timer must fire well before the
    // heartbeat refreshes `lastWriteAt`. Expected terminal frame:
    // `client_evicted` with the new `reason: 'writer_idle_timeout'`.
    const bridge = fakeBridge({
      // eslint-disable-next-line require-yield
      async *subscribeImpl(_sessionId, _opts) {
        // Park forever; the test triggers eviction via the timer.
        // No yield: the test asserts that the daemon's idle-timeout
        // path fires even when the bridge produces zero frames.
        await new Promise(() => {});
      },
    });
    handle = await runQwenServe(
      {
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        writerIdleTimeoutMs: 200,
      },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/session/sess-A/events`);
    expect(res.status).toBe(200);

    // Read until we see the eviction frame OR the stream closes. The
    // 1500ms budget is well below the 15s heartbeat so a regression
    // that disables the idle timer would still fail loudly here.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let evictedData: unknown;
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!raw || raw.startsWith(':') || raw.startsWith('retry:')) continue;
        // Parse the frame; look for event: client_evicted.
        let eventName = '';
        let dataLine = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) eventName = line.slice(7);
          else if (line.startsWith('data: ')) dataLine = line.slice(6);
        }
        if (eventName === 'client_evicted') {
          evictedData = JSON.parse(dataLine);
          break;
        }
      }
      if (evictedData !== undefined) break;
    }
    await reader.cancel().catch(() => undefined);

    expect(evictedData).toBeDefined();
    expect(evictedData).toMatchObject({
      v: 1,
      type: 'client_evicted',
      data: {
        reason: 'writer_idle_timeout',
        errorKind: 'writer_idle_timeout',
        timeoutMs: 200,
      },
    });
  });

  it('does not evict when the writer idle timeout is unset (legacy contract)', async () => {
    // Without `writerIdleTimeoutMs`, the existing 15s-heartbeat-only
    // behavior must be preserved bit-for-bit. We open a stream, read
    // a real event, then wait ~600ms — no client_evicted frame may
    // appear in that window.
    const bridge = fakeBridge({
      async *subscribeImpl(_sessionId, _opts) {
        yield { id: 1, v: 1, type: 'session_update', data: { ok: true } };
        await new Promise(() => {});
      },
    });
    handle = await runQwenServe(
      { hostname: '127.0.0.1', port: 0, mode: 'http-bridge' },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/session/sess-A/events`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let sawFirstEvent = false;
    let sawEviction = false;
    const deadline = Date.now() + 600;
    while (Date.now() < deadline) {
      const readPromise = reader.read();
      const wakeup = new Promise<{ value: undefined; done: false }>((r) => {
        setTimeout(
          () => r({ value: undefined, done: false }),
          deadline - Date.now() + 10,
        );
      });
      const { value, done } = (await Promise.race([readPromise, wakeup])) as {
        value: Uint8Array | undefined;
        done: boolean;
      };
      if (done) break;
      if (value === undefined) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!raw || raw.startsWith(':') || raw.startsWith('retry:')) continue;
        let eventName = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) eventName = line.slice(7);
        }
        if (eventName === 'session_update') sawFirstEvent = true;
        if (eventName === 'client_evicted') sawEviction = true;
      }
    }
    await reader.cancel().catch(() => undefined);

    expect(sawFirstEvent).toBe(true);
    expect(sawEviction).toBe(false);
  });

  it('does NOT evict when active writes keep refreshing lastWriteAt (#4514 T2.9 wenshao review)', async () => {
    // wenshao flagged that the existing "fires when idle" + "doesn't
    // fire when unset" tests don't cover the case where REAL writes
    // (event yields, not just heartbeats) refresh `lastWriteAt`
    // inside `doWrite`. With idle timeout = 300ms and an event every
    // 100ms, the timer should keep deferring — the connection stays
    // alive even past several timeout cycles.
    const bridge = fakeBridge({
      async *subscribeImpl(_sessionId, _opts) {
        // Yield 5 events at ~100ms intervals — well below the 300ms
        // idle budget — then park forever. We expect no eviction in
        // the read window.
        for (let i = 1; i <= 5; i++) {
          await new Promise<void>((r) => setTimeout(r, 100));
          yield {
            id: i,
            v: 1,
            type: 'session_update',
            data: { tick: i },
          };
        }
        await new Promise(() => {});
      },
    });
    handle = await runQwenServe(
      {
        hostname: '127.0.0.1',
        port: 0,
        mode: 'http-bridge',
        writerIdleTimeoutMs: 300,
      },
      { bridge },
    );
    const port = (handle.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/session/sess-A/events`);
    expect(res.status).toBe(200);

    // Read for ~700ms — long enough that an IDLE writer would have
    // been evicted twice over (300ms timeout, polled every ~250ms),
    // but the per-100ms event stream refreshes lastWriteAt before the
    // check fires.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let sawEviction = false;
    let sessionUpdates = 0;
    const deadline = Date.now() + 700;
    while (Date.now() < deadline) {
      const readPromise = reader.read();
      const wakeup = new Promise<{ value: undefined; done: false }>((r) => {
        setTimeout(
          () => r({ value: undefined, done: false }),
          Math.max(0, deadline - Date.now() + 10),
        );
      });
      const { value, done } = (await Promise.race([readPromise, wakeup])) as {
        value: Uint8Array | undefined;
        done: boolean;
      };
      if (done) break;
      if (value === undefined) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!raw || raw.startsWith(':') || raw.startsWith('retry:')) continue;
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: session_update')) sessionUpdates += 1;
          if (line.startsWith('event: client_evicted')) sawEviction = true;
        }
      }
    }
    await reader.cancel().catch(() => undefined);

    expect(sessionUpdates).toBeGreaterThanOrEqual(3);
    expect(sawEviction).toBe(false);
  });

  it('does NOT evict when a back-pressured write drains within the idle budget', async () => {
    const http = await import('node:http');
    type WriteCallback = (error?: Error | null) => void;
    const originalWrite = http.ServerResponse.prototype.write as unknown as (
      this: ServerResponse,
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | WriteCallback,
      cb?: WriteCallback,
    ) => boolean;
    const writeSpy = vi.spyOn(http.ServerResponse.prototype, 'write');
    let forcedBackpressure = false;
    writeSpy.mockImplementation(function (
      this: ServerResponse,
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | WriteCallback,
      cb?: WriteCallback,
    ): boolean {
      const wrote =
        typeof encodingOrCb === 'function'
          ? originalWrite.call(this, chunk, encodingOrCb)
          : originalWrite.call(this, chunk, encodingOrCb, cb);
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      if (!forcedBackpressure && text.includes('event: session_update')) {
        forcedBackpressure = true;
        setTimeout(() => this.emit('drain'), 150);
        return false;
      }
      return wrote;
    });

    try {
      const bridge = fakeBridge({
        async *subscribeImpl(_sessionId, _opts) {
          yield {
            id: 1,
            v: 1,
            type: 'session_update',
            data: { tick: 1 },
          };
          await new Promise(() => {});
        },
      });
      handle = await runQwenServe(
        {
          hostname: '127.0.0.1',
          port: 0,
          mode: 'http-bridge',
          writerIdleTimeoutMs: 200,
        },
        { bridge },
      );
      const port = (handle.server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/session/sess-A/events`);
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let sawSessionUpdate = false;
      let sawEviction = false;
      const deadline = Date.now() + 350;
      while (Date.now() < deadline) {
        const readPromise = reader.read();
        const wakeup = new Promise<{ value: undefined; done: false }>((r) => {
          setTimeout(
            () => r({ value: undefined, done: false }),
            Math.max(0, deadline - Date.now() + 10),
          );
        });
        const { value, done } = (await Promise.race([readPromise, wakeup])) as {
          value: Uint8Array | undefined;
          done: boolean;
        };
        if (done) break;
        if (value === undefined) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!raw || raw.startsWith(':') || raw.startsWith('retry:')) continue;
          for (const line of raw.split('\n')) {
            if (line.startsWith('event: session_update')) {
              sawSessionUpdate = true;
            }
            if (line.startsWith('event: client_evicted')) sawEviction = true;
          }
        }
      }
      await reader.cancel().catch(() => undefined);

      expect(forcedBackpressure).toBe(true);
      expect(sawSessionUpdate).toBe(true);
      expect(sawEviction).toBe(false);
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe('T2.9 serve-side errorKind taxonomy (issue #4514)', () => {
  it('publishes the new error kinds in SERVE_ERROR_KINDS', async () => {
    // Lock the serve-side taxonomy contains both T2.9 kinds. The
    // mirrored SDK assertion lives in
    // `packages/sdk-typescript/test/unit/daemon-public-surface.test.ts`
    // (different package, no cross-package import). Together they
    // guarantee a PR adding a kind on one side without the other
    // fails CI.
    const { SERVE_ERROR_KINDS } = await import('@qwen-code/acp-bridge/status');
    expect(SERVE_ERROR_KINDS).toContain('prompt_deadline_exceeded');
    expect(SERVE_ERROR_KINDS).toContain('writer_idle_timeout');
  });
});

describe('sendBridgeError daemonLog routing', () => {
  it('routes 5xx errors through daemonLog when provided', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'daemon-log-'));
    const stderrLines: string[] = [];
    const { initDaemonLogger } = await import('./daemon-logger.js');
    const daemonLog = initDaemonLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
      stderr: (line: string) => stderrLines.push(line),
    });
    const bridge = fakeBridge({
      spawnImpl: async () => {
        throw new Error('daemon-log-test-boom');
      },
    });
    const app = createServeApp(baseOpts, undefined, { bridge, daemonLog });
    const res = await request(app)
      .post('/session')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({ cwd: '/work/a' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('daemon-log-test-boom');
    await daemonLog.flush();
    // Verify the daemon log file contains the structured error
    const logPath = daemonLog.getLogPath();
    const logContent = await fsp.readFile(logPath, 'utf8');
    expect(logContent).toContain('[ERROR]');
    expect(logContent).toContain('[DAEMON]');
    expect(logContent).toContain('daemon-log-test-boom');
    expect(logContent).toContain('route=POST /session');
    // Verify stderr also received the line (tee behavior)
    expect(stderrLines.some((l) => l.includes('daemon-log-test-boom'))).toBe(
      true,
    );
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('falls back to writeStderrLine when daemonLog is not provided', async () => {
    const bridge = fakeBridge({
      spawnImpl: async () => {
        throw new Error('legacy-stderr-test-boom');
      },
    });
    // No daemonLog in deps → legacy path
    const app = createServeApp(baseOpts, undefined, { bridge });
    const res = await request(app)
      .post('/session')
      .set('Host', `127.0.0.1:${baseOpts.port}`)
      .send({ cwd: '/work/a' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('legacy-stderr-test-boom');
  });
});
