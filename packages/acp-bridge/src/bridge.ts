/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { inspect } from 'node:util';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk';
import type {
  CancelNotification,
  Client,
  ContentBlock,
  PromptRequest,
  PromptResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import type {
  ApprovalMode,
  RebuiltSessionArtifactSnapshot,
  TurnResultRecordPayload,
} from '@qwen-code/qwen-code-core';
import {
  DAEMON_TRACEPARENT_META_KEY,
  DAEMON_TRACESTATE_META_KEY,
  INVOCATION_CONTEXT_META_KEY,
  PRIVATE_ACP_CAPABILITY_ENV,
  PRIVATE_PARENT_CAPABILITY_META_KEY,
  SESSION_ARTIFACT_PERSISTENCE_VERSION,
  SESSION_PR_LIST_LIMIT,
  SESSION_PR_URL_MAX_LENGTH,
  SESSION_TRANSCRIPT_MAX_LIMIT,
  TURN_RESULT_CODE_TEXT_TRUNCATED,
  TURN_RESULT_TEXT_MAX_CHARS,
  TrustGateError,
  normalizeTurnResultError,
  normalizeSnapshotPayload,
  ShellExecutionService,
  type InvocationContextV1,
  type ShellOutputEvent,
} from '@qwen-code/qwen-code-core';
import type { ShellCommandResult } from './bridgeTypes.js';
import type { AcpChannel, AcpChannelTransportGuard } from './channel.js';
import {
  EventBus,
  DEFAULT_RING_SIZE,
  EVENT_SCHEMA_VERSION,
  type BridgeEvent,
} from './eventBus.js';
import {
  JOURNAL_GROWTH_HARD_CAP_BYTES,
  normalizeCompactedReplayMaxBytes,
  normalizeJournalGrowthPoolBytes,
  normalizeMaxJournalBytes,
  normalizeMaxJournalEvents,
  TurnBoundaryCompactionEngine,
  type JournalGrowthSessionLimit,
} from './compactionEngine.js';
import { createJournalGrowthPolicy } from './journalGrowthPolicy.js';
import {
  BridgeChannelClosedError,
  BridgeTimeoutError,
  SessionRestoreTimeoutError,
  createIdleWorkspaceExtensionsStatus,
  createIdleWorkspaceHooksStatus,
  SERVE_CONTROL_EXT_METHODS,
  SERVE_STATUS_EXT_METHODS,
  STATUS_SCHEMA_VERSION,
  type ServeSessionStatsStatus,
  type ServeSessionContextStatus,
  type ServeSessionLspStatus,
  type ServeSessionTasksStatus,
  type ServeWorkspaceMcpResourcesStatus,
  type ServeWorkspaceMcpStatus,
  type ServeWorkspaceMcpToolsStatus,
} from './status.js';
import {
  EXTERNAL_TOOL_GUARD_READY_META_KEY,
  EXTERNAL_TOOL_GUARD_REQUIRED_VALUE,
} from './externalToolGuard.js';
import {
  BranchWhilePromptActiveError,
  CdWhilePromptActiveError,
  SessionNotFoundError,
  RestoreInProgressError,
  InvalidSessionScopeError,
  SessionLimitExceededError,
  PromptQueueFullError,
  WorkspaceMismatchError,
  InvalidClientIdError,
  SessionShellClientRequiredError,
  SessionShellDisabledError,
  // Mediator's `vote()` validates `optionId in allowedOptionIds`,
  // but the bridge ALSO throws `InvalidPermissionOptionError`
  // pre-mediator when a wire client tries to inject the cancel
  // sentinel via a `selected` outcome — without this guard, a
  // wire-supplied `optionId === CANCEL_VOTE_SENTINEL` would
  // short-circuit all policy dispatch.
  InvalidPermissionOptionError,
  InvalidSessionMetadataError,
  isNotCurrentlyGeneratingCancelError,
  SessionBusyError,
  InvalidRewindTargetError,
  PromptDeadlineExceededError,
  BridgeChannelQuarantinedError,
} from './bridgeErrors.js';
import type { BridgeChannelUnavailableReason } from './bridgeErrors.js';
import {
  resolveSessionRestoreTimeoutMs,
  restoreRetryAfterSeconds,
} from './session-restore-timeout.js';
import {
  canonicalizeWorkspace,
  translateAndCheckAbsoluteWorkspacePath,
} from './workspacePaths.js';
import {
  parseSessionSource,
  SESSION_SOURCE_META_KEY,
} from './session-source.js';
import {
  ACTIVE_WORK_CLOSE_IF_UNHELD_PARAM,
  ACTIVE_WORK_CLOSE_TIMEOUT_MS,
  ACTIVE_WORK_HEARTBEAT_INTERVAL_MS,
  ACTIVE_WORK_HEARTBEAT_META_KEY,
  ACTIVE_WORK_HEARTBEAT_VERSION,
  ACTIVE_WORK_HOLD_CATEGORIES,
  ACTIVE_WORK_MAX_SESSION_HOLDS,
  ACTIVE_WORK_STALE_INTERVALS,
  CHANNEL_LIVENESS_META_KEY,
  CHANNEL_LIVENESS_VERSION,
  clampActiveWorkIntervalMs,
  type ActiveWorkHeartbeatCapabilityV1,
  type ActiveWorkHoldCategory,
  type ActiveWorkSnapshotV1,
  CHANNEL_PROMPT_META_KEY,
  CHANNEL_STARTUP_PROFILE_META_KEY,
  CHANNEL_STARTUP_PROFILE_VERSION,
  DAEMON_CHANNEL_DELIVERY_META_KEY,
  DAEMON_ATTACHMENT_REFERENCES_META_KEY,
  DAEMON_MODEL_PROMPT_META_KEY,
  DAEMON_PROMPT_DISPLAY_TEXT_META_KEY,
  DAEMON_RESTORE_ASK_USER_QUESTION_META_KEY,
  DAEMON_SUPPRESS_RESTORE_ASK_USER_QUESTION_META_KEY,
  LOAD_REPLAY_BULK_MODE,
  LOAD_REPLAY_HIDE_INHERITED_META_KEY,
  LOAD_REPLAY_MAX_UPDATES,
  LOAD_REPLAY_META_KEY,
  LOAD_REPLAY_MODE_META_KEY,
  LOAD_REPLAY_PAGE_SIZE_META_KEY,
  LOAD_REPLAY_VERSION,
  MID_TURN_RECONCILIATION_RING_SIZE,
  PROMPT_CANCEL_METHOD,
  REQUESTED_SESSION_ID_META_KEY,
  TODO_STOP_GUARD_QUEUE_RELEASE_METHOD,
  WORKTREE_MCP_DEFER_META_KEY,
  isValidTrustedModelPrompt,
  sessionCloseDrainBudgetMs,
} from './bridgeTypes.js';
import {
  startChannelLivenessMonitor,
  type ChannelLivenessMonitor,
  type ChannelLivenessFailure,
} from './channel-liveness.js';
import { getChannelStartupProfileAttributes } from './channel-startup-profile.js';
import type {
  BridgeSession,
  BridgeRestoreSessionRequest,
  BridgeSessionState,
  BridgeRestoredSession,
  BridgeSessionGoal,
  BridgeSessionSummary,
  SessionPrInfo,
  BridgeTurnStatus,
  BridgeSessionCatalogVersion,
  BridgePendingInteraction,
  BridgeClientRequestContext,
  CloseSessionOpts,
  AcpSessionBridge,
  MidTurnQueueEntry,
  PendingPromptEntry,
  BridgeDaemonStatusSnapshot,
  ChangeSessionCwdRequest,
  ChangeSessionCwdResult,
  BridgeAutoMemoryTopic,
  BridgeWorkspaceMemoryDreamResult,
  BridgeWorkspaceMemoryForgetRequest,
  BridgeWorkspaceMemoryForgetResult,
  BridgeWorkspaceMemoryForgetMatch,
  BridgeWorkspaceMemoryRememberRequest,
  BridgeWorkspaceMemoryRememberResult,
  BridgeSessionTranscriptPage,
  BridgeSessionTranscriptPageRequest,
  BridgeGenerationStreamEvent,
  BridgeWorkspaceGenerationStreamEvent,
  BridgePromptContentBlock,
  BridgePromptRequest,
  ChildHeapReport,
  RuntimeMcpServerAddResult,
  RuntimeMcpServerRemoveResult,
} from './bridgeTypes.js';
import {
  isSessionAttachmentReference,
  SessionAttachmentReferenceError,
  SessionAttachmentStore,
  withAttachmentDegradationMarker,
} from './sessionAttachments.js';
import type {
  BridgeFreshSessionAdmissionContext,
  BridgeFreshSessionReservation,
  BridgeOptions,
  BridgeSessionLifecycleEvent,
  BridgeTelemetry,
  LiveScreenContextCaptureHandler,
  LiveSpeakToUserHandler,
  LiveTaskToolRequestHandler,
  PromptLedgerSink,
} from './bridgeOptions.js';
import type {
  PromptLedgerRecord,
  PromptLedgerTerminalRecord,
} from './prompt-ledger.js';
import { MCP_RESTART_SERVER_DEADLINE_MS } from './mcpTimeouts.js';
import { defaultSpawnChannelFactory } from './spawnChannel.js';
import { writeStderrLine } from './internal/stderrLine.js';
import { BridgeClient, KNOWN_APPROVAL_MODES } from './bridgeClient.js';
import { GenerationStreamQueue } from './generation-stream.js';
import {
  CANCEL_VOTE_SENTINEL,
  createNoOpPermissionAuditPublisher,
  MultiClientPermissionMediator,
  type PermissionAuditPublisher,
} from './permissionMediator.js';
import { PermissionForbiddenError } from './bridgeErrors.js';
import {
  SessionArtifactStore,
  isArtifactRestoreFailureWarning,
  publicArtifactsEqual,
  type DaemonSessionArtifact,
  type SessionArtifactChange,
  type SessionArtifactInput,
  type SessionArtifactMutationResult,
} from './sessionArtifacts.js';

const NOOP_BRIDGE_TELEMETRY: BridgeTelemetry = {
  captureContext: () => undefined,
  runWithContext(_captured, fn) {
    return fn();
  },
  withSpan(_operation, _attributes, fn) {
    return fn();
  },
  event() {},
  injectPromptContext(request) {
    const meta = (request as { _meta?: unknown })._meta;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      return request;
    }
    const record = meta as Record<string, unknown>;
    if (
      !(DAEMON_TRACEPARENT_META_KEY in record) &&
      !(DAEMON_TRACESTATE_META_KEY in record)
    ) {
      return request;
    }
    const nextMeta = { ...record };
    delete nextMeta[DAEMON_TRACEPARENT_META_KEY];
    delete nextMeta[DAEMON_TRACESTATE_META_KEY];
    return { ...request, _meta: nextMeta };
  },
};

const KNOWN_SESSION_UPDATE_TYPES = new Set([
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeTransportFailureCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const code = error['code'];
  return typeof code === 'string' && /^[a-z0-9_.-]{1,64}$/iu.test(code)
    ? code
    : undefined;
}

function sessionSourceRequestMeta(
  sourceType: string | undefined,
  sourceId: string | undefined,
): Record<string, unknown> {
  return sourceType
    ? {
        [SESSION_SOURCE_META_KEY]: {
          sourceType,
          ...(sourceId !== undefined ? { sourceId } : {}),
        },
      }
    : {};
}

/**
 * Only the daemon's authenticated channel-worker path can populate the
 * user-facing display projection. Every other source echoes its prompt content
 * verbatim. Single source of truth for the echo, pending-entry text, and child
 * metadata so their `''`/undefined semantics cannot drift apart.
 */
function getChannelPromptDisplayText(
  entry: Pick<SessionEntry, 'sourceType'>,
  displayText: string | undefined,
): string | undefined {
  return entry.sourceType === 'channel' && typeof displayText === 'string'
    ? displayText
    : undefined;
}

function isDefinitiveAcpRequestError(error: unknown): boolean {
  if (error instanceof RequestError) return true;
  if (!isRecord(error)) return false;
  return (
    typeof error['code'] === 'number' &&
    Number.isInteger(error['code']) &&
    typeof error['message'] === 'string'
  );
}

class LogSafeAcpRequestError extends RequestError {
  constructor(
    code: number,
    message: string,
    data: unknown,
    private readonly reservePreparedResponse?: (value: unknown) => void,
  ) {
    super(code, message, data);
  }

  override toResult<T>() {
    const result = super.toResult<T>();
    if ('error' in result) {
      Object.defineProperty(result.error, inspect.custom, {
        configurable: true,
        value: () => ({ code: result.error.code, payloadOmitted: true }),
      });
      try {
        this.reservePreparedResponse?.(result.error);
      } catch {
        // The guard already retired the transport. The ACP SDK does not await
        // its message dispatcher, so throwing from toResult would be unhandled.
      }
    }
    return result;
  }
}

const MAX_LOG_SAFE_ACP_ERROR_DETAILS_CHARS = 1_024;
const MAX_LOG_SAFE_ACP_ERROR_KIND_CHARS = 128;
const MAX_LOG_SAFE_ACP_ERROR_HINT_CHARS = 512;

function logSafeAcpErrorDetails(
  error: unknown,
): { details: string } | undefined {
  const details =
    error instanceof Error
      ? error.message
      : isRecord(error) && typeof error['message'] === 'string'
        ? error['message']
        : undefined;
  if (!details) return undefined;
  return {
    details:
      details.length <= MAX_LOG_SAFE_ACP_ERROR_DETAILS_CHARS
        ? details
        : `${details.slice(0, MAX_LOG_SAFE_ACP_ERROR_DETAILS_CHARS)}…`,
  };
}

function boundedAcpErrorString(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

function logSafeRequestErrorMessage(code: number): string {
  switch (code) {
    case -32700:
      return 'Parse error';
    case -32600:
      return 'Invalid request';
    case -32601:
      return 'Method not found';
    case -32602:
      return 'Invalid params';
    case -32603:
      return 'Internal error';
    case -32000:
      return 'Authentication required';
    case -32002:
      return 'Resource not found';
    default:
      return 'ACP client request failed';
  }
}

function logSafeRequestErrorData(data: unknown): unknown {
  if (!isRecord(data) || typeof data['errorKind'] !== 'string') {
    return undefined;
  }
  const status = data['status'];
  const hint = data['hint'];
  return {
    errorKind: boundedAcpErrorString(
      data['errorKind'],
      MAX_LOG_SAFE_ACP_ERROR_KIND_CHARS,
    ),
    ...(typeof status === 'number' && Number.isFinite(status)
      ? { status }
      : {}),
    ...(typeof hint === 'string'
      ? {
          hint: boundedAcpErrorString(hint, MAX_LOG_SAFE_ACP_ERROR_HINT_CHARS),
        }
      : {}),
  };
}

class AcpInboundHandlerLimitError extends Error {
  readonly code = 'acp_handler_limit_exceeded';

  constructor(
    readonly maxActiveHandlers: number,
    readonly maxActiveHandlerBytes: number,
    readonly requiredBytes: number,
    readonly availableBytes: number,
  ) {
    super('ACP inbound handler capacity exceeded');
    this.name = 'AcpInboundHandlerLimitError';
  }
}

function estimateAcpHandlerBytes(value: unknown, limitBytes: number): number {
  let bytes = 0;
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null) {
      bytes += 4;
    } else if (typeof current === 'string') {
      bytes += Buffer.byteLength(current) + 2;
    } else if (typeof current === 'number') {
      bytes += 24;
    } else if (typeof current === 'boolean') {
      bytes += 5;
    } else if (Array.isArray(current)) {
      if (seen.has(current)) return limitBytes + 1;
      seen.add(current);
      bytes += 2 + Math.max(0, current.length - 1);
      if (bytes + current.length > limitBytes) return limitBytes + 1;
      for (let index = current.length - 1; index >= 0; index--) {
        stack.push(current[index]);
      }
    } else if (isRecord(current)) {
      if (seen.has(current)) return limitBytes + 1;
      seen.add(current);
      const entries = Object.entries(current);
      bytes += 2 + Math.max(0, entries.length - 1);
      for (const [key, entryValue] of entries) {
        bytes += Buffer.byteLength(key) + 3;
        stack.push(entryValue);
      }
    } else {
      bytes += 4;
    }
    if (bytes > limitBytes) return limitBytes + 1;
  }
  return Math.max(1, bytes);
}

class AcpInboundHandlerAdmission {
  private activeHandlers = 0;
  private activeBytes = 0;

  constructor(private readonly guard: AcpChannelTransportGuard) {}

  async run<T>(params: unknown, operation: () => Promise<T>): Promise<T> {
    const envelopeBytes = Math.min(2_048, this.guard.maxActiveHandlerBytes);
    const requiredBytes =
      envelopeBytes +
      estimateAcpHandlerBytes(
        params,
        Math.max(0, this.guard.maxActiveHandlerBytes - envelopeBytes),
      );
    const availableBytes = Math.max(
      0,
      this.guard.maxActiveHandlerBytes - this.activeBytes,
    );
    if (
      this.activeHandlers >= this.guard.maxActiveHandlers ||
      requiredBytes > availableBytes
    ) {
      const error = new AcpInboundHandlerLimitError(
        this.guard.maxActiveHandlers,
        this.guard.maxActiveHandlerBytes,
        requiredBytes,
        availableBytes,
      );
      this.guard.fail(error);
      throw error;
    }
    this.activeHandlers++;
    this.activeBytes += requiredBytes;
    try {
      return await operation();
    } finally {
      this.activeHandlers--;
      this.activeBytes -= requiredBytes;
    }
  }
}

async function withLogSafeAcpError<T>(
  operation: () => Promise<T>,
  reservePreparedResponse?: (value: unknown) => void,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RequestError) {
      const code = Number.isFinite(error.code) ? error.code : -32603;
      throw new LogSafeAcpRequestError(
        code,
        logSafeRequestErrorMessage(code),
        logSafeRequestErrorData(error.data),
        reservePreparedResponse,
      );
    }
    throw new LogSafeAcpRequestError(
      -32603,
      'Internal error',
      logSafeAcpErrorDetails(error),
      reservePreparedResponse,
    );
  }
}

function createLogSafeAcpClient(
  client: Client,
  transportGuard: AcpChannelTransportGuard,
): Client {
  const admission = new AcpInboundHandlerAdmission(transportGuard);
  const runNotification = <T>(params: unknown, operation: () => Promise<T>) =>
    withLogSafeAcpError(() => admission.run(params, operation));
  const runRequest = <T>(params: unknown, operation: () => Promise<T>) =>
    withLogSafeAcpError(
      () =>
        admission.run(params, async () => {
          const result = await operation();
          transportGuard.reservePreparedResponse(result ?? null);
          return result;
        }),
      transportGuard.reservePreparedResponse,
    );
  return {
    requestPermission: (params) =>
      runRequest(params, () => client.requestPermission(params)),
    sessionUpdate: (params) =>
      runNotification(params, () => client.sessionUpdate(params)),
    writeTextFile: client.writeTextFile
      ? (params) => runRequest(params, () => client.writeTextFile!(params))
      : undefined,
    readTextFile: client.readTextFile
      ? (params) => runRequest(params, () => client.readTextFile!(params))
      : undefined,
    createTerminal: client.createTerminal
      ? (params) => runRequest(params, () => client.createTerminal!(params))
      : undefined,
    terminalOutput: client.terminalOutput
      ? (params) => runRequest(params, () => client.terminalOutput!(params))
      : undefined,
    releaseTerminal: client.releaseTerminal
      ? (params) =>
          runRequest(
            params,
            async () => (await client.releaseTerminal!(params)) ?? {},
          )
      : undefined,
    waitForTerminalExit: client.waitForTerminalExit
      ? (params) =>
          runRequest(params, () => client.waitForTerminalExit!(params))
      : undefined,
    killTerminal: client.killTerminal
      ? (params) =>
          runRequest(
            params,
            async () => (await client.killTerminal!(params)) ?? {},
          )
      : undefined,
    extMethod: client.extMethod
      ? (method, params) =>
          runRequest(params, () => client.extMethod!(method, params))
      : undefined,
    extNotification: client.extNotification
      ? (method, params) =>
          runNotification(params, () => client.extNotification!(method, params))
      : undefined,
  };
}

const OUTBOUND_GUARDED_CONNECTION_METHODS = new Set<PropertyKey>([
  'initialize',
  'newSession',
  'loadSession',
  'unstable_forkSession',
  'unstable_listSessions',
  'unstable_resumeSession',
  'setSessionMode',
  'unstable_setSessionModel',
  'setSessionConfigOption',
  'authenticate',
  'prompt',
  'cancel',
  'extMethod',
  'extNotification',
]);

function createOutboundGuardedConnection(
  connection: ClientSideConnection,
  transportGuard: AcpChannelTransportGuard,
): ClientSideConnection {
  const wrappers = new Map<
    PropertyKey,
    (...args: unknown[]) => Promise<unknown>
  >();
  return new Proxy(connection, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (
        typeof value !== 'function' ||
        !OUTBOUND_GUARDED_CONNECTION_METHODS.has(property)
      ) {
        return value;
      }
      let wrapper = wrappers.get(property);
      if (!wrapper) {
        wrapper = async (...args: unknown[]) => {
          const release = transportGuard.reserveOutboundOperation(args);
          try {
            return await Reflect.apply(value, target, args);
          } finally {
            release();
          }
        };
        wrappers.set(property, wrapper);
      }
      return wrapper;
    },
  });
}

function getCanonicalModelId(response: unknown, fallback: string): string {
  if (!isRecord(response) || !isRecord(response['_meta'])) return fallback;
  const modelSwitch = response['_meta']['qwenModelSwitch'];
  if (!isRecord(modelSwitch)) return fallback;
  const modelId = modelSwitch['modelId'];
  return typeof modelId === 'string' ? modelId : fallback;
}

function isBulkReplayUpdate(value: unknown): value is SessionUpdate {
  if (!isRecord(value)) return false;
  const updateType = value['sessionUpdate'];
  return (
    typeof updateType === 'string' && KNOWN_SESSION_UPDATE_TYPES.has(updateType)
  );
}

function describeLoadReplayValue(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function extractLoadReplayResponse(state: BridgeSessionState): {
  state: BridgeSessionState;
  updates: SessionUpdate[];
  anchorRecordId?: string;
  partial?: true;
  replayError?: string;
  hasMore?: boolean;
} {
  const meta = isRecord(state._meta) ? state._meta : undefined;
  const replay = meta?.[LOAD_REPLAY_META_KEY];
  if (replay === undefined) return { state, updates: [] };
  if (!isRecord(replay) || replay['v'] !== LOAD_REPLAY_VERSION) {
    const version = isRecord(replay) ? replay['v'] : undefined;
    throw new Error(
      `Invalid qwen.session.loadReplay payload ` +
        `(type=${describeLoadReplayValue(replay)}, version=${JSON.stringify(version)})`,
    );
  }
  const rawUpdates = replay['updates'];
  if (!Array.isArray(rawUpdates)) {
    throw new Error(
      `Invalid qwen.session.loadReplay updates ` +
        `(version=${LOAD_REPLAY_VERSION}, count=not-array)`,
    );
  }
  if (rawUpdates.length > LOAD_REPLAY_MAX_UPDATES) {
    throw new Error(
      `qwen.session.loadReplay updates exceed limit ` +
        `(${rawUpdates.length} > ${LOAD_REPLAY_MAX_UPDATES})`,
    );
  }
  const partial = replay['partial'];
  if (partial !== undefined && partial !== true) {
    throw new Error(
      `Invalid qwen.session.loadReplay partial ` +
        `(version=${LOAD_REPLAY_VERSION}, partial=${JSON.stringify(partial)})`,
    );
  }
  const replayError = replay['replayError'];
  if (replayError !== undefined && typeof replayError !== 'string') {
    throw new Error(
      `Invalid qwen.session.loadReplay replayError ` +
        `(version=${LOAD_REPLAY_VERSION}, replayError=${describeLoadReplayValue(replayError)})`,
    );
  }
  const hasMore = replay['hasMore'];
  if (hasMore !== undefined && typeof hasMore !== 'boolean') {
    throw new Error(
      `Invalid qwen.session.loadReplay hasMore ` +
        `(version=${LOAD_REPLAY_VERSION}, hasMore=${describeLoadReplayValue(hasMore)})`,
    );
  }
  const anchorRecordId = replay['anchorRecordId'];
  if (anchorRecordId !== undefined && typeof anchorRecordId !== 'string') {
    throw new Error(
      `Invalid qwen.session.loadReplay anchorRecordId ` +
        `(version=${LOAD_REPLAY_VERSION}, anchorRecordId=${describeLoadReplayValue(anchorRecordId)})`,
    );
  }
  const invalidUpdateIndex = rawUpdates.findIndex(
    (update) => !isBulkReplayUpdate(update),
  );
  if (invalidUpdateIndex !== -1) {
    const invalidUpdate = rawUpdates[invalidUpdateIndex];
    const discriminator = isRecord(invalidUpdate)
      ? invalidUpdate['sessionUpdate']
      : undefined;
    throw new Error(
      `Invalid qwen.session.loadReplay update at index ${invalidUpdateIndex} ` +
        `(version=${LOAD_REPLAY_VERSION}, count=${rawUpdates.length}, ` +
        `sessionUpdate=${JSON.stringify(discriminator)})`,
    );
  }

  const nextMeta = { ...(meta ?? {}) };
  delete nextMeta[LOAD_REPLAY_META_KEY];
  const cleanState: BridgeSessionState = { ...state };
  if (Object.keys(nextMeta).length > 0) {
    cleanState._meta = nextMeta;
  } else {
    delete cleanState._meta;
  }
  return {
    state: cleanState,
    updates: rawUpdates,
    ...(typeof anchorRecordId === 'string' ? { anchorRecordId } : {}),
    ...(partial === true ? { partial: true as const } : {}),
    ...(typeof replayError === 'string' ? { replayError } : {}),
    ...(hasMore === true ? { hasMore: true } : {}),
  };
}

function takeRestoreAskUserQuestionHint(state: BridgeSessionState): {
  hint: boolean;
  state: BridgeSessionState;
} {
  const meta = isRecord(state._meta) ? state._meta : undefined;
  const hint = meta?.[DAEMON_RESTORE_ASK_USER_QUESTION_META_KEY] === true;
  if (!hint || !meta) return { hint: false, state };
  const nextMeta = { ...meta };
  delete nextMeta[DAEMON_RESTORE_ASK_USER_QUESTION_META_KEY];
  const next: BridgeSessionState = { ...state };
  if (Object.keys(nextMeta).length > 0) {
    next._meta = nextMeta;
  } else {
    delete next._meta;
  }
  return { hint: true, state: next };
}

/**
 * Stage 1 HTTP->ACP bridge factory + supporting helpers.
 *
 * Architecture:
 *   - **1 bridge = 1 workspace runtime**: every bridge instance is bound to a
 *     single canonical workspace path at construction
 *     (`BridgeOptions.boundWorkspace`). All `spawnOrAttach` calls must
 *     target that workspace; cross-workspace requests throw
 *     `WorkspaceMismatchError`. A multi-workspace daemon owns one bridge per
 *     registered runtime and selects the bridge before dispatch.
 *   - At most one `qwen --acp` child per bridge. Secondary daemon routing
 *     admits only trusted runtime-backed work and starts the child on demand;
 *     the primary may be preheated for legacy compatibility. Multiple sessions
 *     multiplex onto the child via
 *     `connection.newSession()`. Sessions share its process /
 *     OAuth state / `FileReadCache` / hierarchy-memory parse.
 *   - HTTP request bodies are forwarded as ACP NDJSON over the child's stdin.
 *   - Child stdout NDJSON notifications publish onto each session's
 *     `EventBus`; HTTP SSE subscribers (`GET /session/:id/events`) drain
 *     it. Cross-client fan-out + `Last-Event-ID` reconnect supported.
 *   - Multi-client requests against the same session serialize through this
 *     bridge (FIFO; honors ACP's "one active prompt per session" invariant).
 *     Different sessions on the same channel can prompt concurrently —
 *     the ACP layer demultiplexes by sessionId.
 *
 * Stage 2 replaces the spawn step with an in-process call into core's
 * ACP-equivalent API. The `AcpSessionBridge` interface stays the same so HTTP
 * route handlers don't need to change.
 */

interface ChannelInfo {
  id: string;
  channel: AcpChannel;
  connection: ClientSideConnection;
  /** Shared BridgeClient — its methods route ACP params by sessionId. */
  client: BridgeClient;
  // One bridge owns one workspace runtime, so module-scope `boundWorkspace` is
  // the source of truth and every channel in this bridge inherits it.
  // Per-channel storage would suggest variance the bridge doesn't allow;
  // keeping it out makes the runtime boundary visible at the type level.
  /**
   * Live session ids multiplexed on this channel. Updated when
   * `doSpawn` registers a new session and when `killSession` /
   * `channel.exited` removes one. When the set drops to empty under
   * `killSession`, the channel is marked `isDying = true` and its
   * `channel.kill()` is awaited; `channelInfo` itself is left
   * pointing at the dying channel until `channel.exited` fires (see
   * BkUyD invariant on `isDying` below).
   */
  sessionIds: Set<string>;
  /**
   * Restore calls currently executing on this channel but not yet registered
   * in `sessionIds`. Used to avoid killing the shared channel when one pending
   * restore fails while another is still healthy.
   */
  pendingRestoreIds: Set<string>;
  /**
   * `newSession` calls currently executing on this channel but not yet
   * registered in `sessionIds`. This is channel-scoped so one workspace/thread
   * spawn cannot keep another empty failed channel alive.
   */
  sessionSpawnsInFlight: number;
  /** Workspace-level control calls that use the shared channel without a session. */
  workspaceControlInFlight: number;
  /** Background MCP discovery started by the workspace initialize control. */
  workspaceMcpDiscoveryInFlight: boolean;
  workspaceMcpDiscoveryTimer?: NodeJS.Timeout;
  workspaceMcpDiscoveryRequested: boolean;
  workspaceMcpAuthenticationServerNames: Set<string>;
  workspaceMcpAuthenticationTimers: Map<string, NodeJS.Timeout>;
  /**
   * Set when an empty channel should be reaped after overlapping
   * session/workspace-control work drains.
   */
  emptyReapPending: boolean;
  /**
   * Session ids whose restore hit its public deadline and whose underlying
   * ACP request has not settled yet. Non-empty means "this channel is still
   * carrying hidden work we cannot cancel", which is a reason to reap once
   * visible work drains — closing the transport is the only lever that breaks
   * a permanently hung request. It clears on real settlement, so a channel
   * whose late restore resolved cleanly returns to the configured idle
   * policy instead of being condemned by a timeout it already recovered from.
   */
  unsettledAbandonedRestores: Set<string>;
  /**
   * Set when an abandoned restore has outlived its settlement grace period.
   * Existing sessions keep working; fresh session work is refused so the
   * channel can drain and be recycled, which is what finally closes the
   * transport out from under the request we cannot cancel.
   */
  restoreSettlementOverdue: boolean;
  /** Grace timers armed at restore abandonment, keyed by session id. */
  restoreSettlementTimers: Map<string, NodeJS.Timeout>;
  /** Transport guard fired before the child process exited. */
  transportFailed: boolean;
  /** The transport guard, rather than an existing teardown, condemned it. */
  transportFailureInitiatedTeardown: boolean;
  /** Safe bounded code retained for telemetry; never the raw error message. */
  transportFailureCode?: string;
  /**
   * Cached channel-close race for workspace-scoped status requests. Workspace
   * status can be polled frequently by dashboards, so keep one promise per
   * channel instead of attaching a new `.then()` to `channel.exited` per poll.
   */
  statusClosedReject?: Promise<never>;
  /**
   * Latest self-reported ACP-child resource sample (rss/cpu), refreshed by the
   * daemon's metrics sampler via `refreshChildResource`. Kept on the channel so
   * it drops automatically on a channel swap — the sampler always reads the
   * live channel's cache.
   */
  childRssBytes?: number;
  childCpuPercent?: number;
  childResourceAt?: number;
  /**
   * The child's lifetime old-generation high-water marks, when it reports
   * them. Absent — never zeroed — for a child that predates the fields or was
   * spawned without the daemon marker, so a reader can tell "not measured"
   * from a measured zero.
   */
  childHeap?: ChildHeapReport;
  /**
   * MUST be set to `true` synchronously by any teardown path BEFORE
   * awaiting `channel.kill()`. `ensureChannel` treats a dying channel
   * as absent and spawns a fresh one — without this flag a concurrent
   * `spawnOrAttach` arriving during the SIGTERM grace window (up to
   * 10s) would attach to a transport about to close, landing the
   * caller with a sessionId that 404s on every follow-up request.
   *
   * **Set-sites (6)** — any new teardown path MUST call into one of
   * these or replicate the pattern:
   *
   *   1. `ensureChannel`: `initialize`-failure catch.
   *   2. `ensureChannel`: late-shutdown re-check (shuttingDown flipped
   *      during handshake).
   *   3. `doSpawn`: newSession-failure on an empty channel
   *      (sessionIds.size === 0).
   *   4. `killSession`: last session leaving (sessionIds.size === 0
   *      after the delete).
   *   5. `shutdown`: bulk-mark every entry in `aliveChannels`.
   *   6. `ensureChannel`: a channel-level transport-failure signal.
   *
   * **BkUyD invariant (why we don't clear `channelInfo` here)**:
   * `killAllSync` must still find the channel during the SIGTERM
   * grace window to fire SIGKILL on `process.exit(1)`. `aliveChannels`
   * holds the dying entry until `channel.exited` fires (OS-level
   * reap); `isDying` is the "available-for-new-spawns" half of the
   * two-bit (alive, dying) state.
   */
  isDying: boolean;
  /** Existing sessions stay usable, but no fresh session work may enter. */
  isQuarantined: boolean;
  /**
   * Negotiated active-work reporting for this channel, or `undefined` when the
   * child never acknowledged the capability. `undefined` is *not* "idle": it
   * means this channel contributes no active-work facts at all, so the
   * daemon's reporting grade degrades and pre-existing cleanup behavior
   * applies unchanged. Conflating the two would let an older child either
   * pin every Session forever or look permanently idle.
   */
  activeWork?: {
    intervalMs: number;
    categories: readonly ActiveWorkHoldCategory[];
    /** Highest snapshot sequence applied; guards against reordering only. */
    seq: number;
  };
  channelLiveness?: ChannelLivenessMonitor;
  handshakeComplete: boolean;
}

interface SessionEntry {
  sessionId: string;
  workspaceCwd: string;
  effectiveCwd: string;
  createdAt: string;
  displayName?: string;
  /** Id of the session that spawned this one (via `create_sub_session`).
   * Immutable — written once at creation, never on attach. Absent for a
   * top-level session. */
  parentSessionId?: string;
  /** Immutable creator attribution, persisted in the transcript when present. */
  sourceType?: string;
  sourceId?: string;
  /** Worktree isolation metadata, when created with worktree param. */
  worktree?: { slug: string; path: string; branch: string };
  /** Branch metadata, when created with branch param. */
  branch?: { name: string; baseBranch: string };
  /** GitHub PRs bound via updateSessionMetadata, in binding order. */
  prs?: SessionPrInfo[];
  channel: AcpChannel;
  connection: ClientSideConnection;
  /** Per-session event bus drives `GET /session/:id/events`. */
  events: EventBus;
  /** Per-session structured artifact registry. */
  artifacts: SessionArtifactStore;
  /** Session-owned temporary attachment referenced by prompts and SSE events. */
  attachments: SessionAttachmentStore;
  /** Sticky in-memory health state for the session's transcript recorder. */
  recordingDegraded: boolean;
  /** Set synchronously while agent-owned state and its writer lease close. */
  closing: boolean;
  /** Tail of cwd changes that direct shell commands must not overtake. */
  cwdChangeQueue: Promise<void>;
  /**
   * Tail of the per-session prompt queue. Each new prompt chains off the
   * resolved (or rejected) state of this promise so prompts run one at a
   * time in arrival order. Always resolves — failures are swallowed at the
   * tail so a prior failure doesn't block subsequent prompts; the original
   * caller still observes the rejection on its own returned promise.
   */
  promptQueue: Promise<void>;
  /** Accepted prompts that have not settled yet (queued + active). */
  pendingPromptCount: number;
  pendingAgentNotificationCount: number;
  /**
   * Optional prompt terminal ledger sink (injected via BridgeOptions).
   * Best-effort synchronous appends; absence keeps pre-existing behavior.
   */
  promptLedger?: PromptLedgerSink;
  /**
   * Last hold set the owning child reported for this Session, or `null` while
   * the channel has negotiated reporting but has not yet been heard from.
   *
   * `null` (unknown) reads as *retained*, never as idle — but it is also the
   * state that makes the daemon go ask, rather than a state it sits in
   * forever. A channel that never negotiated leaves this `null` too; the
   * `ChannelInfo.activeWork` presence check is what separates the two.
   */
  childHolds: Map<string, ActiveWorkHoldCategory> | null;
  /** `Date.now()` of the snapshot behind `childHolds`; null while unknown. */
  childHoldsAt: number | null;
  /**
   * A close-if-unheld request is on the wire. Only one may be outstanding: on
   * timeout the daemon cannot tell whether the child already closed, so it
   * neither retries nor assumes — it clears this flag and lets the next
   * snapshot settle the question.
   */
  activeWorkCloseInFlight: boolean;
  /**
   * Detailed list of prompts accepted into the FIFO queue. Each entry
   * carries its `promptId`, summary, and an `abortController` so the
   * `removePendingPrompt` API can cancel specific items. The currently
   * running prompt has `state: 'running'`; waiting prompts have
   * `state: 'queued'`. Entries are removed in the `result.finally()`
   * tail of `sendPrompt`.
   */
  pendingPromptList: PendingPromptEntry[];
  /** Recent formal terminals bridge-published before transcript visibility. */
  terminalTurnStatuses: Map<string, BridgeTurnStatus>;
  /**
   * promptIds whose overlay terminal was enriched with the child's persisted
   * `turn_result` by `getSessionTurnStatus`. Those entries fully answer a
   * status poll, so they can be served without re-scanning the child
   * transcript.
   */
  enrichedTerminalPromptIds: Set<string>;
  /**
   * Monotonic counter incremented when a successful rewind truncates this
   * session's history. `getSessionTurnStatus` captures it before scanning
   * the child transcript and discards the scanned outcome when the
   * generation moved, so a result rolled back by a concurrent rewind is
   * never cached or served.
   */
  rewindGeneration: number;
  /** Bridge prompt that owns the child Guard wait for this FIFO. */
  todoStopGuardAwaitingQueuedPromptOwnerPromptId?: string;
  /**
   * Mid-turn user messages pushed by the browser (`POST
   * /session/:id/mid-turn-message`) while a turn is running. The ACP child
   * drains these between tool batches via the `craft/drainMidTurnQueue`
   * ext-method so the model sees them before the turn ends. The queue is
   * accepted into only while the session is busy (`pendingPromptCount > 0`)
   * and reconciled when the session next goes idle — see the settle handler in
   * `sendPrompt`. Every accepted entry is daemon-owned and promoted into the
   * normal prompt FIFO if it remains undrained at idle.
   */
  midTurnMessageQueue: MidTurnQueueEntry[];
  /**
   * Bounded ids either handed to the ACP child or explicitly deleted.
   */
  settledMidTurnMessageIds: string[];
  /** Bounded ids promoted into the normal prompt FIFO. */
  promotedMidTurnMessageIds: string[];
  /**
   * Per-session model/configuration FIFO. Prevents model changes and
   * model-dependent configuration changes from racing into the agent and
   * leaving it in non-deterministic state. Always resolves — failures are
   * swallowed at the tail like `promptQueue`.
   */
  modelChangeQueue: Promise<void>;
  /**
   * True while the bridge is driving a model roundtrip
   * (`setSessionModel` / `applyModelServiceId`) for this session. The
   * `current_model_update` extNotification demux in `BridgeClient` reads this
   * to SUPPRESS promotion of the agent's notification during a bridge-driven
   * change — the bridge publishes the authoritative `model_switched` itself,
   * so promoting the notification too would double-publish. In-session
   * `/model` (no bridge roundtrip) sees this false and IS promoted.
   */
  modelRoundtripInFlight?: boolean;
  /** A2: true while the bridge drives an approval-mode roundtrip. */
  approvalModeRoundtripInFlight?: boolean;
  /** §2.3: cached model id, updated by every `publishModelSwitched` call. */
  currentModelId?: string;
  /** §2.3: cached approval mode, updated by every `publishApprovalModeChanged` call. */
  currentApprovalMode?: string;
  /** §2.3: monotonic counter bumped on every `model_switched` publish. */
  modelPublishGeneration: number;
  /** §2.3: monotonic counter bumped on every `approval_mode_changed` publish. */
  approvalModePublishGeneration: number;
  /** §2.2: true while a model reconciliation read is in flight. */
  modelReconciliationInFlight?: boolean;
  /** §2.2: true while an approval-mode reconciliation read is in flight. */
  approvalModeReconciliationInFlight?: boolean;
  /**
   * Per-session approval-mode FIFO. Mirrors `modelChangeQueue`:
   * serializes concurrent `setSessionApprovalMode` calls so two
   * `POST /session/:id/approval-mode` can't race their ACP roundtrip
   * + persist and publish an `approval_mode_changed` event whose
   * `next` mode disagrees with the mode the ACP child actually settled
   * on. Always resolves — failures swallowed at the tail like
   * `modelChangeQueue`.
   */
  approvalModeQueue: Promise<void>;
  /**
   * Cached "transport closed" promise. The first `sendPrompt` on a
   * session lazy-builds this from `channel.exited.then(throw)`; every
   * subsequent prompt's race uses the SAME promise so the listener
   * count on `channel.exited` stays at one regardless of how many
   * prompts run on the session over its lifetime.
   */
  transportClosedReject?: Promise<never>;
  /**
   * Permission requestIds belonging to this session, kept so cancelSession
   * + shutdown can resolve them as `cancelled` per ACP requirement
   * (cancelled prompt MUST resolve outstanding requestPermission with
   * outcome.cancelled).
   */
  pendingPermissionIds: Set<string>;
  /** Stores pending permissions/questions for the pollable runtime summary. */
  pendingInteractions: Map<string, BridgePendingInteraction>;
  /**
   * Daemon-issued client ids currently known for this live session. HTTP
   * clients may echo one through `X-Qwen-Client-Id`; the bridge only treats
   * it as trusted originator metadata if it appears in this set.
   */
  clientIds: Map<string, number>;
  /**
   * Admitted id for the prompt currently running on this session. ACP enforces
   * one active prompt per session, and this bridge FIFO-serializes prompts, so
   * turn-scoped events can safely inherit this id.
   */
  activePromptId?: string;
  /**
   * Originator for the prompt currently running on this session. ACP enforces
   * one active prompt per session, and this bridge FIFO-serializes prompts, so
   * inline session updates / permission requests can safely inherit this id.
   */
  activePromptOriginatorClientId?: string;
  /** True while a prompt is executing on the FIFO, regardless of whether
   *  an originator clientId is known. Used by the session reaper to avoid
   *  killing sessions mid-prompt. */
  promptActive: boolean;
  /**
   * True while a child-driven Goal turn is running. Maintained by the
   * `_qwencode/start_turn` / `_qwencode/end_turn` (source `goal`)
   * notifications in `BridgeClient`; OR-ed into `hasActivePrompt`
   * summaries because Goal turns never flip `promptActive`.
   */
  goalTurnActive?: boolean;
  /** Terminal error from the prior turn, cleared when the next turn starts. */
  turnError?: {
    message: string;
    code?: string;
    errorKind?: string;
  };
  /**
   * The journaled `turn_error` event behind `turnError`, when the failed
   * turn published one. A bounded refresh replays it onto persisted
   * history so the terminal survives a page refresh; any newer turn
   * terminal — or newer turn content about to be folded by a queued
   * terminal boundary — clears it so a stale error is never re-appended
   * after newer content. Not part of the session summary.
   */
  turnErrorEvent?: BridgeEvent;
  retryAllowed: boolean;
  /** Prompt id whose `prompt_cancelled` event has already been broadcast. */
  cancelBroadcastPromptId?: string;
  /** Whether an id-less idle cancellation has already been broadcast. */
  cancelBroadcastWithoutPrompt?: boolean;
  /**
   * Count of times `spawnOrAttach` has returned `attached: true` for
   * this entry — i.e. a second-or-subsequent client claimed this
   * session under `sessionScope: 'single'`. Used by the disconnect-
   * reaper in `server.ts`: if the spawn-owner client disconnected
   * during the spawn handshake but another client has already
   * attached, the reaper must NOT tear the session down. The
   * increment + the killSession-skip-check both happen in the
   * synchronous portion of their respective async functions, so the
   * counter is observed atomically across the awaiting boundary.
   */
  attachCount: number;
  /**
   * Per-clientId attach reference ledger. Every `attachCount`
   * contribution that materialized into a registered clientId is
   * recorded here; `detachClient` may only decrement `attachCount`
   * by releasing a ref from this ledger. Owner-style registrations
   * (spawn owner, restore initiator) never contribute to
   * `attachCount` and are deliberately absent, so a detach with an
   * owner clientId — or a duplicate/unknown/anonymous detach —
   * cannot steal another attacher's count.
   */
  attachRefs: Map<string, number>;
  /**
   * BkwQP: tombstone for the spawn-owner-disconnect path. When the
   * spawn owner's HTTP response can't be written and they call
   * `killSession({ requireZeroAttaches: true })` but the bail
   * triggers (because some other client already bumped
   * `attachCount`), set this flag — it remembers the spawn owner
   * wanted the session reaped. A later `detachClient()` that brings
   * `attachCount` back to 0 then completes the deferred reap. Stays
   * `false` for sessions the spawn owner never tried to kill, so
   * `detachClient` of a transient attach doesn't reap a still-valid
   * session.
   */
  spawnOwnerWantedKill: boolean;
  /**
   * ACP state captured at `session/load` / `session/resume` time so
   * late attachers (existing-byId early-return + coalesced restore
   * waiters) get the same payload the original restore caller did.
   * `undefined` for sessions created via `doSpawn` — those have never
   * had an ACP load/resume response, so attaches return `state: {}`.
   */
  restoreState?: BridgeSessionState;
  /** Response-mode `session/load` can return a partial replay prefix. */
  restoreReplayPartial?: true;
  restoreReplayError?: string;
  restoreHistoryHasMore?: true;
  restoreHistoryAnchorRecordId?: string;
  /**
   * Most recent heartbeat across any client on this session (Date.now()
   * epoch ms). Set on every `recordHeartbeat` call regardless of whether
   * the caller identified themselves; consumed by diagnostics and
   * revocation policy. Undefined until the first heartbeat lands.
   */
  sessionLastSeenAt?: number;
  /**
   * Per-`clientId` last heartbeat (Date.now() epoch ms). Only populated
   * when the heartbeat carried a trusted `X-Qwen-Client-Id`. Entries are
   * dropped together with the parent session — revocation policy will
   * own per-client eviction.
   */
  clientLastSeenAt: Map<string, number>;
  /**
   * Strictly monotonic activity watermark (Date.now() epoch ms), advanced
   * once when a prompt that reached `running` publishes its first formal
   * terminal. Projected as `BridgeSessionSummary.updatedAt` so clients can
   * refresh session recency from the memory-only live-state route instead of
   * rescanning the persisted catalog after each turn.
   *
   * Bridge-local and deliberately not a persistence acknowledgement: the
   * recorder writes turn results through a serialized async queue, so a
   * terminal only proves the daemon observed the running attempt settle.
   * Undefined until the first running turn settles in this bridge.
   */
  lastTurnEndedAtMs?: number;
  /**
   * DAEMON-005: timestamp (Date.now()) when the last prompt settled with no
   * active subscriber attached, or `null` when no deferred close is pending.
   * Used by `entryIsAutoCloseCandidate` to hold the session open during the
   * `sessionPromptSettledCloseGraceMs` window so poll-based clients can
   * reconnect without triggering a session-rebuild epoch_reset resync.
   */
  promptSettledAt: number | null;
  /** Timer handle for the deferred `maybeCloseIdleSession` scheduled by
   * `schedulePromptSettledClose`. `undefined` when grace is 0 or no close
   * is pending. Cancelled by `clearPromptSettledClose` when a subscriber
   * reconnects or the session is explicitly closed / killed. */
  promptSettledCloseTimer: ReturnType<typeof setTimeout> | undefined;
}

function isServeDebugLoggingEnabled(): boolean {
  const value = process.env['QWEN_SERVE_DEBUG'];
  if (!value) return false;
  return !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
}

function writeServeDebugLine(message: string): void {
  if (!isServeDebugLoggingEnabled()) return;
  writeStderrLine(`qwen serve debug: ${message}`);
}

const MAX_DISPLAY_NAME_LENGTH = 256;

/**
 * Upper bound on how many prompt content blocks the bridge echoes per
 * prompt. A programmatically-generated prompt with thousands of small
 * blocks would otherwise trigger thousands of synchronous `publish()`
 * fan-outs (each up to the per-bus subscriber cap) and flood the
 * replay ring, evicting real history for every SSE subscriber. 256 is
 * far above any human-authored prompt's block count.
 */
const MAX_ECHO_CONTENT_BLOCKS = 256;

function extractPermissionResponseMetadata(
  response: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (response === null || typeof response !== 'object') return undefined;
  // Keep this extension deliberately narrow. Today the only non-ACP field
  // expected by the agent is AskUserQuestion's `answers` payload.
  const answers = (response as { readonly answers?: unknown }).answers;
  if (
    answers !== null &&
    typeof answers === 'object' &&
    !Array.isArray(answers)
  ) {
    const entries = Object.entries(answers as Record<string, unknown>);
    if (entries.every(([, v]) => typeof v === 'string')) {
      return { answers };
    }
  }
  return undefined;
}

function parseWorkspaceMemoryRememberResult(
  response: unknown,
): BridgeWorkspaceMemoryRememberResult {
  if (
    response === null ||
    typeof response !== 'object' ||
    Array.isArray(response)
  ) {
    throw new Error('Malformed workspace memory remember response');
  }
  const record = response as Record<string, unknown>;
  const summary = record['summary'];
  const filesTouched = record['filesTouched'];
  const touchedScopes = record['touchedScopes'];
  if (
    (summary !== undefined && typeof summary !== 'string') ||
    !Array.isArray(filesTouched) ||
    !filesTouched.every((file) => typeof file === 'string') ||
    !Array.isArray(touchedScopes) ||
    !touchedScopes.every((scope) => scope === 'user' || scope === 'project')
  ) {
    throw new Error('Malformed workspace memory remember response');
  }
  return {
    ...(summary === undefined ? {} : { summary }),
    filesTouched: filesTouched as string[],
    touchedScopes: touchedScopes as Array<'user' | 'project'>,
  };
}

function isBridgeAutoMemoryTopic(
  value: unknown,
): value is BridgeAutoMemoryTopic {
  return (
    value === 'user' ||
    value === 'feedback' ||
    value === 'project' ||
    value === 'reference'
  );
}

function touchedScopesFromTopics(
  topics: BridgeAutoMemoryTopic[],
): Array<'user' | 'project'> {
  const scopes = new Set<'user' | 'project'>();
  for (const topic of topics) {
    scopes.add(topic === 'user' || topic === 'feedback' ? 'user' : 'project');
  }
  return (['user', 'project'] as const).filter((scope) => scopes.has(scope));
}

function isBridgeMemoryScope(value: unknown): value is 'user' | 'project' {
  return value === 'user' || value === 'project';
}

function parseWorkspaceMemoryForgetMatch(
  value: unknown,
): BridgeWorkspaceMemoryForgetMatch | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !isBridgeAutoMemoryTopic(record['topic']) ||
    typeof record['summary'] !== 'string' ||
    typeof record['filePath'] !== 'string'
  ) {
    return null;
  }
  return {
    topic: record['topic'],
    summary: record['summary'],
    filePath: record['filePath'],
  };
}

function parseWorkspaceMemoryForgetResult(
  response: unknown,
): BridgeWorkspaceMemoryForgetResult {
  if (
    response === null ||
    typeof response !== 'object' ||
    Array.isArray(response)
  ) {
    throw new Error('Malformed workspace memory forget response');
  }
  const record = response as Record<string, unknown>;
  const summary = record['summary'];
  const removedEntries = record['removedEntries'];
  const touchedTopics = record['touchedTopics'];
  const touchedScopes = record['touchedScopes'];
  const parsedRemovedEntries = Array.isArray(removedEntries)
    ? removedEntries.map(parseWorkspaceMemoryForgetMatch)
    : [];
  if (
    (summary !== undefined && typeof summary !== 'string') ||
    !Array.isArray(removedEntries) ||
    parsedRemovedEntries.some((entry) => entry === null) ||
    !Array.isArray(touchedTopics) ||
    !touchedTopics.every(isBridgeAutoMemoryTopic) ||
    (touchedScopes !== undefined &&
      (!Array.isArray(touchedScopes) ||
        !touchedScopes.every(isBridgeMemoryScope)))
  ) {
    throw new Error('Malformed workspace memory forget response');
  }
  const parsedTouchedTopics = touchedTopics as BridgeAutoMemoryTopic[];
  return {
    ...(summary === undefined ? {} : { summary }),
    removedEntries: parsedRemovedEntries as BridgeWorkspaceMemoryForgetMatch[],
    touchedTopics: parsedTouchedTopics,
    touchedScopes:
      touchedScopes === undefined
        ? touchedScopesFromTopics(parsedTouchedTopics)
        : (touchedScopes as Array<'user' | 'project'>),
  };
}

function parseWorkspaceMemoryDreamResult(
  response: unknown,
): BridgeWorkspaceMemoryDreamResult {
  if (
    response === null ||
    typeof response !== 'object' ||
    Array.isArray(response)
  ) {
    throw new Error('Malformed workspace memory dream response');
  }
  const record = response as Record<string, unknown>;
  const summary = record['summary'];
  const touchedTopics = record['touchedTopics'];
  const dedupedEntries = record['dedupedEntries'];
  if (
    (summary !== undefined && typeof summary !== 'string') ||
    !Array.isArray(touchedTopics) ||
    !touchedTopics.every(isBridgeAutoMemoryTopic) ||
    typeof dedupedEntries !== 'number' ||
    !Number.isFinite(dedupedEntries)
  ) {
    throw new Error('Malformed workspace memory dream response');
  }
  return {
    ...(summary === undefined ? {} : { summary }),
    touchedTopics: touchedTopics as BridgeAutoMemoryTopic[],
    dedupedEntries,
  };
}

function pickUserInputEchoMeta(meta: unknown): Record<string, unknown> {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const inputAnnotations = (meta as Record<string, unknown>)[
    'inputAnnotations'
  ];
  return Array.isArray(inputAnnotations) ? { inputAnnotations } : {};
}

/**
 * Echo a user prompt to the session bus so multi-client SSE subscribers
 * see the input alongside the agent response. Iterates content blocks
 * and emits one `user_message_chunk` per block, mirroring the shape the
 * agent itself emits in the cron path (`Session.ts` cron handler) and
 * the history-replay path (`HistoryReplayer`). The regular interactive
 * `Session#executePrompt` was the historical outlier — it forwarded
 * the prompt straight to the LLM without going through the session bus.
 *
 * Originator dedup: SDK consumers using `normalizeDaemonEvent` with
 * `suppressOwnUserEcho: true` skip the echo for the originator (the
 * envelope-level `originatorClientId` matches their own clientId).
 *
 * Anonymous-prompt caveat: a stable `X-Qwen-Client-Id` is a PRECONDITION
 * for that dedup. A prompt with no clientId (curl smoke / pre-registration
 * script) produces an envelope without `originatorClientId`, so
 * `suppressOwnUserEcho` has nothing to match and the originating connection
 * sees its own input echoed back. This is an accepted edge for
 * headless/anonymous callers; interactive multi-client UIs always carry a
 * clientId and are unaffected.
 *
 * Source marker: `_meta.source: 'bridge-echo'` lets downstream tooling
 * distinguish bridge-synthesized echoes from agent-emitted content if
 * needed (e.g., for replay-deduplication when the agent later catches
 * up and emits the same chunk through `HistoryReplayer`).
 */
function echoPromptToSessionBus(
  entry: SessionEntry,
  req: BridgePromptRequest,
  promptId: string,
  originatorClientId: string | undefined,
  displayText: string | undefined,
): void {
  // `PromptRequest.prompt` is a non-optional `ContentBlock[]` per the
  // ACP type contract — read it directly so a future SDK bump that
  // makes it optional surfaces as a TypeScript error rather than being
  // silently swallowed by an `unknown` cast.
  // `PromptRequest.prompt` is typed as a non-optional `ContentBlock[]`, so
  // TS guarantees the shape. The runtime `Array.isArray` guard (D6) is pure
  // defense-in-depth for a malformed HTTP body that slips past the type
  // contract — cheaper than a thrown `TypeError` mid-echo.
  const prompt = req.prompt;
  if (!Array.isArray(prompt) || prompt.length === 0) return;
  let displayTextPublished = false;
  const serverTimestamp = Date.now();
  const echoPrompt = prompt.slice(0, MAX_ECHO_CONTENT_BLOCKS);
  if (
    displayText &&
    !echoPrompt.some((part) => isRecord(part) && part['type'] === 'text')
  ) {
    const textPart = prompt
      .slice(MAX_ECHO_CONTENT_BLOCKS)
      .find((part) => isRecord(part) && part['type'] === 'text');
    if (textPart) echoPrompt[echoPrompt.length - 1] = textPart;
  }
  const blockCount = echoPrompt.length;
  for (let i = 0; i < blockCount; i += 1) {
    const part = echoPrompt[i];
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
    let displayPart = part;
    if (displayText !== undefined && part.type === 'text') {
      if (displayTextPublished) continue;
      displayTextPublished = true;
      if (!displayText) continue;
      displayPart = { ...part, text: displayText };
    }
    // Non-text blocks are published verbatim. Channel text uses the display
    // projection so hidden model context never reaches transcript consumers.
    try {
      entry.events.publish({
        type: 'session_update',
        promptId,
        data: {
          sessionId: req.sessionId,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: displayPart,
            // `_meta` lives inside the `update` object rather than at
            // envelope level. `_meta` is a standard JSON-RPC/MCP extension
            // field permitted alongside spec fields, the SDK normalizer
            // reads it from `update._meta`/`data._meta`, and every other
            // agent-emitted session_update carries `_meta` the same way.
            _meta: {
              ...pickUserInputEchoMeta(req._meta),
              serverTimestamp,
              source: 'bridge-echo',
            },
          },
        },
        ...(originatorClientId ? { originatorClientId } : {}),
      });
    } catch {
      // bus may be closed (session being torn down); ignore — the
      // prompt forward still proceeds.
    }
  }
}

/**
 * Publish a `prompt_cancelled` event to the session bus so peer SSE
 * subscribers observe the cancel as a first-class event instead of
 * inferring it from the absence of further `agent_message_chunk`
 * frames.
 *
 * Semantic: this signals **cancel REQUESTED**, not **cancel
 * confirmed** — it's published before the ACP `cancel` notification is
 * forwarded/awaited (so peers learn promptly even if the agent is slow
 * to wind down or the channel is dead). If a consumer needs hard
 * confirmation it should observe the subsequent terminal
 * `tool_call_update` / `agent_message_chunk` quiescence.
 *
 * `originatorClientId` identifies the cancelling client. Used by both
 * the explicit `cancelSession` route and the `sendPrompt` abort path
 * (originator SSE disconnect) so neither cancel route is a silent gap.
 */
function broadcastPromptCancelled(
  entry: SessionEntry,
  sessionId: string,
  promptId: string | undefined,
  originatorClientId: string | undefined,
  reason?: 'forward_failed',
): void {
  try {
    entry.events.publish({
      type: 'prompt_cancelled',
      ...(promptId ? { promptId } : {}),
      data: { sessionId, ...(reason ? { reason } : {}) },
      ...(originatorClientId ? { originatorClientId } : {}),
    });
  } catch {
    /* bus closed */
  }
}

/**
 * Dedup wrapper around {@link broadcastPromptCancelled}. Broadcasts at
 * most once per active prompt by recording its id, so the
 * `cancelSession` route and the `sendPrompt` abort path can't both emit a
 * `prompt_cancelled` for a single turn (POST /cancel then socket close).
 */
function broadcastPromptCancelledOnce(
  entry: SessionEntry,
  sessionId: string,
  promptId: string | undefined,
  originatorClientId: string | undefined,
  reason?: 'forward_failed',
): void {
  if (
    (promptId !== undefined && entry.cancelBroadcastPromptId === promptId) ||
    (promptId === undefined && entry.cancelBroadcastWithoutPrompt === true)
  ) {
    writeStderrLine(
      `broadcastPromptCancelledOnce: suppressed duplicate cancel for session ${sessionId} prompt=${promptId ?? 'none'}`,
    );
    return;
  }
  if (promptId === undefined) {
    entry.cancelBroadcastWithoutPrompt = true;
  } else {
    entry.cancelBroadcastPromptId = promptId;
  }
  broadcastPromptCancelled(
    entry,
    sessionId,
    promptId,
    originatorClientId,
    reason,
  );
}

function broadcastTurnComplete(
  entry: SessionEntry,
  sessionId: string,
  promptResult: { stopReason?: string; [k: string]: unknown },
  promptId: string | undefined,
  originatorClientId: string | undefined,
  mutateTurnState: boolean,
): void {
  try {
    const meta =
      promptResult['_meta'] && typeof promptResult['_meta'] === 'object'
        ? (promptResult['_meta'] as Record<string, unknown>)
        : undefined;
    const rawBranchPoint =
      meta?.['qwen.branchPoint'] && typeof meta['qwen.branchPoint'] === 'object'
        ? (meta['qwen.branchPoint'] as Record<string, unknown>)
        : undefined;
    const branchPoint =
      promptResult.stopReason === 'end_turn' &&
      typeof rawBranchPoint?.['assistantRecordUuid'] === 'string' &&
      CHAT_RECORD_UUID_RE.test(rawBranchPoint['assistantRecordUuid']) &&
      typeof rawBranchPoint['checkpointUuid'] === 'string' &&
      CHAT_RECORD_UUID_RE.test(rawBranchPoint['checkpointUuid'])
        ? {
            assistantRecordUuid: rawBranchPoint['assistantRecordUuid'],
            checkpointUuid: rawBranchPoint['checkpointUuid'],
          }
        : undefined;
    const published = entry.events.publish({
      type: 'turn_complete',
      ...(promptId ? { promptId } : {}),
      data: {
        sessionId,
        stopReason: promptResult.stopReason ?? 'end_turn',
        ...(promptId ? { promptId } : {}),
        ...(branchPoint ? { branchPoint } : {}),
      },
      ...(originatorClientId ? { originatorClientId } : {}),
    });
    // A newer turn terminal supersedes any pending refresh-append error —
    // but only for a prompt that actually ran. A queued prompt's terminal
    // (deadline expiry, queued removal) publishes the event alone without
    // mutating turn state, so it must not erase the refresh-replay record
    // of the active turn's failure either.
    if (mutateTurnState && published !== undefined)
      entry.turnErrorEvent = undefined;
  } catch {
    /* bus may be closed during session teardown */
  }
}

/**
 * Extract a human-readable message from an unknown error value.
 * Handles Error instances, JSON-RPC error objects (`{ code, message,
 * data: { details } }`, `{ data: { message } }`, or string `data`), and plain
 * objects with a `message` property.
 * JSON-RPC internal errors carry the generic `"Internal error"` as
 * `message`; the actual detail often lives in `data.details` or
 * provider-specific `data.message`.
 */
export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const data = (err as Error & { data?: unknown }).data;
    const detail = extractJsonRpcErrorDetail(data);
    return detail ?? err.message;
  }
  if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, unknown>;
    const detail = extractJsonRpcErrorDetail(obj['data']);
    if (detail) return detail;
    const msg = obj['message'];
    if (typeof msg === 'string') return msg;
  }
  return String(err);
}

function extractJsonRpcErrorDetail(data: unknown): string | undefined {
  if (typeof data === 'string' && data.length > 0) return data;
  if (typeof data === 'object' && data !== null) {
    const details = (data as Record<string, unknown>)['details'];
    if (typeof details === 'string' && details.length > 0) return details;
    const message = (data as Record<string, unknown>)['message'];
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return undefined;
}

function extractJsonRpcErrorField(
  err: unknown,
  field: string,
): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const data = (err as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return undefined;
  const value = (data as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function extractErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err))
    return undefined;
  const raw = (err as Record<string, unknown>)['code'];
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return String(raw);
  return undefined;
}

/**
 * Event types that may be published after a turn terminal without adding
 * turn content (prompt-queue bookkeeping, config changes, and other
 * idle-reachable session bookkeeping). The bounded refresh-append guard
 * skips these when deciding whether the in-memory `turn_error` is still
 * the newest meaningful terminal; any other event type blocks the append.
 * `pending_prompt_started` is deliberately absent: it is published before
 * admission clears `turnErrorEvent`, so blocking the append in that window
 * keeps a stale error from trailing a turn that is already starting.
 *
 * Audit the full `broadcastWorkspaceEvent` vocabulary (and any other
 * idle-reachable session-bus publish) before adding a new event type to
 * the bus: every idle non-turn event belongs here, or an otherwise-idle
 * activity — a model switch, an extension refresh, an MCP server change,
 * a user-shell command — defeats the append and the loop terminal
 * disappears from the refreshed transcript. `session_update` events are
 * turn content except the idle bookkeeping subtypes skipped via
 * `isIdleBookkeepingSessionUpdate`: the user-shell output stream (its
 * history goes to the model conversation, not the persisted transcript
 * the refresh pages) and the latest-wins state snapshots
 * (`available_commands_update`, `current_mode_update`) that settings and
 * approval-mode refreshes fan out to idle sessions.
 */
const REFRESH_APPEND_BOOKKEEPING_EVENT_TYPES = new Set([
  'pending_prompt_added',
  'pending_prompt_completed',
  'prompt_cancelled',
  'model_switched',
  'model_switch_failed',
  'approval_mode_changed',
  'language_changed',
  'session_metadata_updated',
  'session_cwd_changed',
  'artifact_changed',
  'settings_changed',
  'extensions_changed',
  'mcp_server_changed',
  'mcp_server_added',
  'mcp_server_removed',
  'user_shell_command',
  'user_shell_result',
  // Workspace-level fan-out (workspace service, git watcher, memory /
  // agent CRUD, device-flow registry) reaches every session bus via
  // `publishWorkspaceEvent` while idle. The `auth_device_flow_*` members
  // mirror the closed `DeviceFlowEventEmission` union — audit that union
  // when it grows.
  'tool_toggled',
  'workspace_initialized',
  'mcp_server_restarted',
  'mcp_server_restart_refused',
  'settings_reloaded',
  'trust_change_requested',
  'memory_changed',
  'agent_changed',
  'git_status_changed',
  'git_branch_changed',
  'github_setup_completed',
  'auth_device_flow_started',
  'auth_device_flow_throttled',
  'auth_device_flow_authorized',
  'auth_device_flow_failed',
  'auth_device_flow_cancelled',
]);

/**
 * `session_update` frames published while idle that carry no turn content
 * for the persisted transcript, so they must not defeat the refresh-append
 * of a pending terminal error the way a real turn's `session_update` does:
 * the user-shell output stream (injected into the model conversation
 * history instead of the transcript the refresh pages) and the
 * latest-wins state snapshots (`available_commands_update` from a
 * skills/settings refresh, the legacy dual-emit `current_mode_update`).
 */
function isIdleBookkeepingSessionUpdate(event: BridgeEvent): boolean {
  if (event.type !== 'session_update') return false;
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const update = (data as Record<string, unknown>)['update'];
  if (!update || typeof update !== 'object' || Array.isArray(update))
    return false;
  const updateRecord = update as Record<string, unknown>;
  const subtype = updateRecord['sessionUpdate'];
  if (
    subtype === 'available_commands_update' ||
    subtype === 'current_mode_update'
  ) {
    return true;
  }
  const meta = updateRecord['_meta'];
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  return (meta as Record<string, unknown>)['source'] === 'user-shell';
}

/**
 * Turn-content test behind the refresh-append guard: everything that is
 * neither idle bookkeeping nor the synthetic journal-truncation marker
 * (which `liveJournalSnapshot` unshifts without ever ingesting it as
 * content) counts as newer turn content.
 */
function isRefreshAppendTurnContent(event: BridgeEvent): boolean {
  if (event.type === 'history_truncated') return false;
  if (REFRESH_APPEND_BOOKKEEPING_EVENT_TYPES.has(event.type)) return false;
  return !isIdleBookkeepingSessionUpdate(event);
}

export function classifyTurnErrorKind(
  message: string,
): 'model_stream_interrupted' | undefined {
  return message.trim().toLowerCase() === 'terminated'
    ? 'model_stream_interrupted'
    : undefined;
}

function broadcastTurnError(
  entry: SessionEntry,
  sessionId: string,
  err: unknown,
  promptId: string | undefined,
  originatorClientId: string | undefined,
  mutateTurnState: boolean,
): void {
  const message = extractErrorMessage(err);
  const structuredErrorKind = extractJsonRpcErrorField(err, 'errorKind');
  const errorKind = structuredErrorKind ?? classifyTurnErrorKind(message);
  const code =
    structuredErrorKind !== undefined
      ? (extractJsonRpcErrorField(err, 'code') ?? extractErrorCode(err))
      : extractErrorCode(err);
  const loopType = extractJsonRpcErrorField(err, 'loopType');
  if (errorKind) {
    writeServeDebugLine(
      `turn_error classified session=${JSON.stringify(sessionId)} ` +
        `message=${JSON.stringify(message)} ` +
        `errorKind=${JSON.stringify(errorKind)}` +
        (code ? ` code=${JSON.stringify(code)}` : '') +
        (promptId ? ` promptId=${JSON.stringify(promptId)}` : ''),
    );
  }
  // Session-scoped turn state (`turnError` is surfaced by the summary,
  // `retryAllowed` is consumed by the retry-admission check) must only
  // reflect the ACTIVE turn's failure. A queued prompt's terminal (deadline
  // expiry, teardown flush) publishes the event alone — otherwise a queued
  // failure would advertise a `turnError` for a turn that never ran and
  // arm a retry the active prompt didn't earn.
  if (mutateTurnState) {
    entry.retryAllowed = true;
    entry.turnError = {
      message,
      ...(code ? { code } : {}),
      ...(errorKind ? { errorKind } : {}),
    };
  }
  try {
    const published = entry.events.publish({
      type: 'turn_error',
      ...(promptId ? { promptId } : {}),
      data: {
        sessionId,
        message,
        ...(code ? { code } : {}),
        ...(errorKind ? { errorKind } : {}),
        ...(loopType ? { loopType } : {}),
        ...(promptId ? { promptId } : {}),
      },
      ...(originatorClientId ? { originatorClientId } : {}),
    });
    if (mutateTurnState) {
      // Undefined when the bus dropped the publish (closed mid-teardown);
      // the refresh-append guard then simply has nothing to replay. A
      // queued prompt's terminal (mutateTurnState=false) publishes the
      // event alone and leaves the active turn's refresh-replay record
      // untouched — the prompt never ran, so its terminal is not a newer
      // turn boundary for the replay (but see `publishPromptTerminal`: a
      // queued boundary that folds newer turn content supersedes it).
      entry.turnErrorEvent = published;
    }
  } catch {
    /* bus may be closed during session teardown */
  }
}

/**
 * The formal terminal outcome of an accepted prompt. Every prompt that was
 * admitted (202) must observe exactly one of these, published as either a
 * `turn_complete` (complete / cancelled) or `turn_error` event keyed by
 * `promptId`.
 */
type PromptTerminal =
  | { kind: 'complete'; result: { stopReason?: string; [k: string]: unknown } }
  | { kind: 'cancelled' }
  | { kind: 'error'; err: unknown };

const TERMINAL_TURN_STATUS_OVERLAY_LIMIT = 64;

function truncateTurnText(text: string): {
  text: string;
  truncated: boolean;
} {
  const truncated = text.length > TURN_RESULT_TEXT_MAX_CHARS;
  return {
    text: truncated ? text.slice(0, TURN_RESULT_TEXT_MAX_CHARS) : text,
    truncated,
  };
}

function rememberTerminalTurnStatus(
  entry: SessionEntry,
  pending: PendingPromptEntry,
  terminal: PromptTerminal,
): void {
  const promptText = truncateTurnText(pending.text);
  const shared = {
    sessionId: entry.sessionId,
    promptId: pending.promptId,
    promptText: promptText.text,
    ...(promptText.truncated ? { promptTextTruncated: true } : {}),
    queuedAt: pending.queuedAt,
    ...(pending.startedAt !== undefined
      ? { startedAt: pending.startedAt }
      : {}),
    endedAt: Date.now(),
    ...(pending.originatorClientId !== undefined
      ? { originatorClientId: pending.originatorClientId }
      : {}),
  };
  const status: BridgeTurnStatus =
    terminal.kind === 'complete'
      ? {
          ...shared,
          state:
            terminal.result.stopReason === 'cancelled'
              ? 'cancelled'
              : 'completed',
          ...(terminal.result.stopReason !== undefined
            ? { stopReason: terminal.result.stopReason }
            : {}),
        }
      : terminal.kind === 'cancelled'
        ? { ...shared, state: 'cancelled', stopReason: 'cancelled' }
        : {
            ...shared,
            state: 'error',
            error: normalizeTurnResultError(terminal.err),
          };
  entry.terminalTurnStatuses.set(pending.promptId, status);
  // A fresh bridge-published terminal replaces any enriched answer for the
  // same promptId.
  entry.enrichedTerminalPromptIds.delete(pending.promptId);
  while (entry.terminalTurnStatuses.size > TERMINAL_TURN_STATUS_OVERLAY_LIMIT) {
    const oldest = entry.terminalTurnStatuses.keys().next().value;
    if (oldest === undefined) break;
    entry.terminalTurnStatuses.delete(oldest);
    entry.enrichedTerminalPromptIds.delete(oldest);
  }
}

/**
 * Write a `getSessionTurnStatus` answer back into the overlay so later polls
 * for the same settled promptId are served from memory instead of forcing a
 * full child transcript scan each time. Shares the overlay's bounded
 * eviction.
 */
function rememberEnrichedTerminalTurnStatus(
  entry: SessionEntry,
  promptId: string,
  status: BridgeTurnStatus,
): void {
  entry.terminalTurnStatuses.set(promptId, status);
  entry.enrichedTerminalPromptIds.add(promptId);
  while (entry.terminalTurnStatuses.size > TERMINAL_TURN_STATUS_OVERLAY_LIMIT) {
    const oldest = entry.terminalTurnStatuses.keys().next().value;
    if (oldest === undefined) break;
    entry.terminalTurnStatuses.delete(oldest);
    entry.enrichedTerminalPromptIds.delete(oldest);
  }
}

/**
 * Advance a session's activity watermark past both wall time and its own
 * previous value. The extra millisecond is a logical tie-breaker that keeps
 * `updatedAt` strictly increasing when several terminals land inside one
 * wall-clock millisecond or the clock moves backward; it is not a duration.
 * A forward clock jump therefore stays until wall time catches up — correcting
 * it downward would break the monotonicity clients order rows by.
 *
 * The first advance floors at `createdAt`: rows without a watermark are keyed
 * by `createdAt`, and the live-only session cursor carries no emitted-identity
 * list, so a first watermark behind `createdAt` (wall-clock rollback between
 * creation and the first terminal) would move an already-emitted row's key
 * backward mid-pass and let the strictly-older filter return it twice.
 */
function advanceTurnActivity(entry: SessionEntry): void {
  const createdAtMs = Date.parse(entry.createdAt);
  const previous =
    entry.lastTurnEndedAtMs ??
    (Number.isFinite(createdAtMs) ? createdAtMs : undefined);
  entry.lastTurnEndedAtMs =
    previous === undefined ? Date.now() : Math.max(Date.now(), previous + 1);
}

/**
 * Best-effort ledger append: a failure must never block prompt execution
 * or teardown, so it is logged and swallowed. Synchronous by design — the
 * daemon-shutdown flush path requires the record to land before process
 * exit.
 */
function appendPromptLedgerBestEffort(
  entry: SessionEntry,
  record: PromptLedgerRecord,
): void {
  const ledger = entry.promptLedger;
  if (!ledger) return;
  try {
    ledger.appendSync(entry.sessionId, record);
  } catch (error) {
    writeStderrLine(
      `qwen serve: prompt ledger append failed for session=${entry.sessionId} promptId=${record.promptId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Project a PromptTerminal into the persisted ledger record. Mirrors the
 * in-memory `rememberTerminalTurnStatus` mapping so the ledger and the SSE
 * terminal agree, including the `stopReason: 'cancelled'` special case that
 * the complete path reports as a cancellation.
 */
function promptLedgerTerminalRecord(
  pendingEntry: PendingPromptEntry,
  terminal: PromptTerminal,
): PromptLedgerTerminalRecord {
  const at = Date.now();
  if (terminal.kind === 'complete') {
    if (terminal.result.stopReason === 'cancelled') {
      return {
        v: 1,
        promptId: pendingEntry.promptId,
        terminal: 'cancelled',
        at,
      };
    }
    return {
      v: 1,
      promptId: pendingEntry.promptId,
      terminal: 'completed',
      ...(terminal.result.stopReason !== undefined
        ? { stopReason: terminal.result.stopReason }
        : {}),
      at,
    };
  }
  if (terminal.kind === 'cancelled') {
    return { v: 1, promptId: pendingEntry.promptId, terminal: 'cancelled', at };
  }
  const normalized = normalizeTurnResultError(terminal.err);
  return {
    v: 1,
    promptId: pendingEntry.promptId,
    terminal: 'error',
    ...(normalized.code !== undefined ? { code: normalized.code } : {}),
    at,
  };
}

/**
 * Publish the formal terminal event for an accepted prompt exactly once.
 * All terminal paths (agent settle, queued removal, deadline, session
 * close/kill/crash flush) funnel through here; the per-prompt
 * `terminalPublished` latch suppresses later attempts so consumers keyed
 * on `promptId` see one and only one `turn_complete`/`turn_error`.
 * `originatorClientId` is always taken from the pending entry so callers
 * can't disagree with the admission-time attribution.
 */
function publishPromptTerminal(
  entry: SessionEntry,
  pendingEntry: PendingPromptEntry,
  terminal: PromptTerminal,
): void {
  if (pendingEntry.terminalPublished) {
    // Dedup here is the designed steady state, not an anomaly: deadline
    // expiry, queued removal, and teardown flush each race the prompt's
    // natural settle, so the loser lands here on every such turn.
    writeServeDebugLine(
      `publishPromptTerminal: suppressed duplicate ${terminal.kind} terminal ` +
        `for prompt ${pendingEntry.promptId} (session ${entry.sessionId})`,
    );
    return;
  }
  pendingEntry.terminalPublished = true;
  appendPromptLedgerBestEffort(
    entry,
    promptLedgerTerminalRecord(pendingEntry, terminal),
  );
  rememberTerminalTurnStatus(entry, pendingEntry, terminal);
  const originatorClientId = pendingEntry.originatorClientId;
  // Only a running prompt's terminal belongs to the active turn. The
  // `state === 'running'` gate (not `activePromptId`) is deliberate: on
  // the normal settle path `settleActivePromptState` runs in
  // `promptPromise.finally` BEFORE the terminal is published, so
  // `activePromptId` is already cleared when a genuine active terminal
  // lands here. Queued terminals publish their event alone and must
  // neither set nor clear session-scoped turn state.
  const mutateTurnState = pendingEntry.state === 'running';
  if (mutateTurnState) {
    // Written before the terminal is published so a client that observed the
    // terminal and then starts a live-state request cannot read a stale
    // watermark. A queued-only terminal is not conversation activity and
    // leaves the watermark alone.
    advanceTurnActivity(entry);
  }
  if (!mutateTurnState && entry.turnErrorEvent) {
    // A queued terminal is still a turn boundary on the bus: ingesting it
    // folds and resets the live journal, erasing the guard's only evidence
    // of newer turn content journaled since the pending error terminal.
    // That content supersedes the stale error, so drop the refresh-replay
    // record before the fold — otherwise the append would re-place the
    // stale error AFTER the newer content.
    const journal = entry.events.liveJournalSnapshot() ?? [];
    if (journal.some(isRefreshAppendTurnContent)) {
      entry.turnErrorEvent = undefined;
    }
  }
  if (terminal.kind === 'complete') {
    broadcastTurnComplete(
      entry,
      entry.sessionId,
      terminal.result,
      pendingEntry.promptId,
      originatorClientId,
      mutateTurnState,
    );
  } else if (terminal.kind === 'cancelled') {
    broadcastTurnComplete(
      entry,
      entry.sessionId,
      { stopReason: 'cancelled' },
      pendingEntry.promptId,
      originatorClientId,
      mutateTurnState,
    );
  } else {
    broadcastTurnError(
      entry,
      entry.sessionId,
      terminal.err,
      pendingEntry.promptId,
      originatorClientId,
      mutateTurnState,
    );
  }
}

/**
 * Publish an error terminal for every prompt still pending on a session
 * that is being torn down (close/kill/channel crash/daemon shutdown), then
 * abort each prompt so residual FIFO nodes skip at their pre-dispatch
 * check instead of being promoted to running. Must run before
 * `entry.events.close()` — the bus swallows publishes afterwards. Any
 * later settle of the same prompts re-enters `publishPromptTerminal` and
 * is deduped by the latch. For a running prompt the abort fires the
 * existing `onAbort` listener while the bus is still open, so a trailing
 * `prompt_cancelled` after the terminal frame is expected — consumers
 * settling on the terminal by `promptId` are unaffected.
 */
function flushPromptTerminals(
  entry: SessionEntry,
  code: string,
  message: string,
): void {
  for (const pending of [...entry.pendingPromptList]) {
    publishPromptTerminal(entry, pending, {
      kind: 'error',
      err: { code, message },
    });
    try {
      pending.abortController.abort(
        new DOMException('Prompt aborted', 'AbortError'),
      );
    } catch {
      /* listeners must not break teardown */
    }
  }
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Extract the full text content from prompt content blocks for the pending
 * prompt queue. Takes the first `text` block and falls back to an image
 * placeholder for image-only prompts.
 */
function extractPromptText(
  prompt: readonly BridgePromptContentBlock[],
): string {
  if (!Array.isArray(prompt)) return '';
  let hasImage = false;
  for (const block of prompt) {
    const record = block as unknown as Record<string, unknown>;
    if (record['type'] === 'image') {
      hasImage = true;
    }
    if (
      record['type'] === 'text' &&
      typeof record['text'] === 'string' &&
      record['text'].length > 0
    ) {
      return record['text'];
    }
  }
  return hasImage ? '[image]' : '';
}

function liveTurnStatus(
  sessionId: string,
  pending: PendingPromptEntry,
): BridgeTurnStatus {
  const promptText = truncateTurnText(pending.text);
  return {
    sessionId,
    state: pending.state === 'running' ? 'running' : 'queued',
    promptId: pending.promptId,
    promptText: promptText.text,
    ...(promptText.truncated ? { promptTextTruncated: true } : {}),
    queuedAt: pending.queuedAt,
    ...(pending.startedAt !== undefined
      ? { startedAt: pending.startedAt }
      : {}),
    ...(pending.originatorClientId !== undefined
      ? { originatorClientId: pending.originatorClientId }
      : {}),
  };
}

function findLiveTurnStatus(
  entry: SessionEntry,
  promptId?: string,
): BridgeTurnStatus | undefined {
  const live = entry.pendingPromptList.filter(
    (pending) =>
      !pending.terminalPublished &&
      (!pending.removed || pending.state === 'running'),
  );
  if (promptId !== undefined) {
    const match = live.find((pending) => pending.promptId === promptId);
    return match ? liveTurnStatus(entry.sessionId, match) : undefined;
  }
  const running = live.find((pending) => pending.state === 'running');
  if (running) return liveTurnStatus(entry.sessionId, running);
  const queued = live.find((pending) => pending.state === 'queued');
  return queued ? liveTurnStatus(entry.sessionId, queued) : undefined;
}

function settledTurnStatus(
  sessionId: string,
  record: TurnResultRecordPayload,
): BridgeTurnStatus {
  return {
    sessionId,
    state: record.state,
    promptId: record.promptId,
    ...(record.stopReason !== undefined
      ? { stopReason: record.stopReason }
      : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    endedAt: record.endedAt,
    ...(record.promptText !== undefined
      ? { promptText: record.promptText }
      : {}),
    ...(record.promptTextTruncated !== undefined
      ? { promptTextTruncated: record.promptTextTruncated }
      : {}),
    ...(record.resultText !== undefined
      ? { resultText: record.resultText }
      : {}),
    ...(record.resultTruncated !== undefined
      ? { resultTruncated: record.resultTruncated }
      : {}),
    ...(record.resultTruncated === true
      ? { resultCode: record.resultCode ?? TURN_RESULT_CODE_TEXT_TRUNCATED }
      : {}),
    ...(record.originatorClientId !== undefined
      ? { originatorClientId: record.originatorClientId }
      : {}),
  };
}

function enrichTerminalTurnStatus(
  terminal: BridgeTurnStatus,
  persisted: BridgeTurnStatus,
): BridgeTurnStatus {
  return {
    ...terminal,
    // The bridge's display projection is trusted; the child-recorded text
    // only backfills when the terminal has none, so hidden channel context
    // the child derived from raw blocks never replaces it.
    ...(terminal.promptText === undefined && persisted.promptText !== undefined
      ? { promptText: persisted.promptText }
      : {}),
    ...(terminal.promptTextTruncated === undefined &&
    persisted.promptTextTruncated !== undefined
      ? { promptTextTruncated: persisted.promptTextTruncated }
      : {}),
    ...(persisted.resultText !== undefined
      ? { resultText: persisted.resultText }
      : {}),
    ...(persisted.resultTruncated !== undefined
      ? { resultTruncated: persisted.resultTruncated }
      : {}),
    ...(persisted.resultCode !== undefined
      ? { resultCode: persisted.resultCode }
      : {}),
    ...(terminal.originatorClientId === undefined &&
    persisted.originatorClientId !== undefined
      ? { originatorClientId: persisted.originatorClientId }
      : {}),
  };
}

/**
 * Merge an overlay terminal with the child's persisted record for the same
 * prompt. A bridge-synthesized error terminal (prompt deadline, teardown
 * flush) is superseded on the poll surface once the child has settled and
 * persisted a non-error outcome: the deadline releases the caller without
 * killing the agent, so the persisted outcome is what actually happened.
 * The trusted prompt display projection always stays the terminal's. Every
 * other combination keeps the overlay outcome and enriches it with
 * persisted text.
 */
function mergeTerminalWithPersisted(
  terminal: BridgeTurnStatus,
  persisted: BridgeTurnStatus,
): BridgeTurnStatus {
  if (terminal.state === 'error' && persisted.state !== 'error') {
    return {
      ...persisted,
      ...(terminal.promptText !== undefined
        ? { promptText: terminal.promptText }
        : {}),
      ...(terminal.promptTextTruncated !== undefined
        ? { promptTextTruncated: terminal.promptTextTruncated }
        : {}),
    };
  }
  return enrichTerminalTurnStatus(terminal, persisted);
}

function latestTerminalTurnStatus(
  entry: SessionEntry,
): BridgeTurnStatus | undefined {
  let latest: BridgeTurnStatus | undefined;
  for (const status of entry.terminalTurnStatuses.values()) {
    if ((status.endedAt ?? 0) >= (latest?.endedAt ?? 0)) latest = status;
  }
  return latest;
}

/**
 * Extract attachment content blocks from a prompt for storage in the
 * pending-prompt queue. References use the session attachment store; legacy
 * audio blocks remain inline. This lets refreshed clients restore the payload.
 */
function extractMediaBlocks(
  prompt: readonly BridgePromptContentBlock[],
): BridgePromptContentBlock[] | undefined {
  if (!Array.isArray(prompt)) return undefined;
  const media: BridgePromptContentBlock[] = [];
  for (const block of prompt) {
    if (!block || typeof block !== 'object') continue;
    if (
      block.type === 'image' ||
      block.type === 'audio' ||
      (block.type === 'resource' && 'attachmentId' in block)
    ) {
      media.push(block);
    }
  }
  return media.length > 0 ? media : undefined;
}

const DEFAULT_INIT_TIMEOUT_MS = 10_000;
const PERSIST_TIMEOUT_MS = 5_000;
// Bounded retries for the sub-session `parentSessionId` transcript write on the
// spawn critical path — a transport/timeout hiccup gets a couple more tries
// before the child is reported as live-only (`parentSessionPersisted:false`).
const MAX_PARENT_PERSIST_ATTEMPTS = 3;
const MCP_RESTART_TIMEOUT_MS = 300_000;
const WORKSPACE_MEMORY_REMEMBER_TIMEOUT_MS = 300_000;
const MCP_OAUTH_TIMEOUT_MS = 600_000;
const DAEMON_RETRY_META_KEY = 'qwen.daemon.retry';
// Trusted continuation marker. `sendPrompt` strips it from every caller and
// re-arms it only for the trusted `continueSession` dispatch (the `isContinue`
// flag), so an external `POST /session/:id/prompt` can never smuggle it in to
// trigger a continuation that skips `continueLastTurn()`'s accept/reject
// pre-check. Mirrors how `DAEMON_RETRY_META_KEY` is stripped and re-armed.
const DAEMON_CONTINUE_META_KEY = 'qwen.daemon.continueLastTurn';
/**
 * Backstop timeout for `qwen/control/session/recap`. The underlying
 * side-query is single-attempt with `maxOutputTokens: 300`, so a
 * healthy call finishes in 1–5 seconds; we cap at 60s to absorb model-
 * provider hiccups without inheriting the 10s `initTimeoutMs` default
 * (which would false-fire on any GPT-style slow start). The race is a
 * safety net against a wedged ACP channel — there is no HTTP-side
 * disconnect cancellation in v1 (see server.ts route comment).
 */
const SESSION_RECAP_TIMEOUT_MS = 60_000;
const SESSION_GENERATION_TIMEOUT_MS = 65_000;
const GENERATION_STREAM_QUEUE_CAPACITY = 128;
const SESSION_BTW_TIMEOUT_MS = 60_000;
const SESSION_TRANSCRIPT_TIMEOUT_MS = 60_000;
const MAX_EMPTY_TRANSCRIPT_PAGES = 20;
const SHELL_COMMAND_TIMEOUT_MS = 120_000;
const MAX_SHELL_OUTPUT_FOR_HISTORY = 10_000;
// Per-session cap on undrained mid-turn messages: a busy turn with no drain
// point (a long tool-free generation) must not let a client pin unbounded
// messages in the in-memory queue. Past the cap, `enqueueMidTurnMessage`
// rejects without taking ownership.
// Intentionally a fixed const for now; if this ever needs tuning, promote it to
// a `BridgeOptions` knob the same way `maxPendingPromptsPerSession` (the
// analogous bound `/prompt` enforces, default 5) is wired.
const MAX_MID_TURN_QUEUE_DEPTH = 20;
const MAX_QUEUED_INLINE_ATTACHMENT_BYTES = 100 * 1024 * 1024;

function inlineAttachmentBlockBytes(
  blocks: readonly BridgePromptContentBlock[],
): number {
  let total = 0;
  for (const block of blocks) {
    if (block.type === 'image' && 'data' in block) {
      total += Buffer.byteLength(block.data);
      continue;
    }
    if (block.type !== 'resource' || !('resource' in block)) continue;
    const resource = block.resource;
    if ('blob' in resource) total += Buffer.byteLength(resource.blob);
    else if ('text' in resource) total += Buffer.byteLength(resource.text);
  }
  return total;
}

const DEFAULT_MAX_SESSIONS = 32;
// Keep in sync with CLI serve/server.ts and SDK DaemonClient.ts.
const DEFAULT_MAX_PENDING_PROMPTS_PER_SESSION = 5;
const CHAT_RECORD_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/**
 * Soft upper bound on `BridgeOptions.eventRingSize` to catch operator
 * typos before they OOM the daemon. At ~500 B per `BridgeEvent` an
 * 1 000 000-frame ring already pins ~500 MB per session — well past
 * any realistic workload. Not a security boundary (the flag is
 * operator-controlled), just typo defense.
 */
const MAX_EVENT_RING_SIZE = 1_000_000;
// Human permissions wait indefinitely by default and still resolve through
// voter cancellation, session cancellation, and shutdown. Operators can set
// `BridgeOptions.permissionResponseTimeoutMs` when they need a wall-clock cap.
const DEFAULT_PERMISSION_TIMEOUT_MS = 0;
// Bd1z5: per-session cap on pending permissions in flight. A chatty
// agent making rapid `requestPermission` calls would otherwise grow
// `pendingPermissions` unboundedly — each entry is a UUID + closure
// + bus event. 64 mirrors `DEFAULT_MAX_SUBSCRIBERS` (one pending
// per subscriber feels like a reasonable headroom). Excess requests
// resolve as cancelled and emit a stderr warning so operators see
// the limit being hit. Configurable via
// `BridgeOptions.maxPendingPermissionsPerSession`.
const DEFAULT_MAX_PENDING_PER_SESSION = 64;
const DEFAULT_SESSION_REAP_INTERVAL_MS = 60_000;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;
/** Default grace period for the prompt-settled close deferral. 0 = disabled
 * (original behavior). Poll-based CLI callers opt in via BridgeOptions or the
 * `qwen serve --session-prompt-settled-close-grace-ms` flag. */
const DEFAULT_SESSION_PROMPT_SETTLED_CLOSE_GRACE_MS = 0;

export function createAcpSessionBridge(opts: BridgeOptions): AcpSessionBridge {
  let liveScreenContextCaptureHandler:
    | LiveScreenContextCaptureHandler
    | undefined;
  let liveTaskToolRequestHandler: LiveTaskToolRequestHandler | undefined;
  let liveSpeakToUserHandler: LiveSpeakToUserHandler | undefined;
  const defaultSessionScope = opts.sessionScope ?? 'single';
  // Resolved once beside the other option defaults: this default is
  // load-bearing for every non-daemon consumer, and reading `?? true` inline
  // would let a second `initialize` site drift away from it.
  const delegateReadTextFileToClient =
    opts.delegateReadTextFileToClient ?? true;
  // `undefined` → default 32 (intentionally tight to avoid resource cliffs).
  // `0` → explicitly unlimited (operator opt-out).
  // `Infinity` → unlimited (programmatic opt-out — accepted as a
  //              long-standing alias since the cap check is `>= max`).
  // `NaN` / negative → throw. A typo / parse error in CLI/config
  //                    silently disabling the daemon's only resource
  //                    guard is fail-OPEN behavior — we'd rather fail
  //                    boot than serve unbounded.
  let maxSessions: number;
  if (opts.maxSessions === undefined) {
    maxSessions = DEFAULT_MAX_SESSIONS;
  } else if (Number.isNaN(opts.maxSessions)) {
    throw new TypeError(
      `Invalid maxSessions: NaN. Must be a number >= 0 ` +
        `(0 / Infinity = unlimited).`,
    );
  } else if (opts.maxSessions < 0) {
    throw new TypeError(
      `Invalid maxSessions: ${opts.maxSessions}. Must be >= 0 ` +
        `(0 / Infinity = unlimited).`,
    );
  } else if (opts.maxSessions === 0 || opts.maxSessions === Infinity) {
    maxSessions = Infinity;
  } else {
    maxSessions = opts.maxSessions;
  }
  // Two independent conditions close a channel to NEW session work while
  // leaving its existing sessions usable: cleanup after a timed-out restore
  // failed (we no longer know the child's state), or an abandoned restore
  // blew past its settlement grace period (the child is holding work we
  // cannot cancel or account for). Both want existing work to drain so the
  // channel can be recycled, so they share one 503 shape and differ by
  // `reason`. Scanned rather than tracked in a single variable, so a second
  // condemned channel can never silently displace the first.
  const freshSessionBlocker = ():
    | { channel: ChannelInfo; reason: BridgeChannelUnavailableReason }
    | undefined => {
    for (const ci of aliveChannels) {
      if (ci.isDying) continue;
      if (ci.isQuarantined) {
        return { channel: ci, reason: 'restore_cleanup_failed' };
      }
      if (ci.restoreSettlementOverdue) {
        return { channel: ci, reason: 'restore_settlement_overdue' };
      }
    }
    return undefined;
  };
  const assertFreshSessionsAvailable = (): void => {
    const blocker = freshSessionBlocker();
    if (blocker) {
      throw new BridgeChannelQuarantinedError(
        blocker.reason,
        abandonedRestoreRetryAfterSeconds,
      );
    }
  };
  const reserveFreshSession = (
    context: BridgeFreshSessionAdmissionContext,
  ): BridgeFreshSessionReservation | undefined => {
    assertFreshSessionsAvailable();
    return opts.freshSessionAdmission?.(context);
  };
  const releaseFreshSessionReservation = (
    reservation: BridgeFreshSessionReservation | undefined,
  ): void => {
    if (!reservation) return;
    try {
      reservation.release();
    } catch (err) {
      opts.onDiagnosticLine?.(
        `qwen serve: fresh session admission release failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        'warn',
      );
    }
  };
  // In-memory session-catalog clock for the workspace live-state protocol.
  // The generation changes only with this bridge instance; the revision
  // advances on daemon-observed catalog membership and static-metadata
  // changes. Getters return fresh value snapshots so a later mark never
  // mutates a previously handed-out version.
  const sessionCatalogGeneration = randomUUID();
  let sessionCatalogRevision = 0;
  const getSessionCatalogVersion = (): BridgeSessionCatalogVersion => ({
    generation: sessionCatalogGeneration,
    revision: sessionCatalogRevision,
  });
  const markSessionCatalogChanged = (): void => {
    sessionCatalogRevision += 1;
  };
  const emitSessionLifecycle = (event: BridgeSessionLifecycleEvent): void => {
    // Membership marks advance through this single choke point — every
    // bridge map insertion, deletion, and clear emits here after the
    // mutation. Marking before the host callback keeps a throwing
    // `sessionLifecycle` listener from suppressing the revision change.
    markSessionCatalogChanged();
    try {
      opts.sessionLifecycle?.(event);
    } catch (err) {
      const message = `qwen serve: session lifecycle callback failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      opts.onDiagnosticLine?.(message, 'warn');
      writeStderrLine(message);
    }
  };
  if (defaultSessionScope !== 'single' && defaultSessionScope !== 'thread') {
    throw new TypeError(
      `Invalid sessionScope: ${JSON.stringify(defaultSessionScope)}. ` +
        `Expected 'single' or 'thread'.`,
    );
  }
  // `eventRingSize` follows the same fail-CLOSED posture as
  // `maxSessions`: silently disabling SSE backpressure on a config
  // typo is worse than failing to start. Unlike `maxSessions` there
  // is NO unlimited sentinel — an unbounded ring would grow forever.
  // Soft upper bound MAX_EVENT_RING_SIZE catches operator typos
  // (`--event-ring-size 80000000` instead of `8000000`); at 1M
  // frames × ~500 B/frame the per-session ceiling is already
  // ~500 MB, well past any legitimate use.
  const eventRingSize = opts.eventRingSize ?? DEFAULT_RING_SIZE;
  // `Number.isInteger` already rejects NaN / Infinity / non-finite
  // — no separate `Number.isFinite` guard needed.
  if (
    !Number.isInteger(eventRingSize) ||
    eventRingSize < 1 ||
    eventRingSize > MAX_EVENT_RING_SIZE
  ) {
    throw new TypeError(
      `Invalid eventRingSize: ${opts.eventRingSize}. ` +
        `Must be a positive integer in [1, ${MAX_EVENT_RING_SIZE}].`,
    );
  }
  const compactedReplayMaxBytes = normalizeCompactedReplayMaxBytes(
    opts.compactedReplayMaxBytes,
  );
  const maxJournalEvents = normalizeMaxJournalEvents(opts.maxJournalEvents);
  const maxJournalBytes = normalizeMaxJournalBytes(opts.maxJournalBytes);
  // Adaptive live-journal growth is opt-in via the pool: `runQwenServe`
  // derives one from the daemon memory budget (and skips it when the
  // operator pinned the journal flags). No pool → fixed-cap eviction,
  // exactly the pre-growth behavior.
  const journalGrowthPoolBytes = normalizeJournalGrowthPoolBytes(
    opts.journalGrowthPoolBytes,
  );
  const journalGrowthPolicy =
    journalGrowthPoolBytes !== undefined
      ? createJournalGrowthPolicy({
          baselineEvents: maxJournalEvents,
          baselineBytes: maxJournalBytes,
          poolBytes: journalGrowthPoolBytes,
          hardCapBytes: JOURNAL_GROWTH_HARD_CAP_BYTES,
        })
      : undefined;
  // Daemon-wired shared-pool accounting (see BridgeOptions): the
  // aggregator reports every sharing session's current cap, this
  // bridge's included. Absent on standalone bridges.
  const journalGrowthSessionLimits = opts.journalGrowthSessionLimits;
  const channelFactory = opts.channelFactory ?? defaultSpawnChannelFactory;
  // Close over a per-handle env-override snapshot. Calls to
  // `channelFactory` at spawn time receive this as the 2nd arg, so
  // the default factory can merge into the child env without
  // consulting any global state that another concurrent
  // `runQwenServe()` handle might have mutated. Frozen to make
  // accidental mutation throw rather than silently corrupt later
  // spawns.
  const childEnvOverrides: Readonly<Record<string, string | undefined>> =
    opts.childEnvOverrides
      ? Object.freeze({ ...opts.childEnvOverrides })
      : Object.freeze({});
  const initTimeoutMs = opts.initializeTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  if (initTimeoutMs <= 0) {
    throw new TypeError(
      `Invalid initializeTimeoutMs: ${initTimeoutMs}. Must be > 0.`,
    );
  }
  const sessionRestoreTimeoutMs = resolveSessionRestoreTimeoutMs(opts);
  // Retry hint for an id fenced behind an abandoned restore. The underlying
  // ACP request already exceeded the full budget, so the next useful retry is
  // at least a budget away; the cap keeps the advertised hint sane when an
  // operator configures a very long restore deadline.
  // How long after the public deadline an abandoned restore may keep holding
  // its slot and fence before the channel stops taking fresh work. One further
  // budget: the request already had that long and missed it once.
  const restoreSettlementGraceMs = sessionRestoreTimeoutMs;
  const abandonedRestoreRetryAfterSeconds = restoreRetryAfterSeconds(
    sessionRestoreTimeoutMs,
  );
  // Bd1yh + Bd1z5: per-permission deadline + per-session pending cap.
  // Permission caps keep the legacy sentinel behavior; prompt caps are
  // stricter because they are an admission-control surface.
  const permissionTimeoutRaw =
    opts.permissionResponseTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
  const permissionTimeoutMs =
    permissionTimeoutRaw > 0 && Number.isFinite(permissionTimeoutRaw)
      ? // Clamp to 2^31-1: Node treats setTimeout delays larger than
        // this as 1ms (TimeoutOverflowWarning), which would make a
        // huge "effectively never" timeout cancel prompts almost
        // immediately — the opposite of intent. Mirrors the sibling
        // `resolvePositiveFiniteMs` / `resolvedChannelIdleTimeoutMs`.
        Math.min(permissionTimeoutRaw, 2_147_483_647)
      : 0; // 0 = disabled
  const maxPendingRaw =
    opts.maxPendingPermissionsPerSession ?? DEFAULT_MAX_PENDING_PER_SESSION;
  const maxPendingPerSession =
    maxPendingRaw > 0 && Number.isFinite(maxPendingRaw)
      ? maxPendingRaw
      : Infinity;
  const maxPendingPromptsRaw =
    opts.maxPendingPromptsPerSession ?? DEFAULT_MAX_PENDING_PROMPTS_PER_SESSION;
  let maxPendingPromptsPerSession: number;
  if (
    maxPendingPromptsRaw === 0 ||
    maxPendingPromptsRaw === Number.POSITIVE_INFINITY
  ) {
    maxPendingPromptsPerSession = Infinity;
  } else if (
    !Number.isInteger(maxPendingPromptsRaw) ||
    maxPendingPromptsRaw < 0
  ) {
    throw new TypeError(
      `Invalid maxPendingPromptsPerSession: ${maxPendingPromptsRaw}. ` +
        `Must be a non-negative integer (0 / Infinity = unlimited).`,
    );
  } else {
    maxPendingPromptsPerSession = maxPendingPromptsRaw;
  }
  // The bound path is the canonical form `spawnOrAttach` compares
  // incoming `workspaceCwd` against. The caller MUST pass an already-
  // canonical value (via `canonicalizeWorkspace`). `runQwenServe`
  // does this at boot and threads the same value into both
  // `createHttpAcpBridge` and `createServeApp`; direct embeds / tests
  // must call `canonicalizeWorkspace` first. No redundant
  // `realpathSync.native` here — on case-insensitive / symlinked
  // filesystems two independent calls could disagree if the FS mutates
  // between them. The `path.isAbsolute` guard is a structural input
  // check, not a syscall.
  if (!path.isAbsolute(opts.boundWorkspace)) {
    throw new TypeError(
      `Invalid boundWorkspace: "${opts.boundWorkspace}". Must be an ` +
        `absolute path.`,
    );
  }
  const boundWorkspace = opts.boundWorkspace;
  const persistApprovalMode = opts.persistApprovalMode;
  const telemetry = opts.telemetry ?? NOOP_BRIDGE_TELEMETRY;

  // Per-workspace bridge model: the bridge hosts AT MOST one
  // ATTACH-AVAILABLE channel and one default attach-target entry.
  // Multi-session multiplexing happens through `channelInfo.sessionIds`;
  // the `defaultEntry` slot is the FIRST session created (the one a
  // same-workspace attach under `single` scope reuses). Thread-scope
  // sessions add to `byId` but don't displace `defaultEntry`.
  let defaultEntry: SessionEntry | undefined;
  // `channelInfo` is the SINGLE attach-available channel. Cleared
  // ONLY by the `channel.exited` handler (see below) when the OS
  // reaps the underlying child process. Teardown initiators
  // (`killSession` last-session-leaving, `doSpawn`-newSession-failure
  // on an empty channel, `ensureChannel` init-failure /
  // late-shutdown, `shutdown`) set `isDying = true` but LEAVE
  // `channelInfo` pointing at the dying channel until OS reap — that
  // asymmetry IS the BkUyD invariant. It lets `killAllSync` reach a
  // mid-SIGTERM-grace channel through `aliveChannels` while a
  // concurrent `spawnOrAttach` can already start spawning a fresh
  // replacement (which overwrites `channelInfo` when its
  // handshake completes). Race-aware code paths (`ensureChannel`,
  // `killAllSync`) gate on `isDying` rather than presence; see
  // `ChannelInfo.isDying` for the per-set-site rationale.
  let channelInfo: ChannelInfo | undefined;
  let workspaceMcpStatusCache: ServeWorkspaceMcpStatus | undefined;
  const workspaceMcpToolsCache = new Map<
    string,
    ServeWorkspaceMcpToolsStatus
  >();
  const workspaceMcpResourcesCache = new Map<
    string,
    ServeWorkspaceMcpResourcesStatus
  >();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const sessionReapIntervalMs = resolvePositiveFiniteMs(
    opts.sessionReapIntervalMs,
    DEFAULT_SESSION_REAP_INTERVAL_MS,
  );
  const sessionIdleTimeoutMs = resolvePositiveFiniteMs(
    opts.sessionIdleTimeoutMs,
    DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  );
  const sessionPromptSettledCloseGraceMs = resolvePositiveFiniteMs(
    opts.sessionPromptSettledCloseGraceMs,
    DEFAULT_SESSION_PROMPT_SETTLED_CLOSE_GRACE_MS,
  );
  let sessionReaper: ReturnType<typeof setInterval> | undefined;

  // Tracks the most recent "activity" event for idle-detection by
  // external schedulers. Updated on prompt start/end and session
  // spawn/restore. `null` until the first activity after boot.
  let lastActivityTimestamp: number | null = null;
  let activePromptCounter = 0;
  function touchActivity(): void {
    lastActivityTimestamp = Date.now();
  }

  /**
   * Daemon-owned facts only: prompts this daemon accepted (queued *or*
   * dispatched) and notifications it is currently pushing into the child.
   * These never depend on the child reporting anything, which is why they
   * stay authoritative for a channel that never negotiated.
   */
  function entryHasLocalWork(entry: SessionEntry): boolean {
    return (
      entry.pendingPromptCount > 0 || entry.pendingAgentNotificationCount > 0
    );
  }

  /**
   * Whether the child's cached hold set is recent enough to be evidence of
   * anything. Anything older than the grading window is not a report that the
   * Session is idle, it is the absence of a report.
   */
  function childHoldsAreFresh(
    entry: SessionEntry,
    capability: Pick<ActiveWorkHeartbeatCapabilityV1, 'intervalMs'>,
  ): boolean {
    if (entry.childHoldsAt === null) return false;
    return (
      Date.now() - entry.childHoldsAt <=
      capability.intervalMs * ACTIVE_WORK_STALE_INTERVALS
    );
  }

  /**
   * Whether the child has told us, recently enough to count, that it is
   * holding work for this Session. Positive knowledge only — a channel that
   * never negotiated and one that has gone quiet both answer `false` here,
   * because neither is a report *of work*.
   */
  function childReportsHeldWork(entry: SessionEntry): boolean {
    const owner = channelInfoForEntry(entry);
    if (!owner?.activeWork) return false;
    if (!childHoldsAreFresh(entry, owner.activeWork)) return false;
    return entry.childHolds !== null && entry.childHolds.size > 0;
  }

  /**
   * Whether the child's side of this Session's state is currently unknown:
   * the channel negotiated reporting, but no snapshot recent enough to grade
   * has arrived. Never-reported and gone-quiet are the same state on purpose —
   * a snapshot from ten minutes ago says nothing about whether a background
   * agent started since.
   *
   * A channel that never negotiated is not "unknown", it is out of scope:
   * treating it as unknown would make every legacy Session unreapable.
   */
  function childWorkIsUnknown(entry: SessionEntry): boolean {
    const owner = channelInfoForEntry(entry);
    if (!owner?.activeWork) return false;
    return !childHoldsAreFresh(entry, owner.activeWork);
  }

  /**
   * Whether this Session counts as busy for the health surface.
   *
   * Fails closed on ignorance: unknown reads the same as busy, because a
   * controller must not be able to mistake "nobody told me" for "nothing is
   * running". The reporting grade published alongside is what lets a caller
   * tell those two apart when it needs to.
   */
  function entryHasActiveWork(entry: SessionEntry): boolean {
    return (
      entryHasLocalWork(entry) ||
      childReportsHeldWork(entry) ||
      childWorkIsUnknown(entry)
    );
  }

  /**
   * The guards every automatic teardown shares, whichever policy decided it
   * was time to look. Each caller adds its own policy on top (the reaper its
   * TTL, the detach path its client bookkeeping) but none of them may skip
   * these.
   *
   * Note what is deliberately *not* here: `childWorkIsUnknown`. Unknown is not
   * a reason to skip, it is a reason to ask — the candidate goes on to
   * `confirmChildUnheld`, and the child answers authoritatively under its own
   * close gate whether or not its snapshots are arriving. Skipping on unknown
   * instead would retain such a Session forever, with no path that ever
   * resolves it; asking costs one bounded round trip and still retains on any
   * non-answer. Only *known* work — daemon-owned, or a fresh report of held
   * work — blocks the attempt outright.
   *
   * `activeWorkCloseInFlight` is in here because a conditional close is a
   * multi-step, awaited sequence: while one is outstanding this Session is
   * already a teardown candidate under consideration, and a second path
   * evaluating it concurrently would either duplicate the round trip or race
   * its own guards against the first one's outcome.
   */
  function entryIsAutoCloseCandidate(entry: SessionEntry): boolean {
    if (byId.get(entry.sessionId) !== entry) return false;
    if (isClosingOrAuthorizingClose(entry)) return false;
    if (entry.events.subscriberCount > 0) return false;
    if (entryHasLocalWork(entry)) return false;
    // A restore in flight looks exactly like an abandoned Session and is the
    // opposite of one. `session/load` registers the entry before it awaits
    // `artifacts.restore()` and `seedSessionUpdates()`, and its first client
    // is registered only after those resolve — so for that whole window there
    // are no clients, no subscribers, and nothing held, and the child answers
    // the conditional close truthfully. Excluded here rather than at the
    // snapshot trigger so every automatic path is covered: the reaper's TTL
    // can elapse inside a slow restore too.
    const owner = channelInfoForEntry(entry);
    if (owner?.pendingRestoreIds.has(entry.sessionId)) return false;
    // A child that negotiated active-work but cannot report every category
    // the daemon currently relies on must not authorize ordinary teardown.
    // This differs from a legacy child that never negotiated at all: legacy
    // cleanup keeps its historical behavior, while an incomplete negotiated
    // answer is explicitly known not to cover the full retention predicate.
    const capability = owner?.activeWork;
    if (
      capability &&
      !owner.isQuarantined &&
      !owner.restoreSettlementOverdue &&
      ACTIVE_WORK_HOLD_CATEGORIES.some(
        (category) => !capability.categories.includes(category),
      )
    ) {
      return false;
    }
    // DAEMON-005: hold the session open during the prompt-settled grace
    // window so a poll-based client can reconnect without forcing a
    // session-rebuild epoch_reset resync.
    if (
      entry.promptSettledAt !== null &&
      sessionPromptSettledCloseGraceMs > 0 &&
      Date.now() - entry.promptSettledAt < sessionPromptSettledCloseGraceMs
    ) {
      return false;
    }
    return !childReportsHeldWork(entry);
  }

  /**
   * Whether this Session is off-limits to new work.
   *
   * Two states, one meaning. `closing` is teardown already under way;
   * `activeWorkCloseInFlight` is teardown authorized and being confirmed. Both
   * must refuse admission, or a prompt accepted during the confirmation round
   * trip is lost when the teardown it raced completes.
   */
  function isClosingOrAuthorizingClose(entry: SessionEntry): boolean {
    return entry.closing || entry.activeWorkCloseInFlight;
  }

  /**
   * DAEMON-005: schedule (or immediately fire) the prompt-settled auto-close.
   *
   * Called from `result.finally` when a prompt settles with no subscriber.
   * When `sessionPromptSettledCloseGraceMs > 0`, stamps `promptSettledAt` and
   * schedules a deferred `maybeCloseIdleSession` so a reconnecting poll-based
   * client has time to cancel the timer via `subscribeEvents` →
   * `clearPromptSettledClose`. When grace is 0, fires immediately (original
   * behavior).
   */
  function schedulePromptSettledClose(entry: SessionEntry): void {
    entry.promptSettledAt = Date.now();
    if (sessionPromptSettledCloseGraceMs <= 0) {
      entry.promptSettledAt = null;
      void maybeCloseIdleSession(entry, 'prompt_settled');
      return;
    }
    entry.promptSettledCloseTimer = setTimeout(() => {
      entry.promptSettledCloseTimer = undefined;
      entry.promptSettledAt = null;
      void maybeCloseIdleSession(entry, 'prompt_settled');
    }, sessionPromptSettledCloseGraceMs);
    // Node timer must not prevent process exit.
    entry.promptSettledCloseTimer.unref?.();
  }

  /**
   * DAEMON-005: cancel any pending prompt-settled deferred close.
   * Called when a subscriber reconnects (clearing the grace hold) or when
   * the session is explicitly closed / killed (avoiding a stale fire).
   */
  function clearPromptSettledClose(entry: SessionEntry): void {
    if (entry.promptSettledCloseTimer !== undefined) {
      clearTimeout(entry.promptSettledCloseTimer);
      entry.promptSettledCloseTimer = undefined;
    }
    entry.promptSettledAt = null;
  }

  /**
   * Single decision point for "this Session is detached and has nothing left
   * to do — let it go".
   *
   * Every automatic cleanup path funnels through here (last-client detach,
   * prompt settle, notification settle, a child reporting itself idle) so the
   * preservation rule lives in exactly one place. Explicit close, kill, and
   * shutdown deliberately do NOT come through here: they keep their force
   * semantics.
   */
  async function maybeCloseIdleSession(
    entry: SessionEntry,
    reason: string,
  ): Promise<void> {
    // Note the asymmetry, preserved from the call sites this replaces: the
    // kill path keys off `attachCount`, the close path off `clientIds`. A
    // spawn owner that asked for a kill gets one once nothing is attached,
    // even if some client id is still registered. This is a deferred explicit
    // kill, so incomplete child reporting must not turn it into ordinary
    // cleanup or leave it pending forever.
    //
    // `activeWorkCloseInFlight` must stay excluded (the auto-close candidacy
    // gate used to cover it): the reaper can be mid-probe on this same entry,
    // holding the child's close gate for up to `ACTIVE_WORK_CLOSE_TIMEOUT_MS`.
    // A kill fired in that window reaches `beginClose()` as 'Session close is
    // already in progress', and `killSession` escalates any close error to a
    // channel kill — taking down every sibling session with it. The in-flight
    // probe resolves this entry one way or the other; if it retains, the
    // tombstone completes on the next settle event.
    if (
      byId.get(entry.sessionId) === entry &&
      !isClosingOrAuthorizingClose(entry) &&
      entry.spawnOwnerWantedKill &&
      entry.attachCount === 0
    ) {
      writeStderrLine(
        `qwen serve: completing deferred kill of session ${JSON.stringify(entry.sessionId)} (${reason})`,
      );
      await bridgeApi.killSession(entry.sessionId).catch(() => {
        /* best-effort; channel.exited will eventually reap anyway */
      });
      return;
    }
    if (!entryIsAutoCloseCandidate(entry)) return;
    if (entry.clientIds.size > 0) return;
    await closeIfChildUnheld(entry, {
      trigger: reason,
      closeReason: 'last_client_detached',
    });
  }

  /**
   * Confirm with the child, then tear down locally — holding the in-flight flag
   * across both steps.
   *
   * The span matters. `closeSessionImpl` sets `entry.closing` synchronously, so
   * once teardown starts the ordinary close gate covers the rest; but the
   * conditional-close round trip in front of it is an await of up to
   * `ACTIVE_WORK_CLOSE_TIMEOUT_MS`. Leaving that span unmarked is what would
   * let a client attach, prompt, or rewind into a Session that has already been
   * authorized for destruction. Every admission path therefore checks this flag
   * alongside `closing`, which is what restores the atomicity a single
   * synchronous guard-then-teardown sequence used to give for free.
   */
  async function closeIfChildUnheld(
    entry: SessionEntry,
    opts: { trigger: string; closeReason: string },
  ): Promise<void> {
    entry.activeWorkCloseInFlight = true;
    try {
      if (!(await confirmChildUnheld(entry))) return;
      // Re-check identity, not just liveness. `closeSessionImpl` re-resolves
      // the target by raw id, and the id can be re-registered to a *different*
      // entry during the round trip — an explicit kill removes this one (kill
      // deliberately ignores the in-flight flag, keeping its force semantics)
      // and a `session/load` for the same persisted id registers a fresh one.
      // Without this, the stale continuation tears down the newly restored
      // Session under its just-attached client.
      if (byId.get(entry.sessionId) !== entry) return;
      // On a condemned channel we skipped the bounded hold probe above; the
      // agent close that follows must not be unbounded in its place, or we
      // trade one wait on a wedged child for a worse one. Bounding it routes a
      // hang into the unknown-outcome recovery, which kills the channel — and
      // that teardown is exactly what the drain is waiting for.
      const condemnedOwner = channelInfoForEntry(entry);
      const agentCloseTimeoutMs =
        condemnedOwner?.isQuarantined === true ||
        condemnedOwner?.restoreSettlementOverdue === true
          ? ACTIVE_WORK_CLOSE_TIMEOUT_MS
          : undefined;
      await closeSessionImpl(entry.sessionId, undefined, {
        reason: opts.closeReason,
        ...(agentCloseTimeoutMs !== undefined ? { agentCloseTimeoutMs } : {}),
      }).catch((err) => {
        writeStderrLine(
          `qwen serve: deferred close (${opts.trigger}) failed for ` +
            `${JSON.stringify(entry.sessionId)}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
      });
    } finally {
      entry.activeWorkCloseInFlight = false;
    }
  }

  /**
   * Ask the owning child to close this Session only if it holds nothing, and
   * report whether the daemon may now finish its own teardown.
   *
   * The cached hold set says what was true when the last snapshot was built,
   * which is not the same as what is true now — new work can start in the gap.
   * So the authorization to destroy comes from the child, under its close
   * gate, not from the cache. The cache's job is only to decide *when* it is
   * worth asking.
   *
   * The child's gate makes the check atomic **on the child side**: with it held
   * the Session admits no prompt and starts no automatic turn, so a hold cannot
   * appear between the child's read and its teardown. It says nothing about the
   * daemon side — the round trip below is an await, and covering that span is
   * `closeIfChildUnheld`'s job, not this function's.
   *
   * Returns false on every uncertainty: a channel that never negotiated is
   * handled by the pre-existing path, a refusal means work appeared, and a
   * timeout means we cannot tell whether the child closed. None of those are
   * retried here — the next snapshot resolves it, and a Session that is truly
   * gone will be reported with no holds in that snapshot.
   */
  async function confirmChildUnheld(entry: SessionEntry): Promise<boolean> {
    const info = channelInfoForEntry(entry);
    if (!info?.activeWork) return true;
    if (info.isDying) return false;
    // A channel the restore lifecycle has already condemned is waiting to be
    // reaped as soon as its visible work drains — that teardown is the only
    // thing that can release a non-cancellable restore we have given up on.
    // Deferring to the child here would make the drain depend on the very
    // process we have declared unreliable, and a child wedged mid-restore is
    // precisely the one that cannot answer this round trip inside
    // `ACTIVE_WORK_CLOSE_TIMEOUT_MS`. Nothing is attached to this session
    // (`maybeCloseIdleSession` gates on that), so proceed to local teardown.
    if (info.isQuarantined || info.restoreSettlementOverdue) return true;
    try {
      const response = await withTimeout(
        entry.connection.extMethod(SERVE_CONTROL_EXT_METHODS.sessionClose, {
          sessionId: entry.sessionId,
          [ACTIVE_WORK_CLOSE_IF_UNHELD_PARAM]: true,
          drainTimeoutMs: sessionCloseDrainBudgetMs(
            ACTIVE_WORK_CLOSE_TIMEOUT_MS,
          ),
        }),
        ACTIVE_WORK_CLOSE_TIMEOUT_MS,
        SERVE_CONTROL_EXT_METHODS.sessionClose,
      );
      if (response['closed'] === true) {
        // The child is done with it; only local teardown remains.
        return true;
      }
      // Refused: adopt a bounded hold set so the cache reflects the reason we
      // are backing off rather than the stale set that sent us here.
      const holds = response['holds'];
      if (
        Array.isArray(holds) &&
        holds.length <= ACTIVE_WORK_MAX_SESSION_HOLDS
      ) {
        const adopted = new Map<string, ActiveWorkHoldCategory>();
        for (const hold of holds) {
          if (typeof hold !== 'object' || hold === null) continue;
          const record = hold as Record<string, unknown>;
          const id = record['id'];
          const category = record['category'];
          if (
            typeof id === 'string' &&
            typeof category === 'string' &&
            ACTIVE_WORK_HOLD_CATEGORIES.includes(
              category as ActiveWorkHoldCategory,
            )
          ) {
            adopted.set(id, category as ActiveWorkHoldCategory);
          }
        }
        entry.childHolds = adopted;
        entry.childHoldsAt = Date.now();
      }
      return false;
    } catch (err) {
      writeStderrLine(
        `qwen serve: close-if-unheld for session ${JSON.stringify(entry.sessionId)} ` +
          `did not resolve (${err instanceof Error ? err.message : String(err)}); ` +
          `leaving it in place for the next snapshot to settle`,
      );
      return false;
    }
  }

  /** Applies a validated channel-wide snapshot to every Session it names. */
  function applyActiveWorkSnapshot(
    info: ChannelInfo,
    snapshot: ActiveWorkSnapshotV1,
  ): void {
    if (!info.activeWork || info.isDying) return;
    // Reordering guard only. A gap is not an error: each snapshot is complete,
    // so the newest one that arrives is the whole truth regardless of what was
    // lost before it.
    if (snapshot.seq <= info.activeWork.seq) return;
    info.activeWork.seq = snapshot.seq;
    const now = Date.now();
    const reported = new Map<string, Map<string, ActiveWorkHoldCategory>>();
    for (const session of snapshot.sessions) {
      const holds = new Map<string, ActiveWorkHoldCategory>();
      for (const hold of session.holds) holds.set(hold.id, hold.category);
      reported.set(session.sessionId, holds);
    }
    // Iterate what the channel owns rather than what the snapshot named: a
    // Session the child did not mention holds nothing on the child side.
    // Because reports are complete, silence about a Session this channel owns
    // is a statement about that Session, not a gap in the report — so absence
    // and reported-with-no-holds are the same fact and take the same path.
    // That is also how the daemon recovers from a close whose response never
    // made it back: the next snapshot omits the Session, the daemon asks the
    // child once more, and the child answers `closed` for a Session it no
    // longer has.
    //
    // Crucially, absence does NOT authorize local teardown by itself. It only
    // makes the Session a candidate, and every candidate still has to clear
    // the shared guards — a live SSE subscriber or a registered client keeps it
    // exactly as it keeps any other idle Session.
    for (const sessionId of Array.from(info.sessionIds)) {
      const entry = byId.get(sessionId);
      if (!entry || entry.channel !== info.channel) continue;
      const holds = reported.get(sessionId) ?? new Map();
      const previouslyHeld = entry.childHolds
        ? entry.childHolds.size > 0
        : undefined;
      entry.childHolds = holds;
      entry.childHoldsAt = now;
      // Only a change in whether the Session holds anything counts as
      // activity. Cadence reports must not keep `lastActivityAt` warm, or a
      // long-running agent would defeat every idle-based reclaim downstream.
      if (previouslyHeld !== undefined && previouslyHeld !== holds.size > 0) {
        touchActivity();
      }
      if (holds.size === 0) {
        void maybeCloseIdleSession(
          entry,
          reported.has(sessionId) ? 'child_idle' : 'child_dropped',
        );
      }
    }
  }

  /**
   * Idempotently clear a session's active-prompt bookkeeping, but only if
   * `promptId` still owns it. The ownership gate matters: after a deadline
   * releases the FIFO, the wedged agent's old `promptPromise` may settle
   * late — while the NEXT prompt is already active — and must not steal
   * that prompt's `activePromptId`/`promptActive` state. Called from the
   * prompt settle path, the echo-failure path, and the deadline path;
   * without the `promptActive` reset here a wedged agent would pin
   * `promptActive` true forever and the session reaper would skip the
   * session indefinitely.
   */
  function settleActivePromptState(entry: SessionEntry, promptId: string) {
    if (entry.activePromptId !== promptId) return;
    delete entry.activePromptId;
    delete entry.activePromptOriginatorClientId;
    if (entry.promptActive) {
      entry.promptActive = false;
      activePromptCounter--;
      entry.sessionLastSeenAt = Date.now();
      touchActivity();
    }
  }

  function resolvePositiveFiniteMs(
    raw: number | undefined,
    fallback: number,
  ): number {
    if (raw === undefined) return fallback;
    // Clamp to 2^31-1: Node.js treats setInterval delays larger than
    // this as 1ms, which would cause a tight CPU-burning loop.
    return raw > 0 && Number.isFinite(raw) ? Math.min(raw, 2_147_483_647) : 0;
  }

  function cancelIdleTimer(): void {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  }

  function channelUnavailableReject(
    channel: AcpChannel,
    context: string,
  ): Promise<never> {
    const unavailable = channel.transportFailed
      ? Promise.race([channel.exited, channel.transportFailed])
      : channel.exited;
    const reject = () => {
      throw new BridgeChannelClosedError(context);
    };
    return unavailable.then(reject, reject);
  }

  async function killChannelWithLog(
    ci: ChannelInfo,
    context?: string,
  ): Promise<void> {
    ci.isDying = true;
    ci.channelLiveness?.stop();
    await ci.channel.kill().catch((err) => {
      writeStderrLine(
        `qwen serve: channel kill failed${context ? ` (${context})` : ''}: ${String(err)}`,
      );
    });
  }

  function resolvedChannelIdleTimeoutMs(): number {
    const raw = opts.channelIdleTimeoutMs;
    return raw !== undefined && Number.isFinite(raw) && raw > 0
      ? Math.min(raw, 2_147_483_647)
      : 0;
  }

  async function startIdleTimer(
    ci: ChannelInfo,
    context?: string,
  ): Promise<void> {
    const timeoutMs = resolvedChannelIdleTimeoutMs();
    if (timeoutMs <= 0) {
      await killChannelWithLog(ci, context);
      return;
    }
    cancelIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (hasNoChannelWork(ci)) {
        writeStderrLine(
          `qwen serve: idle timeout (${timeoutMs}ms) expired, killing channel`,
        );
        void killChannelWithLog(ci, 'idle timeout');
      }
    }, timeoutMs);
    idleTimer.unref();
  }

  function hasNoChannelWork(
    ci: ChannelInfo,
    opts?: {
      ignoreCurrentSessionSpawn?: boolean;
      ignoreRestoreId?: string;
    },
  ): boolean {
    const inFlightSpawnCount =
      ci.sessionSpawnsInFlight -
      (opts?.ignoreCurrentSessionSpawn === true ? 1 : 0);
    const pendingRestoreCount =
      ci.pendingRestoreIds.size -
      (opts?.ignoreRestoreId !== undefined &&
      ci.pendingRestoreIds.has(opts.ignoreRestoreId)
        ? 1
        : 0);
    return (
      ci.sessionIds.size === 0 &&
      pendingRestoreCount === 0 &&
      ci.workspaceControlInFlight === 0 &&
      !ci.workspaceMcpDiscoveryInFlight &&
      ci.workspaceMcpAuthenticationServerNames.size === 0 &&
      inFlightSpawnCount === 0
    );
  }

  function beginWorkspaceMcpDiscovery(ci: ChannelInfo): void {
    workspaceMcpStatusCache = undefined;
    workspaceMcpToolsCache.clear();
    workspaceMcpResourcesCache.clear();
    ci.workspaceMcpDiscoveryInFlight = true;
    if (ci.workspaceMcpDiscoveryTimer) {
      clearTimeout(ci.workspaceMcpDiscoveryTimer);
    }
    ci.workspaceMcpDiscoveryTimer = setTimeout(() => {
      ci.workspaceMcpDiscoveryTimer = undefined;
      ci.workspaceMcpDiscoveryInFlight = false;
      ci.workspaceMcpDiscoveryRequested = false;
      if (hasNoChannelWork(ci)) {
        void startIdleTimer(ci, 'workspace MCP discovery timeout');
      }
    }, MCP_RESTART_TIMEOUT_MS);
    ci.workspaceMcpDiscoveryTimer.unref();
  }

  function finishWorkspaceMcpDiscovery(ci: ChannelInfo): void {
    ci.workspaceMcpDiscoveryInFlight = false;
    if (ci.workspaceMcpDiscoveryTimer) {
      clearTimeout(ci.workspaceMcpDiscoveryTimer);
      ci.workspaceMcpDiscoveryTimer = undefined;
    }
  }

  function invalidateWorkspaceMcpDetailCache(serverName: string): void {
    workspaceMcpToolsCache.delete(serverName);
    workspaceMcpResourcesCache.delete(serverName);
  }

  /**
   * Whether this channel should be torn down once its visible work drains,
   * rather than handed back to the idle-channel policy. Derived, not sticky:
   * a channel is condemned only while a reason still holds.
   */
  function channelShouldReapWhenIdle(ci: ChannelInfo): boolean {
    return (
      ci.emptyReapPending ||
      ci.unsettledAbandonedRestores.size > 0 ||
      ci.isQuarantined
    );
  }

  /**
   * A restore that blew its public deadline is left running because the ACP
   * request cannot be cancelled — but "cannot cancel" must not mean "wait
   * forever". One further budget after abandonment, a still-unsettled restore
   * closes the channel to NEW session work: it is holding an admission slot,
   * an in-flight entry, and a session-id fence that nothing else can release.
   * Existing sessions keep running, and once they drain the channel is reaped,
   * which closes the transport and finally releases the hung request. We
   * deliberately do NOT force-kill a channel that still has live siblings —
   * that is the failure this whole change exists to remove.
   */
  function armRestoreSettlementGrace(
    ci: ChannelInfo,
    sessionId: string,
    action: 'load' | 'resume',
  ): void {
    if (ci.restoreSettlementTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      ci.restoreSettlementTimers.delete(sessionId);
      if (!ci.unsettledAbandonedRestores.has(sessionId)) return;
      if (ci.isDying || !aliveChannels.has(ci)) return;
      ci.restoreSettlementOverdue = true;
      writeStderrLine(
        `qwen serve: abandoned session/${action} for ${JSON.stringify(sessionId)} has not settled ` +
          `${restoreSettlementGraceMs}ms after its deadline; refusing fresh sessions on channel ${ci.id} until it drains`,
      );
      telemetry.event('session.restore.settlement_overdue', {
        'qwen-code.daemon.session_restore.action': action,
        'qwen-code.daemon.session_restore.timeout_ms': sessionRestoreTimeoutMs,
        'qwen-code.daemon.session_restore.settlement_grace_ms':
          restoreSettlementGraceMs,
        'qwen-code.daemon.acp_channel.id': ci.id,
        'session.id': sessionId,
      });
      void reapPendingEmptyChannel(ci);
    }, restoreSettlementGraceMs);
    timer.unref();
    ci.restoreSettlementTimers.set(sessionId, timer);
  }

  async function reapPendingEmptyChannel(ci: ChannelInfo): Promise<void> {
    if (!channelShouldReapWhenIdle(ci) || !hasNoChannelWork(ci)) return;
    ci.emptyReapPending = false;
    ci.isDying = true;
    ci.channelLiveness?.stop();
    await ci.channel.kill().catch(() => {
      /* best-effort — channel.exited handler still runs */
    });
  }

  async function withWorkspaceControl<T>(
    ci: ChannelInfo,
    fn: () => Promise<T>,
  ): Promise<T> {
    ci.workspaceControlInFlight++;
    try {
      return await fn();
    } finally {
      ci.workspaceControlInFlight = Math.max(
        0,
        ci.workspaceControlInFlight - 1,
      );
      await reapPendingEmptyChannel(ci);
    }
  }

  function startSessionReaper(): void {
    if (sessionReapIntervalMs <= 0) return;
    writeStderrLine(
      `qwen serve: session reaper started ` +
        `(interval ${sessionReapIntervalMs}ms, ` +
        `idle threshold ${sessionIdleTimeoutMs}ms)`,
    );
    sessionReaper = setInterval(() => {
      if (shuttingDown) return;
      const now = Date.now();
      for (const [id, entry] of byId) {
        if (sessionIdleTimeoutMs <= 0) break;
        // Shared guards first (`pendingPromptCount` rather than `promptActive`,
        // so queued prompts and the FIFO hand-off gap between two prompts also
        // block the reap), then the reaper's own TTL policy on top.
        if (!entryIsAutoCloseCandidate(entry)) continue;
        // Note: clientIds.size is NOT checked here. Close-on-last-detach
        // handles the normal path (client sends detach → immediate close).
        // The reaper covers the crash path where detach was never sent —
        // clientIds still > 0 but no SSE subscriber and no heartbeat for
        // the configured TTL.
        const lastActive =
          entry.sessionLastSeenAt ?? Date.parse(entry.createdAt);
        const idle = now - lastActive;
        if (idle < sessionIdleTimeoutMs) continue;
        writeStderrLine(
          `qwen serve: reaping idle session ${JSON.stringify(id)} ` +
            `(idle for ${Math.round(idle / 1000)}s, ` +
            `threshold ${Math.round(sessionIdleTimeoutMs / 1000)}s)`,
        );
        // The TTL says the *client* stopped caring, which is not the same as
        // the child having nothing left to run. Ask before destroying, on the
        // same terms as every other automatic path: an idle-looking cache is
        // never enough on its own.
        void closeIfChildUnheld(entry, {
          trigger: 'idle_timeout',
          closeReason: 'idle_timeout',
        });
      }
    }, sessionReapIntervalMs);
    sessionReaper.unref();
  }

  function stopSessionReaper(): void {
    if (sessionReaper !== undefined) {
      clearInterval(sessionReaper);
      sessionReaper = undefined;
    }
  }

  // BkUyD: superset of `channelInfo` covering channels
  // that are dying but not yet OS-reaped. `killSession` /
  // `doSpawn`-newSession-failure / `shutdown` mark a channel as
  // `isDying` and start its async kill; meanwhile a concurrent
  // `spawnOrAttach` can spawn a FRESH channel and reassign
  // `channelInfo`. Without this set, the dying channel becomes
  // unreachable — a double-Ctrl+C arriving mid-grace would call
  // `killAllSync()`, find only the fresh channel in `channelInfo`,
  // force-kill it, and `process.exit(1)` would orphan the dying one
  // whose SIGTERM hadn't yet completed. The set is the OS-level
  // "still alive" source of truth: entries are added when a channel
  // is created and removed when its `channel.exited` resolves.
  // `killAllSync` iterates THIS set to fire SIGKILL on every alive
  // child regardless of whether it's still the attach target.
  const aliveChannels = new Set<ChannelInfo>();
  // Coalesces a concurrent second `ensureChannel()` call onto the
  // first one's spawn so we never create two children for the same
  // daemon. Cleared in the `finally` of the creator.
  let inFlightChannelSpawn: Promise<ChannelInfo> | undefined;
  const byId = new Map<string, SessionEntry>();
  const forwardRunningPromptCancel = async (
    entry: SessionEntry,
    pending: PendingPromptEntry,
    notification: CancelNotification,
  ): Promise<void> => {
    if (pending.cancelForwardInitial) {
      return pending.cancelForwardInitial;
    }
    const initial = (async () => {
      try {
        const extension = entry.connection
          .extMethod(PROMPT_CANCEL_METHOD, notification)
          .then((result) => ({ kind: 'result' as const, result }));
        const outcome = await Promise.race([
          extension,
          getTransportClosedReject(entry),
          ...(pending.cancelForwardDeadline
            ? [
                pending.cancelForwardDeadline.then(() => ({
                  kind: 'deadline' as const,
                })),
              ]
            : []),
        ]);
        if (outcome.kind === 'deadline') return;
        const { result } = outcome;
        if (typeof result['cancelled'] !== 'boolean') {
          throw new Error(
            `${PROMPT_CANCEL_METHOD} returned an invalid acknowledgement`,
          );
        }
      } catch (error) {
        if (
          (typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === -32601) ||
          isNotCurrentlyGeneratingCancelError(error)
        ) {
          await Promise.race([
            entry.connection.cancel(notification),
            getTransportClosedReject(entry),
            ...(pending.cancelForwardDeadline
              ? [pending.cancelForwardDeadline]
              : []),
          ]);
          return;
        }
        throw error;
      }
    })().catch((error) => {
      if (pending.cancelForwardInitial === initial) {
        delete pending.cancelForwardInitial;
      }
      throw error;
    });
    pending.cancelForwardInitial = initial;
    // The same-revision extension resolves only after cancellation is handled
    // (or the target prompt has already settled). ACP-compatible custom agents
    // that do not implement it receive one standard session/cancel notification.
    // The FIFO tail awaits this promise so no extension request remains in flight
    // when prompt ownership advances, except when the prompt deadline invokes the
    // documented DAEMON-003 overlap policy.
    pending.cancelForwardDrain = initial;
    void initial.catch(() => {});
    return initial;
  };
  const generationRequests = new Map<
    string,
    {
      sessionId: string;
      connection: ClientSideConnection;
      queue: GenerationStreamQueue<BridgeGenerationStreamEvent>;
      settled: boolean;
    }
  >();
  const workspaceGenerationRequests = new Map<
    string,
    {
      connection?: ClientSideConnection;
      queue: GenerationStreamQueue<BridgeWorkspaceGenerationStreamEvent>;
      settled: boolean;
    }
  >();
  const inFlightExtensionRefreshes = new Map<
    string,
    {
      connection: ClientSideConnection;
      promise: Promise<void>;
      wait: Promise<void>;
      rejectUnavailable: () => void;
      refreshBootstrap: boolean;
    }
  >();
  const clearInFlightExtensionRefreshes = (
    connection: ClientSideConnection,
  ) => {
    for (const [sessionId, refresh] of inFlightExtensionRefreshes) {
      if (refresh.connection === connection) {
        refresh.rejectUnavailable();
        inFlightExtensionRefreshes.delete(sessionId);
      }
    }
  };
  const toSessionSummary = (entry: SessionEntry): BridgeSessionSummary => {
    let isWaitingForPermission = false;
    let isWaitingForUserQuestion = false;
    for (const interaction of entry.pendingInteractions.values()) {
      if (interaction.kind === 'user_question') {
        isWaitingForUserQuestion = true;
      } else {
        isWaitingForPermission = true;
      }
    }
    return {
      sessionId: entry.sessionId,
      workspaceCwd: entry.workspaceCwd,
      createdAt: entry.createdAt,
      ...(entry.lastTurnEndedAtMs !== undefined
        ? { updatedAt: new Date(entry.lastTurnEndedAtMs).toISOString() }
        : {}),
      displayName: entry.displayName,
      ...(entry.parentSessionId
        ? { parentSessionId: entry.parentSessionId }
        : {}),
      ...(entry.sourceType ? { sourceType: entry.sourceType } : {}),
      ...(entry.sourceId !== undefined ? { sourceId: entry.sourceId } : {}),
      clientCount: entry.clientIds.size,
      hasActivePrompt: entry.promptActive || entry.goalTurnActive === true,
      isWaitingForPermission,
      isWaitingForUserQuestion,
      pendingInteractionCount: entry.pendingInteractions.size,
      hasTurnError: entry.turnError !== undefined,
      ...(entry.turnError !== undefined ? { turnError: entry.turnError } : {}),
      pendingInteractions: [...entry.pendingInteractions.values()],
      ...(entry.worktree ? { worktree: entry.worktree } : {}),
      ...(entry.branch ? { branch: entry.branch } : {}),
      ...(entry.prs && entry.prs.length > 0 ? { prs: entry.prs } : {}),
    };
  };
  // Pending + resolved permission state lives in
  // `MultiClientPermissionMediator` (constructed below). The bridge
  // keeps `entry.pendingPermissionIds: Set<string>` on each
  // SessionEntry as a fast cap-check index; the mediator is the
  // single source of truth for the actual pending registry and the
  // duplicate-vote LRU.

  // Validate the optional consensus quorum override defensively at
  // construction. The settings layer is the primary enforcement
  // point, but the bridge also rejects malformed values here so a
  // buggy host wiring path can't NaN-poison the mediator.
  const permissionConsensusQuorum = opts.permissionConsensusQuorum;
  if (
    permissionConsensusQuorum !== undefined &&
    (!Number.isInteger(permissionConsensusQuorum) ||
      permissionConsensusQuorum < 1)
  ) {
    throw new Error(
      `BridgeOptions.permissionConsensusQuorum must be a positive integer; ` +
        `got ${String(permissionConsensusQuorum)}`,
    );
  }

  // Build the mediator before the BridgeClient so the agent's
  // `requestPermission` callback can hand the record straight in.
  // Audit publisher fallback: when the host doesn't supply one
  // (cli/serve/run-qwen-serve.ts wraps a real `PermissionAuditRing`
  // backed publisher in production), we use the canonical no-op
  // fallback so the mediator can still run for embedded callers /
  // tests without an audit consumer.
  const permissionAudit: PermissionAuditPublisher =
    opts.permissionAudit ?? createNoOpPermissionAuditPublisher();
  const permissionMediator = new MultiClientPermissionMediator(
    opts.permissionPolicy ?? 'first-responder',
    {
      emit: (sessionId, event) => {
        const sessionEntry = byId.get(sessionId);
        sessionEntry?.events.publish(event);
      },
      audit: permissionAudit,
      ...(permissionConsensusQuorum !== undefined
        ? { consensusQuorum: permissionConsensusQuorum }
        : {}),
      now: () => Date.now(),
      votersForSession: (sessionId) => {
        const sessionEntry = byId.get(sessionId);
        if (!sessionEntry) return new Set<string>();
        return new Set(sessionEntry.clientIds.keys());
      },
    },
  );
  // Set by `shutdown()` so any in-flight `spawnOrAttach` that was
  // dispatched on an existing connection AFTER the shutdown snapshot
  // taken in `shutdown()` fails fast instead of creating a child the
  // shutdown path has no more visibility into. Without this, the
  // server.listen → bridge.shutdown ordering in `runQwenServe` leaves
  // a window between (a) shutdown snapshotting `byId` for kills and
  // (b) `server.close` rejecting new connections, during which a
  // late-arriving `POST /session` slips a fresh child past cleanup.
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  // Tee writeServeDebugLine through the optional onDiagnosticLine callback.
  // The module-level writeServeDebugLine is left intact for other entry points;
  // inside createHttpAcpBridge we use this wrapper exclusively.
  const teeServeDebugLine = (message: string): void => {
    writeServeDebugLine(message);
    if (opts.onDiagnosticLine && isServeDebugLoggingEnabled()) {
      opts.onDiagnosticLine(`qwen serve debug: ${message}`, 'info');
    }
  };

  // Coalesces concurrent `spawnOrAttach` calls under single-scope and
  // tracks in-progress thread-scope spawns for shutdown to await.
  // Single-scope uses the workspaceKey as the dedup key (at most one
  // entry; concurrent callers pass the `defaultEntry` check together
  // and coalesce here). Thread-scope uses `workspaceKey#uuid` so
  // simultaneous calls don't collide while still being awaitable from
  // `shutdown()`.
  const inFlightSpawns = new Map<string, Promise<BridgeSession>>();
  // Reserves caller-supplied ids before `doSpawn` reaches its first await.
  // Restore admission checks the same set, closing the opposite race from
  // `inFlightRestores`: whichever operation reserves the id first owns its
  // registration window.
  const inFlightRequestedSessionSpawns = new Map<string, symbol>();

  interface InFlightRestore {
    action: 'load' | 'resume';
    historyReplay: 'stream' | 'response';
    historyPageSize?: number;
    liveReplayMode: 'full' | 'summary';
    hideInheritedHistory: boolean;
    publicPromise: Promise<BridgeRestoredSession>;
    settlementPromise: Promise<void>;
    lifecycle: { phase: 'active' | 'abandoned' };
    /**
     * Synchronous reservation slot for callers that coalesce onto this
     * restore. Coalescers do `count++` BEFORE awaiting `promise` so the
     * spawn-owner's disconnect-reaper (`killSession({ requireZeroAttaches:
     * true })`) sees a non-zero `attachCount` on the freshly registered
     * entry and skips the kill. The IIFE folds this counter into
     * `entry.attachCount` when it calls `createSessionEntry`. BQ9tV
     * race-guard equivalent for coalesced restore waiters.
     */
    coalesceState: { count: number };
  }

  // Coalesces concurrent explicit restore calls for the same session id.
  // `session/load` replays history through SSE and `session/resume` restores
  // context; running either twice for the same id at the same time can
  // duplicate history frames or race two entries into `byId`.
  const inFlightRestores = new Map<string, InFlightRestore>();
  // `session/load` emits history replay as session_update notifications before
  // the ACP request returns. Keep a temporary bus so those replay frames land in
  // the ring, then promote the same bus into the registered SessionEntry.
  const pendingRestoreEvents = new Map<string, EventBus>();

  // Current journal byte caps of this bridge's live sessions, including
  // in-flight restores whose buses are not registered in byId yet, each
  // with this bridge's baseline cap. Shared with sibling bridges through
  // the daemon-wide aggregator so ONE pool covers every workspace;
  // without it the advisor accounts this bridge's sessions only.
  const journalSessionLimits = (): JournalGrowthSessionLimit[] => {
    const limits = [...byId.values()].map((entry) => ({
      limitBytes: entry.events.journalLimitBytes() ?? maxJournalBytes,
      baselineBytes: maxJournalBytes,
    }));
    for (const [restoreId, bus] of pendingRestoreEvents) {
      if (!byId.has(restoreId)) {
        limits.push({
          limitBytes: bus.journalLimitBytes() ?? maxJournalBytes,
          baselineBytes: maxJournalBytes,
        });
      }
    }
    return limits;
  };
  const unregisterJournalGrowthSessionLimits =
    journalGrowthPolicy !== undefined &&
    opts.registerJournalGrowthSessionLimits !== undefined
      ? opts.registerJournalGrowthSessionLimits(journalSessionLimits)
      : undefined;

  const createClientId = (): string => `client_${randomUUID()}`;

  const registerClient = (
    entry: SessionEntry,
    requestedClientId?: string,
  ): string => {
    if (requestedClientId && entry.clientIds.has(requestedClientId)) {
      entry.clientIds.set(
        requestedClientId,
        (entry.clientIds.get(requestedClientId) ?? 0) + 1,
      );
      return requestedClientId;
    }
    const clientId = createClientId();
    entry.clientIds.set(clientId, 1);
    return clientId;
  };

  const unregisterClient = (entry: SessionEntry, clientId?: string): void => {
    if (clientId === undefined) return;
    const count = entry.clientIds.get(clientId);
    if (count === undefined) return;
    if (count <= 1) {
      entry.clientIds.delete(clientId);
      // Drop the last-seen entry alongside the registration ref.
      // Otherwise a long-lived daemon servicing a churn of disconnect/
      // reconnect clients (each picking a fresh `clientId`) would
      // accumulate stale heartbeat timestamps for clients that no
      // longer exist — the very leak revocation policy is meant to
      // plug.
      entry.clientLastSeenAt.delete(clientId);
    } else {
      entry.clientIds.set(clientId, count - 1);
    }
  };

  // Record one attach-ref for `clientId` in the entry's ledger. Call
  // only at sites where the registered clientId corresponds to an
  // `attachCount` contribution (a direct `++` or a pre-folded coalesce
  // reservation) — never for owner-style registrations.
  const recordAttachRef = (entry: SessionEntry, clientId: string): void => {
    entry.attachRefs.set(clientId, (entry.attachRefs.get(clientId) ?? 0) + 1);
  };

  // Release one attach-ref for `clientId`. Returns true only when a
  // ledger ref was actually released; callers must gate every
  // `attachCount` decrement on that result so duplicate, unknown or
  // owner-clientId detaches cannot steal another attacher's count.
  const releaseAttachRef = (entry: SessionEntry, clientId: string): boolean => {
    const refs = entry.attachRefs.get(clientId);
    if (refs === undefined || refs <= 0) return false;
    if (refs === 1) {
      entry.attachRefs.delete(clientId);
    } else {
      entry.attachRefs.set(clientId, refs - 1);
    }
    return true;
  };

  const rollbackAttachRegistration = async (
    entry: SessionEntry,
    clientId: string,
    attachCountDelta = 1,
  ): Promise<void> => {
    // The initiator's own contribution is only rolled back if it was
    // actually recorded in the attach ledger; the remaining
    // `attachCountDelta - 1` covers coalesce reservations that never
    // registered a clientId (their promise rejects), so they carry no
    // ledger entry to release.
    const released = releaseAttachRef(entry, clientId) ? 1 : 0;
    entry.attachCount = Math.max(
      0,
      entry.attachCount - (released + (attachCountDelta - 1)),
    );
    unregisterClient(entry, clientId);
    await maybeCloseIdleSession(entry, 'attach_rollback');
  };

  const resolveTrustedClientId = (
    entry: SessionEntry,
    clientId?: string,
  ): string | undefined => {
    if (clientId === undefined) return undefined;
    if (!entry.clientIds.has(clientId)) {
      throw new InvalidClientIdError(entry.sessionId, clientId);
    }
    return clientId;
  };

  /**
   * Get-or-create the daemon's single `qwen --acp` channel. N sessions
   * multiplex onto it via `connection.newSession()`. Concurrent callers
   * coalesce through `inFlightChannelSpawn` so we never spawn two
   * children. Wires up the one-and-only `channel.exited` cleanup on
   * first creation so the late-arriving event tears down ALL
   * multiplexed sessions.
   */
  async function ensureChannel(): Promise<ChannelInfo> {
    // Skip a channel that's marked dying — its underlying transport is
    // mid-SIGTERM-or-already-dead and `connection.newSession()` on it
    // would either hang or land the caller with a sessionId that
    // immediately 404s on every follow-up.
    cancelIdleTimer();
    if (channelInfo && !channelInfo.isDying) return channelInfo;
    if (inFlightChannelSpawn) return await inFlightChannelSpawn;

    const promise = (async () => {
      const privateParentCapability = randomBytes(32).toString('base64url');
      const acpChannelId = randomUUID();
      const channel = await telemetry.withSpan(
        'channel.spawn',
        {
          'qwen-code.daemon.bridge.operation': 'channel.spawn',
          'qwen-code.daemon.channel.reused': false,
          'qwen-code.daemon.acp_channel.id': acpChannelId,
        },
        async () =>
          await channelFactory(boundWorkspace, {
            ...childEnvOverrides,
            [PRIVATE_ACP_CAPABILITY_ENV]: privateParentCapability,
          }),
      );
      const sessionIds = new Set<string>();
      const infoRef: { current?: ChannelInfo } = {};
      let client: BridgeClient;
      let connection: ClientSideConnection;
      try {
        client = new BridgeClient(
          // BfFut: ACP today carries a sessionId on every per-session
          // notification / request, so the no-sessionId branch is
          // technically unreachable. But the channel is multi-session
          // (Stage 1.5 multiplex), so if ACP ever grows a no-sessionId
          // call we'd silently drop it on a multi-session channel
          // instead of throwing. Surface that ambiguity loudly.
          (sessionId) => {
            if (sessionId) return byId.get(sessionId);
            if (channelInfo && channelInfo.sessionIds.size > 1) {
              throw new Error(
                'BridgeClient: ACP call without sessionId on a ' +
                  'multi-session channel cannot be routed — workspace=' +
                  boundWorkspace,
              );
            }
            return undefined;
          },
          (sessionId) =>
            sessionId ? pendingRestoreEvents.get(sessionId) : undefined,
          permissionMediator,
          permissionTimeoutMs,
          maxPendingPerSession,
          // Forward the optional `BridgeFileSystem` injection so
          // production `qwen serve` can wire the `WorkspaceFileSystem`
          // adapter into BridgeClient's fs proxy methods. Tests + Mode A
          // consumers + channels / IDE companion omit it; BridgeClient
          // falls back to its inline fs proxy.
          opts.fileSystem,
          // §2.3: centralised model_switched publish — keeps cache + generation
          // update atomic. BridgeClient calls this instead of inlining publish.
          (entry, modelId, originator) =>
            publishModelSwitched(entry as SessionEntry, modelId, originator),
          // A2: centralised approval_mode_changed publish on in-session mode
          // promotion. `previous` is read from the bridge state cache.
          (entry, modeId, originator) => {
            const se = entry as SessionEntry;
            publishApprovalModeChanged(
              se,
              {
                previous: se.currentApprovalMode ?? 'default',
                next: modeId,
                persisted: false,
              },
              originator,
            );
          },
          // Reverse tool channel (issue #5626, Phase 2): forward the optional
          // client-hosted-MCP sender lookup so `BridgeClient.extMethod` can
          // answer `qwen/control/client_mcp/message` from the child by reaching
          // the per-WS-connection `ClientMcpRegistrar`. Omitted callers (tests,
          // Mode A) never host a client MCP server, so the method stays
          // unreachable.
          opts.clientMcpSender,
          (sessionId) => sessionIds.has(sessionId),
          // Daemon token-burn accounting: forward per-round token usage observed
          // at the session/update fan-in to the daemon host's metrics ring via
          // the telemetry seam. Optional-chained so non-daemon callers (tests,
          // Mode A) that wire no `tokenUsage` metric are a silent no-op.
          (inputTokens, outputTokens, durationMs, apiErrors, apiRetries) =>
            telemetry.metrics?.tokenUsage?.(
              inputTokens,
              outputTokens,
              durationMs,
              apiErrors,
              apiRetries,
            ),
          // `create_sub_session` tool: forward the request/response hook so a child
          // tool can ask the daemon to spawn a sub-session and (for 'first-turn')
          // return its result. Omitted → the method reports daemon-only.
          opts.onCreateSubSession,
          (sessionId, event) => {
            const request = generationRequests.get(event.requestId);
            if (!request || request.sessionId !== sessionId) return;
            if (request.queue.push(event)) return;
            request.settled = true;
            generationRequests.delete(event.requestId);
            request.queue.fail(
              new Error('Generation stream consumer too slow'),
            );
            void request.connection
              .extMethod(SERVE_CONTROL_EXT_METHODS.sessionGenerationCancel, {
                sessionId,
                requestId: event.requestId,
              })
              .catch(() => undefined);
          },
          (event) => {
            const request = workspaceGenerationRequests.get(event.requestId);
            if (!request) return;
            if (request.queue.push(event)) return;
            request.settled = true;
            workspaceGenerationRequests.delete(event.requestId);
            request.queue.fail(
              new Error('Generation stream consumer too slow'),
            );
            void request.connection
              ?.extMethod(SERVE_CONTROL_EXT_METHODS.workspaceGenerationCancel, {
                requestId: event.requestId,
              })
              .catch(() => undefined);
          },
          opts.onChannelDelivery,
          () =>
            channelInfo?.sessionIds === sessionIds &&
            channelInfo.sessionSpawnsInFlight > 0,
          () => liveScreenContextCaptureHandler,
          () => liveTaskToolRequestHandler,
          () => liveSpeakToUserHandler,
          opts.externalToolGuard,
          (snapshot) => {
            const currentInfo = infoRef.current;
            if (!currentInfo) return;
            applyActiveWorkSnapshot(currentInfo, snapshot);
          },
          // Child-side automatic title updates change persisted catalog
          // metadata the bridge never sees; forward the catalog-clock mark.
          markSessionCatalogChanged,
          // A Goal turn drains the mid-turn queue but owns no prompt slot, so
          // nothing else would settle what its last drain missed.
          settleMidTurnQueueAfterGoalTurn,
        );
        const rawConnection = new ClientSideConnection(
          () =>
            channel.transportGuard
              ? createLogSafeAcpClient(client, channel.transportGuard)
              : client,
          channel.stream,
        );
        connection = channel.transportGuard
          ? createOutboundGuardedConnection(
              rawConnection,
              channel.transportGuard,
            )
          : rawConnection;
      } catch (error) {
        try {
          channel.killSync();
        } catch {
          // The asynchronous teardown below remains authoritative.
        }
        try {
          // Raw exit is successful teardown after the forced signal; kill()
          // supplies the bounded failure path when exit is never observed.
          await Promise.race([
            channel.exited.then(() => undefined),
            channel.kill(),
          ]);
        } catch (teardownError) {
          throw new AggregateError(
            [error, teardownError],
            'ACP channel construction and teardown failed',
          );
        }
        throw error;
      }

      // Add to `aliveChannels` + register the `channel.exited` handler
      // BEFORE the `initialize` handshake: the agent child exists from
      // the moment `channelFactory(boundWorkspace)` returns, so a
      // `killAllSync()` during the handshake window (up to
      // `initTimeoutMs`, default 10s) must find it to avoid orphaning
      // on `process.exit(1)`. Init-failure / child-crash / late-shutdown
      // all converge on the same cleanup path via the handler below.
      // `channelInfo` (the attach target) is assigned only AFTER
      // initialize succeeds so callers don't attach to a still-
      // handshaking channel.
      const info: ChannelInfo = {
        id: acpChannelId,
        channel,
        connection,
        client,
        sessionIds,
        pendingRestoreIds: new Set(),
        sessionSpawnsInFlight: 0,
        workspaceControlInFlight: 0,
        workspaceMcpDiscoveryInFlight: false,
        workspaceMcpDiscoveryRequested: false,
        workspaceMcpAuthenticationServerNames: new Set(),
        workspaceMcpAuthenticationTimers: new Map(),
        emptyReapPending: false,
        unsettledAbandonedRestores: new Set(),
        restoreSettlementOverdue: false,
        restoreSettlementTimers: new Map(),
        transportFailed: false,
        transportFailureInitiatedTeardown: false,
        isDying: false,
        isQuarantined: false,
        handshakeComplete: false,
      };
      infoRef.current = info;
      const markTransportFailed = (error: unknown) => {
        if (!info.isDying) {
          info.transportFailureInitiatedTeardown = true;
        }
        info.transportFailed = true;
        info.transportFailureCode = safeTransportFailureCode(error);
        info.isDying = true;
        info.channelLiveness?.stop();
        clearInFlightExtensionRefreshes(info.connection);
      };
      void channel.transportFailed?.then(
        markTransportFailed,
        markTransportFailed,
      );
      aliveChannels.add(info);
      // Belt-and-suspenders leak detection. The set is intentionally
      // multi-entry to cover the `killSession`-then-`spawnOrAttach`
      // overlap window (size 2 is legitimate: one dying + one fresh
      // attach-target). Anything higher implies a `channel.exited`
      // handler never fired for some prior channel — a real leak we'd
      // otherwise notice only as gradually-growing RSS over hours.
      // The warning surfaces it the moment it happens. Threshold is
      // 2 because that's the design ceiling; bumping it requires
      // updating both this guard and the comments around
      // `aliveChannels` declaration.
      if (aliveChannels.size > 2) {
        writeStderrLine(
          `qwen serve: WARNING aliveChannels.size=${aliveChannels.size} ` +
            `(expected 1, max 2 during killSession-then-spawnOrAttach ` +
            `overlap) — possible channel leak; check that prior channels' ` +
            `channel.exited fired and the handler ran cleanup.`,
        );
      }

      // One-time channel.exited cleanup. The child dying takes ALL
      // multiplexed sessions with it — iterate `sessionIds` (snapshot
      // first to be safe against concurrent killSession during
      // iteration), publish `session_died` on each session's bus,
      // remove from byId / defaultEntry / pending tables.
      //
      // Registered BEFORE the `initialize` await so init-failure /
      // child-crash / late-shutdown all converge here. During
      // handshake `sessionIds` is empty — the loop below no-ops,
      // the stderr line still fires, and `aliveChannels.delete(info)`
      // clears the entry through the normal exit path.
      //
      // BkUyD: drop from `aliveChannels` ONLY when the OS process is
      // actually gone. Async kill paths mark `isDying = true` but
      // leave the entry in `aliveChannels` until this handler fires,
      // so `killAllSync` still has a reference to fire SIGKILL during
      // the SIGTERM grace window — even if a concurrent `spawnOrAttach`
      // has already reassigned `channelInfo` to a fresh channel.
      void channel.exited.then((exitInfo) => {
        info.channelLiveness?.stop();
        clearInFlightExtensionRefreshes(info.connection);
        if (channelInfo === info) cancelIdleTimer();
        if (info.workspaceMcpDiscoveryTimer) {
          clearTimeout(info.workspaceMcpDiscoveryTimer);
          info.workspaceMcpDiscoveryTimer = undefined;
        }
        for (const timer of info.workspaceMcpAuthenticationTimers.values()) {
          clearTimeout(timer);
        }
        info.workspaceMcpAuthenticationTimers.clear();
        info.workspaceMcpAuthenticationServerNames.clear();
        for (const timer of info.restoreSettlementTimers.values()) {
          clearTimeout(timer);
        }
        info.restoreSettlementTimers.clear();
        aliveChannels.delete(info);
        if (channelInfo === info) channelInfo = undefined;
        const sessions = Array.from(info.sessionIds);
        info.sessionIds.clear();
        // Operator breadcrumb for UNEXPECTED channel exits. Without
        // this an agent crash (OOM / segfault) is invisible from the
        // daemon log: each affected SSE subscriber sees a
        // `session_died` frame and disconnects, the daemon's
        // child-stderr forwarder emits whatever the child wrote before
        // dying (often nothing on a SIGKILL / segfault), and operators
        // can't tell from `qwen serve`'s own output that the agent
        // process is gone.
        //
        // Suppressed during `shuttingDown` because the operator
        // already saw "received SIGINT, draining..." from
        // `runQwenServe`'s signal handler. The standalone
        // killSession case (last session leaves, channel torn down
        // but daemon stays up) still logs — there's no upstream
        // context line in that flow, and the message confirms the
        // cleanup actually ran.
        const channelExitExpected =
          shuttingDown ||
          (info.isDying && !info.transportFailureInitiatedTeardown);
        if (info.handshakeComplete) {
          telemetry.metrics?.channelLifecycle('exit', channelExitExpected);
        }
        if (!shuttingDown) {
          telemetry.event('channel.exited', {
            'qwen-code.daemon.channel.exit_code': exitInfo?.exitCode ?? -1,
            'qwen-code.daemon.channel.session_count': sessions.length,
            'qwen-code.daemon.channel.transport_failed': info.transportFailed,
            'qwen-code.daemon.channel.transport_failure_initiated_teardown':
              info.transportFailureInitiatedTeardown,
            ...(info.transportFailureCode
              ? {
                  'qwen-code.daemon.channel.transport_error_code':
                    info.transportFailureCode,
                }
              : {}),
            ...(exitInfo?.signalCode
              ? { 'qwen-code.daemon.channel.signal': exitInfo.signalCode }
              : {}),
          });
          writeStderrLine(
            `qwen serve: channel exited (code=${exitInfo?.exitCode ?? 'none'}, signal=${exitInfo?.signalCode ?? 'none'}, transport=${info.transportFailed ? (info.transportFailureCode ?? 'failed') : 'ok'}, ${sessions.length} session(s) torn down)`,
          );
        }
        for (const sid of sessions) {
          const sessEntry = byId.get(sid);
          if (!sessEntry) continue;
          cancelPendingForSession(sid);
          // DAEMON-002/005: every still-pending prompt owes its formal
          // terminal before the bus closes below.
          flushPromptTerminals(
            sessEntry,
            'channel_closed',
            'agent channel exited before the prompt completed',
          );
          try {
            sessEntry.events.publish({
              type: 'session_died',
              data: {
                sessionId: sid,
                reason: 'channel_closed',
                // BX9_P: thread exitCode/signalCode through.
                exitCode: exitInfo?.exitCode ?? null,
                signalCode: exitInfo?.signalCode ?? null,
              },
            });
          } catch {
            /* bus already closed */
          }
          if (sessEntry.promptActive) {
            sessEntry.promptActive = false;
            activePromptCounter--;
            touchActivity();
          }
          byId.delete(sid);
          void sessEntry.attachments.close().catch((error) => {
            writeStderrLine(
              `qwen serve: failed to close attachments for closed channel session ${JSON.stringify(sid)}: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
          telemetry.metrics?.sessionLifecycle('die');
          emitSessionLifecycle({
            type: 'removed',
            sessionId: sid,
            workspaceCwd: sessEntry.workspaceCwd,
            reason: 'channel_closed',
          });
          // Tombstone the id so any late `extNotification` from the
          // dying child can't leak into the early-event buffer for a
          // future load/resume of the same persisted session id.
          info.client.markSessionClosed(sid);
          if (defaultEntry === sessEntry) defaultEntry = undefined;
          sessEntry.events.close();
        }
      });

      // Initialize handshake. The channel is already in
      // `aliveChannels` and the `channel.exited` handler above is
      // registered, so failure paths (init throw, timeout, late
      // shutdown) only need to mark dying + kill — the handler does
      // the alive-set cleanup when the OS reaps the child.
      let channelLivenessNegotiated = false;
      try {
        await telemetry.withSpan(
          'channel.initialize',
          {
            'qwen-code.daemon.bridge.operation': 'channel.initialize',
            'qwen-code.daemon.acp_channel.id': acpChannelId,
          },
          async () => {
            const response = await withTimeout(
              Promise.race([
                connection.initialize({
                  protocolVersion: PROTOCOL_VERSION,
                  _meta: {
                    [ACTIVE_WORK_HEARTBEAT_META_KEY]: {
                      v: ACTIVE_WORK_HEARTBEAT_VERSION,
                      intervalMs: ACTIVE_WORK_HEARTBEAT_INTERVAL_MS,
                      categories: [...ACTIVE_WORK_HOLD_CATEGORIES],
                    },
                    [CHANNEL_STARTUP_PROFILE_META_KEY]: {
                      v: CHANNEL_STARTUP_PROFILE_VERSION,
                    },
                    [CHANNEL_LIVENESS_META_KEY]: {
                      v: CHANNEL_LIVENESS_VERSION,
                    },
                    [PRIVATE_PARENT_CAPABILITY_META_KEY]:
                      privateParentCapability,
                  },
                  clientCapabilities: {
                    fs: {
                      readTextFile: delegateReadTextFileToClient,
                      writeTextFile: true,
                    },
                  },
                  clientInfo: { name: 'qwen-serve-bridge', version: '0' },
                }),
                channelUnavailableReject(channel, 'during initialize'),
              ]),
              initTimeoutMs,
              'initialize',
            );
            if (opts.externalToolGuard) {
              const guardAck =
                response._meta?.[EXTERNAL_TOOL_GUARD_READY_META_KEY];
              if (guardAck !== EXTERNAL_TOOL_GUARD_REQUIRED_VALUE) {
                throw new Error(
                  `ACP child did not acknowledge the required external tool guard (received: ${JSON.stringify(guardAck)}).`,
                );
              }
            }
            const activeWorkCapability = isRecord(response._meta)
              ? response._meta[ACTIVE_WORK_HEARTBEAT_META_KEY]
              : undefined;
            if (
              isRecord(activeWorkCapability) &&
              activeWorkCapability['v'] === ACTIVE_WORK_HEARTBEAT_VERSION
            ) {
              const advertised = activeWorkCapability['categories'];
              // Take the child's cadence rather than demanding it match ours,
              // but clamp it: an out-of-range value would either flood the
              // transport or make the freshness grade meaningless.
              info.activeWork = {
                intervalMs: clampActiveWorkIntervalMs(
                  activeWorkCapability['intervalMs'],
                ),
                categories: Array.isArray(advertised)
                  ? ACTIVE_WORK_HOLD_CATEGORIES.filter((category) =>
                      advertised.includes(category),
                    )
                  : [],
                seq: 0,
              };
            }
            const channelLivenessCapability = isRecord(response._meta)
              ? response._meta[CHANNEL_LIVENESS_META_KEY]
              : undefined;
            channelLivenessNegotiated =
              isRecord(channelLivenessCapability) &&
              channelLivenessCapability['v'] === CHANNEL_LIVENESS_VERSION;
            try {
              const attributes = getChannelStartupProfileAttributes(
                response,
                Date.now(),
                initTimeoutMs,
              );
              if (attributes && telemetry.setActiveSpanAttributes) {
                telemetry.setActiveSpanAttributes(attributes);
              }
            } catch {
              // Startup profiling must not affect bridge behavior.
            }
            return response;
          },
        );
      } catch (err) {
        // Mark the half-initialized channel as dying/unavailable, then
        // kill it. Coalesced callers (`inFlightChannelSpawn` branch in
        // `ensureChannel`) observe the same rejection on this promise
        // and propagate it to their callers; the `inFlightSpawns`
        // tracker is cleared in `spawnOrAttach`'s finally so a follow-
        // up call retries cleanly. The `channel.exited` handler
        // registered earlier removes `info` from `aliveChannels` once
        // the OS reaps the child. `isDying` here is the cross-path
        // invariant marker (matches `killSession` / `doSpawn`-
        // newSession-failure / `shutdown`): "any channel in
        // `aliveChannels` with `isDying === true` is mid-teardown."
        info.isDying = true;
        await channel.kill().catch(() => {});
        throw err;
      }

      if (info.isDying) {
        await channel.kill().catch(() => {});
        throw new BridgeChannelClosedError('during initialize');
      }

      // Late-shutdown re-check: if shutdown flipped during the
      // handshake, tear this channel down rather than leak past
      // `process.exit(0)`. Same cleanup pattern as the init-failure
      // path: mark dying + kill, let the exited handler reap.
      if (shuttingDown) {
        info.isDying = true;
        await channel.kill().catch(() => {});
        throw new Error('AcpSessionBridge is shutting down');
      }

      // Handshake succeeded — now publish the channel as the
      // attach-available slot. `channelInfo` is assigned LAST so
      // `ensureChannel`'s fast-path (`if (channelInfo && !.isDying)`)
      // never returns a still-handshaking channel to a concurrent
      // caller.
      channelInfo = info;
      info.handshakeComplete = true;
      if (channelLivenessNegotiated) {
        const failChannelLiveness = (error: ChannelLivenessFailure) => {
          if (info.isDying || !aliveChannels.has(info)) return;
          markTransportFailed(error);
          telemetry.event('channel.liveness_failed', {
            'qwen-code.daemon.acp_channel.id': info.id,
            'qwen-code.daemon.channel.session_count': info.sessionIds.size,
            'qwen-code.daemon.channel.transport_error_code': error.code,
          });
          writeStderrLine(
            `qwen serve: channel liveness failed (${error.code}); killing channel`,
          );
          if (info.channel.transportGuard) {
            info.channel.transportGuard.fail(error);
          } else {
            void killChannelWithLog(info, 'channel liveness failure');
          }
        };
        info.channelLiveness = startChannelLivenessMonitor({
          probe: (nonce) =>
            info.connection.extMethod(SERVE_STATUS_EXT_METHODS.channelPing, {
              v: CHANNEL_LIVENESS_VERSION,
              nonce,
            }),
          onFailure: failChannelLiveness,
          isActive: () =>
            channelInfo === info &&
            aliveChannels.has(info) &&
            !info.isDying &&
            !shuttingDown,
        });
      }
      telemetry.metrics?.channelLifecycle('spawn');
      return info;
    })();

    inFlightChannelSpawn = promise;
    try {
      return await promise;
    } finally {
      inFlightChannelSpawn = undefined;
    }
  }

  async function doSpawn(
    modelServiceId: string | undefined,
    effectiveScope: 'single' | 'thread',
    approvalMode: ApprovalMode | undefined,
    requestedClientId?: string,
    onSessionRegistered?: () => void,
    parentSessionId?: string,
    sourceType?: string,
    sourceId?: string,
    worktree?: { slug: string; path: string; branch: string },
    branch?: { name: string; baseBranch: string },
    requestedSessionId?: string,
  ): Promise<BridgeSession> {
    // Get-or-create the daemon's single channel, then call
    // `connection.newSession()` on it. Sessions share the child's
    // process / OAuth / file-cache / hierarchy-memory parse.
    //
    // newSession on an established channel can fail (auth, config,
    // etc.) without the channel dying. We DON'T kill the channel on
    // newSession failure when OTHER sessions are still using it —
    // they'd lose their work for a problem orthogonal to them.
    //
    // BkwQA: when the failed newSession was the channel's ONLY
    // attempt (sessionIds.size === 0), the empty channel must NOT
    // linger — it would stay set as `channelInfo` invisible to
    // `sessionCount` / `maxSessions` (both backed by `byId`), and
    // repeated failing creates would still find this channel via
    // `ensureChannel`, never spawning a fresh one. Tear down the
    // empty channel so the next attempt gets a clean spawn.
    const channelPath =
      channelInfo && !channelInfo.isDying
        ? 'reused'
        : inFlightChannelSpawn
          ? 'joined'
          : 'spawned_on_request';
    const ci = await telemetry.withSpan(
      'channel.wait',
      {
        'qwen-code.daemon.bridge.operation': 'channel.wait',
        'qwen-code.daemon.channel.path': channelPath,
      },
      ensureChannel,
    );
    if (ci.isDying) {
      throw new BridgeChannelClosedError('before newSession');
    }
    ci.sessionSpawnsInFlight++;
    if (requestedSessionId !== undefined) {
      // A caller-supplied id can legitimately reuse an id after an abandoned
      // restore settles. Transfer ownership before `newSession`, not at
      // registration, so the child's startup notifications are buffered even
      // while the ordinary post-close tombstone is still live.
      ci.client.markSessionRegistrationInFlight(requestedSessionId);
    }
    let sessionRegistered = false;
    let sessionRemovedDuringInitialization = false;
    let initializedSessionId: string | undefined;
    let newSessionResp: {
      sessionId: string;
      models?: { currentModelId?: unknown } | null;
      modes?: { currentModeId?: unknown } | null;
    };
    try {
      try {
        newSessionResp = await telemetry.withSpan(
          'session.new',
          {
            'qwen-code.daemon.bridge.operation': 'session.new',
            'qwen-code.daemon.session_scope': effectiveScope,
            'qwen-code.daemon.channel.path': channelPath,
            'qwen-code.daemon.acp_channel.id': ci.id,
          },
          async () => {
            // This legacy-named helper sanitizes and injects trace metadata
            // for any ACP request, not only prompts.
            const request = telemetry.injectPromptContext({
              cwd: boundWorkspace,
              mcpServers: [],
              ...(requestedSessionId || sourceType
                ? {
                    _meta: {
                      ...sessionSourceRequestMeta(sourceType, sourceId),
                      ...(requestedSessionId
                        ? {
                            [REQUESTED_SESSION_ID_META_KEY]: requestedSessionId,
                          }
                        : {}),
                    },
                  }
                : {}),
            });
            const response = await withTimeout(
              Promise.race([
                ci.connection.newSession(
                  worktree
                    ? {
                        ...request,
                        _meta: {
                          ...(isRecord(request._meta) ? request._meta : {}),
                          [WORKTREE_MCP_DEFER_META_KEY]: true,
                        },
                      }
                    : request,
                ),
                channelUnavailableReject(ci.channel, 'during newSession'),
              ]),
              initTimeoutMs,
              'newSession',
            );
            telemetry.event('session.new.completed', {
              'session.id': response.sessionId,
              'qwen-code.daemon.acp_channel.id': ci.id,
            });
            return response;
          },
        );
      } catch (err) {
        // Only reap when this newSession was the channel's first/only
        // attempt — a populated channel keeps running for its other
        // live sessions. If other work is still using the empty channel,
        // arm a deferred reap so the last blocker tears it down.
        if (hasNoChannelWork(ci, { ignoreCurrentSessionSpawn: true })) {
          // Mark dying SYNCHRONOUSLY so a concurrent `spawnOrAttach`
          // calling `ensureChannel()` between this point and the
          // `channel.exited` cleanup spawns a fresh channel instead of
          // attaching to the one we're about to tear down. `channelInfo`
          // stays set until OS reap so `killAllSync` mid-SIGTERM still
          // finds a target (BkUyD invariant).
          ci.isDying = true;
          ci.channelLiveness?.stop();
          await ci.channel.kill().catch(() => {
            /* best-effort — channel.exited handler still runs */
          });
        } else {
          ci.emptyReapPending = true;
        }
        throw err;
      }

      // Let an already-settled transport failure publish its synchronous
      // lifecycle marker before installing a session from a response that was
      // admitted immediately ahead of the fatal frame.
      await Promise.resolve();
      if (ci.isDying) {
        throw new BridgeChannelClosedError('after newSession');
      }

      // Late-shutdown re-check (BUy4U): shutdown() may have flipped
      // while we were in `connection.newSession` (~1s on cold start).
      if (shuttingDown) {
        // Don't kill the channel — see comment above. Just throw.
        throw new Error('AcpSessionBridge is shutting down');
      }

      const entry = createSessionEntry(
        ci,
        newSessionResp.sessionId,
        boundWorkspace,
        undefined,
        { parentSessionId, sourceType, sourceId, worktree, branch },
      );
      initializedSessionId = entry.sessionId;
      sessionRegistered = true;
      onSessionRegistered?.();
      seedSnapshotCaches(entry, newSessionResp);
      const clientId = registerClient(entry, requestedClientId);
      // Persist the parent lineage into the child's transcript so it survives a
      // daemon restart (rehydrated by `listSessions`). The live `SessionEntry`
      // already exposes `parentSessionId`, so the in-memory filter works this
      // run regardless — but WITHOUT the transcript record the link vanishes
      // from the persisted list on the next restart.
      //
      // So this is on the spawn critical path with the same discipline as the
      // other init round-trips: `withTimeout`-bounded and raced against
      // transport close (a child that never answers, or whose channel died,
      // must not pin the spawn/admission/concurrency slot). The definitive
      // outcome is surfaced to the caller via `BridgeSession.parentSessionPersisted`
      // (NOT just stderr, which is no API contract) so `create_sub_session` /
      // the SDK can tell a durably linked child from a live-only one. Success
      // REQUIRES `persisted === true`.
      //
      // A timeout or transport-close is TERMINAL, not retried: `withTimeout`
      // does not cancel the underlying `extMethod`, so a retry would start an
      // overlapping request whose late completion could contradict the reported
      // result. Only an IMMEDIATE (synchronous) rejection — definitively failed,
      // nothing left in flight — is retried, and the whole loop shares one
      // deadline. `recordParentSession` is idempotent on the child, so even a
      // late-completing timed-out write cannot double-append.
      //
      // The child is NOT rolled back when the write ultimately fails: it exists
      // and is linked in memory, and losing the whole sub-session over a
      // transcript hiccup is the worse failure — the caller is told via the flag
      // instead. Only sub-sessions carry a parent.
      let parentSessionPersisted: boolean | undefined;
      if (entry.parentSessionId) {
        const parentDeadline = Date.now() + initTimeoutMs;
        let lastParentErr: string | undefined;
        for (
          let attempt = 1;
          attempt <= MAX_PARENT_PERSIST_ATTEMPTS;
          attempt++
        ) {
          const remaining = parentDeadline - Date.now();
          if (remaining <= 0) {
            parentSessionPersisted = false;
            lastParentErr = 'deadline exceeded';
            break;
          }
          try {
            const parentResult = await Promise.race([
              withTimeout(
                entry.connection.extMethod(
                  SERVE_CONTROL_EXT_METHODS.sessionParent,
                  {
                    sessionId: entry.sessionId,
                    parentSessionId: entry.parentSessionId,
                  },
                ),
                remaining,
                'sessionParent',
              ),
              getTransportClosedReject(entry),
            ]);
            // A reachable child gives a definitive answer — do not retry a
            // `persisted: false` (recording service off; a retry can't fix it).
            parentSessionPersisted =
              (parentResult as { persisted?: boolean } | undefined)
                ?.persisted === true;
            break;
          } catch (err) {
            lastParentErr = err instanceof Error ? err.message : String(err);
            const terminal =
              err instanceof BridgeTimeoutError ||
              err instanceof BridgeChannelClosedError ||
              attempt === MAX_PARENT_PERSIST_ATTEMPTS;
            if (terminal) {
              parentSessionPersisted = false;
              break;
            }
            // else: immediate transient rejection — retry within the deadline.
          }
        }
        if (parentSessionPersisted === false) {
          // One diagnostic covering both the cause and the API consequence.
          writeStderrLine(
            `qwen serve: parentSessionId for ${entry.sessionId} was not persisted ` +
              `(${lastParentErr ?? 'unknown'}) — the parent link is live-only ` +
              `until restart (reported to the caller via parentSessionPersisted=false)`,
          );
        }
      }

      let sourcePersisted: boolean | undefined;
      if (entry.sourceType) {
        try {
          const sourceResult = await Promise.race([
            withTimeout(
              entry.connection.extMethod(
                SERVE_CONTROL_EXT_METHODS.sessionSource,
                {
                  sessionId: entry.sessionId,
                  sourceType: entry.sourceType,
                  ...(entry.sourceId !== undefined
                    ? { sourceId: entry.sourceId }
                    : {}),
                },
              ),
              initTimeoutMs,
              'sessionSource',
            ),
            getTransportClosedReject(entry),
          ]);
          sourcePersisted =
            (sourceResult as { persisted?: boolean } | undefined)?.persisted ===
            true;
        } catch (err) {
          sourcePersisted = false;
          writeStderrLine(
            `qwen serve: source metadata for ${entry.sessionId} was not persisted ` +
              `(${err instanceof Error ? err.message : String(err)}) — the source is live-only ` +
              `until restart (reported to the caller via sourcePersisted=false)`,
          );
        }
      }

      // ACP `newSession` doesn't take a model id; honor the caller's
      // `modelServiceId` via `unstable_setSessionModel`. See
      // `applyModelServiceId` for rationale (race against
      // transportClosedReject, publish model_switched on success,
      // model_switch_failed on failure, don't tear down the session).
      if (modelServiceId) {
        await applyModelServiceId(
          entry,
          modelServiceId,
          initTimeoutMs,
          clientId,
        ).catch(() => {
          // Already published `model_switch_failed`; session stays
          // operational on the agent's default model.
        });
      }

      if (approvalMode) {
        try {
          await applyApprovalMode(entry, approvalMode, false, clientId);
        } catch (err) {
          try {
            await closeSessionImpl(entry.sessionId, undefined, {
              reason: 'approval_mode_initialization_failed',
            });
            sessionRemovedDuringInitialization = true;
          } catch {
            /* best-effort; preserve the approval-mode failure */
          }
          throw err;
        }
      }

      // Bd1zc: re-check that the entry is still live before returning.
      // The model/approval-mode calls yield and race against
      // `channel.exited` — if the child crashed during the model
      // or approval-mode initialization, the exited handler already removed the entry from
      // byId. Without this check, the caller would get HTTP 200 with
      // a sessionId that already 404s on every subsequent request.
      if (!byId.has(entry.sessionId)) {
        throw new Error(
          `Session ${entry.sessionId} died during session initialization`,
        );
      }

      // `defaultEntry` is the single-scope attach target — only sessions
      // SPAWNED UNDER `'single'` may claim it. Publish it only after
      // fatal initialization has succeeded, otherwise a concurrent attach
      // can join a session that the failing initializer is about to close.
      if (effectiveScope === 'single' && !defaultEntry) defaultEntry = entry;

      return {
        sessionId: entry.sessionId,
        workspaceCwd: entry.workspaceCwd,
        attached: false,
        clientId,
        createdAt: entry.createdAt,
        ...(entry.sourceType ? { sourceType: entry.sourceType } : {}),
        ...(entry.sourceId !== undefined ? { sourceId: entry.sourceId } : {}),
        ...(entry.sourceType
          ? { sourcePersisted: sourcePersisted === true }
          : {}),
        ...(entry.parentSessionId
          ? { parentSessionPersisted: parentSessionPersisted === true }
          : {}),
        ...(entry.worktree ? { worktree: entry.worktree } : {}),
        ...(entry.branch ? { branch: entry.branch } : {}),
      };
    } finally {
      if (requestedSessionId !== undefined) {
        ci.client.clearSessionRegistrationInFlight(requestedSessionId);
        if (
          initializedSessionId !== requestedSessionId &&
          !byId.has(requestedSessionId)
        ) {
          // The child rejected the attempt or returned another id. Purge any
          // startup frames buffered for the requested id and restore the
          // ordinary post-close tombstone.
          ci.client.markSessionClosed(requestedSessionId);
        }
      }
      ci.sessionSpawnsInFlight = Math.max(0, ci.sessionSpawnsInFlight - 1);
      if (!sessionRegistered) {
        await reapPendingEmptyChannel(ci);
      } else if (sessionRemovedDuringInitialization && hasNoChannelWork(ci)) {
        await reapPendingEmptyChannel(ci);
        if (!ci.isDying) {
          await startIdleTimer(
            ci,
            `approval-mode initialization failure "${initializedSessionId}"`,
          );
        }
      } else if (sessionRegistered && hasNoChannelWork(ci) && !ci.isDying) {
        await startIdleTimer(
          ci,
          `session orphaned during initialization "${initializedSessionId}"`,
        );
      }
    }
  }

  /**
   * Send `unstable_setSessionModel` and broadcast a `model_switched`
   * event. Used at create-session time (via doSpawn) AND on attach when
   * the caller passes a modelServiceId — the existing session may be
   * running a different model.
   *
   * Serialized through `entry.modelChangeQueue` so two concurrent
   * attach-with-different-model requests can't race into the agent.
   * On failure, publishes a `model_switch_failed` event for cross-client
   * observability and re-throws so the HTTP caller sees the error
   * (session keeps running its previous model — that's the safer
   * default than tearing down a shared session because one client
   * asked for an unknown model).
   */
  async function applyModelServiceId(
    entry: SessionEntry,
    modelId: string,
    timeoutMs: number,
    originatorClientId?: string,
  ): Promise<void> {
    const conn = entry.connection as unknown as {
      unstable_setSessionModel(p: {
        sessionId: string;
        modelId: string;
      }): Promise<unknown>;
    };
    // Race against `transportClosedReject` so a child crash during
    // model switch fails the call immediately instead of waiting the
    // full `timeoutMs`. Matches what `sendPrompt` and `setSessionModel`
    // already do — without this, a callback-attach with a broken model
    // wedges the HTTP handler for 10s.
    const transportClosed = getTransportClosedReject(entry);
    const work = entry.modelChangeQueue.then(async () => {
      // A1: mark a bridge-driven model roundtrip so the agent's
      // `current_model_update` extNotification (this path also drives
      // `Session.setModel`, which emits it) is suppressed by the demux —
      // the authoritative `model_switched` is published below.
      entry.modelRoundtripInFlight = true;
      // Mirror setSessionModel: only reconcile after a change that landed. A
      // rejected roundtrip leaves the cache unchanged (often still unset on
      // the create/attach path), so reconciling would emit a corrective
      // model_switched right beside the model_switch_failed below.
      let succeeded = false;
      try {
        const result = await Promise.race([
          withTimeout(
            conn.unstable_setSessionModel({
              sessionId: entry.sessionId,
              modelId,
            }),
            timeoutMs,
            'setSessionModel',
          ),
          transportClosed,
        ]);
        publishModelSwitched(entry, modelId, originatorClientId);
        broadcastWorkspaceEvent({
          type: 'settings_changed',
          data: {
            key: 'model.name',
            value: getCanonicalModelId(result, modelId),
          },
          ...(originatorClientId ? { originatorClientId } : {}),
        });
        succeeded = true;
      } catch (err) {
        // Surface the failure to ALL attached clients, not just the
        // caller — a shared session swallowing a denied model change
        // silently would surprise the others. `publish()` never throws
        // (see `publishModelSwitched`), so no wrapper.
        entry.events.publish({
          type: 'model_switch_failed',
          data: {
            sessionId: entry.sessionId,
            requestedModelId: modelId,
            error: err instanceof Error ? err.message : String(err),
          },
          ...(originatorClientId ? { originatorClientId } : {}),
        });
        throw err;
      } finally {
        entry.modelRoundtripInFlight = false;
        if (succeeded) {
          void reconcileAfterRoundtrip(entry, 'model');
        } else {
          writeStderrLine(
            `[reconcile] session=${entry.sessionId} target=model action=skipped reason=roundtrip_failed`,
          );
        }
      }
    });
    // Tail swallows failures so subsequent model changes still run; the
    // original caller still observes the rejection on `work`.
    entry.modelChangeQueue = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  async function applyApprovalMode(
    entry: SessionEntry,
    mode: ApprovalMode,
    persist: boolean,
    originatorClientId?: string,
  ): Promise<{
    sessionId: string;
    mode: ApprovalMode;
    previous: ApprovalMode;
    persisted: boolean;
  }> {
    if (persist && !persistApprovalMode) {
      throw new Error(
        'setSessionApprovalMode called with `persist: true` but no ' +
          '`persistApprovalMode` callback wired in BridgeOptions. ' +
          'runQwenServe wires the production callback; direct embeds ' +
          'and tests must opt in or omit `persist`.',
      );
    }

    const approvalWork = entry.approvalModeQueue.then(async () => {
      entry.approvalModeRoundtripInFlight = true;
      let succeeded = false;
      try {
        const response = (await Promise.race([
          withTimeout(
            entry.connection.extMethod(
              SERVE_CONTROL_EXT_METHODS.sessionApprovalMode,
              { sessionId: entry.sessionId, mode },
            ),
            initTimeoutMs,
            SERVE_CONTROL_EXT_METHODS.sessionApprovalMode,
          ),
          getTransportClosedReject(entry),
        ])) as { previous: ApprovalMode; current: ApprovalMode };

        if (
          typeof response.current !== 'string' ||
          !KNOWN_APPROVAL_MODES.has(response.current)
        ) {
          throw new Error(
            `Agent returned unknown approval mode: ${JSON.stringify(response.current)}`,
          );
        }

        let persisted = false;
        if (persist) {
          try {
            await withTimeout(
              persistApprovalMode?.(boundWorkspace, mode) ?? Promise.resolve(),
              PERSIST_TIMEOUT_MS,
              'persistApprovalMode',
            );
            persisted = persistApprovalMode !== undefined;
          } catch (err) {
            writeStderrLine(
              `setSessionApprovalMode: persist failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
        publishApprovalModeChanged(
          entry,
          {
            previous: response.previous,
            next: response.current,
            persisted,
          },
          originatorClientId,
        );
        if (persisted) {
          broadcastWorkspaceEvent(
            {
              type: 'approval_mode_changed',
              data: {
                sessionId: entry.sessionId,
                previous: response.previous,
                next: response.current,
                persisted,
              },
              ...(originatorClientId ? { originatorClientId } : {}),
            },
            entry.sessionId,
          );
          for (const peer of byId.values()) {
            if (peer.sessionId === entry.sessionId) {
              continue;
            }
            peer.currentApprovalMode = response.current;
          }
        }
        succeeded = true;
        return {
          sessionId: entry.sessionId,
          mode: response.current,
          previous: response.previous,
          persisted,
        };
      } finally {
        entry.approvalModeRoundtripInFlight = false;
        if (succeeded) {
          void reconcileAfterRoundtrip(entry, 'approvalMode');
        } else {
          writeStderrLine(
            `[reconcile] session=${entry.sessionId} target=approvalMode action=skipped reason=roundtrip_failed`,
          );
        }
      }
    });
    entry.approvalModeQueue = approvalWork.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await approvalWork;
    } catch (err) {
      const data = (err as { data?: unknown })?.data;
      if (
        data &&
        typeof data === 'object' &&
        'errorKind' in data &&
        (data as { errorKind?: unknown }).errorKind === 'trust_gate'
      ) {
        const rawMessage = (err as { message?: unknown })?.message;
        const message =
          typeof rawMessage === 'string'
            ? rawMessage
            : 'Trust-gate rejection from ACP child';
        throw new TrustGateError(message);
      }
      throw err;
    }
  }

  async function applyApprovalModeForAttach(
    entry: SessionEntry,
    mode: ApprovalMode,
    clientId: string,
  ): Promise<ApprovalMode> {
    try {
      const result = await applyApprovalMode(entry, mode, false, clientId);
      return result.previous;
    } catch (err) {
      await rollbackAttachRegistration(entry, clientId);
      throw err;
    }
  }

  async function rollbackApprovalModeForRejectedAttach(
    entry: SessionEntry,
    previous: ApprovalMode,
    clientId: string,
  ): Promise<void> {
    if (byId.get(entry.sessionId) !== entry) return;
    try {
      await applyApprovalMode(entry, previous, false, clientId);
    } catch (err) {
      writeStderrLine(
        `attach: failed to restore approval mode for session ${entry.sessionId}: ${extractErrorMessage(err)}`,
      );
    }
  }

  /**
   * Resolve every pending request belonging to one session as cancelled.
   *
   * **Scope contract (per ACP spec / live-collab default):**
   * Permissions are issued by the agent inline DURING an active
   * prompt — `requestPermission` returns a Promise the agent awaits
   * before continuing. Per the bridge's per-session FIFO + ACP's
   * "one active prompt per session" guarantee, ALL outstanding
   * permissions at any moment belong to the **currently active
   * prompt**. So "cancel all pending permissions for this session"
   * is equivalent to "cancel the active prompt's permissions" — and
   * that's exactly what ACP requires when a prompt is cancelled
   * ("cancelling a prompt MUST resolve outstanding requestPermission
   * calls with outcome.cancelled").
   *
   * **Multi-client live-collab caveat:** under `sessionScope: 'single'`
   * Client B may have been about to vote on A's pending permission
   * via SSE — when A disconnects mid-prompt, B's vote (if it arrives
   * after the abort) gets `404`. This is the right behavior: A's
   * prompt is being cancelled, so the permission belongs to a turn
   * that no longer matters. From B's side they see
   * `permission_resolved` with `outcome: cancelled` on the SSE
   * stream, then the prompt's `cancelled` stop reason. Voting on a
   * cancelled-prompt's permission was never going to drive the
   * agent forward anyway.
   */
  const cancelPendingForSession = (sessionId: string) => {
    // Mediator first (it cancels each pending,
    // emits `permission_resolved`, writes audit, settles the
    // Promise), THEN clear the bridge's fast cap-check index.
    permissionMediator.forgetSession(sessionId);
    byId.get(sessionId)?.pendingPermissionIds.clear();
    byId.get(sessionId)?.pendingInteractions.clear();
  };

  /**
   * Lazy-init the per-session `transportClosedReject` promise that
   * `sendPrompt` / `setSessionModel` / `applyModelServiceId` race their
   * ACP calls against. ONE unavailable race is attached to the channel
   * over the session's lifetime (the first caller "wins" and creates
   * the promise; subsequent callers reuse it) — a per-call attach
   * would grow Node's listener list linearly with prompt count on
   * chatty sessions. The rejection message names the FIRST caller,
   * which can be misleading if a later method observes the failure;
   * the cost-benefit favors the single-listener invariant.
   */
  const getTransportClosedReject = (entry: SessionEntry): Promise<never> => {
    if (!entry.transportClosedReject) {
      entry.transportClosedReject = channelUnavailableReject(
        entry.channel,
        `mid-request (session ${entry.sessionId})`,
      );
    }
    return entry.transportClosedReject;
  };

  const resolveWorkspaceKey = (rawWorkspaceCwd: string): string => {
    // #7139: host-shaped Windows paths reach the in-container bridge via
    // clients and persisted registrations; the shared helper maps them to
    // the bind mount before the absolute-path check.
    const workspaceCwd =
      translateAndCheckAbsoluteWorkspacePath(rawWorkspaceCwd);
    if (workspaceCwd === null) {
      throw new Error(
        `workspaceCwd must be an absolute path; got "${rawWorkspaceCwd}"`,
      );
    }
    const workspaceKey =
      workspaceCwd === boundWorkspace
        ? boundWorkspace
        : canonicalizeWorkspace(workspaceCwd);
    if (workspaceKey !== boundWorkspace) {
      throw new WorkspaceMismatchError(boundWorkspace, workspaceKey);
    }
    return workspaceKey;
  };

  const liveChannelInfo = (): ChannelInfo | undefined => {
    if (!channelInfo || channelInfo.isDying) return undefined;
    return channelInfo;
  };

  const channelInfoForEntry = (
    entry: SessionEntry,
  ): ChannelInfo | undefined => {
    if (channelInfo?.channel === entry.channel) return channelInfo;
    for (const info of aliveChannels) {
      if (info.channel === entry.channel) return info;
    }
    return undefined;
  };

  const assertAttachableSessionEntry = (
    sessionId: string,
    entry: SessionEntry,
  ): void => {
    if (byId.get(sessionId) !== entry) {
      throw new SessionNotFoundError(
        sessionId,
        'The session channel is unavailable; retry after teardown completes',
      );
    }
    if (isClosingOrAuthorizingClose(entry)) {
      throw new SessionNotFoundError(
        sessionId,
        'The session is closing; retry after close completes',
        'session_closing',
      );
    }
    const owner = channelInfoForEntry(entry);
    if (!owner || owner.isDying) {
      throw new SessionNotFoundError(
        sessionId,
        'The session channel is unavailable; retry after teardown completes',
      );
    }
  };

  const assertLivePromptEntry = (
    sessionId: string,
    entry: SessionEntry,
  ): void => {
    const info = channelInfoForEntry(entry);
    if (byId.get(sessionId) !== entry || !info || info.isDying) {
      throw new SessionNotFoundError(sessionId);
    }
  };

  const getChannelClosedReject = (info: ChannelInfo): Promise<never> => {
    if (!info.statusClosedReject) {
      info.statusClosedReject = channelUnavailableReject(
        info.channel,
        'mid-request (workspace status)',
      );
    }
    return info.statusClosedReject;
  };

  const cacheWorkspaceMcpDetails = async (
    info: ChannelInfo,
    status: { servers?: unknown },
  ): Promise<void> => {
    if (!Array.isArray(status.servers)) return;
    const serverNames = status.servers.flatMap((server) =>
      isRecord(server) &&
      typeof server['name'] === 'string' &&
      server['mcpStatus'] === 'connected'
        ? [server['name']]
        : [],
    );
    const cacheDetail = async <T>(
      serverName: string,
      method: string,
      cache: Map<string, T>,
    ): Promise<void> => {
      try {
        const result = await withTimeout(
          Promise.race([
            info.connection.extMethod(method, {
              serverName,
              cwd: boundWorkspace,
            }),
            getChannelClosedReject(info),
          ]),
          initTimeoutMs,
          method,
        );
        cache.set(serverName, result as unknown as T);
      } catch {
        // The base MCP status remains useful when one detail query fails.
      }
    };
    await Promise.all(
      serverNames.flatMap((serverName) => [
        cacheDetail(
          serverName,
          SERVE_STATUS_EXT_METHODS.workspaceMcpTools,
          workspaceMcpToolsCache,
        ),
        cacheDetail(
          serverName,
          SERVE_STATUS_EXT_METHODS.workspaceMcpResources,
          workspaceMcpResourcesCache,
        ),
      ]),
    );
  };

  const mergeManagedWorkspaceMcpStatus = (
    serverNames: ReadonlySet<string>,
    previous: ServeWorkspaceMcpStatus | undefined,
    current: ServeWorkspaceMcpStatus,
  ): ServeWorkspaceMcpStatus => {
    if (
      Array.isArray(current.servers) &&
      previous?.discoveryState === 'completed' &&
      current.discoveryState === 'not_started'
    ) {
      if (current.servers.length === 0) return previous;
      const currentServers = new Map(
        current.servers.map((server) => [server.name, server]),
      );
      const previousNames = new Set(
        previous.servers.map((server) => server.name),
      );
      const servers = previous.servers.map((server) =>
        serverNames.has(server.name)
          ? (currentServers.get(server.name) ?? server)
          : server,
      );
      for (const server of current.servers) {
        if (serverNames.has(server.name) && !previousNames.has(server.name)) {
          servers.push(server);
        }
      }
      return {
        ...previous,
        discoveryState: 'completed',
        servers,
      };
    }
    return current;
  };

  const requestWorkspaceStatus = async <T>(
    method: string,
    idle: () => T,
    params: Record<string, unknown> = {},
    managedServerNames?: ReadonlySet<string>,
  ): Promise<T> => {
    const info = liveChannelInfo();
    if (!info) {
      if (
        method === SERVE_STATUS_EXT_METHODS.workspaceMcp &&
        workspaceMcpStatusCache
      ) {
        return workspaceMcpStatusCache as T;
      }
      return idle();
    }
    let response = await withTimeout(
      Promise.race([
        info.connection.extMethod(method, { ...params, cwd: boundWorkspace }),
        getChannelClosedReject(info),
      ]),
      initTimeoutMs,
      method,
    );
    if (method === SERVE_STATUS_EXT_METHODS.workspaceMcp) {
      const rawStatus = response as unknown as ServeWorkspaceMcpStatus;
      if (!Array.isArray(rawStatus.servers)) {
        return response as unknown as T;
      }
      const rawServers = rawStatus.servers;
      const effectiveManagedServerNames = new Set([
        ...info.workspaceMcpAuthenticationServerNames,
        ...(managedServerNames ?? []),
      ]);
      if (
        effectiveManagedServerNames.size > 0 ||
        (workspaceMcpStatusCache?.discoveryState === 'completed' &&
          rawStatus.discoveryState === 'not_started' &&
          rawServers.length === 0)
      ) {
        response = mergeManagedWorkspaceMcpStatus(
          effectiveManagedServerNames,
          workspaceMcpStatusCache,
          rawStatus,
        ) as unknown as typeof response;
      }
      const status = response as {
        discoveryState?: unknown;
        servers?: unknown;
        errors?: unknown;
      };
      if (status.discoveryState === 'completed') {
        await cacheWorkspaceMcpDetails(
          info,
          effectiveManagedServerNames.size > 0
            ? {
                servers: rawServers.filter((server) =>
                  effectiveManagedServerNames.has(server.name),
                ),
              }
            : status,
        );
      }
      if (
        info.workspaceMcpDiscoveryInFlight &&
        (status.discoveryState === 'completed' ||
          (Array.isArray(status.errors) && status.errors.length > 0))
      ) {
        finishWorkspaceMcpDiscovery(info);
        if (hasNoChannelWork(info)) {
          await startIdleTimer(info, 'workspace MCP discovery complete');
        }
      }
      if (status.discoveryState === 'completed') {
        info.workspaceMcpDiscoveryRequested = true;
      } else if (status.discoveryState === 'in_progress') {
        info.workspaceMcpDiscoveryRequested = true;
      } else if (Array.isArray(status.errors) && status.errors.length > 0) {
        info.workspaceMcpDiscoveryRequested = false;
      }
      let authenticationCompleted = false;
      for (const serverName of info.workspaceMcpAuthenticationServerNames) {
        const server = rawServers.find(
          (candidate) => candidate.name === serverName,
        );
        if (
          server?.authenticationState !== 'pending' &&
          (server !== undefined || rawStatus.discoveryState === 'completed')
        ) {
          info.workspaceMcpAuthenticationServerNames.delete(serverName);
          const timer = info.workspaceMcpAuthenticationTimers.get(serverName);
          if (timer) clearTimeout(timer);
          info.workspaceMcpAuthenticationTimers.delete(serverName);
          authenticationCompleted = true;
        }
      }
      if (authenticationCompleted) {
        if (hasNoChannelWork(info)) {
          await startIdleTimer(info, 'workspace MCP authentication complete');
        }
      }
      workspaceMcpStatusCache = response as unknown as ServeWorkspaceMcpStatus;
    }
    return response as unknown as T;
  };

  /**
   * Caps on the one variable-length field a child controls in its heap
   * report. V8 exposes 11 spaces on Node 22 and 13 on Node 24, all named well
   * under 64 characters, so a legitimate report never approaches either.
   */
  const MAX_CHILD_HEAP_UNCLASSIFIED_NAMES = 64;
  const MAX_CHILD_HEAP_SPACE_NAME_LENGTH = 64;

  /**
   * Validate a child's self-reported heap block at the trust boundary.
   *
   * Returns `undefined` for anything malformed rather than a partially filled
   * report: these figures exist to decide whether a child fits a heap ceiling,
   * and a report with some fields defaulted would understate a peak while
   * looking complete. Rejecting the whole block leaves the channel's last good
   * report in place, which is the honest fallback.
   *
   * `Number.isFinite` and not just `typeof`, because `typeof NaN === 'number'`
   * — the same reason the rss and cpu checks above are written this way.
   */
  const parseChildHeapReport = (
    value: unknown,
  ): ChildHeapReport | undefined => {
    if (typeof value !== 'object' || value === null) return undefined;
    const raw = value as Record<string, unknown>;
    const counts: Array<keyof ChildHeapReport> = [
      'peakOldGenerationBytes',
      'peakLiveSetBytes',
      'peakTotalHeapBytes',
      'majorGcCount',
      'majorGcMs',
    ];
    const parsed: Record<string, number> = {};
    for (const key of counts) {
      const n = raw[key];
      // Negative bytes or pause times are not a degraded reading, they are a
      // broken sender; treat them like any other malformed field.
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
        return undefined;
      }
      parsed[key] = n;
    }
    // Bounded because the daemon caches this array on the channel for the
    // child's lifetime, and the child chooses its contents. It is the one
    // variable-length field in the report, and a workstream about bounding
    // daemon memory should not add an unbounded retained container. Real
    // values come from V8's heap-space list: around a dozen entries with
    // short names, so these caps are far above anything legitimate.
    const names = raw['unclassifiedSpaceNames'];
    if (
      !Array.isArray(names) ||
      names.length > MAX_CHILD_HEAP_UNCLASSIFIED_NAMES ||
      names.some(
        (name) =>
          typeof name !== 'string' ||
          name.length > MAX_CHILD_HEAP_SPACE_NAME_LENGTH,
      )
    ) {
      return undefined;
    }
    return {
      peakOldGenerationBytes: parsed['peakOldGenerationBytes'],
      peakLiveSetBytes: parsed['peakLiveSetBytes'],
      peakTotalHeapBytes: parsed['peakTotalHeapBytes'],
      majorGcCount: parsed['majorGcCount'],
      majorGcMs: parsed['majorGcMs'],
      unclassifiedSpaceNames: names as string[],
    };
  };

  // Daemon Status child-resource: poll the live child's `workspaceResource`
  // extMethod and cache rss/cpu on the channel. The daemon's metrics sampler
  // fires this fire-and-forget, then reads the cache synchronously — keeping the
  // async round-trip off the sampler's hot path.
  const STALE_CHILD_RESOURCE_MS = 30_000;
  // In-flight guard: `requestWorkspaceStatus` waits up to `initTimeoutMs` (10s),
  // longer than the 5s sample cadence — so without this a degraded child (the
  // exact case the chart should surface) would accumulate concurrent polls and
  // pile more load onto an already-struggling pipe. At most one outstanding poll.
  let childResourceRefreshing = false;
  const refreshChildResource = async (): Promise<void> => {
    if (childResourceRefreshing) return;
    const info = liveChannelInfo();
    if (!info) return;
    childResourceRefreshing = true;
    try {
      const res = await requestWorkspaceStatus<{
        rssBytes?: unknown;
        cpuPercent?: unknown;
        heap?: unknown;
      }>(SERVE_STATUS_EXT_METHODS.workspaceResource, () => ({}));
      // A channel swap during the await would otherwise stamp a dead channel;
      // only write if this is still the live one.
      if (liveChannelInfo() !== info) return;
      // `typeof NaN === 'number'` is true, so also require finiteness at this
      // trust boundary — a misbehaving child returning NaN would otherwise be
      // cached and read as NaN before the sampler's finiteGauge() catches it.
      if (typeof res.rssBytes === 'number' && Number.isFinite(res.rssBytes)) {
        info.childRssBytes = res.rssBytes;
      }
      if (
        typeof res.cpuPercent === 'number' &&
        Number.isFinite(res.cpuPercent)
      ) {
        // Clamp on receive too — enforce the [0,100] JSDoc invariant here, not
        // only on the child's send side.
        info.childCpuPercent = Math.min(100, Math.max(0, res.cpuPercent));
      }
      // Only overwrite on a well-formed report. A child that stops sending the
      // block keeps its last good marks rather than having them cleared: these
      // are lifetime high-water values, so dropping them would lose history the
      // child cannot resend.
      const heap = parseChildHeapReport(res.heap);
      if (heap) info.childHeap = heap;
      info.childResourceAt = Date.now();
    } catch (err) {
      // Child unreachable / mid-swap — keep the last good cache (or nothing
      // before the first success). The staleness guard in the reader drops it
      // once it ages out, so a stuck child reads 0 rather than a frozen value.
      // Log at debug so an operator watching child rss/cpu flatline to 0 can
      // tell "the poll is failing" apart from "the child is genuinely idle".
      teeServeDebugLine(
        `child-resource refresh failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      childResourceRefreshing = false;
    }
  };
  const getChildResourceSnapshot = ():
    | {
        rssBytes: number;
        cpuPercent: number;
        ageMs: number;
        heap?: ChildHeapReport;
      }
    | undefined => {
    const info = liveChannelInfo();
    if (!info || info.childResourceAt === undefined) return undefined;
    // Staleness: a child that goes unresponsive without a channel swap would
    // otherwise show its last-good rss/cpu forever (a zombie looking healthy).
    // Drop the reading once it ages past the window so the chart reads 0.
    const ageMs = Date.now() - info.childResourceAt;
    if (ageMs > STALE_CHILD_RESOURCE_MS) {
      return undefined;
    }
    return {
      rssBytes: info.childRssBytes ?? 0,
      cpuPercent: info.childCpuPercent ?? 0,
      // Deliberately not defaulted. Unlike rss/cpu, where 0 is a plausible
      // reading, a zeroed heap report would assert the child needed no old
      // generation — the one conclusion that must never be manufactured.
      heap: info.childHeap,
      // Bounded by the guard above, so a caller summing several children's
      // readings can say how far apart they were taken. Without it a sum of
      // readings up to `STALE_CHILD_RESOURCE_MS` apart looks instantaneous.
      ageMs,
    };
  };

  const requestSessionStatus = async <T>(
    sessionId: string,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = initTimeoutMs,
  ): Promise<T> => {
    const entry = byId.get(sessionId);
    if (!entry) throw new SessionNotFoundError(sessionId);
    const info = channelInfoForEntry(entry);
    if (!info || info.isDying) throw new SessionNotFoundError(sessionId);
    const response = await Promise.race([
      withTimeout(
        entry.connection.extMethod(method, { ...params, sessionId }),
        timeoutMs,
        method,
      ),
      getTransportClosedReject(entry),
    ]);
    return response as unknown as T;
  };

  const notifyAgentSessionClose = async (
    entry: SessionEntry,
    ci: ChannelInfo | undefined,
    label: 'closeSession' | 'killSession',
    opts?: {
      throwOnFailure?: boolean;
      requireFlush?: boolean;
      timeoutMs?: number;
    },
  ): Promise<boolean> => {
    if (!ci || ci.channel !== entry.channel) {
      if (opts?.throwOnFailure === true) {
        writeStderrLine(
          `qwen serve: ${label} ACP session close channel unavailable ` +
            `for session ${JSON.stringify(entry.sessionId)}; agent close skipped`,
        );
        throw new Error(
          `ACP session close channel unavailable for ${entry.sessionId}`,
        );
      }
      return false;
    }
    try {
      const closeRequest = entry.connection.extMethod(
        SERVE_CONTROL_EXT_METHODS.sessionClose,
        {
          sessionId: entry.sessionId,
          drainTimeoutMs: sessionCloseDrainBudgetMs(
            opts?.timeoutMs ?? initTimeoutMs,
          ),
          ...(opts?.requireFlush === true ? { requireFlush: true } : {}),
        },
      );
      const observedCloseRequest = opts?.timeoutMs
        ? withTimeout(closeRequest, opts.timeoutMs, label)
        : closeRequest;
      const response = await Promise.race([
        opts?.throwOnFailure === true
          ? observedCloseRequest
          : withTimeout(
              observedCloseRequest,
              initTimeoutMs,
              SERVE_CONTROL_EXT_METHODS.sessionClose,
            ),
        getTransportClosedReject(entry),
      ]);
      return response['closed'] === true;
    } catch (err) {
      writeStderrLine(
        `qwen serve: ${label} ACP session close notification failed ` +
          `for session ${JSON.stringify(entry.sessionId)}: ${String(
            err instanceof Error ? err.message : err,
          )}`,
      );
      if (opts?.throwOnFailure === true) {
        throw err;
      }
      return false;
    }
  };

  /**
   * Fan-out an event to every live session bus. Mutation events
   * (`tool_toggled`, `workspace_initialized`, `mcp_server_restart*`,
   * persisted `approval_mode_changed` mirror) call this.
   *
   * Kept as a local closure rather than a member method because call
   * sites within the bridge implementation run inside the factory
   * scope where `this` is not yet the proxy.
   *
   * Optional `skipSessionId` — when set, that session is excluded
   * from the broadcast. Used by `setSessionApprovalMode` to avoid
   * delivering `approval_mode_changed` twice to the requesting
   * session (which already received the session-scoped publish on
   * its own bus).
   */
  const broadcastWorkspaceEvent = (
    envelope: Omit<BridgeEvent, 'id' | 'v'>,
    skipSessionId?: string,
  ): void => {
    const sessions = Array.from(byId.values());
    let successCount = 0;
    let failureCount = 0;
    let skippedCount = 0;
    for (const entry of sessions) {
      if (skipSessionId !== undefined && entry.sessionId === skipSessionId) {
        skippedCount += 1;
        continue;
      }
      try {
        const published = entry.events.publish(envelope);
        if (published === undefined) {
          failureCount += 1;
          teeServeDebugLine(
            `broadcastWorkspaceEvent: publish on session ${entry.sessionId} no-op (bus closed or unserializable)`,
          );
        } else {
          successCount += 1;
        }
      } catch (err) {
        failureCount += 1;
        const detail =
          `broadcastWorkspaceEvent: bus publish failed for session ` +
          `${JSON.stringify(entry.sessionId)} (type=${envelope.type}): ` +
          `${err instanceof Error ? err.message : String(err)}`;
        if (shuttingDown) {
          teeServeDebugLine(detail);
        } else {
          writeStderrLine(`qwen serve: ${detail}`);
        }
      }
    }
    // Only elevate when the broadcast had at least one eligible
    // recipient (excluding the skipped requester) and ALL of them
    // dropped the event. Single-session workspaces with the requester
    // skipped naturally produce zero recipients — that's not an
    // "all dropped" condition, just nobody to deliver to.
    //
    // Count the sessions we actually skipped instead of unconditionally
    // subtracting 1 when `skipSessionId` is set. Counting actual skips
    // makes the alarm condition self-consistent regardless of whether
    // the `skipSessionId` matches any live session.
    const eligible = sessions.length - skippedCount;
    if (eligible > 0 && successCount === 0 && !shuttingDown) {
      writeStderrLine(
        `qwen serve: broadcastWorkspaceEvent type=${envelope.type} dropped on ALL ${failureCount} session bus(es); SSE subscribers will miss this event (GET fallback still authoritative)`,
      );
    }
  };

  const createSessionEventBus = (sessionId: string): EventBus =>
    new EventBus(
      eventRingSize,
      undefined,
      new TurnBoundaryCompactionEngine({
        maxReplayBytes: compactedReplayMaxBytes,
        maxJournalEvents,
        maxJournalBytes,
        onReplayWindowEviction: (eviction) => {
          teeServeDebugLine(
            `replay window evicted ${JSON.stringify(eviction)}`,
          );
        },
        // Adaptive growth: the engine asks before evicting past its caps.
        // The policy accounts growth across this bridge's live sessions
        // from every session's CURRENT journal cap (stateless — no ledger
        // to reconcile when a session is reaped), so granted headroom dies
        // with its session.
        ...(journalGrowthPolicy
          ? {
              onJournalGrowth: (current: {
                maxEvents: number;
                maxBytes: number;
              }) => {
                // The daemon-wired aggregator already covers every
                // sharing bridge's live sessions (this bridge's included);
                // standalone bridges fall back to their own enumeration.
                const allSessionLimits = journalGrowthSessionLimits
                  ? [...journalGrowthSessionLimits()]
                  : journalSessionLimits();
                // A requester whose bus lives outside both maps (defensive
                // — today it is either registered or mid-restore) must
                // still be charged at its current cap.
                if (
                  !byId.has(sessionId) &&
                  !pendingRestoreEvents.has(sessionId)
                ) {
                  allSessionLimits.push({
                    limitBytes: current.maxBytes,
                    baselineBytes: maxJournalBytes,
                  });
                }
                const grant = journalGrowthPolicy.grant({
                  currentMaxEvents: current.maxEvents,
                  currentMaxBytes: current.maxBytes,
                  allSessionLimits,
                });
                if (grant) {
                  teeServeDebugLine(
                    `live journal growth session=${JSON.stringify(sessionId)}: ` +
                      `${current.maxBytes} -> ${grant.maxBytes} bytes, ` +
                      `${current.maxEvents} -> ${grant.maxEvents} entries`,
                  );
                }
                return grant;
              },
            }
          : {}),
      }),
      {
        // Fired once, on the FIRST ingest/seed failure (the bus keeps the
        // degraded flag set silently afterwards). The bus doesn't know its
        // session, so the sessionId context is injected here.
        onCompactionError: (err) => {
          writeStderrLine(
            `qwen serve: compaction degraded for session=${JSON.stringify(sessionId)}; replay snapshot may lag behind live events: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        },
      },
    );

  // §2.3 publish helpers — centralise cache + generation + bus publish so
  // every `model_switched` / `approval_mode_changed` site stays atomic.

  const publishModelSwitched = (
    entry: SessionEntry,
    modelId: string,
    originatorClientId: string | undefined,
  ): void => {
    entry.currentModelId = modelId;
    entry.modelPublishGeneration++;
    // `EventBus.publish` never throws (a closed bus is a return-undefined
    // no-op); per its documented contract we don't wrap it — a try/catch
    // here would be dead code for "bus closed" and would mislabel a real
    // programming error (e.g. a `TypeError`) as a benign bus-closed swallow.
    entry.events.publish({
      type: 'model_switched',
      ...(entry.activePromptId ? { promptId: entry.activePromptId } : {}),
      data: { sessionId: entry.sessionId, modelId },
      ...(originatorClientId ? { originatorClientId } : {}),
    });
  };

  const publishApprovalModeChanged = (
    entry: SessionEntry,
    payload: { previous: string; next: string; persisted: boolean },
    originatorClientId: string | undefined,
  ): void => {
    entry.currentApprovalMode = payload.next;
    entry.approvalModePublishGeneration++;
    // See `publishModelSwitched`: `publish()` never throws, so no wrapper.
    entry.events.publish({
      type: 'approval_mode_changed',
      ...(entry.activePromptId ? { promptId: entry.activePromptId } : {}),
      data: {
        sessionId: entry.sessionId,
        previous: payload.previous,
        next: payload.next,
        persisted: payload.persisted,
      },
      ...(originatorClientId ? { originatorClientId } : {}),
    });
  };

  // §2.2 post-roundtrip reconciliation — after a bridge-driven model or
  // approval-mode change settles, re-read the agent's actual state and
  // emit a corrective event if it drifted from the cached value.
  const reconcileAfterRoundtrip = async (
    entry: SessionEntry,
    target: 'model' | 'approvalMode',
  ): Promise<void> => {
    const flagKey =
      target === 'model'
        ? 'modelReconciliationInFlight'
        : 'approvalModeReconciliationInFlight';
    const genOf = () =>
      target === 'model'
        ? entry.modelPublishGeneration
        : entry.approvalModePublishGeneration;
    if (entry[flagKey]) return;
    entry[flagKey] = true;
    const genBefore = genOf();
    // Set when a newer change published while our status read was in
    // flight; we re-run once after releasing the guard (see `finally`).
    let rerun = false;
    try {
      const status = await requestSessionStatus<ServeSessionContextStatus>(
        entry.sessionId,
        SERVE_STATUS_EXT_METHODS.sessionContext,
      );
      if (genOf() !== genBefore) {
        // A newer change published during our RPC; its own
        // `reconcileAfterRoundtrip` bailed on the in-flight guard above,
        // so without a re-run the latest change would never be
        // reconciled. Skip this (now-stale) read and re-run once. The
        // re-run is gated on this generation-change signal — NOT on a
        // bare `genOf() !== genBefore` at `finally` time — because a
        // corrective publish below bumps the generation itself and would
        // otherwise self-trigger an unbounded reconcile loop.
        rerun = true;
        writeStderrLine(
          `[reconcile] session=${entry.sessionId} target=${target} action=skipped reason=generation_changed genBefore=${genBefore} genAfter=${genOf()}`,
        );
        return;
      }

      if (target === 'model') {
        const actual = (
          status?.state?.models as { currentModelId?: string } | undefined
        )?.currentModelId;
        if (
          typeof actual === 'string' &&
          actual &&
          actual !== entry.currentModelId
        ) {
          writeStderrLine(
            `[reconcile] session=${entry.sessionId} target=model action=corrected cached=${entry.currentModelId ?? '<unset>'} actual=${actual}`,
          );
          publishModelSwitched(entry, actual, undefined);
        }
      } else {
        const actual = (
          status?.state?.modes as { currentModeId?: string } | undefined
        )?.currentModeId;
        // Same enum backstop as the demux path (`handleInSessionModeUpdate`):
        // `actual` is an agent-supplied id typed `unknown`, and the SDK's
        // `isApprovalModeChangedData` is a structural check (deliberately
        // forward-compatible with a future 5th mode), NOT an enum gate. An
        // unknown id here would fan out to every SSE client and land in the
        // reducer's `state.approvalMode`, so drop it before publishing.
        if (actual && !KNOWN_APPROVAL_MODES.has(actual)) {
          writeStderrLine(
            `[reconcile] session=${entry.sessionId} target=approvalMode action=dropped reason=unknown_mode mode=${actual}`,
          );
        } else if (actual && actual !== entry.currentApprovalMode) {
          writeStderrLine(
            `[reconcile] session=${entry.sessionId} target=approvalMode action=corrected cached=${entry.currentApprovalMode ?? '<unset>'} actual=${actual}`,
          );
          publishApprovalModeChanged(
            entry,
            {
              previous: entry.currentApprovalMode ?? 'default',
              next: actual,
              persisted: false,
            },
            undefined,
          );
        }
      }
    } catch (err) {
      // The status read failed — drift can be neither confirmed nor
      // corrected. Keep the signal in the operator log rather than
      // emitting a bus event no client can decode: `reconciliation_failed`
      // is not a known SDK event type, so `asKnownDaemonEvent` drops it
      // and the reducer never sees it. Long-lived SSE connections that
      // never disconnect will hold their last-seen state until the next
      // successful roundtrip triggers another reconcile; reconnecting
      // clients get a fresh `session_snapshot` on attach.
      writeStderrLine(
        `[reconcile] session=${entry.sessionId} target=${target} action=failed error=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      entry[flagKey] = false;
      if (rerun) void reconcileAfterRoundtrip(entry, target);
    }
  };

  const createSessionEntry = (
    ci: ChannelInfo,
    sessionId: string,
    workspaceCwd: string,
    events = createSessionEventBus(sessionId),
    options: {
      drainEarlyEvents?: boolean;
      lifecycleReason?: string;
      parentSessionId?: string;
      sourceType?: string;
      sourceId?: string;
      worktree?: { slug: string; path: string; branch: string };
      branch?: { name: string; baseBranch: string };
    } = {},
  ): SessionEntry => {
    const entry: SessionEntry = {
      sessionId,
      workspaceCwd,
      effectiveCwd: workspaceCwd,
      createdAt: new Date().toISOString(),
      ...(options.parentSessionId
        ? { parentSessionId: options.parentSessionId }
        : {}),
      ...(options.sourceType ? { sourceType: options.sourceType } : {}),
      ...(options.sourceId !== undefined ? { sourceId: options.sourceId } : {}),
      ...(options.worktree ? { worktree: options.worktree } : {}),
      ...(options.branch ? { branch: options.branch } : {}),
      channel: ci.channel,
      connection: ci.connection,
      events,
      artifacts: new SessionArtifactStore({
        sessionId,
        workspaceCwd,
        persistence: createSessionArtifactPersistence(ci.connection, sessionId),
      }),
      attachments: new SessionAttachmentStore(
        opts.sessionAttachmentsRoot,
        sessionId,
      ),
      recordingDegraded: false,
      closing: false,
      cwdChangeQueue: Promise.resolve(),
      promptQueue: Promise.resolve(),
      pendingPromptCount: 0,
      pendingAgentNotificationCount: 0,
      ...(opts.promptLedger ? { promptLedger: opts.promptLedger } : {}),
      pendingPromptList: [],
      terminalTurnStatuses: new Map(),
      enrichedTerminalPromptIds: new Set(),
      rewindGeneration: 0,
      midTurnMessageQueue: [],
      settledMidTurnMessageIds: [],
      promotedMidTurnMessageIds: [],
      modelChangeQueue: Promise.resolve(),
      approvalModeQueue: Promise.resolve(),
      modelPublishGeneration: 0,
      approvalModePublishGeneration: 0,
      pendingPermissionIds: new Set(),
      pendingInteractions: new Map(),
      clientIds: new Map(),
      clientLastSeenAt: new Map(),
      attachCount: 0,
      attachRefs: new Map(),
      spawnOwnerWantedKill: false,
      promptActive: false,
      childHolds: null,
      childHoldsAt: null,
      activeWorkCloseInFlight: false,
      retryAllowed: false,
      promptSettledAt: null,
      promptSettledCloseTimer: undefined,
    };
    ci.sessionIds.add(entry.sessionId);
    byId.set(entry.sessionId, entry);
    // A legitimate owner supersedes any abandoned-restore fence on this id.
    // The fence has no TTL by design, and it silently drops session updates,
    // guardrail events, and notifications — so leaving it standing would hand
    // this session a working id that never emits anything. Restore and
    // caller-supplied spawn paths transfer ownership before their ACP call;
    // this remains a defense for routes that only learn the id from the child.
    ci.client.clearAbandonedRestoreFence(entry.sessionId);
    touchActivity();
    telemetry.metrics?.sessionLifecycle('spawn');
    emitSessionLifecycle({
      type: 'registered',
      sessionId: entry.sessionId,
      workspaceCwd: entry.workspaceCwd,
      reason: options.lifecycleReason ?? 'spawn',
    });
    if (options.drainEarlyEvents !== false) {
      // Drain any guardrail events that fired during this session's
      // `newSession` handler (before this entry registered) onto the
      // freshly-created EventBus. Idempotent on unknown sessionIds.
      ci.client.drainEarlyEvents(entry.sessionId, entry);
    }
    return entry;
  };

  const publishArtifactChanges = (
    entry: SessionEntry,
    changes: SessionArtifactChange[],
    originatorClientId?: string,
  ): void => {
    for (const change of changes) {
      entry.events.publish({
        type: 'artifact_changed',
        data: { sessionId: entry.sessionId, change },
        ...(originatorClientId ? { originatorClientId } : {}),
      });
    }
  };

  const artifactReseedChanges = (
    before: readonly DaemonSessionArtifact[],
    after: readonly DaemonSessionArtifact[],
  ): SessionArtifactChange[] => {
    const beforeById = new Map(
      before.map((artifact) => [artifact.id, artifact]),
    );
    const afterById = new Map(after.map((artifact) => [artifact.id, artifact]));
    const changes: SessionArtifactChange[] = [];
    for (const artifact of before) {
      if (!afterById.has(artifact.id)) {
        changes.push({
          action: 'removed',
          artifactId: artifact.id,
          artifact,
          reason: 'eviction',
        });
      }
    }
    for (const artifact of after) {
      const previous = beforeById.get(artifact.id);
      if (!previous) {
        changes.push({
          action: 'created',
          artifactId: artifact.id,
          artifact,
        });
        continue;
      }
      if (!publicArtifactsEqual(previous, artifact)) {
        changes.push({
          action: 'updated',
          artifactId: artifact.id,
          artifact,
        });
      }
    }
    return changes;
  };

  const makeClientArtifactInput = (
    artifact: SessionArtifactInput,
    clientId: string | undefined,
  ): SessionArtifactInput => {
    const input: SessionArtifactInput = {
      title: artifact.title,
      kind: artifact.kind,
      storage: artifact.storage,
      description: artifact.description,
      workspacePath: artifact.workspacePath,
      managedId: artifact.managedId,
      url: artifact.url,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      metadata: artifact.metadata,
      retention: artifact.retention,
      clientRetained: artifact.clientRetained,
      source: 'client',
    };
    if (clientId) {
      input.clientId = clientId;
    }
    return input;
  };

  function createSessionArtifactPersistence(
    connection: ClientSideConnection,
    sessionId: string,
  ) {
    return {
      recordEvent: async (payload: unknown): Promise<void> => {
        await connection.extMethod(
          SERVE_CONTROL_EXT_METHODS.sessionArtifactsPersist,
          {
            sessionId,
            kind: 'event',
            payload,
          },
        );
      },
      recordSnapshot: async (payload: unknown): Promise<void> => {
        await connection.extMethod(
          SERVE_CONTROL_EXT_METHODS.sessionArtifactsPersist,
          {
            sessionId,
            kind: 'snapshot',
            payload,
          },
        );
      },
    };
  }

  // A5: seed the snapshot caches from the agent's session-create response
  // (`newSession` / `loadSession` / `resumeSession` all return `models` +
  // `modes`). Without this the caches stay unset until the first change, so a
  // cold `?snapshot=1` attach to a session that never switched would return
  // `{ currentModelId: null, currentApprovalMode: null }` and the SDK reducer's
  // `!= null` guard would leave the client unseeded — defeating A5's primary
  // (initial-attach) use case. The agent's `currentModelId` is already the
  // advertised selector (legacy or opaque), matching what
  // `reconcileAfterRoundtrip` reads back, so seeding it keeps the comparison
  // format-stable. Mode ids pass the same `KNOWN_APPROVAL_MODES` backstop the
  // demux/reconcile paths use.
  const seedSnapshotCaches = (
    entry: SessionEntry,
    resp: {
      models?: { currentModelId?: unknown } | null;
      modes?: { currentModeId?: unknown } | null;
    },
  ): void => {
    const model = resp.models?.currentModelId;
    if (typeof model === 'string' && model.length > 0) {
      entry.currentModelId = model;
    } else if (model != null) {
      writeStderrLine(
        `[seed] session=${entry.sessionId} target=model action=dropped value=${JSON.stringify(model)} reason=invalid_type`,
      );
    }
    const mode = resp.modes?.currentModeId;
    if (typeof mode === 'string' && KNOWN_APPROVAL_MODES.has(mode)) {
      entry.currentApprovalMode = mode;
    } else if (mode != null) {
      writeStderrLine(
        `[seed] session=${entry.sessionId} target=approvalMode action=dropped value=${JSON.stringify(mode)} reason=${typeof mode !== 'string' ? 'invalid_type' : 'unknown_mode'}`,
      );
    }
  };

  const isAcpSessionResourceNotFound = (
    err: unknown,
    sessionId: string,
  ): boolean => {
    if (!err || typeof err !== 'object') return false;
    const maybe = err as {
      code?: unknown;
      data?: unknown;
      message?: unknown;
    };
    if (maybe.code !== -32002) return false;
    const expectedUri = `session:${sessionId}`;
    if (
      maybe.data &&
      typeof maybe.data === 'object' &&
      (maybe.data as { uri?: unknown }).uri === expectedUri
    ) {
      return true;
    }
    // Fallback for ACP servers that omit `data.uri` and embed the
    // URI in the human-readable message. Use exact equality on the
    // canonical "Resource not found: <uri>" form rather than
    // `includes(expectedUri)` — a substring match would cause a
    // sessionId of `"a"` to falsely match a message containing
    // `"session:abc"`.
    return (
      typeof maybe.message === 'string' &&
      maybe.message === `Resource not found: ${expectedUri}`
    );
  };

  const replayFieldsFor = (
    entry: Pick<
      SessionEntry,
      | 'events'
      | 'restoreReplayPartial'
      | 'restoreReplayError'
      | 'restoreHistoryHasMore'
      | 'restoreHistoryAnchorRecordId'
      | 'activePromptId'
    >,
    action: 'load' | 'resume',
    liveReplayMode: 'full' | 'summary' = 'full',
  ): Pick<
    BridgeRestoredSession,
    | 'compactedReplay'
    | 'liveJournal'
    | 'lastEventId'
    | 'eventEpoch'
    | 'replayDegraded'
    | 'partial'
    | 'replayError'
    | 'historyHasMore'
    | 'historyAnchorRecordId'
  > => {
    const replayStatus =
      action === 'load' && entry.restoreReplayPartial === true
        ? {
            partial: true as const,
            ...(typeof entry.restoreReplayError === 'string'
              ? { replayError: entry.restoreReplayError }
              : {}),
          }
        : {};
    // Clients seed their reconnect cursor from `lastEventId`; the epoch
    // token must travel with it so a daemon restart between this response
    // and the first subscribe is detected (stale cursor + dead epoch).
    const eventEpoch = entry.events.epoch;
    const snapshot = entry.events.snapshotReplay(liveReplayMode);
    if (!snapshot) {
      return {
        lastEventId: entry.events.lastEventId,
        eventEpoch,
        ...replayStatus,
        ...(action === 'load' &&
        entry.restoreHistoryAnchorRecordId !== undefined
          ? { historyAnchorRecordId: entry.restoreHistoryAnchorRecordId }
          : {}),
      };
    }
    if (action === 'load') {
      const liveJournal = snapshot.liveJournal.map((event) => {
        if (
          !entry.activePromptId ||
          event.type !== 'history_truncated' ||
          !event.data ||
          typeof event.data !== 'object' ||
          (event.data as { scope?: unknown }).scope !== 'live_journal'
        ) {
          return event;
        }
        return { ...event, promptId: entry.activePromptId };
      });
      return {
        compactedReplay: snapshot.compactedTurns,
        liveJournal,
        lastEventId: snapshot.lastEventId,
        eventEpoch,
        ...replayStatus,
        ...(snapshot.degraded ? { replayDegraded: true } : {}),
        ...(entry.restoreHistoryHasMore === true
          ? { historyHasMore: true }
          : {}),
        ...(entry.restoreHistoryAnchorRecordId !== undefined
          ? { historyAnchorRecordId: entry.restoreHistoryAnchorRecordId }
          : {}),
      };
    }
    return { lastEventId: snapshot.lastEventId, eventEpoch, ...replayStatus };
  };

  const restoredArtifactSnapshotFromState = (
    state: BridgeSessionState,
  ): RebuiltSessionArtifactSnapshot | undefined => {
    const candidate = state.artifactSnapshot;
    const warnings: string[] = [];
    const snapshot = normalizeSnapshotPayload(candidate, warnings);
    if (!snapshot) return undefined;
    const snapshotWarnings =
      isRecord(candidate) && Array.isArray(candidate['warnings'])
        ? candidate['warnings']
            .filter(
              (warning): warning is string =>
                typeof warning === 'string' && warning.length <= 1000,
            )
            .slice(-500)
        : [];
    return {
      v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
      sessionId: snapshot.sessionId,
      sequence: snapshot.sequence,
      artifacts: snapshot.artifacts,
      ...(snapshot.markerArtifacts
        ? { markerArtifacts: snapshot.markerArtifacts }
        : {}),
      tombstonedIds: snapshot.tombstonedIds ?? [],
      stickyEphemeralIds: snapshot.stickyEphemeralIds ?? [],
      warnings: [...warnings, ...snapshotWarnings],
    };
  };

  const artifactSnapshotUnavailableReason = (
    state: BridgeSessionState,
  ): string | undefined => {
    const reason = state.artifactSnapshotUnavailable;
    return typeof reason === 'string' && reason ? reason : undefined;
  };

  const publicRestoreState = (
    state: BridgeSessionState,
  ): BridgeSessionState => {
    const {
      artifactSnapshot: _artifactSnapshot,
      artifactSnapshotUnavailable: _artifactSnapshotUnavailable,
      ...publicState
    } = state;
    return publicState;
  };

  async function requestSessionTranscriptPage(
    req: BridgeSessionTranscriptPageRequest,
  ): Promise<BridgeSessionTranscriptPage> {
    const info = await ensureChannel();
    try {
      const response = await withWorkspaceControl(info, () =>
        withTimeout(
          Promise.race([
            info.connection.extMethod(
              SERVE_STATUS_EXT_METHODS.sessionTranscript,
              { ...req, cwd: boundWorkspace },
            ),
            getChannelClosedReject(info),
          ]),
          Math.max(initTimeoutMs, SESSION_TRANSCRIPT_TIMEOUT_MS),
          SERVE_STATUS_EXT_METHODS.sessionTranscript,
        ),
      );
      return response as unknown as BridgeSessionTranscriptPage;
    } catch (err) {
      if (isAcpSessionResourceNotFound(err, req.sessionId)) {
        throw new SessionNotFoundError(req.sessionId);
      }
      throw err;
    } finally {
      if (hasNoChannelWork(info)) {
        await startIdleTimer(info, 'session transcript');
      }
    }
  }

  async function refreshedReplayFieldsFor(
    entry: SessionEntry,
    historyPageSize: number,
    liveReplayMode: 'full' | 'summary',
  ): Promise<ReturnType<typeof replayFieldsFor>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const lastEventId = entry.events.lastEventId;
        const eventEpoch = entry.events.epoch;
        const seenCursors = new Set<string>();
        let emptyPageCount = 0;
        let cursor: string | undefined;
        let page: BridgeSessionTranscriptPage;
        do {
          page = await requestSessionTranscriptPage({
            sessionId: entry.sessionId,
            ...(cursor ? { cursor } : { direction: 'backward' }),
            limit: historyPageSize,
          });
          const nextCursor = page.nextCursor;
          if (
            page.events.length === 0 &&
            page.hasMore &&
            (nextCursor === undefined || seenCursors.has(nextCursor))
          ) {
            throw new Error('Transcript cursor did not advance');
          }
          if (
            page.events.length === 0 &&
            page.hasMore &&
            ++emptyPageCount >= MAX_EMPTY_TRANSCRIPT_PAGES
          ) {
            throw new Error('Transcript empty-page limit exceeded');
          }
          cursor = nextCursor;
          if (cursor !== undefined) seenCursors.add(cursor);
        } while (
          page.events.length === 0 &&
          page.hasMore &&
          cursor !== undefined &&
          page.partial !== true &&
          page.replayError === undefined
        );
        if (
          byId.get(entry.sessionId) === entry &&
          !entry.promptActive &&
          entry.events.epoch === eventEpoch &&
          entry.events.lastEventId === lastEventId
        ) {
          let compactedReplay = page.events;
          const turnErrorEvent = entry.turnErrorEvent;
          if (turnErrorEvent) {
            // Append only while no newer turn content was journaled after
            // the in-memory terminal: automatic turns (cron/background
            // notification) run without clearing entry.turnError, and
            // re-appending the stale error after their newer content would
            // misplace it in the refreshed transcript. Bookkeeping events
            // carry no turn content and must not defeat the append; a
            // newer turn terminal clears turnErrorEvent at broadcast. The
            // journal holds exactly the events published since the last
            // turn boundary (the terminal itself folds into the replay
            // window), so no history scan is needed.
            const journal = entry.events.liveJournalSnapshot() ?? [];
            const hasNewerTurnContent = journal.some(
              isRefreshAppendTurnContent,
            );
            if (!hasNewerTurnContent) {
              compactedReplay = [...page.events, turnErrorEvent];
            }
          }
          return {
            compactedReplay,
            liveJournal: [],
            lastEventId,
            eventEpoch,
            ...(page.partial === true ? { partial: true as const } : {}),
            ...(page.replayError !== undefined
              ? { replayError: page.replayError }
              : {}),
            ...(page.hasMore ? { historyHasMore: true as const } : {}),
          };
        }
      } catch {
        // A failed bounded read (missing/unreadable persisted transcript or a
        // workspace timeout) must not tear down a healthy live session; fall
        // back to the in-memory replay instead of surfacing a terminal error.
        break;
      }
    }
    return replayFieldsFor(entry, 'load', liveReplayMode);
  }

  /**
   * Read a `qwen.session.recordId` off a transcript-page event. Unlike
   * `replayRecordId` (which only handles the eventBus-wrapped
   * `data.update._meta` shape), persisted-transcript events carry the
   * ACP update flat under `data` with `_meta` at `data._meta`, so this
   * accepts both shapes.
   */
  function transcriptEventRecordId(event: BridgeEvent): string | undefined {
    if (event.type !== 'session_update') return undefined;
    const data = event.data;
    if (!data || typeof data !== 'object' || Array.isArray(data))
      return undefined;
    const rec = data as Record<string, unknown>;
    const update = rec['update'];
    const meta =
      update && typeof update === 'object' && !Array.isArray(update)
        ? (update as Record<string, unknown>)['_meta']
        : rec['_meta'];
    if (!meta || typeof meta !== 'object' || Array.isArray(meta))
      return undefined;
    const recordId = (meta as Record<string, unknown>)['qwen.session.recordId'];
    return typeof recordId === 'string' ? recordId : undefined;
  }

  /**
   * Backfill a pagination anchor when the replay snapshot carries a
   * `history_truncated` marker with no `recordId`.
   *
   * Live sessions whose in-flight turn pushed the journal past its cap
   * before any turn boundary fired have no recordId-bearing
   * `session_update` in the retained window — `qwen.session.recordId`
   * is only stamped during replay of the persisted transcript
   * (HistoryReplayer), never on the live event stream — so the
   * compaction engine's marker ships without an anchor and the client
   * has no `beforeRecordId` to page backward with. Read the oldest
   * recordId from the last persisted transcript page and return it so
   * the client can still recover the dropped history. The oldest anchor
   * is deliberately conservative: it cannot re-fetch records the client
   * already displays, at the cost of leaving records newer than the
   * anchor in the same page unreachable via backward pagination.
   * Best-effort: any failure
   * (missing transcript, workspace timeout, no recordId in the page)
   * yields `undefined` and the caller simply omits the field.
   */
  async function resolveHistoryAnchorRecordId(
    entry: SessionEntry,
    replayFields: Pick<
      BridgeRestoredSession,
      'compactedReplay' | 'liveJournal'
    >,
  ): Promise<string | undefined> {
    const events = [
      ...(replayFields.compactedReplay ?? []),
      ...(replayFields.liveJournal ?? []),
    ];
    const hasMarker = events.some((e) => e.type === 'history_truncated');
    if (!hasMarker) return undefined;
    // A marker that already carries a recordId (or a retained
    // session_update that does) needs no backfill — the client can
    // anchor on it directly. `transcriptEventRecordId` reads both the
    // eventBus-wrapped (`data.update._meta`) and the flat persisted
    // (`data._meta`) shapes so this holds for the in-memory snapshot
    // and the refreshed persisted page alike.
    const hasRecordId = events.some(
      (e) =>
        transcriptEventRecordId(e) !== undefined ||
        (e.type === 'history_truncated' &&
          isRecord(e.data) &&
          typeof e.data['recordId'] === 'string'),
    );
    if (hasRecordId) return undefined;
    try {
      const page = await requestSessionTranscriptPage({
        sessionId: entry.sessionId,
        direction: 'backward',
        limit: 50,
      });
      // The backward page is chronological ascending; the first recordId
      // we hit is the oldest in the last page — a conservative anchor
      // that cannot re-fetch displayed records.
      for (const event of page.events) {
        const recordId = transcriptEventRecordId(event);
        if (recordId !== undefined) return recordId;
      }
    } catch {
      // Best-effort: a failed read must not break session load.
    }
    return undefined;
  }

  const sendTrackedPrompt: {
    fn: AcpSessionBridge['sendPrompt'] | undefined;
  } = { fn: undefined };

  // Fire-and-forget restore prompt for a session whose transcript ends on an
  // unanswered ask_user_question. Returns true only when the prompt was
  // admitted synchronously. Best-effort: admission failures (sendPrompt
  // throws synchronously by contract) and async failures are logged, never
  // propagated — a successful load/resume must not error over a side effect.
  const maybeFireRestoreAskUserQuestionPrompt = (
    entry: SessionEntry,
    restoreAskUserQuestionHint: boolean,
    requestedClientId: string | undefined,
    registeredClientId: string,
    options: { suppressRestorePrompt?: boolean },
  ): boolean => {
    if (
      opts.restoreAskUserQuestion !== true ||
      restoreAskUserQuestionHint !== true ||
      // Nobody can answer the re-hung question without an attached client;
      // internal restores (boot rehydrate, keepalive, sub-session resume)
      // pass no clientId and must not fabricate an unbounded permission wait.
      requestedClientId === undefined ||
      options.suppressRestorePrompt === true ||
      // Admission-time busy check: pendingPromptCount flips synchronously
      // when a prompt is accepted, before the queue callback sets
      // promptActive; Goal turns never set promptActive at all.
      entry.promptActive ||
      entry.pendingPromptCount > 0 ||
      entry.goalTurnActive === true
    ) {
      return false;
    }
    let restorePrompt: Promise<PromptResponse> | undefined;
    try {
      restorePrompt = sendTrackedPrompt.fn?.(
        entry.sessionId,
        { sessionId: entry.sessionId, prompt: [] } as Parameters<
          AcpSessionBridge['sendPrompt']
        >[1],
        undefined,
        { clientId: registeredClientId, restoreAskUserQuestion: true },
      );
    } catch (err) {
      teeServeDebugLine(
        `restoreAskUserQuestion: restore prompt admission failed for ${entry.sessionId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
    restorePrompt?.catch((err) => {
      teeServeDebugLine(
        `restoreAskUserQuestion: restore prompt failed for ${entry.sessionId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return true;
  };

  async function restoreSession(
    action: 'load' | 'resume',
    req: BridgeRestoreSessionRequest,
    options: {
      skipFreshSessionAdmission?: boolean;
      suppressRestorePrompt?: boolean;
    } = {},
  ): Promise<BridgeRestoredSession> {
    if (shuttingDown) {
      throw new Error('AcpSessionBridge is shutting down');
    }
    const workspaceKey = resolveWorkspaceKey(req.workspaceCwd);
    if (
      req.approvalMode !== undefined &&
      !KNOWN_APPROVAL_MODES.has(req.approvalMode)
    ) {
      throw new Error(
        `Invalid approvalMode: ${JSON.stringify(req.approvalMode)}`,
      );
    }
    const historyReplay =
      action === 'load' ? (req.historyReplay ?? 'stream') : 'stream';
    const historyPageSize =
      action === 'load' && historyReplay === 'response'
        ? req.historyPageSize
        : undefined;
    const requestedLiveReplayMode = req.liveReplayMode;
    if (
      requestedLiveReplayMode !== undefined &&
      requestedLiveReplayMode !== 'full' &&
      requestedLiveReplayMode !== 'summary'
    ) {
      throw new Error(
        `Invalid liveReplayMode: ${JSON.stringify(requestedLiveReplayMode)}`,
      );
    }
    const liveReplayMode =
      action === 'load' ? (requestedLiveReplayMode ?? 'full') : 'full';
    if (
      historyPageSize !== undefined &&
      (!Number.isSafeInteger(historyPageSize) ||
        historyPageSize < 1 ||
        historyPageSize > SESSION_TRANSCRIPT_MAX_LIMIT)
    ) {
      throw new Error(
        `Invalid historyPageSize; expected 1..${SESSION_TRANSCRIPT_MAX_LIMIT}`,
      );
    }
    const hideInheritedHistory =
      action === 'load' && req.hideInheritedHistory === true;

    const existing = byId.get(req.sessionId);
    if (existing) {
      assertAttachableSessionEntry(req.sessionId, existing);
      const replayFields =
        historyPageSize !== undefined
          ? await refreshedReplayFieldsFor(
              existing,
              historyPageSize,
              liveReplayMode,
            )
          : replayFieldsFor(existing, action, liveReplayMode);
      // Backfill a pagination anchor when the snapshot's truncation
      // marker carries no recordId (live session, in-flight turn capped
      // the journal before any turn boundary). Best-effort; omitted on
      // any failure so load never breaks on its account.
      const historyAnchorRecordId =
        action === 'load'
          ? await resolveHistoryAnchorRecordId(existing, replayFields)
          : undefined;
      assertAttachableSessionEntry(req.sessionId, existing);
      existing.attachCount++;
      const clientId = registerClient(existing, req.clientId);
      recordAttachRef(existing, clientId);
      if (req.approvalMode) {
        const previousApprovalMode = await applyApprovalModeForAttach(
          existing,
          req.approvalMode,
          clientId,
        );
        try {
          assertAttachableSessionEntry(req.sessionId, existing);
        } catch (error) {
          await rollbackApprovalModeForRejectedAttach(
            existing,
            previousApprovalMode,
            clientId,
          );
          await rollbackAttachRegistration(existing, clientId);
          throw error;
        }
      }
      return {
        sessionId: existing.sessionId,
        workspaceCwd: existing.workspaceCwd,
        ...(existing.effectiveCwd !== existing.workspaceCwd
          ? { currentCwd: existing.effectiveCwd }
          : {}),
        attached: true,
        clientId,
        createdAt: existing.createdAt,
        ...(existing.sourceType ? { sourceType: existing.sourceType } : {}),
        ...(existing.sourceId !== undefined
          ? { sourceId: existing.sourceId }
          : {}),
        // Late attachers get the same ACP state the original restore
        // caller saw; spawn-only sessions don't carry a state payload.
        state: existing.restoreState ?? {},
        hasActivePrompt:
          existing.promptActive || existing.goalTurnActive === true,
        ...replayFields,
        ...(historyAnchorRecordId !== undefined
          ? { historyAnchorRecordId }
          : {}),
      };
    }

    if (inFlightRequestedSessionSpawns.has(req.sessionId)) {
      throw new RestoreInProgressError(req.sessionId, 'spawn', action);
    }

    const inFlight = inFlightRestores.get(req.sessionId);
    if (inFlight) {
      // Cold restores only coalesce when their effective request shapes
      // match. Sharing across actions, replay transports, response pages, or
      // inherited-history policies can return replay selected for another
      // caller. Same-shape coalescing is unaffected. The one directional
      // exception is liveReplayMode: a summary request safely shares an
      // in-flight full restore because once the restore settles the daemon
      // recomputes the waiter's replay fields for its own mode from the
      // registered entry — the two journals can diverge under cap pressure
      // (each evicts independently against the shared caps), so the owner's
      // projected fields can never be reused or filtered down for a waiter
      // of a different mode. Only the reverse — a full request joining a
      // summary restore — stays fenced: that projection lacks the nested
      // detail the full client expects.
      if (
        inFlight.lifecycle.phase === 'abandoned' ||
        action !== inFlight.action ||
        historyReplay !== inFlight.historyReplay ||
        historyPageSize !== inFlight.historyPageSize ||
        (inFlight.liveReplayMode === 'summary' && liveReplayMode === 'full') ||
        hideInheritedHistory !== inFlight.hideInheritedHistory
      ) {
        // An abandoned restore is fenced until the real ACP request and its
        // cleanup settle, which takes at least as long as the budget the
        // request already blew through. Hinting the ordinary 5s here would
        // just spin the caller against a fence it cannot clear.
        const abandoned = inFlight.lifecycle.phase === 'abandoned';
        throw new RestoreInProgressError(
          req.sessionId,
          inFlight.action,
          action,
          abandoned
            ? {
                reason: 'awaiting_abandoned_cleanup',
                retryAfterSeconds: abandonedRestoreRetryAfterSeconds,
              }
            : undefined,
        );
      }
      // Reserve the attach SYNCHRONOUSLY before awaiting so the spawn
      // owner's `requireZeroAttaches` disconnect-reaper observes our
      // intent. The IIFE folds this counter into `entry.attachCount`
      // at `createSessionEntry` time.
      inFlight.coalesceState.count++;
      let restored: BridgeRestoredSession;
      try {
        restored = await inFlight.publicPromise;
      } catch (err) {
        // Roll back our reservation so a subsequent retry isn't
        // permanently skewed if the in-flight restore failed.
        inFlight.coalesceState.count--;
        throw err;
      }
      const entry = byId.get(restored.sessionId);
      if (!entry) {
        // Restore owner's session got reaped before our await
        // resumed (channel died mid-microtask, etc). Roll back the
        // reservation too — there's no entry for it to live on.
        inFlight.coalesceState.count--;
        throw new SessionNotFoundError(
          restored.sessionId,
          'the agent child likely crashed during session restore — retry to restore the session',
        );
      }
      try {
        assertAttachableSessionEntry(restored.sessionId, entry);
      } catch (error) {
        inFlight.coalesceState.count--;
        entry.attachCount = Math.max(0, entry.attachCount - 1);
        throw error;
      }
      // The owner's result carries replay fields selected for the OWNER'S
      // live replay mode. A waiter whose mode differs (a summary load that
      // joined a full restore — the only asymmetric direction the fence
      // admits) recomputes its own fields from the registered entry, exactly
      // as the existing-entry attach path above does — before registering —
      // instead of inheriting the owner's unprojected full journal — which
      // would include nested frames the summary client discards and the full
      // journal's `history_truncated` marker even when the summary journal
      // never truncated.
      const waiterReplayFields =
        liveReplayMode !== inFlight.liveReplayMode
          ? historyPageSize !== undefined
            ? await refreshedReplayFieldsFor(
                entry,
                historyPageSize,
                liveReplayMode,
              )
            : replayFieldsFor(entry, action, liveReplayMode)
          : undefined;
      // `refreshedReplayFieldsFor` swallows fetch failures into the
      // in-memory fallback, so re-assert after the await above: a channel
      // death mid-fetch would otherwise attach the waiter to a session the
      // daemon already tore down.
      try {
        assertAttachableSessionEntry(restored.sessionId, entry);
      } catch (error) {
        inFlight.coalesceState.count--;
        entry.attachCount = Math.max(0, entry.attachCount - 1);
        throw error;
      }
      // NOTE: do NOT bump entry.attachCount here — `createSessionEntry`
      // already initialized it from coalesceState.count synchronously
      // when the IIFE registered the entry. Spread `restored` so the
      // ACP state propagates to coalesced waiters (BQ9tV-equivalent
      // for restore waiter consistency).
      const clientId = registerClient(entry, req.clientId);
      // This coalescer's attachCount contribution was pre-folded via
      // `coalesceState.count`, so only the ledger is updated here.
      recordAttachRef(entry, clientId);
      if (req.approvalMode) {
        const previousApprovalMode = await applyApprovalModeForAttach(
          entry,
          req.approvalMode,
          clientId,
        );
        try {
          assertAttachableSessionEntry(restored.sessionId, entry);
        } catch (error) {
          await rollbackApprovalModeForRejectedAttach(
            entry,
            previousApprovalMode,
            clientId,
          );
          await rollbackAttachRegistration(entry, clientId);
          throw error;
        }
      }
      return {
        ...restored,
        attached: true,
        clientId,
        createdAt: entry.createdAt,
        hasActivePrompt: entry.promptActive || entry.goalTurnActive === true,
        ...(waiterReplayFields ?? {}),
      };
    }

    assertFreshSessionsAvailable();
    if (
      byId.size + inFlightSpawns.size + inFlightRestores.size >=
      maxSessions
    ) {
      throw new SessionLimitExceededError(maxSessions);
    }

    const restoreEvents = createSessionEventBus(req.sessionId);
    let registeredEntry: SessionEntry | undefined;
    let ci: ChannelInfo | undefined;
    // Live counter shared with coalesced waiters (see InFlightRestore
    // doc comment). Mutated synchronously by the coalesce branch above
    // and read once by the IIFE when seeding `entry.attachCount`.
    const coalesceState = { count: 0 };
    const admission =
      options.skipFreshSessionAdmission === true
        ? undefined
        : reserveFreshSession({
            operation: action,
            workspaceCwd: workspaceKey,
            sessionId: req.sessionId,
          });
    let admissionReleased = false;
    const releaseAdmissionOnce = () => {
      if (admissionReleased) return;
      admissionReleased = true;
      releaseFreshSessionReservation(admission);
    };
    let resolveSettlement!: () => void;
    const settlementPromise = new Promise<void>((resolve) => {
      resolveSettlement = resolve;
    });
    const restoreLifecycle: InFlightRestore['lifecycle'] = {
      phase: 'active',
    };
    const settleAbandonedRestore = async (
      channel: ChannelInfo,
      lateResult: 'success' | 'failure',
    ) => {
      telemetry.event('session.restore.late_result', {
        'qwen-code.daemon.session_restore.action': action,
        'qwen-code.daemon.session_restore.result': lateResult,
        'qwen-code.daemon.session_restore.timeout_ms': sessionRestoreTimeoutMs,
        'qwen-code.daemon.acp_channel.id': channel.id,
        'session.id': req.sessionId,
      });
      // Defense in depth behind the same-id spawn rejection above. An
      // abandoned restore never reaches `createSessionEntry` — the deadline
      // rejects before registration — so ANY live entry under this id belongs
      // to someone else. Closing by bare id would tear down that owner and
      // tombstone its id. Bail out and let the usurper's own lifecycle govern
      // the child session instead.
      const usurper = byId.get(req.sessionId);
      if (usurper) {
        writeStderrLine(
          `qwen serve: skipping abandoned session/${action} cleanup for ${JSON.stringify(req.sessionId)}: the id is now owned by a live session`,
        );
        telemetry.event('session.restore.cleanup', {
          'qwen-code.daemon.session_restore.action': action,
          'qwen-code.daemon.session_restore.cleanup_result': 'id_reclaimed',
          'qwen-code.daemon.session_restore.timeout_ms':
            sessionRestoreTimeoutMs,
          'qwen-code.daemon.acp_channel.id': channel.id,
          'session.id': req.sessionId,
        });
        channel.unsettledAbandonedRestores.delete(req.sessionId);
        const reclaimedTimer = channel.restoreSettlementTimers.get(
          req.sessionId,
        );
        if (reclaimedTimer !== undefined) {
          clearTimeout(reclaimedTimer);
          channel.restoreSettlementTimers.delete(req.sessionId);
        }
        if (channel.unsettledAbandonedRestores.size === 0) {
          channel.restoreSettlementOverdue = false;
        }
        releaseAdmissionOnce();
        resolveSettlement();
        return;
      }
      try {
        if (channel.isDying || !aliveChannels.has(channel)) {
          await channel.channel.exited;
          telemetry.event('session.restore.cleanup', {
            'qwen-code.daemon.session_restore.action': action,
            'qwen-code.daemon.session_restore.cleanup_result':
              'transport_closed',
            'qwen-code.daemon.session_restore.timeout_ms':
              sessionRestoreTimeoutMs,
            'qwen-code.daemon.acp_channel.id': channel.id,
            'session.id': req.sessionId,
          });
          return;
        }
        try {
          await Promise.race([
            withTimeout(
              channel.connection.extMethod(
                SERVE_CONTROL_EXT_METHODS.sessionClose,
                {
                  sessionId: req.sessionId,
                  drainTimeoutMs: sessionCloseDrainBudgetMs(initTimeoutMs),
                },
              ),
              initTimeoutMs,
              'abandonedRestoreClose',
            ),
            getChannelClosedReject(channel),
          ]);
          telemetry.event('session.restore.cleanup', {
            'qwen-code.daemon.session_restore.action': action,
            'qwen-code.daemon.session_restore.cleanup_result': 'closed',
            'qwen-code.daemon.session_restore.timeout_ms':
              sessionRestoreTimeoutMs,
            'qwen-code.daemon.acp_channel.id': channel.id,
            'session.id': req.sessionId,
          });
        } catch (error) {
          if (isAcpSessionResourceNotFound(error, req.sessionId)) {
            telemetry.event('session.restore.cleanup', {
              'qwen-code.daemon.session_restore.action': action,
              'qwen-code.daemon.session_restore.cleanup_result': 'not_found',
              'qwen-code.daemon.session_restore.timeout_ms':
                sessionRestoreTimeoutMs,
              'qwen-code.daemon.acp_channel.id': channel.id,
              'session.id': req.sessionId,
            });
            return;
          }
          if (channel.isDying || !aliveChannels.has(channel)) {
            await channel.channel.exited;
            telemetry.event('session.restore.cleanup', {
              'qwen-code.daemon.session_restore.action': action,
              'qwen-code.daemon.session_restore.cleanup_result':
                'transport_closed',
              'qwen-code.daemon.session_restore.timeout_ms':
                sessionRestoreTimeoutMs,
              'qwen-code.daemon.acp_channel.id': channel.id,
              'session.id': req.sessionId,
            });
            return;
          }
          // `isQuarantined` is itself both a reap-when-idle reason and a
          // fresh-admission blocker, so there is no separate flag to set here.
          channel.isQuarantined = true;
          writeStderrLine(
            `qwen serve: quarantining ACP channel after timed-out session/${action} cleanup failed for ${JSON.stringify(req.sessionId)}: ${extractErrorMessage(error)}`,
          );
          telemetry.event('session.restore.cleanup', {
            'qwen-code.daemon.session_restore.action': action,
            'qwen-code.daemon.session_restore.cleanup_result': 'quarantined',
            'qwen-code.daemon.session_restore.timeout_ms':
              sessionRestoreTimeoutMs,
            'qwen-code.daemon.acp_channel.id': channel.id,
            'session.id': req.sessionId,
          });
          if (hasNoChannelWork(channel)) {
            void killChannelWithLog(
              channel,
              `abandoned session/${action} cleanup`,
            );
          }
          await channel.channel.exited;
        }
      } finally {
        channel.client.markSessionClosed(req.sessionId);
        // The hidden work is over. If nothing else condemns this channel it
        // goes back to the normal idle policy; if the channel is quarantined
        // or another abandoned restore is still outstanding, those reasons
        // keep standing on their own.
        channel.unsettledAbandonedRestores.delete(req.sessionId);
        const graceTimer = channel.restoreSettlementTimers.get(req.sessionId);
        if (graceTimer !== undefined) {
          clearTimeout(graceTimer);
          channel.restoreSettlementTimers.delete(req.sessionId);
        }
        // Only the last overdue restore lifts the admission block; a second
        // one still outstanding keeps the channel closed to fresh work.
        if (channel.unsettledAbandonedRestores.size === 0) {
          channel.restoreSettlementOverdue = false;
        }
        releaseAdmissionOnce();
        resolveSettlement();
      }
    };
    const promise = (async (): Promise<BridgeRestoredSession> => {
      pendingRestoreEvents.set(req.sessionId, restoreEvents);
      const restoreChannel = await ensureChannel();
      if (restoreChannel.isDying) {
        throw new BridgeChannelClosedError(`before session/${action}`);
      }
      ci = restoreChannel;
      restoreChannel.pendingRestoreIds.add(req.sessionId);
      // Mark this id as in-flight restore BEFORE the ACP
      // `loadSession`/`unstable_resumeSession` call. Restore-time
      // guardrail events arriving during that ACP call hit
      // `bufferEarlyEvent` BEFORE the post-restore
      // `createSessionEntry -> drainEarlyEvents` clears the tombstone,
      // so without this allow-list the tombstone would silently drop
      // them. Cleared in the matching `finally` below.
      restoreChannel.client.markRestoreInFlight(req.sessionId);
      // Restore is a low-frequency one-shot path, so we register a
      // fresh channel-unavailable race per call instead of going
      // through `getTransportClosedReject` (which exists to keep
      // sendPrompt's per-session listener count at 1 over the
      // session's lifetime). The listener is bound to this restore's
      // race only — once the race settles, no new awaits attach to
      // it, so there's no listener leak across restores.
      const transportClosed = channelUnavailableReject(
        restoreChannel.channel,
        `during session/${action}`,
      );
      // Suppress the dangling rejection if `withTimeout` wins the
      // race below: `transportClosed` then stays pending, and a
      // later channel-unavailable settle fires the inner `throw` with
      // no observer attached. Node 22 logs `unhandledRejection`;
      // under `--unhandled-rejections=throw` (common in container
      // deployments) the daemon process crashes. The `Promise.race`
      // path's own consumer below catches the rejection in the
      // try/catch, so the suppressed rejection here is the
      // race-loser case only.
      transportClosed.catch(() => {});
      let state: BridgeSessionState;
      let replayUpdates: SessionUpdate[] = [];
      let replayPartial: true | undefined;
      let replayError: string | undefined;
      let replayHasMore: true | undefined;
      let replayAnchorRecordId: string | undefined;
      let restoreAskUserQuestionHint = false;
      try {
        const rawRestore = telemetry.withSpan(
          'session.restore',
          {
            'qwen-code.daemon.bridge.operation': `session.${action}`,
            'qwen-code.daemon.session_restore.action': action,
            'qwen-code.daemon.acp_channel.id': restoreChannel.id,
            'qwen-code.daemon.session_restore.timeout_ms':
              sessionRestoreTimeoutMs,
            'session.id': req.sessionId,
          },
          async () => {
            if (action === 'load') {
              const request = telemetry.injectPromptContext({
                sessionId: req.sessionId,
                cwd: workspaceKey,
                // Restore path drops per-request `mcpServers` (matches
                // `doSpawn`); daemon-wide MCP comes from settings on
                // the agent side. The SDK's `RestoreSessionRequest`
                // intentionally has no `mcpServers` field for the
                // same reason.
                mcpServers: [],
                _meta: {
                  ...sessionSourceRequestMeta(req.sourceType, req.sourceId),
                  // Decline decisions known before the child RPC: keep the
                  // child's replay finalize-skip aligned with the re-hang.
                  ...(opts.restoreAskUserQuestion === true &&
                  (req.clientId === undefined ||
                    options.suppressRestorePrompt === true)
                    ? {
                        [DAEMON_SUPPRESS_RESTORE_ASK_USER_QUESTION_META_KEY]: true,
                      }
                    : {}),
                  ...(historyReplay === 'response'
                    ? {
                        [LOAD_REPLAY_MODE_META_KEY]: LOAD_REPLAY_BULK_MODE,
                        ...(historyPageSize !== undefined
                          ? {
                              [LOAD_REPLAY_PAGE_SIZE_META_KEY]: historyPageSize,
                            }
                          : {}),
                      }
                    : {}),
                  ...(hideInheritedHistory
                    ? { [LOAD_REPLAY_HIDE_INHERITED_META_KEY]: true }
                    : {}),
                },
              });
              return await restoreChannel.connection.loadSession(request);
            }
            const request = telemetry.injectPromptContext({
              sessionId: req.sessionId,
              cwd: workspaceKey,
              mcpServers: [],
              _meta: {
                ...sessionSourceRequestMeta(req.sourceType, req.sourceId),
                ...(opts.restoreAskUserQuestion === true &&
                (req.clientId === undefined ||
                  options.suppressRestorePrompt === true)
                  ? {
                      [DAEMON_SUPPRESS_RESTORE_ASK_USER_QUESTION_META_KEY]: true,
                    }
                  : {}),
              },
            });
            return await restoreChannel.connection.unstable_resumeSession(
              request,
            );
          },
        );
        const observedRestore = Promise.race([rawRestore, transportClosed]);
        state = await new Promise<BridgeSessionState>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (restoreLifecycle.phase !== 'active') return;
            restoreLifecycle.phase = 'abandoned';
            restoreChannel.pendingRestoreIds.delete(req.sessionId);
            restoreChannel.client.markRestoreAbandoned(req.sessionId);
            pendingRestoreEvents.delete(req.sessionId);
            restoreEvents.close();
            // Condemn the channel only for as long as this restore is
            // genuinely unresolved. `settleAbandonedRestore` clears the entry,
            // so a late result that lands cleanly hands the channel back to
            // the configured idle policy instead of forcing a cold respawn on
            // the strength of a timeout it already recovered from.
            restoreChannel.unsettledAbandonedRestores.add(req.sessionId);
            const channelWasEmpty = hasNoChannelWork(restoreChannel);
            telemetry.event('session.restore.public_result', {
              'qwen-code.daemon.session_restore.action': action,
              'qwen-code.daemon.session_restore.result': 'timeout',
              'qwen-code.daemon.session_restore.timeout_ms':
                sessionRestoreTimeoutMs,
              'qwen-code.daemon.acp_channel.id': restoreChannel.id,
              'qwen-code.daemon.session_restore.channel_was_empty':
                channelWasEmpty,
              'session.id': req.sessionId,
            });
            writeStderrLine(
              `qwen serve: session/${action} timed out after ${sessionRestoreTimeoutMs}ms for ${JSON.stringify(req.sessionId)} on channel ${restoreChannel.id}; decision=${channelWasEmpty ? 'kill_empty' : 'fence_shared'}`,
            );
            if (channelWasEmpty) {
              void killChannelWithLog(
                restoreChannel,
                `timed-out session/${action} on empty channel`,
              );
            } else {
              armRestoreSettlementGrace(restoreChannel, req.sessionId, action);
            }
            reject(
              new SessionRestoreTimeoutError(
                req.sessionId,
                action,
                sessionRestoreTimeoutMs,
              ),
            );
          }, sessionRestoreTimeoutMs);
          timer.unref();
          void observedRestore.then(
            (value) => {
              if (restoreLifecycle.phase === 'active') {
                clearTimeout(timer);
                resolve(value);
                return;
              }
              void settleAbandonedRestore(restoreChannel, 'success');
            },
            (error: unknown) => {
              if (restoreLifecycle.phase === 'active') {
                clearTimeout(timer);
                reject(error);
                return;
              }
              void settleAbandonedRestore(restoreChannel, 'failure');
            },
          );
        });
        if (action === 'load' && historyReplay === 'response') {
          const extracted = extractLoadReplayResponse(state);
          state = extracted.state;
          replayUpdates = extracted.updates;
          replayPartial = extracted.partial;
          replayError = extracted.replayError;
          replayHasMore = extracted.hasMore === true ? true : undefined;
          replayAnchorRecordId = extracted.anchorRecordId;
        }
        const restoreHint = takeRestoreAskUserQuestionHint(state);
        restoreAskUserQuestionHint = restoreHint.hint;
        state = restoreHint.state;
      } catch (err) {
        if (err instanceof SessionRestoreTimeoutError) throw err;
        restoreEvents.close();
        if (isAcpSessionResourceNotFound(err, req.sessionId)) {
          throw new SessionNotFoundError(req.sessionId);
        }
        ci.emptyReapPending = hasNoChannelWork(ci, {
          ignoreRestoreId: req.sessionId,
        });
        if (ci.emptyReapPending) {
          ci.isDying = true;
        }
        throw err;
      }

      if (shuttingDown) {
        restoreEvents.close();
        throw new Error('AcpSessionBridge is shutting down');
      }
      if (ci.isDying || !aliveChannels.has(ci)) {
        restoreEvents.close();
        throw new Error(
          `Session ${req.sessionId} restored on a closed agent channel`,
        );
      }
      const racedEntry = byId.get(req.sessionId);
      if (racedEntry) {
        restoreEvents.close();
        assertAttachableSessionEntry(req.sessionId, racedEntry);
        // Self + any coalescers we accumulated while the restore was
        // in flight. Coalescers must not bump attachCount themselves
        // (they read it off the registered entry on the next tick).
        racedEntry.attachCount += 1 + coalesceState.count;
        const clientId = registerClient(racedEntry, req.clientId);
        recordAttachRef(racedEntry, clientId);
        if (req.approvalMode) {
          let previousApprovalMode: ApprovalMode;
          try {
            const result = await applyApprovalMode(
              racedEntry,
              req.approvalMode,
              false,
              clientId,
            );
            previousApprovalMode = result.previous;
          } catch (err) {
            await rollbackAttachRegistration(
              racedEntry,
              clientId,
              1 + coalesceState.count,
            );
            throw err;
          }
          try {
            assertAttachableSessionEntry(req.sessionId, racedEntry);
          } catch (error) {
            await rollbackApprovalModeForRejectedAttach(
              racedEntry,
              previousApprovalMode,
              clientId,
            );
            await rollbackAttachRegistration(
              racedEntry,
              clientId,
              1 + coalesceState.count,
            );
            throw error;
          }
        }
        const restorePromptAdmitted = maybeFireRestoreAskUserQuestionPrompt(
          racedEntry,
          restoreAskUserQuestionHint,
          req.clientId,
          clientId,
          options,
        );
        return {
          sessionId: racedEntry.sessionId,
          workspaceCwd: racedEntry.workspaceCwd,
          ...(racedEntry.effectiveCwd !== racedEntry.workspaceCwd
            ? { currentCwd: racedEntry.effectiveCwd }
            : {}),
          attached: true,
          clientId,
          createdAt: racedEntry.createdAt,
          ...(racedEntry.sourceType
            ? { sourceType: racedEntry.sourceType }
            : {}),
          ...(racedEntry.sourceId !== undefined
            ? { sourceId: racedEntry.sourceId }
            : {}),
          state: racedEntry.restoreState ?? {},
          hasActivePrompt:
            restorePromptAdmitted ||
            racedEntry.promptActive ||
            racedEntry.goalTurnActive === true,
          ...replayFieldsFor(racedEntry, action, liveReplayMode),
        };
      }

      const entry = createSessionEntry(
        ci,
        req.sessionId,
        workspaceKey,
        restoreEvents,
        {
          drainEarlyEvents: replayUpdates.length === 0,
          lifecycleReason: action,
          // Re-seed the persisted parent lineage the caller recovered from the
          // transcript, so a restored sub-session's status reports its parent.
          ...(req.parentSessionId
            ? { parentSessionId: req.parentSessionId }
            : {}),
          ...(req.sourceType ? { sourceType: req.sourceType } : {}),
          ...(req.sourceId !== undefined ? { sourceId: req.sourceId } : {}),
        },
      );
      releaseAdmissionOnce();
      const restoredArtifactSnapshot = restoredArtifactSnapshotFromState(state);
      const publicState = publicRestoreState(state);
      entry.restoreState = publicState;
      if (replayPartial === true) {
        entry.restoreReplayPartial = true;
      }
      if (replayError !== undefined) {
        entry.restoreReplayError = replayError;
      }
      if (replayHasMore === true) {
        entry.restoreHistoryHasMore = true;
      }
      if (replayAnchorRecordId !== undefined) {
        entry.restoreHistoryAnchorRecordId = replayAnchorRecordId;
      }
      seedSnapshotCaches(entry, publicState);
      const artifactRestoreWarnings = await entry.artifacts.restore(
        restoredArtifactSnapshot,
      );
      for (const warning of artifactRestoreWarnings) {
        writeStderrLine(
          `[artifacts] session=${entry.sessionId} action=restore_warning warning=${JSON.stringify(
            warning,
          )}`,
        );
      }
      const artifactRestoreFailed = artifactRestoreWarnings.some((warning) =>
        isArtifactRestoreFailureWarning(warning),
      );
      if (replayUpdates.length > 0) {
        await ci.client.seedSessionUpdates(entry, replayUpdates, {
          ingestArtifacts:
            restoredArtifactSnapshot === undefined || artifactRestoreFailed,
        });
        if (
          historyPageSize !== undefined &&
          entry.events
            .snapshotReplay()
            ?.compactedTurns.some((event) => event.type === 'history_truncated')
        ) {
          entry.restoreHistoryHasMore = true;
        }
        ci.client.drainEarlyEvents(entry.sessionId, entry);
      }
      assertAttachableSessionEntry(req.sessionId, entry);
      const clientId = registerClient(entry, req.clientId);
      if (req.approvalMode) {
        await applyApprovalModeForAttach(entry, req.approvalMode, clientId);
        assertAttachableSessionEntry(req.sessionId, entry);
      }
      // Fold synchronous coalesce reservations into the new entry's
      // `attachCount`. By this point all coalescers that beat us must
      // have hit the inFlightRestores branch and bumped
      // `coalesceState.count`; later coalescers will hit the byId
      // early-return path instead and increment `entry.attachCount`
      // directly.
      entry.attachCount = coalesceState.count;
      registeredEntry = entry;
      const restorePromptAdmitted = maybeFireRestoreAskUserQuestionPrompt(
        entry,
        restoreAskUserQuestionHint,
        req.clientId,
        clientId,
        options,
      );
      // Explicit `session/load` / `session/resume` is "give me THIS
      // id"; it must NOT become the implicit attach target for
      // subsequent omitted-id `POST /session` callers under `single`
      // scope. Those callers asked for "any default", and silently
      // joining a restored live history would surprise them.
      // `defaultEntry` is reserved for sessions created through
      // `doSpawn` under `'single'` scope.
      return {
        sessionId: entry.sessionId,
        workspaceCwd: entry.workspaceCwd,
        attached: false,
        clientId,
        createdAt: entry.createdAt,
        ...(entry.sourceType ? { sourceType: entry.sourceType } : {}),
        ...(entry.sourceId !== undefined ? { sourceId: entry.sourceId } : {}),
        state: publicState,
        ...(artifactRestoreWarnings.length > 0
          ? { artifactWarnings: artifactRestoreWarnings }
          : {}),
        hasActivePrompt:
          restorePromptAdmitted ||
          entry.promptActive ||
          entry.goalTurnActive === true,
        ...replayFieldsFor(entry, action, liveReplayMode),
      };
    })().finally(async () => {
      if (restoreLifecycle.phase === 'abandoned') return;
      releaseAdmissionOnce();
      ci?.pendingRestoreIds.delete(req.sessionId);
      // Pair with `markRestoreInFlight`. Once the IIFE settles, either
      // `createSessionEntry` ran (`drainEarlyEvents` already cleared
      // the tombstone) or the restore failed (handled below).
      ci?.client.clearRestoreInFlight(req.sessionId);
      pendingRestoreEvents.delete(req.sessionId);
      if (!registeredEntry) {
        restoreEvents.close();
        let removedRestoreEntry = false;
        const restoreEntry = byId.get(req.sessionId);
        if (restoreEntry?.events === restoreEvents) {
          byId.delete(req.sessionId);
          await restoreEntry.attachments.close().catch((error) => {
            writeStderrLine(
              `qwen serve: failed to close attachments after restoring session ${JSON.stringify(req.sessionId)}: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
          ci?.sessionIds.delete(req.sessionId);
          emitSessionLifecycle({
            type: 'removed',
            sessionId: req.sessionId,
            workspaceCwd: restoreEntry.workspaceCwd,
            reason: 'restore_failed',
          });
          removedRestoreEntry = true;
        }
        if (removedRestoreEntry && ci && hasNoChannelWork(ci)) {
          ci.emptyReapPending = true;
          ci.isDying = true;
        }
        // On restore failure, purge any guardrail events that the
        // child buffered during this restore window AND re-tombstone
        // the id. Without this, a subsequent successful restore for
        // the same id within 60s would drain stale frames into the
        // new session. `markSessionClosed` already does both: refresh
        // tombstone + delete `earlyEvents[id]`.
        ci?.client.markSessionClosed(req.sessionId);
      }
      if (ci) {
        await reapPendingEmptyChannel(ci);
      }
    });

    void promise.then(
      () => {
        if (restoreLifecycle.phase === 'active') {
          telemetry.event('session.restore.public_result', {
            'qwen-code.daemon.session_restore.action': action,
            'qwen-code.daemon.session_restore.result': 'success',
            'qwen-code.daemon.session_restore.timeout_ms':
              sessionRestoreTimeoutMs,
            ...(ci ? { 'qwen-code.daemon.acp_channel.id': ci.id } : {}),
            'session.id': req.sessionId,
          });
          resolveSettlement();
        }
      },
      () => {
        if (restoreLifecycle.phase === 'active') {
          telemetry.event('session.restore.public_result', {
            'qwen-code.daemon.session_restore.action': action,
            'qwen-code.daemon.session_restore.result': 'failure',
            'qwen-code.daemon.session_restore.timeout_ms':
              sessionRestoreTimeoutMs,
            ...(ci ? { 'qwen-code.daemon.acp_channel.id': ci.id } : {}),
            'session.id': req.sessionId,
          });
          resolveSettlement();
        }
      },
    );

    inFlightRestores.set(req.sessionId, {
      action,
      historyReplay,
      ...(historyPageSize !== undefined ? { historyPageSize } : {}),
      liveReplayMode,
      hideInheritedHistory,
      publicPromise: promise,
      settlementPromise,
      lifecycle: restoreLifecycle,
      coalesceState,
    });
    void settlementPromise.finally(() => {
      const current = inFlightRestores.get(req.sessionId);
      if (current?.settlementPromise === settlementPromise) {
        inFlightRestores.delete(req.sessionId);
      }
    });
    return await promise;
  }

  async function closeSessionImpl(
    sessionId: string,
    context?: BridgeClientRequestContext,
    closeOpts?: CloseSessionOpts,
  ): Promise<void> {
    const entry = byId.get(sessionId);
    if (!entry) throw new SessionNotFoundError(sessionId);
    if (entry.closing) {
      throw new SessionNotFoundError(
        sessionId,
        'The session is already closing',
        'session_closing',
      );
    }
    let originatorClientId: string | undefined;
    if (context?.clientId !== undefined) {
      originatorClientId = resolveTrustedClientId(entry, context.clientId);
    }
    entry.closing = true;
    clearPromptSettledClose(entry);
    const reason = closeOpts?.reason ?? 'client_close';
    writeStderrLine(
      `qwen serve: closing session ${JSON.stringify(sessionId)}` +
        ` (reason: ${reason})` +
        (originatorClientId
          ? ` by client ${JSON.stringify(originatorClientId)}`
          : ''),
    );
    telemetry.event('session.close', {
      'qwen-code.daemon.bridge.operation': 'session.close',
      'session.id': sessionId,
      'session.close.reason': reason,
    });
    // HAZARD: Resolve the channel via `channelInfoForEntry(entry)` (search
    // `aliveChannels` for the entry's actual channel) instead of the
    // module-scoped `channelInfo` (the CURRENT attach target). The two
    // diverge during the channel-overlap window — A dying, B freshly
    // spawned as `channelInfo` — where capturing `channelInfo` would
    // (1) skip the `sessionIds.delete()` since `B.channel !==
    // entry.channel`, and (2) call `markSessionClosed` on B's client
    // instead of A's. The regression test is single-channel smoke only
    // and WILL NOT fail if this reverts to module-scoped channelInfo.
    // Keep `channelInfoForEntry(entry)` until a deterministic overlap
    // test lands.
    const ci = channelInfoForEntry(entry);
    if (!ci) {
      writeStderrLine(
        `qwen serve: closeSession channelInfoForEntry returned undefined ` +
          `for session ${JSON.stringify(sessionId)} — channel cleanup skipped (entry's channel already torn down)`,
      );
    }
    let agentSessionClosed = false;
    try {
      // Resolve permission waits before asking the agent to drain active turns;
      // otherwise a turn blocked in requestPermission can deadlock close.
      permissionMediator.forgetSession(sessionId);
      entry.pendingPermissionIds.clear();
      entry.pendingInteractions.clear();
      agentSessionClosed = await notifyAgentSessionClose(
        entry,
        ci,
        'closeSession',
        {
          throwOnFailure: true,
          requireFlush: closeOpts?.requireAgentClose === true,
          ...(closeOpts?.agentCloseTimeoutMs !== undefined
            ? { timeoutMs: closeOpts.agentCloseTimeoutMs }
            : {}),
        },
      );
    } catch (error) {
      // A child RequestError is a definitive close refusal: the child kept
      // the session live, so a retry is safe. A transport failure has an
      // unknown outcome because the close RPC may already have succeeded.
      // Terminate that process so its leases become stale and channel-exit
      // cleanup removes every bridge entry it owned.
      if (isDefinitiveAcpRequestError(error)) {
        entry.closing = false;
      } else if (ci) {
        await killChannelWithLog(
          ci,
          `recover unknown close outcome for session ${JSON.stringify(sessionId)}`,
        );
      } else {
        entry.closing = false;
      }
      throw error;
    }
    if (defaultEntry === entry) defaultEntry = undefined;
    if (ci && ci.channel === entry.channel) {
      ci.sessionIds.delete(sessionId);
    }
    // Agent-owned state, including the writer lease, is gone before bridge
    // visibility is removed. A failed strict close remains retryable.
    if (entry.promptActive) {
      entry.promptActive = false;
      activePromptCounter--;
      touchActivity();
    }
    byId.delete(sessionId);
    telemetry.metrics?.sessionLifecycle('close');
    emitSessionLifecycle({
      type: 'removed',
      sessionId,
      workspaceCwd: entry.workspaceCwd,
      reason,
    });
    // Tombstone the closed sessionId so any late `extNotification`
    // from the (now-defunct) child can't seed the early-event buffer
    // and leak into a future load/resume of the same persisted id.
    ci?.client.markSessionClosed(sessionId);
    // DAEMON-002/005: publish the formal terminal for every still-pending
    // prompt (active AND queued) before `session_closed` and the bus close
    // below — afterwards the bus swallows publishes and subscribers keyed
    // on promptId would never see a turn terminal.
    flushPromptTerminals(
      entry,
      'session_closed',
      'session closed before the prompt completed',
    );
    try {
      entry.events.publish({
        type: 'session_closed',
        data: {
          sessionId,
          reason,
          // `data.closedBy` is kept for back-compat with existing
          // wire consumers; new code should read envelope-level
          // `originatorClientId` (matches `session_metadata_updated`,
          // `model_switched`, `approval_mode_changed`, etc.).
          ...(originatorClientId ? { closedBy: originatorClientId } : {}),
        },
        ...(originatorClientId ? { originatorClientId } : {}),
      });
    } catch {
      /* bus already closed */
    }
    // `session_closed` is terminal. Close the bus before ACP cancel so any
    // late cancellation frames from the agent are intentionally dropped.
    entry.events.close();
    await entry.attachments.close().catch((error) => {
      writeStderrLine(
        `qwen serve: failed to close attachments for session ${JSON.stringify(sessionId)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    if (!agentSessionClosed) {
      try {
        await telemetry.withSpan(
          'session.close.cancel_active_prompt',
          {
            'qwen-code.daemon.bridge.operation':
              'session.close.cancel_active_prompt',
            'session.id': sessionId,
          },
          async () => await entry.connection.cancel({ sessionId }),
        );
      } catch {
        /* no active prompt or session already torn down */
      }
    }
    if (ci && hasNoChannelWork(ci)) {
      await reapPendingEmptyChannel(ci);
      if (!ci.isDying) {
        await startIdleTimer(ci, `closeSession "${sessionId}"`);
      }
    }
  }

  startSessionReaper();

  const rememberMidTurnId = (ring: string[], messageId: string) => {
    ring.push(messageId);
    if (ring.length > MID_TURN_RECONCILIATION_RING_SIZE) {
      ring.splice(0, ring.length - MID_TURN_RECONCILIATION_RING_SIZE);
    }
  };

  const promoteMidTurnMessage = (
    entry: SessionEntry,
    messageId: string,
    text: string,
    originatorClientId?: string,
    content?: readonly BridgePromptContentBlock[],
  ) => {
    // Drop references that are already gone BEFORE admission: the admission
    // check throws on the first dead reference, and the fallback would then
    // replace the ENTIRE prompt with the marker, discarding the siblings the
    // store still holds.
    const resolvableBlocks: BridgePromptContentBlock[] = [];
    let degraded = 0;
    for (const block of content ?? []) {
      try {
        entry.attachments.assertReference(block);
        resolvableBlocks.push(block);
      } catch (error) {
        if (!(error instanceof SessionAttachmentReferenceError)) throw error;
        degraded += 1;
      }
    }
    let prompt: BridgePromptContentBlock[] = [
      ...(text ? [{ type: 'text', text } as ContentBlock] : []),
      ...resolvableBlocks,
    ];
    if (degraded > 0) {
      prompt = withAttachmentDegradationMarker(prompt);
    }
    const context = {
      promptId: messageId,
      promotedMidTurn: { originatorClientId },
      onPromptAdmitted: () => {
        rememberMidTurnId(entry.promotedMidTurnMessageIds, messageId);
      },
    };
    const sendFallback = () =>
      bridgeApi.sendPrompt(
        entry.sessionId,
        {
          sessionId: entry.sessionId,
          prompt: withAttachmentDegradationMarker(
            text ? [{ type: 'text', text } as ContentBlock] : [],
          ),
        },
        undefined,
        context,
      );
    let result: Promise<PromptResponse>;
    try {
      result = bridgeApi.sendPrompt(
        entry.sessionId,
        {
          sessionId: entry.sessionId,
          prompt,
        },
        undefined,
        context,
      );
    } catch (error) {
      try {
        if (!(error instanceof SessionAttachmentReferenceError)) throw error;
        result = sendFallback();
      } catch (fallbackError) {
        writeStderrLine(
          `[mid-turn] session=${JSON.stringify(entry.sessionId)} failed to run promoted message ${JSON.stringify(messageId)}: ${JSON.stringify(fallbackError instanceof Error ? fallbackError.message : String(fallbackError))}`,
        );
        return;
      }
    }
    // SessionAttachmentReferenceError can no longer reject this result
    // asynchronously: admission-time reference checks throw synchronously
    // (handled above) and dispatch degrades in place.
    void result.catch((error: unknown) => {
      writeStderrLine(
        `[mid-turn] session=${JSON.stringify(entry.sessionId)} failed to run promoted message ${JSON.stringify(messageId)}: ${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
      );
    });
  };

  /**
   * Hand back every mid-turn message the turn that just ended never drained:
   * `queueOnly` callers drive their own follow-through, everything else starts
   * through the normal prompt path.
   */
  const settleUndrainedMidTurnMessages = (
    entry: SessionEntry,
    messages: readonly MidTurnQueueEntry[],
  ) => {
    for (const message of messages) {
      if (message.queueOnly) {
        try {
          message.onSettledWithoutDrain?.();
        } catch (error) {
          writeStderrLine(
            `[mid-turn] session=${JSON.stringify(entry.sessionId)} failed to hand undrained queue-only message ${JSON.stringify(message.messageId)} back to its caller: ${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
          );
        }
        continue;
      }
      promoteMidTurnMessage(
        entry,
        message.messageId,
        message.text,
        message.originatorClientId,
        message.content,
      );
    }
  };

  /**
   * Close the Goal turn's drain window. A Goal turn drains the mid-turn queue
   * from inside the child, so a message enqueued after its last drain would
   * otherwise sit in the queue with nothing scheduled to consume it — the same
   * race the prompt settle already closes. Promoting is the supported path
   * while a Goal is still active: the child's `claimGoalTurn` makes the
   * promoted prompt wait for the permit and run as the next Goal turn.
   */
  const settleMidTurnQueueAfterGoalTurn = (sessionId: string) => {
    const entry = byId.get(sessionId);
    if (!entry) return;
    // A prompt owns the queue and settles it on its own terminal; a Goal turn
    // that started again already re-armed the child's drain.
    if (
      entry.goalTurnActive === true ||
      entry.pendingPromptCount > 0 ||
      entry.closing
    ) {
      return;
    }
    const undrained = entry.midTurnMessageQueue.splice(0);
    if (undrained.length === 0) return;
    settleUndrainedMidTurnMessages(entry, undrained);
  };

  const bridgeApi: AcpSessionBridge = {
    setLiveScreenContextCaptureHandler(handler) {
      liveScreenContextCaptureHandler = handler;
    },
    setLiveTaskToolRequestHandler(handler) {
      liveTaskToolRequestHandler = handler;
    },
    setLiveSpeakToUserHandler(handler) {
      liveSpeakToUserHandler = handler;
    },
    getDaemonStatusSnapshot(): BridgeDaemonStatusSnapshot {
      return {
        limits: {
          maxSessions: maxSessions === Infinity ? null : maxSessions,
          maxPendingPromptsPerSession:
            maxPendingPromptsPerSession === Infinity
              ? null
              : maxPendingPromptsPerSession,
          eventRingSize,
          compactedReplayMaxBytes,
          maxJournalEvents,
          maxJournalBytes,
          journalGrowth:
            journalGrowthPoolBytes !== undefined
              ? {
                  poolBytes: journalGrowthPoolBytes,
                  hardCapBytes: JOURNAL_GROWTH_HARD_CAP_BYTES,
                }
              : null,
          channelIdleTimeoutMs: resolvedChannelIdleTimeoutMs(),
          sessionIdleTimeoutMs,
          sessionPromptSettledCloseGraceMs,
        },
        sessionCount: byId.size,
        pendingPermissionCount: permissionMediator.pendingCount,
        channelLive: !!liveChannelInfo(),
        permissionPolicy: permissionMediator.policy,
        sessions: [...byId.values()].map((entry) => {
          const journalLimits = entry.events.journalLimits();
          return {
            sessionId: entry.sessionId,
            workspaceCwd: entry.workspaceCwd,
            createdAt: entry.createdAt,
            ...(entry.displayName ? { displayName: entry.displayName } : {}),
            clientCount: entry.clientIds.size,
            subscriberCount: entry.events.subscriberCount,
            attachCount: entry.attachCount,
            pendingPromptCount: entry.pendingPromptCount,
            pendingPermissionCount: entry.pendingPermissionIds.size,
            hasActivePrompt:
              entry.promptActive || entry.goalTurnActive === true,
            lastEventId: entry.events.lastEventId,
            ...(entry.sessionLastSeenAt !== undefined
              ? { lastSeenAt: entry.sessionLastSeenAt }
              : {}),
            ...(entry.currentModelId
              ? { currentModelId: entry.currentModelId }
              : {}),
            ...(entry.currentApprovalMode
              ? { currentApprovalMode: entry.currentApprovalMode }
              : {}),
            maxJournalEvents: journalLimits?.maxEvents ?? maxJournalEvents,
            maxJournalBytes: journalLimits?.maxBytes ?? maxJournalBytes,
          };
        }),
      };
    },

    get sessionCount() {
      return byId.size;
    },

    get pendingPromptTotal() {
      // Queue-depth gauge for the Daemon Status "Queued" chart: count only
      // prompts still waiting in the per-session FIFO (`state === 'queued'`),
      // NOT the running one. `pendingPromptCount` bundles running + queued, so
      // summing it would overstate backpressure by the number of in-flight
      // prompts and shadow the separate "Active tasks" line. Cheap: each list
      // is bounded by maxPendingPromptsPerSession.
      let total = 0;
      for (const entry of byId.values()) {
        for (const pending of entry.pendingPromptList) {
          if (pending.state === 'queued') total += 1;
        }
      }
      return total;
    },

    // Daemon Status child-resource: sync cache read for the sampler + the async
    // refresh it fires each tick to update that cache.
    getChildResourceSnapshot,
    refreshChildResource,

    get activePromptCount() {
      return activePromptCounter;
    },

    get activeWork() {
      for (const entry of byId.values()) {
        if (entryHasActiveWork(entry)) return true;
      }
      return false;
    },

    /**
     * Raw coverage counts rather than a pre-collapsed grade.
     *
     * The grade has to be computed over the whole daemon, not per runtime and
     * then combined: a runtime with zero Sessions is vacuously `full`, and
     * folding that in as evidence made a deployment whose only real Sessions
     * were unreported aggregate to `partial`. Counts compose; grades do not.
     */
    get activeWorkCoverage() {
      let covered = 0;
      let onNegotiatedChannel = 0;
      let total = 0;
      let oldestCoveredReportAt: number | null = null;
      for (const entry of byId.values()) {
        total++;
        const owner = channelInfoForEntry(entry);
        const capability = owner?.activeWork;
        if (!capability) continue;
        // A child that negotiated but reports late or omits a category still
        // tells us *something*; only a channel that never negotiated at all
        // leaves us with nothing, which is what `none` is reserved for.
        onNegotiatedChannel++;
        // Missing categories and a stale snapshot are the same kind of defect
        // from a controller's point of view: the boolean does not cover what
        // it claims to. Both land in `partial` rather than being invisible.
        if (
          ACTIVE_WORK_HOLD_CATEGORIES.some(
            (category) => !capability.categories.includes(category),
          )
        ) {
          continue;
        }
        if (!childHoldsAreFresh(entry, capability)) continue;
        covered++;
        // Deliberately the oldest *covered* report, not the oldest report of
        // any kind. An uncovered Session already shows up as a downgraded
        // grade; letting it also drag the age down would double-count it, and
        // it would make a positive staleness coexist with a grade saying
        // nothing is covered. Bounded by the stale window by construction.
        if (
          entry.childHoldsAt !== null &&
          (oldestCoveredReportAt === null ||
            entry.childHoldsAt < oldestCoveredReportAt)
        ) {
          oldestCoveredReportAt = entry.childHoldsAt;
        }
      }
      return { total, covered, onNegotiatedChannel, oldestCoveredReportAt };
    },

    get lastActivityAt() {
      return lastActivityTimestamp;
    },

    get idleSinceMs() {
      return lastActivityTimestamp !== null
        ? Date.now() - lastActivityTimestamp
        : null;
    },

    isChannelLive() {
      return !!liveChannelInfo();
    },

    get pendingPermissionCount() {
      return permissionMediator.pendingCount;
    },

    get permissionPolicy() {
      return permissionMediator.policy;
    },

    async loadSession(req) {
      return restoreSession('load', req);
    },

    async resumeSession(req) {
      return restoreSession('resume', req);
    },

    async spawnOrAttach(req) {
      if (shuttingDown) {
        // `runQwenServe.close()` calls `bridge.shutdown()` BEFORE
        // `server.close()`. During that window, established HTTP
        // connections can still hit `POST /session`. Refuse here so
        // late-arrivers don't spawn children the shutdown path won't
        // see — they'd otherwise leak past `process.exit(0)`.
        throw new Error('AcpSessionBridge is shutting down');
      }
      // Fast-path the common case: clients pre-flight `caps.workspaceCwd`
      // and post back the exact same string, so the equality check
      // saves a `realpathSync.native` syscall per spawnOrAttach. The
      // omit-cwd path in `server.ts` also synthesizes `cwd =
      // boundWorkspace` before calling here, so it hits this branch
      // too. Falls through to the full canonicalize when the client
      // sent a non-canonical alias (`/work/./bound`, mixed casing on
      // case-insensitive FS, a symlinked aliased path, …) — that
      // still needs the realpath to compare correctly.
      const workspaceKey = resolveWorkspaceKey(req.workspaceCwd);

      // Resolve the effective scope for THIS call. A per-request
      // `req.sessionScope` overrides the daemon-wide default; omitting
      // it falls back to `defaultSessionScope`. The string-validation
      // happens here (rather than at the route layer alone) so direct
      // callers — tests, embeds, future entry points — can't bypass it.
      if (
        req.sessionScope !== undefined &&
        req.sessionScope !== 'single' &&
        req.sessionScope !== 'thread'
      ) {
        throw new InvalidSessionScopeError(req.sessionScope);
      }
      const effectiveScope =
        req.sessionId !== undefined
          ? 'thread'
          : (req.sessionScope ?? defaultSessionScope);
      const source = parseSessionSource(req.sourceType, req.sourceId);
      if ('error' in source) {
        throw new InvalidSessionMetadataError('sourceType', source.error);
      }
      if (
        req.approvalMode !== undefined &&
        !KNOWN_APPROVAL_MODES.has(req.approvalMode)
      ) {
        throw new Error(
          `Invalid approvalMode: ${JSON.stringify(req.approvalMode)}`,
        );
      }

      if (effectiveScope === 'single') {
        const existing = defaultEntry;
        if (existing) {
          assertAttachableSessionEntry(existing.sessionId, existing);
          // BRSCi: bump attach counter BEFORE any await so the
          // spawn-owner's disconnect reaper (server.ts:
          // `requireZeroAttaches: true`) sees this attach even when
          // we yield on the model-switch below. Increment is
          // synchronous → atomic against the killSession
          // sync-prefix check.
          //
          // BVryk + BWGSL: counter is NOT strictly monotonic any
          // more — `detachClient()` decrements it to roll back an
          // attach whose HTTP response couldn't be written
          // The race-guard invariant we still
          // hold is "attachCount reflects the number of attaching
          // clients whose response was written or is about to be
          // written"; decrementing is the symmetric cleanup for
          // attaches that turned out to be fictitious. The
          // ordering guarantee that matters for the killSession
          // race is "bump runs before any await inside this
          // microtask," which is what we get here.
          existing.attachCount++;
          const clientId = registerClient(existing, req.clientId);
          recordAttachRef(existing, clientId);
          // If the caller passed a modelServiceId on attach, the session
          // may currently be running a DIFFERENT model. Honor the request
          // by issuing setSessionModel — same call we'd use on
          // /session/:id/model. Surfaces a `model_switched` event so
          // every attached client sees the change. If the new model is
          // rejected, propagate as a spawn-style error rather than
          // silently returning an attach-with-stale-model.
          if (req.modelServiceId) {
            // Swallow: matches the create-session catch in `doSpawn`
            // below — a model-switch rejection on an already-running
            // session must NOT 500 the attach (the session is fully
            // operational on its current model; tearing it down or
            // returning an error without the sessionId would deny
            // the caller any way to recover). The
            // `model_switch_failed` SSE event is the visible signal.
            await applyModelServiceId(
              existing,
              req.modelServiceId,
              initTimeoutMs,
              clientId,
            ).catch(() => {});
          }
          let previousApprovalMode: ApprovalMode | undefined;
          if (req.approvalMode) {
            previousApprovalMode = await applyApprovalModeForAttach(
              existing,
              req.approvalMode,
              clientId,
            );
          }
          try {
            assertAttachableSessionEntry(existing.sessionId, existing);
          } catch (error) {
            if (previousApprovalMode !== undefined) {
              await rollbackApprovalModeForRejectedAttach(
                existing,
                previousApprovalMode,
                clientId,
              );
            }
            await rollbackAttachRegistration(existing, clientId);
            throw error;
          }
          return {
            sessionId: existing.sessionId,
            workspaceCwd: existing.workspaceCwd,
            ...(existing.effectiveCwd !== existing.workspaceCwd
              ? { currentCwd: existing.effectiveCwd }
              : {}),
            attached: true,
            clientId,
            createdAt: existing.createdAt,
            ...(existing.sourceType ? { sourceType: existing.sourceType } : {}),
            ...(existing.sourceId !== undefined
              ? { sourceId: existing.sourceId }
              : {}),
            hasActivePrompt:
              existing.promptActive || existing.goalTurnActive === true,
          };
        }
        // Coalesce: if another caller is already mid-spawn for this same
        // workspace, await their result. The reporter's call appears as an
        // attach (the spawn was someone else's, not theirs). If the
        // reporter asked for a different modelServiceId than the spawn
        // chose, apply it now.
        const inFlight = inFlightSpawns.get(workspaceKey);
        if (inFlight) {
          const session = await inFlight;
          // BRSCi: bump attach counter SYNCHRONOUSLY in the same
          // microtask the in-flight spawn resolves to us, BEFORE
          // any further await. The spawn-owner's route handler
          // microtask (which calls `killSession({requireZeroAttaches})`)
          // runs after our spawnOrAttach() resolves; the ordering
          // guarantee is "every attach-bump runs before the
          // matching killSession sync prefix" only if the bump is
          // the first sync step after `await inFlight`. Doing the
          // model-switch await first re-opens the race.
          const attachedEntry = byId.get(session.sessionId);
          // BX9_U: even with the BRSCi bump-before-await ordering,
          // there are still adversarial paths where the entry could
          // be torn down between `await inFlight` resolving and our
          // continuation running (e.g. channel.exited firing during
          // a crash spawn, or a direct bridge.killSession call from
          // outside the route handler). In those cases byId.get()
          // returned undefined. Fail loud with a descriptive error
          // so the caller can distinguish "immediate agent death"
          // from a stale sessionId and retry into a fresh spawn.
          if (!attachedEntry) {
            throw new SessionNotFoundError(
              session.sessionId,
              'the agent child likely crashed during initialization — retry to spawn a new session',
            );
          }
          assertAttachableSessionEntry(session.sessionId, attachedEntry);
          attachedEntry.attachCount++;
          const clientId = registerClient(attachedEntry, req.clientId);
          recordAttachRef(attachedEntry, clientId);
          if (req.modelServiceId) {
            // Same swallow as above — we picked up an in-flight
            // spawn, the session is real, model-switch failure
            // shouldn't deny us the sessionId.
            await applyModelServiceId(
              attachedEntry,
              req.modelServiceId,
              initTimeoutMs,
              clientId,
            ).catch(() => {});
          }
          let previousApprovalMode: ApprovalMode | undefined;
          if (req.approvalMode) {
            previousApprovalMode = await applyApprovalModeForAttach(
              attachedEntry,
              req.approvalMode,
              clientId,
            );
          }
          try {
            assertAttachableSessionEntry(session.sessionId, attachedEntry);
          } catch (error) {
            if (previousApprovalMode !== undefined) {
              await rollbackApprovalModeForRejectedAttach(
                attachedEntry,
                previousApprovalMode,
                clientId,
              );
            }
            await rollbackAttachRegistration(attachedEntry, clientId);
            throw error;
          }
          return {
            ...session,
            attached: true,
            clientId,
            hasActivePrompt:
              attachedEntry.promptActive ||
              attachedEntry.goalTurnActive === true,
          };
        }
      }

      // A caller-supplied id is used verbatim by the agent, so a fresh spawn
      // can collide with a restore that owns the same id. Admitting it would
      // hand the new session an id the restore lifecycle still controls: the
      // abandoned notification fence would silently swallow its events, and a
      // late `settleAbandonedRestore` would close it out from under its owner.
      // Reject instead — the restore either completes and the caller attaches,
      // or it settles and the id frees up.
      if (req.sessionId !== undefined) {
        const restoreOwner = inFlightRestores.get(req.sessionId);
        if (restoreOwner) {
          const abandoned = restoreOwner.lifecycle.phase === 'abandoned';
          throw new RestoreInProgressError(
            req.sessionId,
            restoreOwner.action,
            'spawn',
            abandoned
              ? {
                  reason: 'awaiting_abandoned_cleanup',
                  retryAfterSeconds: abandonedRestoreRetryAfterSeconds,
                }
              : undefined,
          );
        }
        if (inFlightRequestedSessionSpawns.has(req.sessionId)) {
          throw new RestoreInProgressError(req.sessionId, 'spawn', 'spawn');
        }
      }
      // Cap check: count both registered sessions and in-flight spawns
      // (a fresh-spawn race that's about to register hasn't hit
      // `byId` yet but should still count toward the limit). Attaches
      // returned above bypass this — only NEW children are gated.
      assertFreshSessionsAvailable();
      if (
        byId.size + inFlightSpawns.size + inFlightRestores.size >=
        maxSessions
      ) {
        throw new SessionLimitExceededError(maxSessions);
      }

      const requestedSessionRegistrationOwner =
        req.sessionId !== undefined ? Symbol(req.sessionId) : undefined;
      if (
        req.sessionId !== undefined &&
        requestedSessionRegistrationOwner !== undefined
      ) {
        inFlightRequestedSessionSpawns.set(
          req.sessionId,
          requestedSessionRegistrationOwner,
        );
      }
      const releaseRequestedSessionRegistration = () => {
        if (
          req.sessionId !== undefined &&
          requestedSessionRegistrationOwner !== undefined &&
          inFlightRequestedSessionSpawns.get(req.sessionId) ===
            requestedSessionRegistrationOwner
        ) {
          inFlightRequestedSessionSpawns.delete(req.sessionId);
        }
      };
      let admission: BridgeFreshSessionReservation | undefined;
      try {
        admission = reserveFreshSession({
          operation: 'spawn',
          workspaceCwd: workspaceKey,
          ...(req.sessionId !== undefined ? { sessionId: req.sessionId } : {}),
        });
      } catch (error) {
        releaseRequestedSessionRegistration();
        throw error;
      }
      let admissionReleased = false;
      const releaseAdmissionOnce = () => {
        if (admissionReleased) return;
        admissionReleased = true;
        releaseFreshSessionReservation(admission);
      };
      const promise = doSpawn(
        req.modelServiceId,
        effectiveScope,
        req.approvalMode,
        req.clientId,
        releaseAdmissionOnce,
        req.parentSessionId,
        source.sourceType,
        source.sourceId,
        req.worktree,
        req.branch,
        req.sessionId,
      );
      // Track in-flight spawns regardless of scope. Under `single`
      // this also serves the coalescing path above (a parallel
      // `spawnOrAttach` finds the entry and waits for the same
      // promise). Under `thread` we don't need coalescing — every
      // call gets its own session — but `shutdown()` snapshots
      // `inFlightSpawns.values()` to know which spawns to await
      // for graceful tear-down. Without this, a `thread`-scope
      // shutdown returns before in-progress spawns finish their
      // child cleanup, surfacing stderr noise after the daemon
      // claimed graceful shutdown. Use a unique key per spawn so
      // simultaneous thread-scope spawns don't collide on the
      // workspace key.
      const tracker =
        effectiveScope === 'single'
          ? workspaceKey
          : `${workspaceKey}#${randomUUID()}`;
      inFlightSpawns.set(tracker, promise);
      try {
        return await promise;
      } finally {
        releaseAdmissionOnce();
        // Always clear the in-flight slot whether the spawn resolved
        // or rejected — leaving a rejected promise behind would
        // poison every future coalescing-path call for this
        // workspace (single-scope) or grow unbounded (thread-scope).
        inFlightSpawns.delete(tracker);
        releaseRequestedSessionRegistration();
      }
    },

    // Keep this method non-async: admission failures must throw before
    // HTTP routes return 202.
    sendPrompt(sessionId, req, signal, context) {
      opts.onDiagnosticLine?.(
        `qwen serve: bridge sendPrompt for session=${sessionId}`,
        'info',
      );
      const capturedContext = telemetry.captureContext();
      const queuedAt = Date.now();
      const entry = byId.get(sessionId);
      if (!entry) return Promise.reject(new SessionNotFoundError(sessionId));
      if (isClosingOrAuthorizingClose(entry)) {
        return Promise.reject(
          new SessionNotFoundError(
            sessionId,
            'The session is closing; retry after close completes',
            'session_closing',
          ),
        );
      }
      if (!Array.isArray(req.prompt)) {
        return Promise.reject(
          RequestError.invalidParams(undefined, 'Prompt must be an array'),
        );
      }
      const promotedMidTurn = context?.promotedMidTurn;
      const isPromotedMidTurn = promotedMidTurn !== undefined;
      const originatorClientId = promotedMidTurn
        ? promotedMidTurn.originatorClientId
        : resolveTrustedClientId(entry, context?.clientId);
      entry.attachments.assertReferences(req.prompt);
      const modelPrompt = context?.modelPrompt;
      if (
        modelPrompt !== undefined &&
        !isValidTrustedModelPrompt(modelPrompt)
      ) {
        throw new TypeError(
          'Bridge modelPrompt must be a non-empty bounded string.',
        );
      }
      // Pre-aborted: skip the queue entirely. Without this the prompt
      // chains onto promptQueue, waits its turn, and the FIFO worker
      // checks `signal.aborted` only AFTER reaching the head — wasted
      // queue churn on every retry-after-abort, plus a confusing trace
      // where the prompt appears to "run" before erroring.
      if (signal?.aborted) {
        throw new DOMException('Prompt aborted', 'AbortError');
      }
      if (
        !isPromotedMidTurn &&
        entry.pendingPromptCount >= maxPendingPromptsPerSession
      ) {
        throw new PromptQueueFullError(
          maxPendingPromptsPerSession,
          entry.pendingPromptCount,
          sessionId,
        );
      }
      entry.pendingPromptCount += 1;
      let promptSlotReleased = false;
      const releasePromptSlot = () => {
        if (promptSlotReleased) return;
        promptSlotReleased = true;
        entry.pendingPromptCount = Math.max(0, entry.pendingPromptCount - 1);
      };
      // Track this prompt in the pending queue for observability. Only
      // publish an SSE `pending_prompt_added` event when the prompt is
      // genuinely queued (another prompt is already running/queued) —
      // the first prompt on an idle session starts immediately and
      // doesn't need a queue event.
      const promptId = context?.promptId ?? randomUUID();
      const invocationContext: InvocationContextV1 = Object.freeze({
        version: 1,
        sessionId,
        promptId,
        ...(originatorClientId ? { originatorClientId } : {}),
      });
      const isQueued = entry.pendingPromptCount > 1;
      const pendingAbort = new AbortController();
      if (signal) {
        if (signal.aborted) {
          pendingAbort.abort(signal.reason);
        } else {
          signal.addEventListener(
            'abort',
            () => pendingAbort.abort(signal.reason),
            { once: true },
          );
        }
      }
      const channelDisplayText = getChannelPromptDisplayText(
        entry,
        context?.promptDisplayText,
      );
      const pendingText =
        channelDisplayText === undefined
          ? extractPromptText(req.prompt)
          : channelDisplayText ||
            (req.prompt.some(
              (block) => isRecord(block) && block['type'] === 'image',
            )
              ? '[image]'
              : '');
      const pendingEntry: PendingPromptEntry = {
        promptId,
        queuedAt,
        ...(originatorClientId !== undefined ? { originatorClientId } : {}),
        ...(isPromotedMidTurn ? { promotedMidTurn: true } : {}),
        text: pendingText,
        content: extractMediaBlocks(req.prompt),
        abortController: pendingAbort,
        state: isQueued ? 'queued' : 'running',
      };
      entry.pendingPromptList.push(pendingEntry);
      // Dispatch marker: capture the transcript tail uuid before the
      // write-ahead `in_flight` lands so cold-load reconciliation can
      // require visible writes beyond it (identity-based attribution,
      // immune to clock skew). Best-effort: absence degrades reconcile
      // to its marker-less evidence chain, never blocks admission.
      let tailUuid: string | undefined;
      try {
        tailUuid = entry.promptLedger?.transcriptTailUuid?.(sessionId);
      } catch (error) {
        opts.onDiagnosticLine?.(
          `qwen serve: prompt ledger dispatch marker failed for session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
          'warn',
        );
      }
      appendPromptLedgerBestEffort(entry, {
        v: 1,
        promptId,
        state: 'in_flight',
        ...(tailUuid !== undefined ? { tailUuid } : {}),
        at: queuedAt,
      });
      try {
        context?.onPromptAdmitted?.();
      } catch (error) {
        opts.onDiagnosticLine?.(
          `qwen serve: prompt admission observer failed for session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
          'warn',
        );
      }
      // DAEMON-003: absolute wallclock deadline. Armed at admission (the
      // 202 point) so it covers queue wait AND execution. On expiry the
      // prompt gets its formal `turn_error{code:'prompt_deadline_exceeded'}`
      // terminal, the per-session FIFO is released via `deadlineReject`
      // racing the (possibly wedged) `promptPromise`, and the agent is
      // best-effort cancelled through the existing abort path. The channel
      // is NOT killed — it may be shared by other sessions; reclaiming a
      // wedged agent's channel is a tracked follow-up. Releasing the FIFO
      // while the wedged call is still outstanding also means the next
      // prompt overlaps it on the same ACP session: an agent that ignored
      // `cancel()` but keeps streaming will interleave its stale
      // `session/update`s with the new turn's output. Accepted trade-off —
      // the alternative (poisoning the session until the old call settles)
      // would give up the "follow-up prompt dispatches normally" recovery
      // property the deadline exists to provide.
      const deadlineMs = context?.deadlineMs;
      const hasDeadline =
        typeof deadlineMs === 'number' &&
        Number.isFinite(deadlineMs) &&
        deadlineMs > 0;
      let deadlineReject: ((err: unknown) => void) | undefined;
      let deadlinePromise: Promise<never> | undefined;
      let deadlineTimer: NodeJS.Timeout | undefined;
      if (hasDeadline) {
        deadlinePromise = new Promise<never>((_resolve, reject) => {
          deadlineReject = reject;
        });
        // The race consumer may not be attached yet (or ever, for a queued
        // prompt that never dispatches) — keep the rejection handled.
        deadlinePromise.catch(() => {});
        pendingEntry.cancelForwardDeadline = deadlinePromise.then(
          () => undefined,
          () => undefined,
        );
        const onDeadline = () => {
          if (pendingEntry.terminalPublished) return;
          const deadlineErr = new PromptDeadlineExceededError(deadlineMs);
          writeStderrLine(
            `sendPrompt: prompt ${promptId} exceeded ${deadlineMs}ms deadline ` +
              `for session ${sessionId}; agent may still be executing`,
          );
          publishPromptTerminal(entry, pendingEntry, {
            kind: 'error',
            err: {
              code: 'prompt_deadline_exceeded',
              message: deadlineErr.message,
            },
          });
          settleActivePromptState(entry, pendingEntry.promptId);
          // Unlock the dispatch race / FIFO first, then abort so the
          // existing onAbort path (prompt_cancelled UI signal +
          // cancelPendingForSession + best-effort connection.cancel) runs.
          deadlineReject?.(deadlineErr);
          pendingAbort.abort(deadlineErr);
        };
        deadlineTimer = setTimeout(onDeadline, deadlineMs);
        deadlineTimer.unref();
      }
      if (isQueued) {
        pendingAbort.signal.addEventListener(
          'abort',
          () => {
            if (pendingEntry.state !== 'queued') return;
            const waitingOwnerPromptId =
              entry.todoStopGuardAwaitingQueuedPromptOwnerPromptId;
            if (!waitingOwnerPromptId) return;
            const hasAnotherQueuedPrompt = entry.pendingPromptList.some(
              (candidate) =>
                candidate !== pendingEntry &&
                candidate.state === 'queued' &&
                !candidate.abortController.signal.aborted,
            );
            if (hasAnotherQueuedPrompt) return;
            delete entry.todoStopGuardAwaitingQueuedPromptOwnerPromptId;
            void entry.connection
              .extMethod(TODO_STOP_GUARD_QUEUE_RELEASE_METHOD, {
                sessionId,
                promptId: waitingOwnerPromptId,
              })
              .catch((error) => {
                writeStderrLine(
                  `qwen serve: Todo Stop Guard queued-prompt release failed for ` +
                    `${JSON.stringify(sessionId)}: ${error instanceof Error ? error.message : String(error)}`,
                );
              });
          },
          { once: true },
        );
        entry.events.publish({
          type: 'pending_prompt_added',
          promptId: pendingEntry.promptId,
          data: {
            sessionId,
            promptId: pendingEntry.promptId,
            text: pendingEntry.text,
            queuedAt: pendingEntry.queuedAt,
          },
          ...(originatorClientId ? { originatorClientId } : {}),
        });
      }
      // Force the body's sessionId to match the routing id — a client that
      // sent a stale id in the body would otherwise be dispatched to the
      // wrong agent process.
      const result = entry.promptQueue.then(() =>
        telemetry.runWithContext(capturedContext, async () => {
          const queueWaitMs = Date.now() - queuedAt;
          telemetry.metrics?.promptQueueWait(queueWaitMs);
          // Check abort BEFORE promoting state — if `removePendingPrompt`
          // already aborted this entry, skip the running transition and
          // the `pending_prompt_started` event entirely.
          if (pendingAbort.signal.aborted) {
            // A deadline that expired while this prompt was still queued
            // aborted with the typed error; surface it to the caller so
            // queued and running expiry reject identically.
            if (
              pendingAbort.signal.reason instanceof PromptDeadlineExceededError
            ) {
              throw pendingAbort.signal.reason;
            }
            throw new DOMException('Prompt aborted', 'AbortError');
          }
          pendingEntry.startedAt = Date.now();
          // If this prompt was queued behind another, promote it to
          // 'running' and publish a started event now that it has reached the
          // head of the FIFO. A promoted mid-turn message that starts
          // immediately (the turn settled while the POST was in flight) never
          // has a queued phase but still needs the started event: the
          // originator suppresses its own stream echo, and a daemon-owned
          // mid-turn message has no client-side row to render.
          if (pendingEntry.state === 'queued' || isPromotedMidTurn) {
            if (pendingEntry.state === 'queued') {
              delete entry.todoStopGuardAwaitingQueuedPromptOwnerPromptId;
              pendingEntry.state = 'running';
            }
            entry.events.publish({
              type: 'pending_prompt_started',
              promptId: pendingEntry.promptId,
              data: {
                sessionId,
                promptId: pendingEntry.promptId,
                text: pendingEntry.text,
              },
              ...(originatorClientId ? { originatorClientId } : {}),
            });
          }
          const dispatchStartMs = Date.now();
          try {
            return await telemetry.withSpan(
              'prompt.dispatch',
              {
                'qwen-code.daemon.bridge.operation': 'prompt.dispatch',
                'session.id': sessionId,
                'qwen-code.daemon.prompt.queue_wait_ms': queueWaitMs,
                ...(context?.clientId
                  ? { 'qwen-code.client_id': context.clientId }
                  : {}),
              },
              async () => {
                // Degrade in place, never by re-admission: a fallback
                // re-admitted at the FIFO tail would double the terminal
                // for this promptId, transpose the turn behind later
                // prompts, and race the deferred close-on-prompt-complete
                // on a detached session.
                let dispatchBlocks = req.prompt;
                let resolvedPrompt: ContentBlock[];
                try {
                  resolvedPrompt =
                    await entry.attachments.resolveContent(dispatchBlocks);
                } catch (error) {
                  if (
                    !isPromotedMidTurn ||
                    !(error instanceof SessionAttachmentReferenceError)
                  ) {
                    throw error;
                  }
                  // Degrade per block: one dead reference drops itself and
                  // keeps its resolvable siblings instead of replacing the
                  // whole prompt with the marker.
                  const perBlock =
                    await entry.attachments.resolveContentDegrading(
                      dispatchBlocks,
                    );
                  dispatchBlocks = perBlock.retainedBlocks;
                  // The batch resolve threw on a dead reference, so the
                  // marker always applies here.
                  resolvedPrompt = withAttachmentDegradationMarker(
                    perBlock.resolvedBlocks,
                  );
                }
                const normalized: PromptRequest = telemetry.injectPromptContext(
                  {
                    ...req,
                    sessionId,
                    prompt: resolvedPrompt,
                  },
                );
                assertLivePromptEntry(sessionId, entry);
                const requestedRetry =
                  (req as unknown as { retry?: unknown }).retry === true;
                const isRetry = requestedRetry && entry.retryAllowed;
                entry.retryAllowed = false;
                // Trusted continuation: only `continueSession` sets this on the
                // context. It re-arms the continuation meta key that the strip
                // below removes from untrusted callers (see IDX-7 / the
                // DAEMON_CONTINUE_META_KEY note), so the continuation runs
                // through this tracked admission path instead of an untracked
                // internal agent prompt.
                const isContinue = context?.continue === true;
                const isRestoreAskUserQuestion =
                  context?.restoreAskUserQuestion === true;
                const promptRequest = (() => {
                  const copy = {
                    ...normalized,
                  } as PromptRequest & { retry?: unknown; delivery?: unknown };
                  delete copy.retry;
                  delete copy.delivery;
                  const meta =
                    copy._meta && typeof copy._meta === 'object'
                      ? { ...copy._meta }
                      : {};
                  const promptDisplayText = channelDisplayText;
                  delete meta[DAEMON_RETRY_META_KEY];
                  delete meta[INVOCATION_CONTEXT_META_KEY];
                  delete meta[PRIVATE_PARENT_CAPABILITY_META_KEY];
                  // External prompt callers cannot self-trigger a continuation;
                  // only `continueSession` (via the trusted `isContinue` flag
                  // below) re-arms it after this strip.
                  delete meta[DAEMON_CONTINUE_META_KEY];
                  delete meta[DAEMON_RESTORE_ASK_USER_QUESTION_META_KEY];
                  delete meta[DAEMON_CHANNEL_DELIVERY_META_KEY];
                  delete meta[DAEMON_PROMPT_DISPLAY_TEXT_META_KEY];
                  delete meta[DAEMON_MODEL_PROMPT_META_KEY];
                  delete meta[DAEMON_ATTACHMENT_REFERENCES_META_KEY];
                  // Channel classification is authenticated channel-worker
                  // metadata; the daemon prompt route validates the worker
                  // authorization and re-arms it through the trusted
                  // `channelPrompt` context flag below.
                  delete meta[CHANNEL_PROMPT_META_KEY];
                  if (isRetry) {
                    meta[DAEMON_RETRY_META_KEY] = true;
                  }
                  if (isContinue) {
                    meta[DAEMON_CONTINUE_META_KEY] = true;
                  }
                  if (isRestoreAskUserQuestion) {
                    meta[DAEMON_RESTORE_ASK_USER_QUESTION_META_KEY] = true;
                  }
                  if (context?.channelDelivery) {
                    meta[DAEMON_CHANNEL_DELIVERY_META_KEY] =
                      context.channelDelivery;
                  }
                  if (promptDisplayText !== undefined) {
                    meta[DAEMON_PROMPT_DISPLAY_TEXT_META_KEY] =
                      promptDisplayText;
                  }
                  if (modelPrompt !== undefined) {
                    meta[DAEMON_MODEL_PROMPT_META_KEY] = modelPrompt;
                  }
                  const attachmentReferences = dispatchBlocks.filter(
                    isSessionAttachmentReference,
                  );
                  if (attachmentReferences.length > 0) {
                    meta[DAEMON_ATTACHMENT_REFERENCES_META_KEY] =
                      attachmentReferences;
                  }
                  if (context?.channelPrompt === true) {
                    meta[CHANNEL_PROMPT_META_KEY] = true;
                  }
                  meta[INVOCATION_CONTEXT_META_KEY] = invocationContext;
                  if (Object.keys(meta).length > 0) {
                    copy._meta = meta;
                  } else {
                    delete copy._meta;
                  }
                  return copy;
                })();
                entry.promptActive = true;
                // The child serializes Goal turns against RPC prompts, so a
                // still-set flag here means the goal end_turn signal was
                // lost; self-heal rather than pin the session active.
                entry.goalTurnActive = false;
                entry.activePromptId = pendingEntry.promptId;
                delete entry.cancelBroadcastWithoutPrompt;
                delete entry.turnError;
                delete entry.turnErrorEvent;
                activePromptCounter++;
                entry.sessionLastSeenAt = Date.now();
                touchActivity();
                if (originatorClientId === undefined) {
                  delete entry.activePromptOriginatorClientId;
                } else {
                  entry.activePromptOriginatorClientId = originatorClientId;
                }
                try {
                  // Echo the user prompt to the session bus so other SSE-subscribed
                  // clients see the input alongside the agent response.
                  //
                  // The interactive prompt path was the only one not emitting
                  // `user_message_chunk` — `Session#executePrompt` (the agent
                  // side) forwards the prompt directly to the LLM; the cron path
                  // (Session.ts:1402) and `HistoryReplayer` (line 65) emit it
                  // explicitly. Without this echo, multi-client UIs only saw
                  // assistant text from peer prompts — no record of who said what.
                  //
                  // Originator dedup: SDK consumers' `normalizeDaemonEvent` with
                  // `suppressOwnUserEcho: true` filters the echo when
                  // `event.originatorClientId === opts.clientId`. So the
                  // originator's local UI doesn't double-render its own input.
                  //
                  // Multi-modal: one envelope per content block. Non-text blocks
                  // pass through verbatim (the agent's Core multimodal echo is a
                  // for now the common text path is the immediate fix.
                  //
                  // Retry: skip echo — the original user_message_chunk is already
                  // in the transcript from the first attempt.
                  // Continuations carry no user prompt to echo (empty `prompt`);
                  // the original user_message_chunk is already in the transcript.
                  if (!isRetry && !isContinue && !isRestoreAskUserQuestion) {
                    echoPromptToSessionBus(
                      entry,
                      {
                        ...promptRequest,
                        prompt: dispatchBlocks,
                      },
                      pendingEntry.promptId,
                      originatorClientId,
                      channelDisplayText,
                    );
                  }
                } catch (echoErr) {
                  settleActivePromptState(entry, pendingEntry.promptId);
                  throw echoErr;
                }
                pendingEntry.dispatched = true;
                const promptPromise = entry.connection
                  .prompt(promptRequest)
                  .finally(() => {
                    // Ownership-gated: a late settle after a deadline
                    // already released the FIFO must not clear the NEXT
                    // prompt's active state. The deferred
                    // close-on-prompt-complete lives in `result.finally`
                    // (after the terminal broadcast), not here.
                    settleActivePromptState(entry, pendingEntry.promptId);
                  });

                // Race against channel termination: if the underlying transport
                // dies (child crashed, stream torn down) WHILE the prompt is in
                // flight, the SDK's pending-request promise can hang because the
                // wire never delivers a response. Make the prompt fail-fast in
                // that case so the per-session FIFO doesn't poison the next
                // queued prompt with an unbounded await. See
                // `getTransportClosedReject` for the single-listener invariant.
                //
                // The optional `deadlinePromise` (DAEMON-003) joins the same
                // race: a buggy agent that ignores `cancel()` while keeping
                // the channel alive can otherwise hold this race open
                // indefinitely — the deadline rejection settles the raced
                // promise so the FIFO moves on even though the agent-side
                // `promptPromise` never resolves.
                const racedPromise = deadlinePromise
                  ? Promise.race([
                      promptPromise,
                      getTransportClosedReject(entry),
                      deadlinePromise,
                    ])
                  : Promise.race([
                      promptPromise,
                      getTransportClosedReject(entry),
                    ]);

                // The user echo (`echoPromptToSessionBus`) was already published
                // BEFORE the forward. If the forward itself fails (transport died,
                // ACP child error) and it wasn't a user-initiated cancel that
                // already broadcast, peers would be stuck with no terminal signal.
                // Emit a compensating `prompt_cancelled{reason:'forward_failed'}`
                // so the turn visibly ends. The `...Once` latch dedups against
                // the abort path. Side-effect only — the caller's `racedPromise`
                // reference still surfaces the rejection.
                void racedPromise
                  .then(
                    () => {},
                    (err) => {
                      if (err instanceof PromptDeadlineExceededError) {
                        // onDeadline already published the terminal and
                        // aborted the prompt — the abort listener (onAbort)
                        // ran synchronously and handled the cancel broadcast
                        // and cancellation handshake. Nothing to compensate.
                        return;
                      }
                      if (
                        err instanceof DOMException &&
                        err.name === 'AbortError' &&
                        pendingEntry.state === 'queued'
                      ) {
                        writeStderrLine(
                          `sendPrompt: queued prompt removed before agent forward for session ${sessionId}`,
                        );
                        return;
                      }
                      if (extractJsonRpcErrorField(err, 'errorKind')) {
                        // Structured turn error (e.g. loop_detected): the
                        // forward succeeded and the daemon rejected the turn
                        // after running it. The formal turn_error terminal
                        // already ends the turn visibly; a phantom
                        // forward-failure line and prompt_cancelled broadcast
                        // would misreport it.
                        cancelPendingForSession(sessionId);
                        return;
                      }
                      writeStderrLine(
                        `sendPrompt: forward failed for session ${sessionId}: ${extractErrorMessage(err)}`,
                      );
                      broadcastPromptCancelledOnce(
                        entry,
                        sessionId,
                        pendingEntry.promptId,
                        originatorClientId,
                        'forward_failed',
                      );
                      cancelPendingForSession(sessionId);
                    },
                  )
                  .catch(() => {});

                // Always wire `pendingAbort.signal` (not the caller's
                // `signal` directly) so that `removePendingPrompt` can
                // trigger the cancel path on running prompts too.
                const abortSignal = pendingAbort.signal;
                const onAbort = () => {
                  broadcastPromptCancelledOnce(
                    entry,
                    sessionId,
                    pendingEntry.promptId,
                    originatorClientId,
                  );
                  cancelPendingForSession(sessionId);
                  if (byId.get(sessionId) === entry) {
                    void forwardRunningPromptCancel(entry, pendingEntry, {
                      sessionId,
                    }).catch((err) => {
                      writeStderrLine(
                        `[pending-prompt] cancel forward failed after removePendingPrompt session=${sessionId}: ${extractErrorMessage(err)}`,
                      );
                    });
                  }
                };
                if (abortSignal.aborted) {
                  onAbort();
                } else {
                  abortSignal.addEventListener('abort', onAbort, {
                    once: true,
                  });
                  if (abortSignal.aborted) onAbort();
                  racedPromise
                    .finally(() =>
                      abortSignal.removeEventListener('abort', onAbort),
                    )
                    .catch(() => {});
                }
                return racedPromise;
              },
            );
          } finally {
            telemetry.metrics?.promptDuration(Date.now() - dispatchStartMs);
          }
        }),
      );
      // Do not reorder — this `result.then` must stay registered before the
      // `result.finally` below: handlers on the same promise run in
      // registration order and the broadcasts are synchronous, which is what
      // guarantees the terminal frame precedes the deferred
      // close-on-prompt-complete in `result.finally`.
      result.then(
        (promptResult) => {
          publishPromptTerminal(entry, pendingEntry, {
            kind: 'complete',
            result: promptResult,
          });
        },
        (err) => {
          if (err instanceof DOMException && err.name === 'AbortError') {
            // An aborted prompt (queued removal, caller socket close,
            // deadline…) still owes its formal terminal — fall back to a
            // `cancelled` turn_complete. Paths that already published one
            // (removePendingPrompt, onDeadline, flush) are deduped by the
            // per-prompt latch inside `publishPromptTerminal`.
            publishPromptTerminal(entry, pendingEntry, { kind: 'cancelled' });
            return;
          }
          publishPromptTerminal(entry, pendingEntry, { kind: 'error', err });
        },
      );
      // Tail swallows failures so subsequent prompts still run. The caller
      // still sees rejections on its own `result` reference.
      const drainCancelForwarding = async (): Promise<void> => {
        try {
          await pendingEntry.cancelForwardDrain;
        } catch {
          // The initiating mutation already reports or logs forwarding
          // failures. The queue only needs to fence any in-flight write.
        }
      };
      entry.promptQueue = result.then(
        drainCancelForwarding,
        drainCancelForwarding,
      );
      result
        .finally(() => {
          if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
          // Remove this prompt from the pending list and publish a
          // completed event so SSE subscribers can update their queue view.
          // A removed RUNNING prompt is still on the list (see
          // `removePendingPrompt`) — splice it now, but skip the `completed`
          // event: its `pending_prompt_completed{state:'removed'}` already
          // announced the queue-view change.
          const listIdx = entry.pendingPromptList.indexOf(pendingEntry);
          if (listIdx !== -1) {
            entry.pendingPromptList.splice(listIdx, 1);
            // Only publish `completed` when the prompt was genuinely queued
            // (and thus had an `added` event). The first prompt on an idle
            // session starts immediately without `added`, so publishing
            // `completed` would produce an unpaired event.
            if (isQueued && !pendingEntry.removed) {
              try {
                entry.events.publish({
                  type: 'pending_prompt_completed',
                  promptId: pendingEntry.promptId,
                  data: {
                    sessionId,
                    promptId: pendingEntry.promptId,
                    state: 'completed',
                  },
                  ...(originatorClientId ? { originatorClientId } : {}),
                });
              } catch {
                /* bus may be closed during session teardown */
              }
            }
          }
          const shouldSettleMidTurnQueue =
            entry.pendingPromptCount === 1 &&
            !entry.closing &&
            byId.get(entry.sessionId) === entry;
          const undrainedMessages = shouldSettleMidTurnQueue
            ? entry.midTurnMessageQueue.splice(0)
            : [];
          // Release the old turn before handing back queue-only messages. Its
          // caller synchronously reserves the next FIFO slot, then ordinary
          // promotions follow it without exposing the fallback as queued.
          releasePromptSlot();
          settleUndrainedMidTurnMessages(entry, undrainedMessages);
          // DAEMON-005: deferred close-on-prompt-complete. Lives here (not
          // in `promptPromise.finally`) so the terminal broadcast — the
          // `result.then` registered above on this same promise — runs
          // before the bus closes. Conditions: nobody attached or
          // subscribed, no other prompt pending (a queued successor keeps
          // the session draining and triggers its own close), and this
          // exact entry is still registered — after killSession's eager
          // delete the same persisted id can be re-registered as a NEW
          // entry by `session/load`, which a late settle must not close.
          // schedulePromptSettledClose defers the close by
          // sessionPromptSettledCloseGraceMs (default 0 = immediate) so
          // poll-based clients can reconnect without a session rebuild.
          schedulePromptSettledClose(entry);
        })
        .catch(() => {});
      return result;
    },

    async cancelSession(sessionId, req, context) {
      opts.onDiagnosticLine?.(
        `qwen serve: bridge cancelSession for session=${sessionId}`,
        'info',
      );
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const cancelOriginatorClientId = resolveTrustedClientId(
        entry,
        context?.clientId,
      );
      const runningPrompt = entry.pendingPromptList.find(
        (pending) => pending.state === 'running' && !pending.terminalPublished,
      );
      // Broadcast `prompt_cancelled` so other SSE-subscribed clients see
      // the cancel as a first-class event rather than inferring it from
      // the absence of further `agent_message_chunk` frames. Mirrors
      // `session_closed` — same audit gap (cross-client sync audit,
      // 2026-05-24). Published before the ACP cancel forward (see the
      // "cancel requested, not confirmed" semantic in
      // `broadcastPromptCancelled`).
      //
      // Unconditional by design: not gated on `activePromptOriginatorClientId`
      // because that field is only set when the active prompt carried an
      // originator — gating on it would drop the broadcast for anonymous
      // active prompts. A cancel against a genuinely idle session is a
      // harmless no-op that consumers treat idempotently.
      //
      // The pending-permission resolution below intentionally omits the
      // originator stamp (those resolutions are system-initiated, not
      // user-voted); this top-level `prompt_cancelled` carries the
      // cancelling client so peer UIs can attribute it.
      //
      // `...Once` dedups against the `sendPrompt` abort path by prompt id, so
      // a client that POSTs /cancel and then drops its socket doesn't emit two
      // `prompt_cancelled` frames for the same turn.
      broadcastPromptCancelledOnce(
        entry,
        sessionId,
        entry.activePromptId ?? runningPrompt?.promptId,
        cancelOriginatorClientId,
      );
      // ACP spec: cancelling a prompt MUST resolve outstanding
      // requestPermission calls with outcome.cancelled. Do this *before*
      // forwarding the notification so the agent's wind-down sees the
      // resolutions.
      cancelPendingForSession(sessionId);
      // Cancel intentionally bypasses the prompt queue: it's a notification
      // that the agent uses to wind down the *currently active* prompt, not
      // something to wait behind queued work.
      //
      // CONTRACT (multi-prompt clients): cancel affects ONLY the active
      // prompt. Any prompts the client previously POSTed and that are
      // still queued behind the active one will continue to execute
      // after the active prompt resolves with `stopReason: 'cancelled'`.
      // This matches ACP's "cancel is a wind-down notification for the
      // current turn" semantics — multi-prompt queueing is a daemon
      // convenience, not in spec, so we don't extend cancel's reach
      // there. Clients that want a hard stop should stop posting new
      // prompts and call `cancelSession` after their last prompt
      // resolves, or kill the session via the channel-exit path.
      const notif: CancelNotification = req
        ? { ...req, sessionId }
        : { sessionId };
      telemetry.metrics?.cancelled();
      await telemetry.withSpan(
        'session.cancel',
        {
          'qwen-code.daemon.bridge.operation': 'session.cancel',
          'session.id': sessionId,
        },
        async () => {
          if (runningPrompt) {
            const forwarding =
              runningPrompt.dispatched === true &&
              entry.activePromptId === runningPrompt.promptId
                ? forwardRunningPromptCancel(entry, runningPrompt, notif)
                : Promise.resolve();
            runningPrompt.abortController.abort(
              new DOMException(
                'Prompt cancelled before dispatch',
                'AbortError',
              ),
            );
            await forwarding;
            return;
          }
          try {
            await entry.connection.cancel(notif);
          } catch (err) {
            if (isNotCurrentlyGeneratingCancelError(err)) return;
            throw err;
          }
        },
      );
    },

    subscribeEvents(sessionId, subOpts) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      // DAEMON-005: a reconnecting poll-based client cancels the deferred
      // prompt-settled close — the session should stay alive.
      clearPromptSettledClose(entry);
      const raw = entry.events.subscribe(subOpts);
      if (!subOpts?.snapshot) return raw;

      // A5: wrap the iterator to inject a synthetic `session_snapshot`
      // frame so a freshly attached / reconnecting client can seed its
      // side-channel reducer without an extra round-trip. Captures cached
      // state synchronously at yield time.
      //
      // The bus only emits `replay_complete` on the `Last-Event-ID`
      // resume path (`eventBus.subscribe` gates the whole replay block on
      // `opts.lastEventId !== undefined`). A fresh connection has no
      // `Last-Event-ID`, so it never sees `replay_complete` — keying the
      // snapshot solely off that sentinel silently no-ops on the primary
      // use case (initial attach). So inject up front when there is no
      // resume cursor, and otherwise after `replay_complete` so the
      // client applies replayed deltas before the snapshot seeds state.
      const snapshotFrame = (): BridgeEvent => ({
        v: EVENT_SCHEMA_VERSION,
        type: 'session_snapshot',
        data: {
          sessionId: entry.sessionId,
          currentModelId: entry.currentModelId ?? null,
          currentApprovalMode: entry.currentApprovalMode ?? null,
          recordingDegraded: entry.recordingDegraded,
        },
      });
      async function* withSnapshot(): AsyncIterable<BridgeEvent> {
        let injected = false;
        if (subOpts?.lastEventId === undefined) {
          yield snapshotFrame();
          injected = true;
        }
        for await (const event of raw) {
          yield event;
          if (!injected && event.type === 'replay_complete') {
            yield snapshotFrame();
            injected = true;
          }
        }
      }
      return withSnapshot();
    },

    getSessionLastEventId(sessionId) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      return entry.events.lastEventId;
    },

    getSessionEventEpoch(sessionId) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      return entry.events.epoch;
    },

    getSessionReplaySnapshot(sessionId) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      return entry.events.snapshotReplay();
    },

    respondToPermission(requestId, response, context) {
      // Legacy workspace-level vote route. Look up the session via
      // mediator's resolved+pending peek, forward to session-scoped
      // handler if both ids agree.
      const sessionId = permissionMediator.peekSessionFor(requestId);
      // Also check `byId.has(sessionId)`. The mediator's resolved LRU
      // survives session teardown by design; without this guard,
      // `respondToSessionPermission` would throw `SessionNotFoundError`
      // once `byId.delete(sessionId)` ran.
      if (sessionId === undefined || !byId.has(sessionId)) {
        // Short-circuit to false (404) BEFORE clientId validation when
        // the requestId is unknown. Without this, a probe with a
        // fabricated clientId could distinguish "session exists with
        // these clients" (400) from "no such request" (404), creating
        // a cross-session client-registration oracle.
        writeStderrLine(
          `qwen serve: legacy permission vote ${JSON.stringify(requestId)} ` +
            `has no live session (peek returned ${JSON.stringify(sessionId)}); ` +
            `returning 404.`,
        );
        return false;
      }
      return this.respondToSessionPermission(
        sessionId,
        requestId,
        response,
        context,
      );
    },

    respondToSessionPermission(sessionId, requestId, response, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      // Cross-session reject: a vote whose requestId belongs to a
      // DIFFERENT session must return false (404) WITHOUT validating
      // `context.clientId` against this session's registry.
      const actualSessionId = permissionMediator.peekSessionFor(requestId);
      if (actualSessionId !== undefined && actualSessionId !== sessionId) {
        teeServeDebugLine(
          `rejected permission vote ${JSON.stringify(requestId)} ` +
            `for session ${JSON.stringify(sessionId)}; request belongs to ` +
            `session ${JSON.stringify(actualSessionId)}.`,
        );
        return false;
      }
      // Error precedence: when `peekSessionFor` returns `undefined`
      // (timed out / LRU-evicted / never registered), return `false`
      // (404) BEFORE any clientId validation. Without this guard,
      // execution falls through to `resolveTrustedClientId` which
      // throws `InvalidClientIdError` (400), leaking session-exists
      // information. Logged unconditionally so operators can correlate
      // unexpected 404s without debug mode.
      if (actualSessionId === undefined) {
        writeStderrLine(
          `qwen serve: rejected permission vote ${JSON.stringify(requestId)} ` +
            `for session ${JSON.stringify(sessionId)}; mediator has no ` +
            `pending or resolved record (unknown / timed out / LRU-evicted).`,
        );
        return false;
      }
      // requestId matches THIS session — only now validate clientId.
      // `resolveTrustedClientId` throws `InvalidClientIdError`
      // (mapped to 400 by the route) when the supplied id isn't in
      // `entry.clientIds`.
      const trustedClientId = resolveTrustedClientId(entry, context?.clientId);
      // Voter cancel sentinel: when the ACP body is
      // `{outcome: 'cancelled'}`, the wire frame doesn't carry an
      // `optionId`. Map it to the mediator-internal sentinel so
      // the mediator can resolve the pending as cancelled
      // regardless of the active policy.
      //
      // The mediator recognizes `CANCEL_VOTE_SENTINEL` BEFORE
      // validating the option against `allowedOptionIds`, so a wire
      // client sending `{outcome: 'selected', optionId: '__cancelled__'}`
      // would short-circuit all policy dispatch. Enforce the
      // precondition here — the collision-defense at request issue
      // time already prevents agents from advertising the sentinel
      // as an option, so this guard closes the only remaining vector.
      if (
        response.outcome.outcome === 'selected' &&
        response.outcome.optionId === CANCEL_VOTE_SENTINEL
      ) {
        throw new InvalidPermissionOptionError(requestId, CANCEL_VOTE_SENTINEL);
      }
      const optionId =
        response.outcome.outcome === 'selected'
          ? response.outcome.optionId
          : CANCEL_VOTE_SENTINEL;
      const voterMetadata = extractPermissionResponseMetadata(response);
      const outcome = permissionMediator.vote({
        requestId,
        sessionId,
        clientId: trustedClientId,
        optionId,
        receivedAtMs: Date.now(),
        fromLoopback: context?.fromLoopback ?? false,
        ...(voterMetadata ? { metadata: voterMetadata } : {}),
      });
      switch (outcome.kind) {
        case 'resolved':
        case 'recorded': // consensus-policy intermediate vote
          return true;
        case 'already_resolved':
          // Mediator already emitted `permission_already_resolved`.
          return false;
        case 'unknown_request':
          teeServeDebugLine(
            `rejected permission vote ${JSON.stringify(requestId)} ` +
              `for session ${JSON.stringify(sessionId)}; mediator has no ` +
              `pending or resolved record.`,
          );
          return false;
        case 'forbidden':
          throw new PermissionForbiddenError(
            requestId,
            sessionId,
            outcome.reason,
          );
        default: {
          const _exhaustive: never = outcome;
          throw new Error(
            `unreachable PermissionVoteOutcome: ${JSON.stringify(_exhaustive)}`,
          );
        }
      }
    },

    async branchSession(sessionId, req, context) {
      if (shuttingDown) throw new Error('AcpSessionBridge is shutting down');

      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      if (isClosingOrAuthorizingClose(entry)) {
        throw new SessionNotFoundError(sessionId, 'The session is closing');
      }
      const source = parseSessionSource(req.sourceType, req.sourceId);
      if ('error' in source) {
        throw new InvalidSessionMetadataError('sourceType', source.error);
      }
      const isSideTask = source.sourceType === 'side_task';
      const restoreBranch = isSideTask || req.atRecordId === undefined;

      if (context?.clientId !== undefined) {
        resolveTrustedClientId(entry, context.clientId);
      }

      const concurrentSideTask = isSideTask && entry.promptActive;
      // Admission-time check: pendingPromptCount changes synchronously when a
      // prompt is accepted, before its queue callback sets promptActive. A
      // check inside the branch callback would observe post-prompt state and
      // silently wait instead of rejecting.
      if (!isSideTask && (entry.pendingPromptCount > 0 || entry.promptActive)) {
        throw new BranchWhilePromptActiveError(sessionId);
      }
      const branchResult = (
        concurrentSideTask ? Promise.resolve() : entry.promptQueue
      ).then(async () => {
        if (
          isClosingOrAuthorizingClose(entry) ||
          byId.get(sessionId) !== entry
        ) {
          throw new SessionNotFoundError(sessionId, 'The session is closing');
        }

        assertFreshSessionsAvailable();
        let admission: ReturnType<typeof reserveFreshSession> | undefined;
        if (restoreBranch) {
          if (
            byId.size + inFlightSpawns.size + inFlightRestores.size >=
            maxSessions
          ) {
            throw new SessionLimitExceededError(maxSessions);
          }
          admission = reserveFreshSession({
            operation: 'branch',
            workspaceCwd: boundWorkspace,
            sourceSessionId: sessionId,
          });
        }
        let admissionReleased = false;
        const releaseAdmissionOnce = () => {
          if (admissionReleased || !admission) return;
          admissionReleased = true;
          releaseFreshSessionReservation(admission);
        };
        try {
          // HAZARD: dispatch the source-session mutation on the entry's
          // OWN connection, not `ci.connection` (the current attach
          // target). During the channel-overlap window (A dying, B
          // freshly spawned as `channelInfo`) the source session still
          // lives on A; routing through B reports session-not-found or
          // operates on the wrong runtime state. The NEW session's
          // restore below stays on the intended channel.
          const mutation = entry.connection.extMethod(
            isSideTask
              ? SERVE_CONTROL_EXT_METHODS.sessionSideTask
              : SERVE_CONTROL_EXT_METHODS.sessionBranch,
            {
              sessionId,
              cwd: boundWorkspace,
              name: req.name,
              ...(req.atRecordId !== undefined
                ? { atRecordId: req.atRecordId }
                : {}),
            },
          );
          // ACP cannot cancel a branch after dispatch. Keep the queue and
          // reservation until its real outcome is known so a caller never sees
          // a timeout followed by an unobserved committed session. The
          // transport-closed race rejects only when the channel exits — a
          // branch whose channel died cannot be observed or delivered anyway —
          // so a slow-but-alive fork still waits for its real outcome.
          let result: {
            newSessionId: string;
            title?: string;
            displayName?: string;
          };
          try {
            result = (await Promise.race([
              mutation,
              getTransportClosedReject(entry),
            ])) as typeof result;
          } catch (err) {
            const data = (err as { data?: unknown })?.data;
            if (
              !isSideTask &&
              data &&
              typeof data === 'object' &&
              (data as { errorKind?: unknown }).errorKind === 'session_busy'
            ) {
              const msg =
                (err as { message?: string })?.message ?? 'Branch failed';
              throw new SessionBusyError(sessionId, msg);
            }
            throw err;
          }

          if (!result || typeof result.newSessionId !== 'string') {
            throw new Error(
              `branchSession: agent returned invalid response: ${JSON.stringify(result)}`,
            );
          }
          // The fork is durably committed at this point, including the
          // persisted-only path that never becomes a live session. Mark
          // before any restore attempt so a committed branch is visible to
          // catalog-version watchers even when the restore later fails.
          markSessionCatalogChanged();
          if (opts.sessionAttachmentsRoot) {
            const branchAttachments = new SessionAttachmentStore(
              opts.sessionAttachmentsRoot,
              result.newSessionId,
            );
            try {
              await branchAttachments.copyFrom(entry.attachments);
            } catch (error) {
              writeStderrLine(
                `qwen serve: failed to copy attachments for branched session ${result.newSessionId}: ${error instanceof Error ? error.message : String(error)}`,
              );
            } finally {
              await branchAttachments.close();
            }
          }
          const rawBranchName = result.displayName ?? result.title;
          const branchDisplayName =
            typeof rawBranchName === 'string'
              ? rawBranchName
              : result.newSessionId.slice(0, 8);

          if (!restoreBranch) {
            return {
              sessionId: result.newSessionId,
              displayName: branchDisplayName,
              forkedFrom: {
                sessionId,
                displayName: entry.displayName ?? sessionId.slice(0, 8),
              },
            };
          }

          const ci = await ensureChannel();
          let restored;
          try {
            const hideInheritedHistory = req.replayInheritedHistory === false;
            restored = await restoreSession(
              'load',
              {
                sessionId: result.newSessionId,
                workspaceCwd: boundWorkspace,
                clientId: context?.clientId,
                ...(hideInheritedHistory
                  ? {
                      historyReplay: 'response',
                      hideInheritedHistory: true,
                    }
                  : {}),
                ...source,
              },
              {
                skipFreshSessionAdmission: true,
                // A fork inherits the parent's dangling ask_user_question
                // tail, but forks cannot run that tool — never fire a
                // restore prompt into a brand-new branch.
                suppressRestorePrompt: true,
              },
            );
            releaseAdmissionOnce();
          } catch (restoreErr) {
            writeStderrLine(
              `qwen serve: branchSession load failed for ${result.newSessionId}; closing partial live state while preserving the committed session...`,
            );
            try {
              if (!ci.isDying) {
                await withTimeout(
                  Promise.race([
                    ci.connection.extMethod(
                      SERVE_CONTROL_EXT_METHODS.sessionClose,
                      {
                        sessionId: result.newSessionId,
                        cwd: boundWorkspace,
                        drainTimeoutMs:
                          sessionCloseDrainBudgetMs(initTimeoutMs),
                      },
                    ),
                    channelUnavailableReject(
                      ci.channel,
                      'during branchSession cleanup',
                    ),
                  ]),
                  initTimeoutMs,
                  'branchSession cleanup',
                );
              }
            } catch (cleanupErr) {
              writeStderrLine(
                `qwen serve: branchSession live-state close for ${result.newSessionId} failed: ${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`,
              );
            }
            throw restoreErr;
          }

          const newEntry = byId.get(result.newSessionId);
          if (newEntry && !opts.sessionAttachmentsRoot) {
            try {
              await newEntry.attachments.copyFrom(entry.attachments);
            } catch (error) {
              writeStderrLine(
                `qwen serve: failed to copy attachments for branched session ${result.newSessionId}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          if (newEntry) newEntry.displayName = branchDisplayName;
          let sourcePersisted: boolean | undefined;
          if (newEntry?.sourceType) {
            try {
              const sourceResult = await withTimeout(
                newEntry.connection.extMethod(
                  SERVE_CONTROL_EXT_METHODS.sessionSource,
                  {
                    sessionId: newEntry.sessionId,
                    sourceType: newEntry.sourceType,
                    ...(newEntry.sourceId !== undefined
                      ? { sourceId: newEntry.sourceId }
                      : {}),
                  },
                ),
                initTimeoutMs,
                'sessionSource',
              );
              sourcePersisted =
                (sourceResult as { persisted?: boolean } | undefined)
                  ?.persisted === true;
            } catch (error) {
              sourcePersisted = false;
              writeStderrLine(
                `qwen serve: source metadata for branched session ${result.newSessionId} was not persisted: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }

          return {
            ...restored,
            displayName: branchDisplayName,
            forkedFrom: {
              sessionId,
              displayName: entry.displayName ?? sessionId.slice(0, 8),
            },
            ...(sourcePersisted !== undefined ? { sourcePersisted } : {}),
          };
        } finally {
          releaseAdmissionOnce();
        }
      });
      if (!concurrentSideTask) {
        entry.promptQueue = branchResult.then(
          () => undefined,
          () => undefined,
        );
      }
      return branchResult;
    },

    async createSideTaskSession(sessionId, req, context) {
      const result = await this.branchSession(
        sessionId,
        {
          name: req.name,
          sourceType: 'side_task',
          sourceId: sessionId,
          replayInheritedHistory: false,
        },
        context,
      );
      const restoredResult = result as typeof result & BridgeRestoredSession;
      const { forkedFrom: _forkedFrom, ...sideTask } = restoredResult;
      return {
        ...sideTask,
        parentSessionId: sessionId,
      };
    },

    async changeSessionCwd(
      sessionId: string,
      req: ChangeSessionCwdRequest,
      context?: BridgeClientRequestContext,
    ): Promise<ChangeSessionCwdResult> {
      if (shuttingDown) throw new Error('AcpSessionBridge is shutting down');

      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);

      const originatorClientId = resolveTrustedClientId(
        entry,
        context?.clientId,
      );

      // Chain onto promptQueue and update tail — ensures:
      // 1. cd waits for any in-flight prompt to complete
      // 2. Subsequent prompts wait for cd to complete (prevents stale config.cwd)
      const cdPromise = entry.promptQueue.then(async () => {
        if (entry.promptActive) {
          throw new CdWhilePromptActiveError(sessionId);
        }

        assertLivePromptEntry(sessionId, entry);
        const raw = await Promise.race([
          entry.connection.extMethod(SERVE_CONTROL_EXT_METHODS.sessionCd, {
            sessionId,
            path: req.path,
            ...(req.allowedRoots ? { allowedRoots: req.allowedRoots } : {}),
            ...(req.managedRelocation
              ? { managedRelocation: req.managedRelocation }
              : {}),
          }),
          getTransportClosedReject(entry),
        ]);
        const extResult = raw as {
          previousCwd: string;
          newCwd: string;
          warnings: string[];
        };
        if (
          typeof extResult?.previousCwd !== 'string' ||
          typeof extResult?.newCwd !== 'string' ||
          !Array.isArray(extResult?.warnings)
        ) {
          throw new Error(
            `changeSessionCwd: unexpected response shape from agent: ${JSON.stringify(raw)}`,
          );
        }

        // State update inside the queue lambda — always executes when
        // the extMethod settles, regardless of caller timeout.
        entry.effectiveCwd = extResult.newCwd;
        if (extResult.previousCwd !== extResult.newCwd) {
          entry.events.publish({
            type: 'session_cwd_changed',
            data: {
              sessionId,
              previousCwd: extResult.previousCwd,
              newCwd: extResult.newCwd,
            },
            ...(originatorClientId ? { originatorClientId } : {}),
          });
        }
        return extResult;
      });

      // Queue tail tied to the raw extMethod settlement — subsequent
      // operations wait for the actual cd to finish, not the timeout.
      entry.promptQueue = cdPromise.then(
        () => undefined,
        () => undefined,
      );
      entry.cwdChangeQueue = cdPromise.then(
        () => undefined,
        () => undefined,
      );

      // Timeout is caller-facing only: surfaces a deadline exceeded error
      // to the HTTP client without advancing the queue prematurely.
      const result = await withTimeout(
        cdPromise,
        Math.max(initTimeoutMs, 30_000),
        'changeSessionCwd',
      );

      writeStderrLine(
        `qwen serve: session ${sessionId} cwd changed: ` +
          `${result.previousCwd} -> ${result.newCwd}` +
          (result.warnings.length > 0
            ? ` (warnings: ${result.warnings.join('; ')})`
            : ''),
      );

      return { sessionId, ...result };
    },

    setSessionWorktree(sessionId, worktree) {
      const entry = byId.get(sessionId);
      if (entry) {
        entry.worktree = worktree;
        markSessionCatalogChanged();
      }
    },

    async closeSession(sessionId, context, closeOpts) {
      return closeSessionImpl(sessionId, context, closeOpts);
    },

    updateSessionMetadata(sessionId, metadata, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      // Capture the trusted originator so the broadcast envelope can
      // attribute the change to a specific client (parity with
      // `model_switched`, `approval_mode_changed`, etc., which stamp
      // envelope-level `originatorClientId`). Prior to this, the
      // metadata broadcast had no originator stamp at all — UIs
      // couldn't tell which client renamed the session.
      const metadataOriginatorClientId =
        context?.clientId !== undefined
          ? resolveTrustedClientId(entry, context.clientId)
          : undefined;
      // Validate everything before mutating anything: a combined
      // displayName+pr request must not partially apply when the pr is
      // invalid.
      if (metadata.pr !== undefined) {
        const pr = metadata.pr as unknown;
        if (
          pr === null ||
          typeof pr !== 'object' ||
          typeof (pr as SessionPrInfo).number !== 'number' ||
          !Number.isInteger((pr as SessionPrInfo).number) ||
          (pr as SessionPrInfo).number <= 0 ||
          typeof (pr as SessionPrInfo).url !== 'string' ||
          (pr as SessionPrInfo).url.length > SESSION_PR_URL_MAX_LENGTH ||
          !/^https?:\/\//i.test((pr as SessionPrInfo).url) ||
          // The url is interpolated into the stderr audit line — control
          // characters would let a client forge log lines (the displayName
          // branch rejects them for the same reason).
          hasControlCharacter((pr as SessionPrInfo).url)
        ) {
          throw new InvalidSessionMetadataError(
            'pr',
            `must be an object with a positive integer \`number\` and an http(s) \`url\` of at most ${SESSION_PR_URL_MAX_LENGTH} characters, without control characters`,
          );
        }
      }
      if (metadata.displayName !== undefined) {
        if (
          typeof metadata.displayName !== 'string' ||
          metadata.displayName.length > MAX_DISPLAY_NAME_LENGTH
        ) {
          throw new InvalidSessionMetadataError(
            'displayName',
            `must be a string of at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
          );
        }
        if (hasControlCharacter(metadata.displayName)) {
          throw new InvalidSessionMetadataError(
            'displayName',
            'must not contain control characters',
          );
        }
        const nextDisplayName = metadata.displayName || undefined;
        if (entry.displayName !== nextDisplayName) {
          entry.displayName = nextDisplayName;
          // The catalog exposes display names; an actual rename is a
          // static-metadata change. Mark before the SSE publish so the
          // revision never trails the client-visible event.
          markSessionCatalogChanged();
          writeStderrLine(
            `qwen serve: updated session metadata ${JSON.stringify(sessionId)} ` +
              `displayName=${entry.displayName === undefined ? 'cleared' : 'set'}` +
              (context?.clientId
                ? ` by client ${JSON.stringify(context.clientId)}`
                : ''),
          );
          if (nextDisplayName) {
            entry.connection
              .extMethod(SERVE_CONTROL_EXT_METHODS.sessionTitle, {
                sessionId,
                displayName: nextDisplayName,
                titleSource: 'manual',
              })
              .then((res: unknown) => {
                const r = res as { persisted?: boolean } | undefined;
                if (r && r.persisted === false) {
                  writeStderrLine(
                    `qwen serve: displayName for ${sessionId} was not persisted`,
                  );
                }
              })
              .catch((err: unknown) => {
                writeStderrLine(
                  `qwen serve: failed to persist displayName for ${sessionId}: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
              });
          }
          try {
            entry.events.publish({
              type: 'session_metadata_updated',
              data: { sessionId, displayName: entry.displayName },
              ...(metadataOriginatorClientId
                ? { originatorClientId: metadataOriginatorClientId }
                : {}),
            });
          } catch {
            /* bus already closed */
          }
        }
      }
      if (metadata.pr !== undefined) {
        // Already validated above, before any mutation.
        const bound = metadata.pr;
        const existing = entry.prs ?? [];
        const latest = existing[existing.length - 1];
        if (latest?.number === bound.number && latest.url === bound.url) {
          // Same binding repeated — no change, no event.
        } else {
          // Re-binding a number refreshes it and moves it to latest.
          entry.prs = [
            ...existing.filter((p) => p.number !== bound.number),
            { number: bound.number, url: bound.url },
          ].slice(-SESSION_PR_LIST_LIMIT);
          markSessionCatalogChanged();
          writeStderrLine(
            `qwen serve: updated session metadata ${JSON.stringify(sessionId)} ` +
              `pr=${bound.number} bound (${bound.url})` +
              (context?.clientId
                ? ` by client ${JSON.stringify(context.clientId)}`
                : ''),
          );
          try {
            entry.events.publish({
              type: 'session_metadata_updated',
              // Echo the current name: SDK folds treat an absent displayName
              // as "cleared", so a pr-only event must not blank the title.
              data: {
                sessionId,
                ...(entry.displayName !== undefined
                  ? { displayName: entry.displayName }
                  : {}),
                prs: entry.prs,
              },
              ...(metadataOriginatorClientId
                ? { originatorClientId: metadataOriginatorClientId }
                : {}),
            });
          } catch {
            /* bus already closed */
          }
        }
      }
      return {
        displayName: entry.displayName,
        ...(entry.prs && entry.prs.length > 0 ? { prs: entry.prs } : {}),
      };
    },

    seedSessionPrs(sessionId, prs) {
      const entry = byId.get(sessionId);
      if (!entry || (entry.prs && entry.prs.length > 0)) return;
      entry.prs = prs
        .map(({ number, url }) => ({ number, url }))
        .slice(-SESSION_PR_LIST_LIMIT);
    },

    async getSessionArtifacts(sessionId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);
      return entry.artifacts.list();
    },

    async addSessionArtifact(sessionId, artifact, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const clientId = resolveTrustedClientId(entry, context?.clientId);
      const input = makeClientArtifactInput(artifact, clientId);
      const result: SessionArtifactMutationResult =
        await entry.artifacts.upsertMany([input], {
          validationStrict: true,
          persistenceStrict: false,
        });
      publishArtifactChanges(entry, result.changes, clientId);
      const warnings = [...(result.warnings ?? [])];
      return warnings.length > 0 ? { ...result, warnings } : result;
    },

    async removeSessionArtifact(sessionId, artifactId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const clientId = resolveTrustedClientId(entry, context?.clientId);
      const result = await entry.artifacts.remove(artifactId, { clientId });
      publishArtifactChanges(entry, result.changes, clientId);
      const warnings = [...(result.warnings ?? [])];
      return warnings.length > 0 ? { ...result, warnings } : result;
    },

    listWorkspaceSessions(workspaceCwd) {
      if (!path.isAbsolute(workspaceCwd)) return [];
      const key =
        workspaceCwd === boundWorkspace
          ? boundWorkspace
          : canonicalizeWorkspace(workspaceCwd);
      if (key !== boundWorkspace) return [];
      const out: BridgeSessionSummary[] = [];
      for (const entry of byId.values()) {
        if (entry.workspaceCwd === key) {
          out.push(toSessionSummary(entry));
        }
      }
      return out;
    },

    getSessionCatalogVersion,

    markSessionCatalogChanged,

    getSessionSummary(sessionId) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      return toSessionSummary(entry);
    },

    recordHeartbeat(sessionId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      // Validate the optional client id BEFORE bumping any timestamp so
      // an unknown client doesn't get to advance the per-session
      // watermark — that would let an attacker with a valid bearer
      // token mask client absence by spamming heartbeats with random
      // ids. `resolveTrustedClientId` throws `InvalidClientIdError`,
      // which the route layer maps to `400 invalid_client_id`.
      const clientId = resolveTrustedClientId(entry, context?.clientId);
      const lastSeenAt = Date.now();
      entry.sessionLastSeenAt = lastSeenAt;
      if (clientId !== undefined) {
        entry.clientLastSeenAt.set(clientId, lastSeenAt);
      }
      return {
        sessionId: entry.sessionId,
        ...(clientId !== undefined ? { clientId } : {}),
        lastSeenAt,
      };
    },

    getHeartbeatState(sessionId) {
      const entry = byId.get(sessionId);
      if (!entry) return undefined;
      // Snapshot the client map so callers can't mutate the live one;
      // `sessionLastSeenAt` is undefined for sessions that have never
      // received a heartbeat (the typical state right after spawn).
      return {
        ...(entry.sessionLastSeenAt !== undefined
          ? { sessionLastSeenAt: entry.sessionLastSeenAt }
          : {}),
        clientLastSeenAt: new Map(entry.clientLastSeenAt),
      };
    },

    publishWorkspaceEvent(event) {
      // Workspace-level mutations (memory writes / agent CRUD) need a
      // fan-out path that doesn't require a session id. Iterate every
      // live session's bus best-effort — a closed bus (mid-shutdown,
      // or evicted under load) is silently skipped.
      //
      // The route handler's contract is "read-after-write" and any SSE
      // subscriber that misses the event can re-fetch via the route's
      // GET sibling.
      //
      // Per-entry exceptions go to stderr in normal operation, but
      // are downgraded to the debug channel when `shuttingDown` is
      // true. `EventBus.publish` is documented never to throw, so
      // anything landing here in normal ops is unexpected — silencing
      // via QWEN_SERVE_DEBUG would let a regression succeed at the
      // route layer while SSE subscribers stop seeing events.
      //
      // PR #4255 fold-in 9: track per-session success/fail. A
      // closed-bus return (`undefined` from `EventBus.publish` —
      // see eventBus.ts:195-207) counts as a failure (operator
      // signal), distinct from a thrown exception (regression
      // signal). When zero sessions are active OR every active bus
      // dropped the event, we elevate to unconditional stderr so
      // monitoring catches the all-buses-dropped scenario.
      // Two near-duplicate fan-outs coexist in this file:
      //   - this `publishWorkspaceEvent` member (PR 16) — used by
      //     workspace-mutation routes that have a bridge proxy
      //     reference (memory / agents).
      //   - the local `broadcastWorkspaceEvent` closure declared above
      //     in this factory body (PR 17 mutation surface) — used by
      //     `setSessionApprovalMode`
      //     because its call site runs inside the factory closure
      //     where `this` isn't yet the proxy. The closure also takes
      //     an optional `skipSessionId` for the persisted approval-mode
      //     mirror; this member doesn't.
      // The duplication is acknowledged debt — addressed in #4297
      // fold-in 11 (#3263954688). A future refactor can extract a
      // shared `fanOutToSessions(envelope, sessions, opts?)` helper
      // once the `skipSessionId` semantics stabilize.
      const sessions = Array.from(byId.values());
      let successCount = 0;
      let failureCount = 0;
      for (const entry of sessions) {
        try {
          const published = entry.events.publish(event);
          if (published === undefined) {
            failureCount += 1;
            teeServeDebugLine(
              `publishWorkspaceEvent: publish on session ${entry.sessionId} no-op (bus closed or unserializable)`,
            );
          } else {
            successCount += 1;
          }
        } catch (err) {
          failureCount += 1;
          const detail =
            `publishWorkspaceEvent: bus publish failed for session ` +
            `${JSON.stringify(entry.sessionId)} (type=${event.type}): ` +
            `${err instanceof Error ? err.message : String(err)}`;
          if (shuttingDown) {
            teeServeDebugLine(detail);
          } else {
            writeStderrLine(`qwen serve: ${detail}`);
          }
        }
      }
      if (sessions.length > 0 && successCount === 0 && !shuttingDown) {
        writeStderrLine(
          `qwen serve: publishWorkspaceEvent type=${event.type} dropped on ALL ${failureCount} session bus(es); SSE subscribers will miss this event (GET fallback still authoritative)`,
        );
      }
    },

    knownClientIds() {
      // Snapshot the union of every live session's stamped client ids.
      // Returned as a fresh Set so callers can mutate-safely (the live
      // per-session maps stay private). Workspace-level mutation routes
      // use this to validate `X-Qwen-Client-Id` without owning a
      // session id.
      const out = new Set<string>();
      for (const entry of byId.values()) {
        for (const id of entry.clientIds.keys()) out.add(id);
      }
      return out;
    },

    async queryWorkspaceStatus(method, idle) {
      return requestWorkspaceStatus(method, idle);
    },

    async invokeWorkspaceCommand<T>(
      method: string,
      params?: Record<string, unknown>,
      invokeOpts?: { timeoutMs?: number },
    ) {
      const startsWorkspaceChannel =
        method === SERVE_CONTROL_EXT_METHODS.workspaceMcpRestart;
      const info = startsWorkspaceChannel
        ? await ensureChannel()
        : liveChannelInfo();
      if (!info) throw new SessionNotFoundError(`workspace-command:${method}`);
      try {
        const timeout = invokeOpts?.timeoutMs ?? initTimeoutMs;
        const invoke = () =>
          withTimeout(
            Promise.race([
              info.connection.extMethod(method, params ?? {}),
              getChannelClosedReject(info),
            ]),
            timeout,
            method,
          );
        const response = startsWorkspaceChannel
          ? await withWorkspaceControl(info, invoke)
          : await invoke();
        if (
          method === SERVE_CONTROL_EXT_METHODS.workspaceMcpRestart &&
          typeof params?.['serverName'] === 'string'
        ) {
          invalidateWorkspaceMcpDetailCache(params['serverName']);
          await requestWorkspaceStatus<ServeWorkspaceMcpStatus>(
            SERVE_STATUS_EXT_METHODS.workspaceMcp,
            () => {
              throw new BridgeChannelClosedError(
                'workspace MCP restart status refresh',
              );
            },
            {},
            new Set([params['serverName']]),
          );
        }
        return response as T;
      } finally {
        if (startsWorkspaceChannel && hasNoChannelWork(info)) {
          await startIdleTimer(info, 'workspace MCP restart');
        }
      }
    },

    async isWorkspaceMemoryRememberAvailable(): Promise<boolean> {
      const info = await ensureChannel();
      try {
        const response = await withWorkspaceControl(info, () =>
          withTimeout(
            Promise.race([
              info.connection.extMethod(
                SERVE_CONTROL_EXT_METHODS.workspaceMemoryRememberAvailability,
                { cwd: boundWorkspace },
              ),
              getChannelClosedReject(info),
            ]),
            initTimeoutMs,
            SERVE_CONTROL_EXT_METHODS.workspaceMemoryRememberAvailability,
          ),
        );
        return (
          response !== null &&
          typeof response === 'object' &&
          (response as Record<string, unknown>)['available'] === true
        );
      } finally {
        if (hasNoChannelWork(info)) {
          await startIdleTimer(info, 'workspace memory remember availability');
        }
      }
    },

    async runWorkspaceMemoryRemember(
      request: BridgeWorkspaceMemoryRememberRequest,
    ): Promise<BridgeWorkspaceMemoryRememberResult> {
      const info = await ensureChannel();
      try {
        const response = await withWorkspaceControl(info, () =>
          withTimeout(
            Promise.race([
              info.connection.extMethod(
                SERVE_CONTROL_EXT_METHODS.workspaceMemoryRemember,
                { ...request, cwd: boundWorkspace },
              ),
              getChannelClosedReject(info),
            ]),
            WORKSPACE_MEMORY_REMEMBER_TIMEOUT_MS,
            SERVE_CONTROL_EXT_METHODS.workspaceMemoryRemember,
          ),
        );
        return parseWorkspaceMemoryRememberResult(response);
      } finally {
        if (hasNoChannelWork(info)) {
          await startIdleTimer(info, 'workspace memory remember');
        }
      }
    },

    async runWorkspaceMemoryForget(
      request: BridgeWorkspaceMemoryForgetRequest,
    ): Promise<BridgeWorkspaceMemoryForgetResult> {
      const info = await ensureChannel();
      try {
        const response = await withWorkspaceControl(info, () =>
          withTimeout(
            Promise.race([
              info.connection.extMethod(
                SERVE_CONTROL_EXT_METHODS.workspaceMemoryForget,
                { ...request, cwd: boundWorkspace },
              ),
              getChannelClosedReject(info),
            ]),
            WORKSPACE_MEMORY_REMEMBER_TIMEOUT_MS,
            SERVE_CONTROL_EXT_METHODS.workspaceMemoryForget,
          ),
        );
        return parseWorkspaceMemoryForgetResult(response);
      } finally {
        if (hasNoChannelWork(info)) {
          await startIdleTimer(info, 'workspace memory forget');
        }
      }
    },

    async runWorkspaceMemoryDream(): Promise<BridgeWorkspaceMemoryDreamResult> {
      const info = await ensureChannel();
      try {
        const response = await withWorkspaceControl(info, () =>
          withTimeout(
            Promise.race([
              info.connection.extMethod(
                SERVE_CONTROL_EXT_METHODS.workspaceMemoryDream,
                { cwd: boundWorkspace },
              ),
              getChannelClosedReject(info),
            ]),
            WORKSPACE_MEMORY_REMEMBER_TIMEOUT_MS,
            SERVE_CONTROL_EXT_METHODS.workspaceMemoryDream,
          ),
        );
        return parseWorkspaceMemoryDreamResult(response);
      } finally {
        if (hasNoChannelWork(info)) {
          await startIdleTimer(info, 'workspace memory dream');
        }
      }
    },

    async getWorkspaceMcpToolsStatus(serverName) {
      const result = await requestWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceMcpTools,
        () => {
          const cached = workspaceMcpToolsCache.get(serverName);
          return cached
            ? { ...cached, acpChannelLive: false }
            : {
                v: STATUS_SCHEMA_VERSION,
                workspaceCwd: boundWorkspace,
                serverName,
                initialized: false,
                acpChannelLive: false,
                tools: [],
                errors: [
                  {
                    kind: 'mcp_tools' as const,
                    status: 'not_started' as const,
                    hint: 'initialize MCP discovery to populate',
                  },
                ],
              };
        },
        { serverName },
      );
      if (result.acpChannelLive) {
        workspaceMcpToolsCache.set(serverName, result);
      }
      return result;
    },

    async getWorkspaceMcpResourcesStatus(serverName) {
      const result = await requestWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceMcpResources,
        () => {
          const cached = workspaceMcpResourcesCache.get(serverName);
          return cached
            ? { ...cached, acpChannelLive: false }
            : {
                v: STATUS_SCHEMA_VERSION,
                workspaceCwd: boundWorkspace,
                serverName,
                initialized: false,
                acpChannelLive: false,
                resources: [],
                errors: [
                  {
                    kind: 'mcp_resources' as const,
                    status: 'not_started' as const,
                    hint: 'initialize MCP discovery to populate',
                  },
                ],
              };
        },
        { serverName },
      );
      if (result.acpChannelLive) {
        workspaceMcpResourcesCache.set(serverName, result);
      }
      return result;
    },

    async getWorkspaceToolsStatus() {
      return requestWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceTools,
        () => ({
          v: STATUS_SCHEMA_VERSION,
          workspaceCwd: boundWorkspace,
          initialized: true as const,
          acpChannelLive: false,
          tools: [],
          errors: [
            {
              kind: 'tools',
              status: 'not_started' as const,
              hint: 'spawn a session to populate',
            },
          ],
        }),
      );
    },

    async getSessionContextStatus(sessionId) {
      return requestSessionStatus(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionContext,
      );
    },

    async getSessionContextUsageStatus(sessionId, opts) {
      return requestSessionStatus(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionContextUsage,
        { detail: opts?.detail === true },
      );
    },

    async getSessionSupportedCommandsStatus(sessionId) {
      return requestSessionStatus(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionSupportedCommands,
      );
    },

    async getSessionTasksStatus(sessionId) {
      return requestSessionStatus<ServeSessionTasksStatus>(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionTasks,
      );
    },

    async getSessionLspStatus(sessionId) {
      return requestSessionStatus<ServeSessionLspStatus>(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionLspStatus,
      );
    },

    async getSessionTranscriptPage(req) {
      return requestSessionTranscriptPage(req);
    },

    async cancelSessionTask(sessionId, taskId, taskKind) {
      return requestSessionStatus<{ cancelled: boolean }>(
        sessionId,
        SERVE_CONTROL_EXT_METHODS.sessionTaskCancel,
        { taskId, taskKind },
      );
    },

    async controlSessionGoal(sessionId, request, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const info = channelInfoForEntry(entry);
      if (!info || info.isDying) throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);
      return requestSessionStatus(
        sessionId,
        SERVE_CONTROL_EXT_METHODS.sessionGoalControl,
        { request },
      );
    },

    async clearSessionGoal(sessionId) {
      return requestSessionStatus<{ cleared: boolean; condition?: string }>(
        sessionId,
        SERVE_CONTROL_EXT_METHODS.sessionGoalClear,
      );
    },

    async getSessionGoal(sessionId) {
      return requestSessionStatus<BridgeSessionGoal>(
        sessionId,
        SERVE_CONTROL_EXT_METHODS.sessionGoalGet,
      );
    },

    async continueSession(sessionId, context) {
      // Validate the originator up-front, mirroring POST /session/:id/prompt, so
      // an unknown client id (or a session that vanished) surfaces as an error
      // to the caller instead of a misleading accepted:true whose continuation
      // is then silently dropped at admission.
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);

      // Accept/reject pre-check: the agent classifies the last turn (and rejects
      // when one is already in flight) without firing anything.
      const decision = await requestSessionStatus<{
        accepted: boolean;
        interruption: 'none' | 'interrupted_prompt' | 'interrupted_turn';
      }>(sessionId, SERVE_CONTROL_EXT_METHODS.sessionContinue);

      if (!decision.accepted) {
        return decision;
      }

      // Accepted → drive the real turn through the normal prompt-admission path
      // (so pendingPromptCount / promptActive / originator are tracked and
      // turn-complete is broadcast; the agent's Session.prompt() runs it off the
      // trusted continue meta re-armed by `isContinue`). Capture a replay cursor
      // + correlation id BEFORE dispatch — mirroring POST /session/:id/prompt —
      // so a client attaching the SSE stream afterwards can replay missed events
      // and correlate turn_complete / turn_error with this continuation.
      const liveEntry = byId.get(sessionId);
      if (!liveEntry) throw new SessionNotFoundError(sessionId);
      const lastEventId = liveEntry.events.lastEventId;
      // Epoch token paired with the cursor above, mirroring the prompt 202
      // envelope (DAEMON-001): without it a client that seeds its SSE resume
      // position from this response cannot detect a daemon restart.
      const eventEpoch = liveEntry.events.epoch;
      const promptId = context?.promptId;

      // Admit synchronously: `sendPrompt` throws synchronously for queue-full /
      // pre-aborted, so an admission failure propagates out of here and the
      // caller gets an error instead of a misleading accepted:true whose
      // continuation was never queued. Only failures AFTER the turn is admitted
      // (it then runs async) reach the `.catch` below — those are logged, since
      // the ack already went out and the turn's terminal event covers clients.
      // No caller signal: a continuation is cancelled via the cancelSession
      // route (entry.connection.cancel), not a per-dispatch AbortController.
      const promptPromise = bridgeApi.sendPrompt(
        sessionId,
        { sessionId, prompt: [] } as Parameters<
          AcpSessionBridge['sendPrompt']
        >[1],
        undefined,
        {
          ...(context?.clientId !== undefined
            ? { clientId: context.clientId }
            : {}),
          ...(promptId !== undefined ? { promptId } : {}),
          continue: true,
        },
      );
      promptPromise.catch((err) => {
        teeServeDebugLine(
          `continueSession: continuation turn failed for ${sessionId}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      });

      return {
        ...decision,
        ...(promptId !== undefined ? { promptId } : {}),
        lastEventId,
        eventEpoch,
      };
    },

    async getSessionStatsStatus(sessionId) {
      return requestSessionStatus<ServeSessionStatsStatus>(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionStats,
      );
    },

    async getWorkspaceHooksStatus() {
      return requestWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceHooks,
        () => createIdleWorkspaceHooksStatus(boundWorkspace),
      );
    },

    async getSessionHooksStatus(sessionId) {
      return requestSessionStatus(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionHooks,
      );
    },

    async getWorkspaceExtensionsStatus() {
      return requestWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceExtensions,
        () => createIdleWorkspaceExtensionsStatus(boundWorkspace),
      );
    },

    async refreshExtensionsForAllSessions(data) {
      const sessions = Array.from(byId.values());
      const bootstrapRefreshConnections = new Set<
        (typeof sessions)[number]['connection']
      >();
      const refreshSession = async (
        entry: (typeof sessions)[number],
        refreshBootstrap: boolean,
      ) => {
        let inFlight = inFlightExtensionRefreshes.get(entry.sessionId);
        let created = false;
        if (
          !inFlight ||
          inFlight.connection !== entry.connection ||
          (refreshBootstrap && !inFlight.refreshBootstrap)
        ) {
          const promise = (async () => {
            await entry.connection.extMethod(
              SERVE_CONTROL_EXT_METHODS.workspaceExtensionsRefresh,
              {
                sessionId: entry.sessionId,
                ...(refreshBootstrap ? {} : { refreshBootstrap: false }),
              },
            );
          })();
          let rejectUnavailable!: () => void;
          const unavailable = new Promise<never>((_resolve, reject) => {
            rejectUnavailable = () =>
              reject(
                new BridgeChannelClosedError('refreshExtensionsForAllSessions'),
              );
          });
          inFlight = {
            connection: entry.connection,
            promise,
            wait: Promise.race([
              withTimeout(
                promise,
                30_000,
                SERVE_CONTROL_EXT_METHODS.workspaceExtensionsRefresh,
              ),
              unavailable,
            ]),
            rejectUnavailable,
            refreshBootstrap,
          };
          inFlightExtensionRefreshes.set(entry.sessionId, inFlight);
          created = true;
        }
        const clear = () => {
          if (inFlightExtensionRefreshes.get(entry.sessionId) === inFlight) {
            inFlightExtensionRefreshes.delete(entry.sessionId);
          }
        };
        if (created) void inFlight.promise.then(clear, clear);
        await inFlight.wait;
      };

      const results = await Promise.all(
        sessions.map(async (entry) => {
          const info = channelInfoForEntry(entry);
          if (!info || info.isDying) {
            return {
              refreshed: 0,
              failed: 0,
              entry,
              refreshBootstrap: false,
            };
          }
          const refreshBootstrap = !bootstrapRefreshConnections.has(
            entry.connection,
          );
          bootstrapRefreshConnections.add(entry.connection);
          try {
            await refreshSession(entry, refreshBootstrap);
            return { refreshed: 1, failed: 0, entry, refreshBootstrap };
          } catch (err) {
            writeServeDebugLine(
              `refreshExtensions: session ${entry.sessionId} failed: ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
            return { refreshed: 0, failed: 1, entry, refreshBootstrap };
          }
        }),
      );

      await Promise.all(
        results
          .filter((result) => result.failed > 0 && result.refreshBootstrap)
          .map(async (failedBootstrap) => {
            const retry = results.find(
              (result) =>
                result.refreshed > 0 &&
                result.entry.connection === failedBootstrap.entry.connection,
            );
            if (!retry) return;
            try {
              await refreshSession(retry.entry, true);
            } catch (err) {
              writeServeDebugLine(
                `refreshExtensions: bootstrap retry via session ${retry.entry.sessionId} failed: ` +
                  `${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }),
      );

      const refreshed = results.reduce(
        (sum, result) => sum + result.refreshed,
        0,
      );
      const failed = results.reduce((sum, result) => sum + result.failed, 0);

      if (refreshed > 0 || failed > 0 || data?.status !== undefined) {
        broadcastWorkspaceEvent({
          type: 'extensions_changed',
          data: { ...data, refreshed, failed },
        });
      }

      return { refreshed, failed };
    },

    broadcastExtensionsChanged(data) {
      broadcastWorkspaceEvent({
        type: 'extensions_changed',
        data,
      });
    },

    async setSessionModel(sessionId, req, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const originatorClientId = resolveTrustedClientId(
        entry,
        context?.clientId,
      );
      const normalized: SetSessionModelRequest = { ...req, sessionId };
      // The ACP SDK marks setSessionModel as unstable (not in spec yet); the
      // method on AgentSideConnection is `unstable_setSessionModel`. Cast
      // through the shape we know rather than couple to the prefix in case
      // it's renamed when the spec stabilizes.
      const conn = entry.connection as unknown as {
        unstable_setSessionModel(
          p: SetSessionModelRequest,
        ): Promise<SetSessionModelResponse>;
      };
      // Serialize through `entry.modelChangeQueue` so a `POST /session/:id/model`
      // can't race with `applyModelServiceId` (e.g. an attach-with-different-
      // modelServiceId) and leave the agent connection in an indeterminate
      // model. `applyModelServiceId` already chains on this queue; without
      // mirroring that here, two concurrent model changes interleave and the
      // last `model_switched` event published may not match the actual model
      // the agent is on.
      //
      // Race the agent call against `transportClosedReject` and a
      // `withTimeout` so a wedged child can't block the HTTP handler
      // forever. Matches `sendPrompt` (transport race) and
      // `applyModelServiceId` (timeout) — the absence of either was an
      // attack surface for "POST /session/:id/model never returns".
      // See `getTransportClosedReject` for the single-listener invariant.
      //
      // FIXME(stage-2): we reuse `initTimeoutMs` (default 10s) as the
      // model-switch deadline because the two values happen to share
      // a sensible order of magnitude today. They're conceptually
      // distinct (cold-start handshake vs in-flight model swap) and
      // a Stage 2 split into `modelSwitchTimeoutMs` would let
      // operators tune them independently — also a good time to
      // remove the no-abort behavior of `withTimeout` (it rejects
      // the promise but leaves the underlying ACP call running, so a
      // late-arriving `model_switched` can race a previously-fired
      // `model_switch_failed`). Both depend on ACP exposing a cancel
      // signal for `unstable_setSessionModel`.
      const transportClosed = getTransportClosedReject(entry);
      const work = entry.modelChangeQueue.then(async () => {
        // A1: suppress the agent's current_model_update notification (this
        // path drives Session.setModel, which emits it) while the bridge
        // owns the change. Publish the authoritative model_switched INSIDE
        // this callback — i.e. while the flag is still true — mirroring
        // `applyModelServiceId`, so the agent notification can never slip
        // through after the flag clears even if transport ordering changes.
        entry.modelRoundtripInFlight = true;
        // Only reconcile after a change that actually landed. If the
        // roundtrip rejects (timeout / transport close) `publishModelSwitched`
        // never ran and the cache is unchanged, so a reconcile would just emit
        // a confusing corrective `model_switched` alongside the
        // `model_switch_failed` the catch block already publishes.
        let succeeded = false;
        try {
          const result = await Promise.race([
            withTimeout(
              conn.unstable_setSessionModel(normalized),
              initTimeoutMs,
              'setSessionModel',
            ),
            transportClosed,
          ]);
          // Cache the advertised selector as received from the caller. Any
          // drift is corrected by `reconcileAfterRoundtrip`, which reads the
          // agent's authoritative selector and re-publishes if it differs.
          publishModelSwitched(entry, req.modelId, originatorClientId);
          broadcastWorkspaceEvent({
            type: 'settings_changed',
            data: {
              key: 'model.name',
              value: getCanonicalModelId(result, req.modelId),
            },
            ...(originatorClientId ? { originatorClientId } : {}),
          });
          succeeded = true;
          return result;
        } finally {
          entry.modelRoundtripInFlight = false;
          if (succeeded) {
            void reconcileAfterRoundtrip(entry, 'model');
          } else {
            writeStderrLine(
              `[reconcile] session=${entry.sessionId} target=model action=skipped reason=roundtrip_failed`,
            );
          }
        }
      });
      // Tail-swallow on the queue so a model-change failure doesn't poison
      // every subsequent change (matches `applyModelServiceId`'s pattern).
      entry.modelChangeQueue = work.then(
        () => undefined,
        () => undefined,
      );
      let response: SetSessionModelResponse;
      try {
        response = await work;
      } catch (err) {
        // Mirror `applyModelServiceId`'s observability contract: surface
        // failed model changes on the SSE bus so subscribers can update
        // their UI / retry. Without this the only signal is the HTTP
        // 5xx, which doesn't reach passive viewers. `publish()` never
        // throws (see `publishModelSwitched`), so no wrapper.
        entry.events.publish({
          type: 'model_switch_failed',
          data: {
            sessionId: entry.sessionId,
            requestedModelId: req.modelId,
            error: err instanceof Error ? err.message : String(err),
          },
          ...(originatorClientId ? { originatorClientId } : {}),
        });
        throw err;
      }
      return response;
    },

    async setSessionConfigOption(sessionId, req) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const info = channelInfoForEntry(entry);
      if (!info || info.isDying) throw new SessionNotFoundError(sessionId);
      const normalized: SetSessionConfigOptionRequest = { ...req, sessionId };
      const transportClosed = getTransportClosedReject(entry);
      const work = entry.modelChangeQueue.then(() =>
        Promise.race([
          withTimeout(
            entry.connection.setSessionConfigOption(normalized),
            initTimeoutMs,
            'setSessionConfigOption',
          ),
          transportClosed,
        ]),
      );
      entry.modelChangeQueue = work.then(
        () => undefined,
        () => undefined,
      );
      return (await work) as SetSessionConfigOptionResponse;
    },

    async setSessionLanguage(sessionId, params, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const info = channelInfoForEntry(entry);
      if (!info || info.isDying) throw new SessionNotFoundError(sessionId);
      const originatorClientId = resolveTrustedClientId(
        entry,
        context?.clientId,
      );

      const result = (await Promise.race([
        withTimeout(
          entry.connection.extMethod(
            SERVE_CONTROL_EXT_METHODS.sessionLanguage,
            {
              sessionId,
              language: params.language,
              syncOutputLanguage: params.syncOutputLanguage,
            },
          ),
          initTimeoutMs,
          SERVE_CONTROL_EXT_METHODS.sessionLanguage,
        ),
        getTransportClosedReject(entry),
      ])) as {
        language: string;
        outputLanguage: string | null;
        refreshed: boolean;
      };

      try {
        entry.events.publish({
          type: 'language_changed',
          data: {
            sessionId: entry.sessionId,
            language: result.language,
            outputLanguage: result.outputLanguage ?? null,
            refreshed: result.refreshed ?? false,
          },
          ...(originatorClientId ? { originatorClientId } : {}),
        });
      } catch (err) {
        writeServeDebugLine(
          `language_changed event publish failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return {
        language: result.language,
        outputLanguage: result.outputLanguage ?? null,
        refreshed: result.refreshed ?? false,
      };
    },

    async setSessionLiveConversationActive(sessionId, active) {
      await requestSessionStatus<Record<string, unknown>>(
        sessionId,
        SERVE_CONTROL_EXT_METHODS.sessionLiveConversation,
        { active },
      );
    },

    async appendSessionLiveTranscript(sessionId, entries, model) {
      await requestSessionStatus<Record<string, unknown>>(
        sessionId,
        SERVE_CONTROL_EXT_METHODS.sessionLiveTranscript,
        { entries, model },
      );
    },

    async setSessionApprovalMode(sessionId, mode, opts, context) {
      // Forwards through `qwen/control/session/approval_mode` so the
      // change lands inside the ACP child's own `Config` (per-session
      // `setApprovalMode`). The bridge layer adds two things on top:
      // trusted `originatorClientId` resolution and an opt-in persist
      // hook that writes `tools.approvalMode` to the workspace settings
      // file. Persist is OFF by default — see the interface doc.
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const info = channelInfoForEntry(entry);
      if (!info || info.isDying) throw new SessionNotFoundError(sessionId);
      const originatorClientId = resolveTrustedClientId(
        entry,
        context?.clientId,
      );
      return await applyApprovalMode(
        entry,
        mode,
        opts.persist,
        originatorClientId,
      );
    },

    async generateSessionRecap(sessionId, _context) {
      // Thin pass-through to `qwen/control/session/
      // recap` — the ACP child runs `generateSessionRecap` against the
      // session's GeminiClient history and returns `{sessionId, recap}`
      // where `recap` may be `null` for too-short histories or transient
      // model failures. The core helper is documented to never throw,
      // so the only paths that surface as bridge errors are: unknown
      // sessionId (`SessionNotFoundError`), transport closed mid-flight
      // (race against `getTransportClosedReject`), and the backstop
      // `SESSION_RECAP_TIMEOUT_MS` race for a wedged ACP channel.
      //
      // `_context` carries the trusted client id for future event
      // fan-out (e.g. a `session_recap_generated` push event), but
      // recap is informational-only today — no SSE broadcast.
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const info = channelInfoForEntry(entry);
      if (!info || info.isDying) throw new SessionNotFoundError(sessionId);
      opts.onDiagnosticLine?.(
        `qwen serve: bridge generateSessionRecap dispatching ext-method for session=${sessionId}`,
        'info',
      );
      const response = (await Promise.race([
        withTimeout(
          entry.connection.extMethod(SERVE_CONTROL_EXT_METHODS.sessionRecap, {
            sessionId,
          }),
          SESSION_RECAP_TIMEOUT_MS,
          SERVE_CONTROL_EXT_METHODS.sessionRecap,
        ),
        getTransportClosedReject(entry),
      ])) as { sessionId: string; recap: string | null };
      opts.onDiagnosticLine?.(
        `qwen serve: bridge generateSessionRecap completed for session=${sessionId} recap=${response.recap ? `len=${response.recap.length}` : 'null'}`,
        'info',
      );
      return {
        sessionId: entry.sessionId,
        recap: response.recap ?? null,
      };
    },

    generateSessionContent(sessionId, prompt, signal, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const info = channelInfoForEntry(entry);
      if (!info || info.isDying) throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);

      const requestId = randomUUID();
      const queue = new GenerationStreamQueue<BridgeGenerationStreamEvent>(
        GENERATION_STREAM_QUEUE_CAPACITY,
      );
      const request = {
        sessionId,
        connection: entry.connection,
        queue,
        settled: false,
      };
      generationRequests.set(requestId, request);

      const cancel = () => {
        if (request.settled) return;
        request.settled = true;
        generationRequests.delete(requestId);
        queue.close();
        void entry.connection
          .extMethod(SERVE_CONTROL_EXT_METHODS.sessionGenerationCancel, {
            sessionId,
            requestId,
          })
          .catch(() => undefined);
      };
      signal.addEventListener('abort', cancel, { once: true });

      if (signal.aborted) {
        cancel();
        return queue;
      }

      void Promise.race([
        withTimeout(
          entry.connection.extMethod(
            SERVE_CONTROL_EXT_METHODS.sessionGenerationStart,
            { sessionId, requestId, prompt },
          ),
          SESSION_GENERATION_TIMEOUT_MS,
          SERVE_CONTROL_EXT_METHODS.sessionGenerationStart,
        ),
        getTransportClosedReject(entry),
      ])
        .then((raw) => {
          if (request.settled) return;
          const response = raw as Record<string, unknown>;
          const model = response['model'];
          const modelSource = response['modelSource'];
          if (
            typeof model !== 'string' ||
            (modelSource !== 'fast' && modelSource !== 'main')
          ) {
            throw new Error('Malformed generation completion');
          }
          const accepted = queue.push({
            type: 'done',
            requestId,
            model,
            modelSource,
            ...(typeof response['inputTokens'] === 'number'
              ? { inputTokens: response['inputTokens'] }
              : {}),
            ...(typeof response['outputTokens'] === 'number'
              ? { outputTokens: response['outputTokens'] }
              : {}),
          });
          if (accepted) queue.close();
          else queue.fail(new Error('Generation stream consumer too slow'));
        })
        .catch((error: unknown) => {
          if (!request.settled) queue.fail(error);
        })
        .finally(() => {
          request.settled = true;
          signal.removeEventListener('abort', cancel);
          generationRequests.delete(requestId);
        });

      return queue;
    },

    getPendingPrompts(sessionId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      // Authorize the caller against this session — mirrors /prompt.
      resolveTrustedClientId(entry, context?.clientId);
      return entry.pendingPromptList
        .filter((p) => !p.removed && !p.terminalPublished)
        .map((p) => ({
          promptId: p.promptId,
          text: p.text,
          ...(p.content ? { content: p.content } : {}),
          queuedAt: p.queuedAt,
          state: p.state,
          ...(p.originatorClientId !== undefined
            ? { originatorClientId: p.originatorClientId }
            : {}),
        }));
    },

    async getSessionTurnStatus(sessionId, context, promptId) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);

      const liveBeforeRead = findLiveTurnStatus(entry, promptId);
      if (liveBeforeRead) return liveBeforeRead;

      // An overlay terminal a previous poll already enriched with the
      // child's persisted record fully answers the query; serving it here
      // spares settled prompts a full child transcript scan on every poll.
      if (
        promptId !== undefined &&
        entry.enrichedTerminalPromptIds.has(promptId)
      ) {
        const enrichedTerminal = entry.terminalTurnStatuses.get(promptId);
        if (enrichedTerminal) return enrichedTerminal;
      }

      const rewindGenerationBeforeRead = entry.rewindGeneration;
      let result: {
        v: number;
        sessionId: string;
        turnResult: TurnResultRecordPayload | null;
      };
      try {
        result = await requestSessionStatus(
          sessionId,
          SERVE_CONTROL_EXT_METHODS.sessionTurnStatus,
          { ...(promptId !== undefined ? { promptId } : {}) },
          // Transcript scans of large histories exceed the 10s init default;
          // give the read the same budget as other transcript reads.
          SESSION_TRANSCRIPT_TIMEOUT_MS,
        );
      } catch (error) {
        const liveAfterFailure = findLiveTurnStatus(entry, promptId);
        if (liveAfterFailure) return liveAfterFailure;
        const terminalAfterFailure =
          promptId !== undefined
            ? entry.terminalTurnStatuses.get(promptId)
            : latestTerminalTurnStatus(entry);
        if (terminalAfterFailure) return terminalAfterFailure;
        throw error;
      }
      const liveAfterRead = findLiveTurnStatus(entry, promptId);
      if (liveAfterRead) return liveAfterRead;
      const terminal =
        promptId !== undefined
          ? entry.terminalTurnStatuses.get(promptId)
          : latestTerminalTurnStatus(entry);
      // A rewind that completed while the scan was in flight may have
      // rolled back the scanned outcome; drop it so neither the write-back
      // nor the return below resurrects a rewound-away result. Rewind also
      // cleared the overlay this read falls back to, so the failure path
      // needs no equivalent guard.
      const persisted =
        result.turnResult &&
        entry.rewindGeneration === rewindGenerationBeforeRead
          ? settledTurnStatus(sessionId, result.turnResult)
          : undefined;
      if (promptId !== undefined) {
        if (terminal && persisted) {
          const merged = mergeTerminalWithPersisted(terminal, persisted);
          rememberEnrichedTerminalTurnStatus(entry, promptId, merged);
          return merged;
        }
        if (terminal) return terminal;
        if (persisted) {
          rememberEnrichedTerminalTurnStatus(entry, promptId, persisted);
          return persisted;
        }
      } else {
        if (terminal && persisted && terminal.promptId === persisted.promptId) {
          return mergeTerminalWithPersisted(terminal, persisted);
        }
        if (terminal && persisted) {
          return (terminal.endedAt ?? 0) >= (persisted.endedAt ?? 0)
            ? terminal
            : persisted;
        }
        if (terminal) return terminal;
        if (persisted) return persisted;
      }
      if (promptId !== undefined) {
        return undefined;
      }
      return { sessionId, state: 'idle' as const };
    },

    async storeSessionAttachment(sessionId, data, mimeType, context, name) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);
      return await entry.attachments.putAttachment(data, mimeType, name);
    },

    async readSessionAttachment(sessionId, attachmentId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);
      return await entry.attachments.read(attachmentId);
    },

    async removeSessionAttachment(sessionId, attachmentId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);
      return await entry.attachments.remove(attachmentId);
    },

    async deleteSessionAttachments(sessionId, options) {
      const store =
        byId.get(sessionId)?.attachments ??
        new SessionAttachmentStore(opts.sessionAttachmentsRoot, sessionId);
      await store.delete(options);
    },

    removePendingPrompt(sessionId, promptId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      // Authorize the caller BEFORE performing any mutation.
      resolveTrustedClientId(entry, context?.clientId);
      const idx = entry.pendingPromptList.findIndex(
        (p) => p.promptId === promptId,
      );
      if (idx === -1) return { removed: false };
      const target = entry.pendingPromptList[idx];
      // A running prompt already removed once is invisible to the API —
      // repeat removals are no-ops.
      if (target.removed) return { removed: false };
      writeStderrLine(
        `[pending-prompt] session=${sessionId} removing promptId=${promptId} state=${target.state}`,
      );
      // Abort the prompt: for 'queued' prompts the FIFO will skip
      // dispatch on the `signal.aborted` check; for 'running' prompts
      // this triggers the cancel path.
      target.abortController.abort(
        new DOMException('Prompt removed by user', 'AbortError'),
      );
      if (target.state === 'queued') {
        // A queued prompt never dispatches once aborted — safe to drop
        // from the list immediately.
        entry.pendingPromptList.splice(idx, 1);
      } else {
        // A RUNNING prompt must stay on the list (hidden from
        // `getPendingPrompts` via the `removed` flag) until it settles
        // through `result.finally`. Splicing it here would make it
        // invisible to `flushPromptTerminals`: if the session then closes
        // before the agent cooperates with the cancel, the prompt's
        // terminal would be published into an already-closed bus and
        // silently dropped.
        target.removed = true;
      }
      // Keep the admission slot until this prompt's FIFO node reaches the head
      // and settles through the original result.finally() path. Otherwise a
      // client could enqueue/delete queued prompts repeatedly while one turn is
      // running and bypass maxPendingPromptsPerSession with hidden backlog nodes.
      try {
        entry.events.publish({
          type: 'pending_prompt_completed',
          promptId,
          data: { sessionId, promptId, state: 'removed' },
          ...(target.originatorClientId
            ? { originatorClientId: target.originatorClientId }
            : {}),
        });
      } catch {
        /* bus may be closed during session teardown */
      }
      // DAEMON-004: a deleted QUEUED prompt never dispatches, so nothing
      // downstream would ever emit its formal terminal — publish the
      // `cancelled` turn_complete now. Running prompts keep the existing
      // cooperative cancel path (agent returns cancelled → turn_complete);
      // the FIFO node's later AbortError is deduped by the latch.
      if (target.state === 'queued') {
        publishPromptTerminal(entry, target, { kind: 'cancelled' });
      }
      return { removed: true };
    },

    enqueueMidTurnMessage(
      sessionId,
      message,
      context,
      requestedMessageId,
      options,
    ) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      // Authorize the caller against THIS session before doing anything —
      // mirrors `/prompt` and `/btw`. Throws `InvalidClientIdError` when the
      // client-declared id isn't bound to the session, so a token-holding
      // client attached to another session can't push into this turn. Returns
      // the trusted id (or undefined for anonymous callers) for diagnostics.
      // Queue ownership is session-wide.
      const originatorClientId = resolveTrustedClientId(
        entry,
        context?.clientId,
      );
      const trimmed = message.trim();
      // Attachment blocks travel with the message through drain and promotion;
      // text blocks are dropped so the drain never duplicates the message text.
      const mediaBlocks = (options?.content ?? []).filter(
        (block): block is BridgePromptContentBlock =>
          block.type === 'image' || block.type === 'resource',
      );
      if (trimmed.length === 0 && mediaBlocks.length === 0) {
        writeStderrLine(
          `[mid-turn] session=${entry.sessionId} rejected: empty`,
        );
        return { accepted: false };
      }
      if (requestedMessageId !== undefined) {
        const existing = entry.midTurnMessageQueue.find(
          (queued) => queued.messageId === requestedMessageId,
        );
        if (existing) {
          // A retry under the same id is only idempotent when the WHOLE
          // payload matches — accepting different media under an existing id
          // would silently keep the original attachments.
          const sameMedia =
            JSON.stringify(existing.content ?? []) ===
            JSON.stringify(mediaBlocks);
          if (existing.text === trimmed && sameMedia) {
            return { accepted: true, messageId: requestedMessageId };
          }
          writeStderrLine(
            `[mid-turn] session=${JSON.stringify(entry.sessionId)} rejected id ${JSON.stringify(requestedMessageId)}: text or content mismatch`,
          );
          return { accepted: false };
        }
        const promoted = entry.pendingPromptList.find(
          (pending) => pending.promptId === requestedMessageId,
        );
        if (promoted) {
          const promotedMedia = (promoted.content ?? []).filter(
            (block) => block.type === 'image' || block.type === 'resource',
          );
          const sameMedia =
            JSON.stringify(promotedMedia) === JSON.stringify(mediaBlocks);
          const promotedText =
            promoted.text === '[image]' && trimmed.length === 0
              ? ''
              : promoted.text;
          if (promotedText === trimmed && sameMedia) {
            return { accepted: true, messageId: requestedMessageId };
          }
          writeStderrLine(
            `[mid-turn] session=${JSON.stringify(entry.sessionId)} rejected promoted id ${JSON.stringify(requestedMessageId)}: text or content mismatch`,
          );
          return { accepted: false };
        }
        if (entry.settledMidTurnMessageIds.includes(requestedMessageId)) {
          return { accepted: true, messageId: requestedMessageId };
        }
        if (entry.promotedMidTurnMessageIds.includes(requestedMessageId)) {
          return { accepted: true, messageId: requestedMessageId };
        }
      }
      // Answer retries for daemon-owned ids before rejecting genuinely new
      // work during conditional close. Existing ownership remains idempotent;
      // only fresh admission can race the teardown.
      if (isClosingOrAuthorizingClose(entry)) {
        writeStderrLine(
          `[mid-turn] session=${JSON.stringify(entry.sessionId)} rejected: session closing`,
        );
        return { accepted: false };
      }
      // Validate only genuinely new admissions, AFTER the retry-ack rings:
      // a same-id retry whose media was already removed (delete racing an
      // in-flight POST, or a refresh re-enqueueing from the snapshot) must
      // settle idempotently instead of failing with session_attachment_gone.
      entry.attachments.assertReferences(mediaBlocks);
      const inlineBytes = inlineAttachmentBlockBytes(mediaBlocks);
      if (inlineBytes > 0) {
        const queuedInlineBytes = entry.midTurnMessageQueue.reduce(
          (total, queued) =>
            total + inlineAttachmentBlockBytes(queued.content ?? []),
          0,
        );
        if (
          queuedInlineBytes + inlineBytes >
          MAX_QUEUED_INLINE_ATTACHMENT_BYTES
        ) {
          writeStderrLine(
            `[mid-turn] session=${entry.sessionId} rejected: queued inline attachments exceed the ${MAX_QUEUED_INLINE_ATTACHMENT_BYTES}-byte session budget`,
          );
          return { accepted: false };
        }
      }
      const messageId = requestedMessageId ?? randomUUID();
      // If the turn settled while the POST was in flight, start it through the
      // normal prompt path. A client-supplied id keeps retries idempotent.
      // A child-driven Goal turn never crosses the `session/prompt` RPC
      // boundary, so `pendingPromptCount` stays 0 for its whole duration —
      // but the child drains THIS queue between tool batches from inside that
      // turn, so the session is genuinely busy and the message belongs in the
      // queue. Without `goalTurnActive` here every mid-turn insert during a
      // Goal turn is rejected as idle even though the client enables the
      // affordance (Goal turns are non-idle in `hasActivePrompt` summaries).
      if (entry.pendingPromptCount === 0 && entry.goalTurnActive !== true) {
        // Both modes refuse new ownership once idle. `queueOnly` callers (live
        // steering) additionally drive the next turn themselves: a promoted
        // message would have no collector forwarding its response or deadline.
        if (options?.queueOnly || options?.rejectIfIdle) {
          writeStderrLine(
            `[mid-turn] session=${JSON.stringify(entry.sessionId)} rejected id ${JSON.stringify(messageId)}: session idle`,
          );
          return { accepted: false };
        }
        promoteMidTurnMessage(
          entry,
          messageId,
          trimmed,
          originatorClientId,
          mediaBlocks.length > 0 ? mediaBlocks : undefined,
        );
        return { accepted: true, messageId };
      }
      // Bound the drain queue. Rejected requests remain unowned.
      if (entry.midTurnMessageQueue.length >= MAX_MID_TURN_QUEUE_DEPTH) {
        writeStderrLine(
          `[mid-turn] session=${entry.sessionId} rejected: queue full (depth ${entry.midTurnMessageQueue.length} >= ${MAX_MID_TURN_QUEUE_DEPTH})`,
        );
        return { accepted: false };
      }
      const queuedMessage: MidTurnQueueEntry = {
        messageId,
        text: trimmed,
        ...(mediaBlocks.length > 0 ? { content: mediaBlocks } : {}),
        originatorClientId,
        ...(options?.queueOnly
          ? {
              queueOnly: true,
              onSettledWithoutDrain: options.onSettledWithoutDrain,
            }
          : {}),
      };
      entry.midTurnMessageQueue.push(queuedMessage);
      // UI enqueues only: an anonymous enqueue (live steering) is an internal
      // delegation prompt — publishing it would surface its raw text in every
      // attached client's queue view and reconciliation snapshot.
      if (originatorClientId) {
        try {
          entry.events.publish({
            type: 'pending_prompt_added',
            promptId: messageId,
            data: {
              sessionId,
              promptId: messageId,
              text: trimmed,
              queuedAt: Date.now(),
            },
            originatorClientId,
          });
        } catch {
          /* bus may be closed during session teardown */
        }
      }
      return { accepted: true, messageId };
    },

    removeMidTurnMessage(sessionId, messageId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);
      const index = entry.midTurnMessageQueue.findIndex(
        (message) => message.messageId === messageId,
      );
      if (index === -1) {
        const isPromoted = entry.pendingPromptList.some(
          (pending) =>
            pending.promptId === messageId && pending.promotedMidTurn === true,
        );
        if (!isPromoted) {
          writeStderrLine(
            `[mid-turn] session=${JSON.stringify(entry.sessionId)} remove missed messageId=${JSON.stringify(messageId)} (already drained or completed)`,
          );
          return { removed: false };
        }
        const promoted = bridgeApi.removePendingPrompt(
          sessionId,
          messageId,
          context,
        );
        if (promoted.removed) {
          rememberMidTurnId(entry.settledMidTurnMessageIds, messageId);
          return promoted;
        }
        writeStderrLine(
          `[mid-turn] session=${JSON.stringify(entry.sessionId)} remove missed messageId=${JSON.stringify(messageId)} (already drained or completed)`,
        );
        return { removed: false };
      }
      const [removed] = entry.midTurnMessageQueue.splice(index, 1);
      rememberMidTurnId(entry.settledMidTurnMessageIds, messageId);
      if (removed) {
        try {
          entry.events.publish({
            type: 'pending_prompt_completed',
            promptId: messageId,
            data: { sessionId, promptId: messageId, state: 'removed' },
            ...(removed.originatorClientId
              ? { originatorClientId: removed.originatorClientId }
              : {}),
          });
        } catch {
          /* bus may be closed during session teardown */
        }
      }
      return { removed: true };
    },

    async enqueueBackgroundNotification(sessionId, notification) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const info = channelInfoForEntry(entry);
      if (!info || info.isDying) throw new SessionNotFoundError(sessionId);
      entry.pendingAgentNotificationCount++;
      try {
        const response = await Promise.race([
          withTimeout(
            entry.connection.extMethod(
              SERVE_CONTROL_EXT_METHODS.sessionBackgroundNotification,
              { sessionId, ...notification },
            ),
            initTimeoutMs,
            SERVE_CONTROL_EXT_METHODS.sessionBackgroundNotification,
          ),
          getTransportClosedReject(entry),
        ]);
        return { sessionId, accepted: response['accepted'] === true };
      } finally {
        entry.pendingAgentNotificationCount = Math.max(
          0,
          entry.pendingAgentNotificationCount - 1,
        );
        void maybeCloseIdleSession(entry, 'agent_notification_settled');
      }
    },

    getMidTurnMessages(sessionId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      // Authorize the caller against THIS session — mirrors the sibling
      // mid-turn routes and `getPendingPrompts`. The queue is session-global,
      // so a refreshed client with a newly-issued id can still restore and
      // mutate it.
      resolveTrustedClientId(entry, context?.clientId);
      return {
        // Anonymous enqueues (live steering) stay off the shared surface:
        // their delegation text is not a user message other attached clients
        // should restore into their queue views.
        messages: entry.midTurnMessageQueue
          .filter((message) => message.originatorClientId !== undefined)
          .map((message) => ({
            messageId: message.messageId,
            text: message.text,
            // Carry the media blocks so a refreshed client can rebuild the
            // queued row with its attachments (the snapshot is the only
            // recovery source once the client's in-memory copy is gone).
            ...(message.content ? { content: message.content } : {}),
          })),
        settledMessageIds: [...entry.settledMidTurnMessageIds],
        promotedMessageIds: [...entry.promotedMidTurnMessageIds],
      };
    },

    async generateSessionBtw(sessionId, question, signal, _context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const info = channelInfoForEntry(entry);
      if (!info || info.isDying) throw new SessionNotFoundError(sessionId);
      if (signal?.aborted) return { sessionId, answer: null };
      const races: Array<Promise<unknown>> = [
        withTimeout(
          entry.connection.extMethod(SERVE_CONTROL_EXT_METHODS.sessionBtw, {
            sessionId,
            question,
          }),
          SESSION_BTW_TIMEOUT_MS,
          SERVE_CONTROL_EXT_METHODS.sessionBtw,
        ),
        getTransportClosedReject(entry),
      ];
      let cleanupAbort: (() => void) | undefined;
      if (signal) {
        races.push(
          new Promise<never>((_, reject) => {
            const handler = () =>
              reject(new DOMException('Aborted', 'AbortError'));
            signal.addEventListener('abort', handler, { once: true });
            cleanupAbort = () => signal.removeEventListener('abort', handler);
          }),
        );
      }
      let response: { sessionId: string; answer: string | null };
      try {
        response = (await Promise.race(races)) as {
          sessionId: string;
          answer: string | null;
        };
      } finally {
        cleanupAbort?.();
      }
      return {
        sessionId: entry.sessionId,
        answer: response.answer ?? null,
      };
    },

    async launchSessionForkAgent(sessionId, directive, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const info = channelInfoForEntry(entry);
      if (!info || info.isDying) throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);

      const trimmed = directive.trim();
      if (!trimmed) {
        throw new Error('Fork directive is required');
      }
      if (entry.pendingPromptCount > 0 || entry.promptActive) {
        throw new SessionBusyError(
          sessionId,
          'Cannot fork while a response or tool call is in progress',
        );
      }
      return entry.promptQueue.then(async () => {
        if (entry.pendingPromptCount > 0 || entry.promptActive) {
          throw new SessionBusyError(
            sessionId,
            'Cannot fork while a response or tool call is in progress',
          );
        }

        opts.onDiagnosticLine?.(
          `qwen serve: launchSessionForkAgent requested for session=${sessionId}`,
          'info',
        );

        let response: {
          description?: string;
          launched?: boolean;
        };
        try {
          response = (await Promise.race([
            withTimeout(
              entry.connection.extMethod(
                SERVE_CONTROL_EXT_METHODS.sessionForkAgent,
                {
                  sessionId,
                  directive: trimmed,
                },
              ),
              initTimeoutMs,
              SERVE_CONTROL_EXT_METHODS.sessionForkAgent,
            ),
            getTransportClosedReject(entry),
          ])) as {
            description?: string;
            launched?: boolean;
          };
        } catch (error) {
          opts.onDiagnosticLine?.(
            `qwen serve: launchSessionForkAgent failed for session=${sessionId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            'warn',
          );
          throw error;
        }

        const result = {
          sessionId: entry.sessionId,
          description: response.description ?? trimmed.slice(0, 60),
          launched: response.launched === true,
        };
        opts.onDiagnosticLine?.(
          `qwen serve: launchSessionForkAgent completed for session=${sessionId} launched=${result.launched}`,
          'info',
        );
        return result;
      });
    },

    async executeShellCommand(
      sessionId,
      command,
      signal,
      context,
    ): Promise<ShellCommandResult> {
      opts.onDiagnosticLine?.(
        `qwen serve: bridge executeShellCommand for session=${sessionId}`,
        'info',
      );
      if (opts.sessionShellCommandEnabled !== true) {
        throw new SessionShellDisabledError();
      }
      if (context?.clientId === undefined) {
        throw new SessionShellClientRequiredError();
      }
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const originatorClientId = resolveTrustedClientId(
        entry,
        context.clientId,
      );

      if (signal?.aborted) {
        return { exitCode: null, output: '', aborted: true };
      }

      // Race the cwd queue against the caller's abort signal so a shell
      // command cannot park forever on a changeSessionCwd extMethod that
      // never settles (agent crash / deadlock / partitioned ACP channel).
      let abortResolve: (() => void) | undefined;
      const onAbort = () => abortResolve?.();
      try {
        await Promise.race([
          entry.cwdChangeQueue,
          new Promise<void>((resolve) => {
            abortResolve = resolve;
            if (signal?.aborted) return resolve();
            signal?.addEventListener('abort', onAbort, { once: true });
          }),
        ]);
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
      if (signal?.aborted) {
        return { exitCode: null, output: '', aborted: true };
      }
      const cwd = entry.effectiveCwd;

      entry.events.publish({
        type: 'user_shell_command',
        data: { sessionId, command, cwd },
        ...(originatorClientId ? { originatorClientId } : {}),
      });

      const outputChunks: string[] = [];
      const abort = new AbortController();
      const onSignalAbort = () => abort.abort();
      signal?.addEventListener('abort', onSignalAbort, { once: true });

      try {
        const handle = await ShellExecutionService.execute(
          command,
          cwd,
          (event: ShellOutputEvent) => {
            if (event.type === 'data') {
              const chunk =
                typeof event.chunk === 'string'
                  ? event.chunk
                  : event.chunk
                      .map((line: Array<{ text: string }>) =>
                        line.map((t) => t.text).join(''),
                      )
                      .join('\n');
              outputChunks.push(chunk);
              entry.events.publish({
                type: 'session_update',
                data: {
                  sessionId,
                  update: {
                    sessionUpdate: 'shell_output',
                    output: chunk,
                    _meta: {
                      serverTimestamp: Date.now(),
                      source: 'user-shell',
                    },
                  },
                },
                ...(originatorClientId ? { originatorClientId } : {}),
              });
            }
          },
          abort.signal,
          false,
          { terminalWidth: 120, terminalHeight: 40 },
          { streamStdout: true },
        );

        const timeoutId = setTimeout(
          () => abort.abort(),
          SHELL_COMMAND_TIMEOUT_MS,
        );
        timeoutId.unref();

        const result = await handle.result;
        clearTimeout(timeoutId);

        const exitCode = result.exitCode;
        const aborted = result.aborted;
        const output = outputChunks.join('') || result.output;

        entry.events.publish({
          type: 'user_shell_result',
          data: {
            sessionId,
            exitCode,
            signal: result.signal,
            aborted,
            _meta: { serverTimestamp: Date.now() },
          },
          ...(originatorClientId ? { originatorClientId } : {}),
        });

        const historyOutput =
          output.length > MAX_SHELL_OUTPUT_FOR_HISTORY
            ? output.substring(0, MAX_SHELL_OUTPUT_FOR_HISTORY) +
              '\n... (truncated)'
            : output;

        try {
          await withTimeout(
            Promise.race([
              entry.connection.extMethod(
                SERVE_CONTROL_EXT_METHODS.sessionShellHistory,
                { sessionId, command, output: historyOutput, exitCode },
              ),
              getTransportClosedReject(entry),
            ]),
            initTimeoutMs,
            'sessionShellHistory',
          );
        } catch (err) {
          writeServeDebugLine(
            `shell history injection failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        return { exitCode, output, aborted };
      } catch (err) {
        entry.events.publish({
          type: 'user_shell_result',
          data: {
            sessionId,
            exitCode: null,
            signal: null,
            aborted: false,
            error: err instanceof Error ? err.message : String(err),
            _meta: { serverTimestamp: Date.now() },
          },
          ...(originatorClientId ? { originatorClientId } : {}),
        });
        throw err;
      } finally {
        signal?.removeEventListener('abort', onSignalAbort);
      }
    },

    async getRewindSnapshots(sessionId) {
      return requestSessionStatus(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionRewindSnapshots,
      );
    },

    async rewindSession(sessionId, req, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      if (isClosingOrAuthorizingClose(entry)) {
        throw new SessionNotFoundError(
          sessionId,
          'The session is closing; retry after close completes',
          'session_closing',
        );
      }
      const info = channelInfoForEntry(entry);
      if (!info || info.isDying) throw new SessionNotFoundError(sessionId);
      const originatorClientId = resolveTrustedClientId(
        entry,
        context?.clientId,
      );

      // Admission-time check: a rewind queued behind an active prompt runs
      // after the prompt's `finally` clears the busy flags, and client-side
      // timeouts cannot cancel queued work — the rewind would truncate
      // history after the caller was told it failed. The agent-side
      // `isTurnIdle()` guard never fires because the queue guarantees the turn
      // is over before the rewind reaches the agent. Reject synchronously,
      // matching branchSession and launchSessionForkAgent.
      if (entry.pendingPromptCount > 0 || entry.promptActive) {
        throw new SessionBusyError(
          sessionId,
          'Cannot rewind while a prompt is running',
        );
      }

      const rewindResult = entry.promptQueue.then(async () => {
        if (entry.closing) {
          throw new SessionNotFoundError(sessionId, 'The session is closing');
        }
        let response: Record<string, unknown>;
        try {
          // ACP cannot cancel a rewind after dispatch. Keep the queue until
          // its real outcome is known so a caller never sees a timeout
          // followed by an unobserved history truncation + file restores —
          // same hazard the branch path documents.
          response = (await Promise.race([
            entry.connection.extMethod(
              SERVE_CONTROL_EXT_METHODS.sessionRewind,
              {
                sessionId,
                promptId: req.promptId,
                rewindFiles: req.rewindFiles !== false,
              },
            ),
            getTransportClosedReject(entry),
          ])) as Record<string, unknown>;
        } catch (err) {
          const data = (err as { data?: unknown })?.data;
          if (data && typeof data === 'object' && 'errorKind' in data) {
            const kind = (data as { errorKind: string }).errorKind;
            const msg =
              (err as { message?: string })?.message ?? 'Rewind failed';
            if (kind === 'session_busy') {
              throw new SessionBusyError(sessionId, msg);
            }
            if (kind === 'invalid_rewind_target') {
              throw new InvalidRewindTargetError(sessionId, msg);
            }
          }
          throw err;
        }

        entry.terminalTurnStatuses.clear();
        entry.enrichedTerminalPromptIds.clear();
        entry.rewindGeneration += 1;

        const targetTurnIndex = (response['targetTurnIndex'] as number) ?? 0;
        const filesChanged = (response['filesChanged'] as string[]) ?? [];
        const filesFailed = (response['filesFailed'] as string[]) ?? [];
        const artifactSnapshot = restoredArtifactSnapshotFromState(
          response as BridgeSessionState,
        );
        const artifactSnapshotUnavailable = artifactSnapshotUnavailableReason(
          response as BridgeSessionState,
        );
        const beforeArtifacts = (await entry.artifacts.list()).artifacts;
        const shouldRestoreArtifactSnapshot =
          artifactSnapshot !== undefined &&
          artifactSnapshotUnavailable === undefined;
        const artifactRestoreWarnings =
          artifactSnapshotUnavailable !== undefined
            ? [
                `artifact snapshot rebuild unavailable during rewind: ${artifactSnapshotUnavailable}`,
              ]
            : shouldRestoreArtifactSnapshot
              ? await entry.artifacts.restore(artifactSnapshot, {
                  preserveLiveEphemeral: true,
                })
              : [];
        const artifactRestoreFailed = artifactRestoreWarnings.some(
          isArtifactRestoreFailureWarning,
        );
        const shouldRecordArtifactSnapshot =
          shouldRestoreArtifactSnapshot && !artifactRestoreFailed;
        const artifactSnapshotWarnings = shouldRecordArtifactSnapshot
          ? await entry.artifacts.recordSnapshot()
          : [];
        const artifactWarnings = [
          ...artifactRestoreWarnings,
          ...artifactSnapshotWarnings,
        ];
        for (const warning of artifactRestoreWarnings) {
          writeStderrLine(
            `[artifacts] session=${entry.sessionId} action=rewind_restore_warning warning=${JSON.stringify(
              warning,
            )}`,
          );
        }
        for (const warning of artifactSnapshotWarnings) {
          writeStderrLine(
            `[artifacts] session=${entry.sessionId} action=rewind_snapshot_warning warning=${JSON.stringify(
              warning,
            )}`,
          );
        }
        const afterArtifacts = (await entry.artifacts.list()).artifacts;
        publishArtifactChanges(
          entry,
          artifactReseedChanges(beforeArtifacts, afterArtifacts),
          originatorClientId,
        );
        try {
          entry.events.publish({
            type: 'session_rewound',
            data: {
              sessionId,
              promptId: req.promptId,
              targetTurnIndex,
              filesChanged,
              filesFailed,
              ...(artifactWarnings.length > 0
                ? { warnings: artifactWarnings }
                : {}),
            },
            ...(originatorClientId ? { originatorClientId } : {}),
          });
        } catch {
          /* bus closed */
        }

        return {
          rewound: filesFailed.length === 0,
          targetTurnIndex,
          filesChanged,
          filesFailed,
          ...(artifactWarnings.length > 0
            ? { warnings: artifactWarnings }
            : {}),
        };
      });
      entry.promptQueue = rewindResult.then(
        () => undefined,
        () => undefined,
      );
      return rewindResult;
    },

    async manageMcpServer(serverName, action, originatorClientId) {
      const info = await ensureChannel();
      try {
        return await withWorkspaceControl(info, async () => {
          const timeout =
            action === 'authenticate'
              ? MCP_OAUTH_TIMEOUT_MS
              : MCP_RESTART_TIMEOUT_MS;
          const response = (await Promise.race([
            withTimeout(
              info.connection.extMethod(
                SERVE_CONTROL_EXT_METHODS.workspaceMcpManage,
                { serverName, action, originatorClientId },
              ),
              timeout,
              SERVE_CONTROL_EXT_METHODS.workspaceMcpManage,
            ),
            getChannelClosedReject(info),
          ])) as {
            serverName: string;
            action:
              | 'approve'
              | 'enable'
              | 'disable'
              | 'authenticate'
              | 'clear-auth';
            ok: true;
            changed?: boolean;
            messages?: string[];
            authUrl?: string;
            pending?: boolean;
          };
          if (action === 'authenticate' && response.pending) {
            info.workspaceMcpAuthenticationServerNames.add(serverName);
            const previousTimer =
              info.workspaceMcpAuthenticationTimers.get(serverName);
            if (previousTimer) clearTimeout(previousTimer);
            const timer = setTimeout(() => {
              info.workspaceMcpAuthenticationServerNames.delete(serverName);
              info.workspaceMcpAuthenticationTimers.delete(serverName);
              if (hasNoChannelWork(info)) {
                void startIdleTimer(
                  info,
                  'workspace MCP authentication timeout',
                );
              }
            }, MCP_OAUTH_TIMEOUT_MS);
            timer.unref();
            info.workspaceMcpAuthenticationTimers.set(serverName, timer);
          }
          invalidateWorkspaceMcpDetailCache(serverName);
          await requestWorkspaceStatus<ServeWorkspaceMcpStatus>(
            SERVE_STATUS_EXT_METHODS.workspaceMcp,
            () => {
              throw new BridgeChannelClosedError(
                'workspace MCP management status refresh',
              );
            },
            {},
            new Set([serverName]),
          );
          broadcastWorkspaceEvent({
            type: 'mcp_server_changed',
            data: {
              serverName: response.serverName,
              action: response.action,
              originatorClientId,
            },
            ...(originatorClientId ? { originatorClientId } : {}),
          });
          return response;
        });
      } finally {
        if (hasNoChannelWork(info)) {
          await startIdleTimer(info, 'workspace MCP management');
        }
      }
    },

    async initializeWorkspaceMcp() {
      const info = await ensureChannel();
      info.workspaceMcpDiscoveryRequested = true;
      try {
        const result = (await Promise.race([
          withTimeout(
            info.connection.extMethod(
              SERVE_CONTROL_EXT_METHODS.workspaceMcpInitialize,
              { cwd: boundWorkspace },
            ),
            initTimeoutMs,
            SERVE_CONTROL_EXT_METHODS.workspaceMcpInitialize,
          ),
          getChannelClosedReject(info),
        ])) as { accepted: boolean };
        if (result.accepted) {
          beginWorkspaceMcpDiscovery(info);
        }
        return result;
      } finally {
        if (hasNoChannelWork(info)) {
          await startIdleTimer(info, 'workspace MCP initialization');
        }
      }
    },

    async reloadWorkspaceMcp(options) {
      const info = await ensureChannel();
      info.workspaceMcpDiscoveryRequested = true;
      try {
        const result = (await Promise.race([
          withTimeout(
            info.connection.extMethod(
              SERVE_CONTROL_EXT_METHODS.workspaceMcpReload,
              { cwd: boundWorkspace, ...options },
            ),
            initTimeoutMs,
            SERVE_CONTROL_EXT_METHODS.workspaceMcpReload,
          ),
          getChannelClosedReject(info),
        ])) as { accepted: boolean };
        if (result.accepted) {
          beginWorkspaceMcpDiscovery(info);
        }
        return result;
      } finally {
        if (hasNoChannelWork(info)) {
          await startIdleTimer(info, 'workspace MCP reload');
        }
      }
    },

    async generateWorkspaceAgent(description, _originatorClientId) {
      const info = liveChannelInfo();
      if (!info) {
        throw new SessionNotFoundError('agents:generate');
      }
      return (await Promise.race([
        withTimeout(
          info.connection.extMethod(
            SERVE_CONTROL_EXT_METHODS.workspaceAgentGenerate,
            { description },
          ),
          MCP_RESTART_TIMEOUT_MS,
          SERVE_CONTROL_EXT_METHODS.workspaceAgentGenerate,
        ),
        getChannelClosedReject(info),
      ])) as {
        name: string;
        description: string;
        systemPrompt: string;
      };
    },

    generateWorkspaceContent(prompt, signal, _originatorClientId) {
      const requestId = randomUUID();
      const queue =
        new GenerationStreamQueue<BridgeWorkspaceGenerationStreamEvent>(
          GENERATION_STREAM_QUEUE_CAPACITY,
        );
      const request = {
        connection: undefined as ClientSideConnection | undefined,
        queue,
        settled: false,
      };

      const cancel = () => {
        if (request.settled) return;
        request.settled = true;
        workspaceGenerationRequests.delete(requestId);
        queue.close();
        void request.connection
          ?.extMethod(SERVE_CONTROL_EXT_METHODS.workspaceGenerationCancel, {
            requestId,
          })
          .catch(() => undefined);
      };
      signal.addEventListener('abort', cancel, { once: true });

      if (signal.aborted) {
        cancel();
        return queue;
      }

      void (async () => {
        let info: ChannelInfo | undefined;
        try {
          const channelInfo = await ensureChannel();
          info = channelInfo;
          request.connection = channelInfo.connection;
          await withWorkspaceControl(channelInfo, async () => {
            if (request.settled) return;
            workspaceGenerationRequests.set(requestId, request);
            const raw = await Promise.race([
              withTimeout(
                channelInfo.connection.extMethod(
                  SERVE_CONTROL_EXT_METHODS.workspaceGenerationStart,
                  {
                    requestId,
                    prompt,
                    purpose: 'text',
                  },
                ),
                SESSION_GENERATION_TIMEOUT_MS,
                SERVE_CONTROL_EXT_METHODS.workspaceGenerationStart,
              ),
              getChannelClosedReject(channelInfo),
            ]);
            if (request.settled) return;
            const response = raw as Record<string, unknown>;
            const model = response['model'];
            const modelSource = response['modelSource'];
            if (
              typeof model !== 'string' ||
              (modelSource !== 'fast' && modelSource !== 'main')
            ) {
              throw new Error('Malformed workspace generation completion');
            }
            const accepted = queue.push({
              type: 'done',
              requestId,
              model,
              modelSource,
              ...(typeof response['inputTokens'] === 'number'
                ? { inputTokens: response['inputTokens'] }
                : {}),
              ...(typeof response['outputTokens'] === 'number'
                ? { outputTokens: response['outputTokens'] }
                : {}),
            });
            if (accepted) queue.close();
            else queue.fail(new Error('Generation stream consumer too slow'));
          });
        } catch (error: unknown) {
          if (!request.settled) queue.fail(error);
        } finally {
          request.settled = true;
          signal.removeEventListener('abort', cancel);
          workspaceGenerationRequests.delete(requestId);
          if (info && hasNoChannelWork(info) && !info.isDying) {
            await startIdleTimer(info, 'workspace generation');
          }
        }
      })().catch(() => undefined);

      return queue;
    },

    async addRuntimeMcpServer(name, config, originatorClientId) {
      // Round-trip the runtime-add ext-method through the
      // live ACP child and broadcast an `mcp_server_added` event on
      // success. Soft-refuse (`budget_warning_only`) returns the skip
      // shape without emitting — the caller (HTTP route) decides how to
      // surface the skip to the SDK consumer.
      const info = liveChannelInfo();
      if (!info) {
        throw Object.assign(
          new Error(`No live ACP channel for runtime MCP add: ${name}`),
          { data: { errorKind: 'acp_channel_unavailable' } },
        );
      }
      type AddOk = {
        name: string;
        transport: 'stdio' | 'sse' | 'http' | 'tcp' | 'sdk';
        replaced: boolean;
        shadowedSettings: boolean;
        toolCount: number;
        originatorClientId: string;
      };
      type AddSkip = {
        name: string;
        skipped: true;
        reason: 'budget_warning_only' | 'runtime_name_conflict';
      };
      const response = (await Promise.race([
        withTimeout(
          info.connection.extMethod(
            SERVE_CONTROL_EXT_METHODS.workspaceMcpRuntimeAdd,
            { name, config, originatorClientId },
          ),
          MCP_RESTART_SERVER_DEADLINE_MS,
          SERVE_CONTROL_EXT_METHODS.workspaceMcpRuntimeAdd,
        ),
        getChannelClosedReject(info),
      ])) as AddOk | AddSkip;
      // Emit event on success (non-skip)
      const addSkipped = (response as { skipped?: boolean }).skipped === true;
      if (!addSkipped) {
        const ok = response as AddOk;
        broadcastWorkspaceEvent({
          type: 'mcp_server_added',
          data: {
            name: ok.name,
            transport: ok.transport,
            replaced: ok.replaced,
            shadowedSettings: ok.shadowedSettings,
            toolCount: ok.toolCount,
            originatorClientId: ok.originatorClientId,
          },
          ...(originatorClientId ? { originatorClientId } : {}),
        });
      }
      return response;
    },

    async removeRuntimeMcpServer(name, originatorClientId) {
      // Round-trip the runtime-remove ext-method through
      // the live ACP child and broadcast `mcp_server_removed` on success.
      // Idempotent skip (`not_present`) returns without emitting.
      const info = liveChannelInfo();
      if (!info) {
        throw Object.assign(
          new Error(`No live ACP channel for runtime MCP remove: ${name}`),
          { data: { errorKind: 'acp_channel_unavailable' } },
        );
      }
      type RemoveOk = {
        name: string;
        removed: true;
        wasShadowingSettings: boolean;
        originatorClientId: string;
      };
      type RemoveSkip = { name: string; skipped: true; reason: 'not_present' };
      const response = (await Promise.race([
        withTimeout(
          info.connection.extMethod(
            SERVE_CONTROL_EXT_METHODS.workspaceMcpRuntimeRemove,
            { name, originatorClientId },
          ),
          MCP_RESTART_SERVER_DEADLINE_MS,
          SERVE_CONTROL_EXT_METHODS.workspaceMcpRuntimeRemove,
        ),
        getChannelClosedReject(info),
      ])) as RemoveOk | RemoveSkip;
      // Emit event on success (non-skip)
      const removeSkipped =
        (response as { skipped?: boolean }).skipped === true;
      if (!removeSkipped) {
        const ok = response as RemoveOk;
        broadcastWorkspaceEvent({
          type: 'mcp_server_removed',
          data: {
            name: ok.name,
            wasShadowingSettings: ok.wasShadowingSettings,
            originatorClientId: ok.originatorClientId,
          },
          ...(originatorClientId ? { originatorClientId } : {}),
        });
      }
      return response;
    },

    async addSessionRuntimeMcpServer(
      sessionId,
      name,
      config,
      originatorClientId,
    ) {
      return requestSessionStatus<RuntimeMcpServerAddResult>(
        sessionId,
        SERVE_CONTROL_EXT_METHODS.sessionMcpRuntimeAdd,
        { name, config, originatorClientId },
        MCP_RESTART_SERVER_DEADLINE_MS,
      );
    },

    async removeSessionRuntimeMcpServer(sessionId, name, originatorClientId) {
      return requestSessionStatus<RuntimeMcpServerRemoveResult>(
        sessionId,
        SERVE_CONTROL_EXT_METHODS.sessionMcpRuntimeRemove,
        { name, originatorClientId },
        MCP_RESTART_SERVER_DEADLINE_MS,
      );
    },

    async killSession(sessionId, opts) {
      const entry = byId.get(sessionId);
      if (!entry) return false;
      // BQ9tV race guard: skip the reap if any other client already
      // attached to this entry. The disconnect-reaper in server.ts
      // sets `requireZeroAttaches: true` because it only wants to
      // reap when the spawn-owner that disconnected truly was the
      // sole client. Counter increment + this check both run
      // synchronously, so no microtask boundary lets a race slip
      // through.
      // BkwQP: when bailing because of an attach, set the tombstone
      // so a later `detachClient` (that brings attachCount back to
      // 0) can complete the deferred reap. Without this, both
      // spawn-owner-and-attach disconnecting leaves the session
      // orphaned forever (spawn owner's reap bails here, attach's
      // detach does nothing structural).
      if (opts?.requireZeroAttaches && entry.attachCount > 0) {
        entry.spawnOwnerWantedKill = true;
        return false;
      }
      if (entry.closing) {
        const closingChannel = channelInfoForEntry(entry);
        if (!closingChannel) return false;
        await killChannelWithLog(
          closingChannel,
          `force kill closing session ${JSON.stringify(sessionId)}`,
        );
        await entry.attachments.close().catch((releaseError) => {
          writeStderrLine(
            `qwen serve: failed to close attachments for killed session ${JSON.stringify(sessionId)}: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
          );
        });
        return true;
      }
      entry.closing = true;
      clearPromptSettledClose(entry);
      const ci = channelInfoForEntry(entry);
      if (!ci) {
        writeStderrLine(
          `qwen serve: killSession channelInfoForEntry returned undefined ` +
            `for session ${JSON.stringify(sessionId)} — channel cleanup skipped (entry's channel already torn down)`,
        );
      }
      // Resolve permission waits before asking the agent to drain active turns;
      // otherwise a turn blocked in requestPermission can deadlock kill.
      permissionMediator.forgetSession(sessionId);
      entry.pendingPermissionIds.clear();
      entry.pendingInteractions.clear();
      try {
        await notifyAgentSessionClose(entry, ci, 'killSession', {
          throwOnFailure: true,
          timeoutMs: initTimeoutMs,
        });
      } catch (error) {
        // A definitive refusal means the child is alive and kept the session:
        // it already holds its own close gate (a cd or restore in progress —
        // child-side state the daemon cannot see). Escalating that to a
        // channel kill would take every sibling session down for a close
        // that is already proceeding. Leave the kill pending instead; the
        // deferred tombstone completes it on the next settle event.
        if (isDefinitiveAcpRequestError(error)) {
          entry.closing = false;
          return false;
        }
        if (ci) {
          await killChannelWithLog(
            ci,
            `force kill session ${JSON.stringify(sessionId)}`,
          );
          return true;
        }
        entry.closing = false;
        throw error;
      }
      if (entry.promptActive) {
        entry.promptActive = false;
        activePromptCounter--;
        touchActivity();
      }
      // Remove from the state eagerly so concurrent `spawnOrAttach`
      // can't reattach to a session we're tearing down.
      if (defaultEntry === entry) defaultEntry = undefined;
      byId.delete(sessionId);
      telemetry.metrics?.sessionLifecycle('die');
      emitSessionLifecycle({
        type: 'removed',
        sessionId,
        workspaceCwd: entry.workspaceCwd,
        reason: 'killed',
      });
      // Detach from the channel. The channel dies only when its LAST
      // session leaves — other sessions on the same channel keep
      // running.
      //
      // HAZARD: Same channel-overlap fix as in `closeSession` above.
      // `channelInfoForEntry(entry)` returns the entry's actual
      // channel rather than the module-scoped `channelInfo` (current
      // attach target), preventing the "kill operates on the freshly-
      // spawned channel B instead of the dying channel A" cascade
      // during the overlap window. The regression test is single-channel
      // smoke only and WILL NOT fail if this reverts to module-scoped
      // channelInfo. Keep `channelInfoForEntry(entry)` until a
      // deterministic overlap test lands.
      if (ci && ci.channel === entry.channel) {
        ci.sessionIds.delete(sessionId);
      }
      // Tombstone the killed sessionId so any in-flight
      // `extNotification` from the (about-to-be-killed) child can't
      // seed the early-event buffer for a subsequent load/resume of
      // the same persisted id.
      ci?.client.markSessionClosed(sessionId);
      // Publish `session_died` BEFORE closing the bus. After the eager
      // `byId.delete` above, the channel.exited handler's
      // `byId.get(...)` returns undefined so the automatic publish
      // at crash time wouldn't fire. SSE subscribers need this
      // terminal frame to know the session is gone.
      // DAEMON-002/005: pending prompts owe their formal terminal first.
      flushPromptTerminals(
        entry,
        'session_killed',
        'session killed before the prompt completed',
      );
      try {
        entry.events.publish({
          type: 'session_died',
          data: { sessionId, reason: 'killed' },
        });
      } catch {
        /* bus already closed */
      }
      entry.events.close();
      await entry.attachments.close().catch((error) => {
        writeStderrLine(
          `qwen serve: failed to close attachments for killed session ${JSON.stringify(sessionId)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      // Only kill the channel when no other sessions remain AND no
      // restore is in flight.
      // `pendingRestoreIds` covers in-flight `session/load` and
      // `session/resume` calls that haven't yet registered into
      // `sessionIds`. Killing the channel out from under them would
      // SIGTERM the restore mid-flight and 500 the caller for a
      // failure orthogonal to their request.
      if (ci && hasNoChannelWork(ci)) {
        await reapPendingEmptyChannel(ci);
        if (!ci.isDying) {
          await startIdleTimer(ci, `killSession "${sessionId}"`);
        }
      }
      return true;
    },

    async detachClient(sessionId, clientId) {
      // The `attachCount` race guard is monotonic — once any attach
      // bumps it, the spawn-owner's disconnect-reaper becomes a
      // permanent no-op even if the attaching client itself
      // disconnected. This is the symmetric rollback the server's
      // `!res.writable && session.attached` path calls into.
      //
      // BkwQP: detachClient decrements attachCount and unregisters the
      // client. Two close paths:
      // 1. spawnOwnerWantedKill tombstone → killSession (deferred reap
      //    from the spawn-handshake disconnect race).
      // 2. clientIds.size === 0 → closeSessionImpl (last registered
      //    client left; session closed immediately, JSONL preserved).
      // The idle reaper serves as a backstop for clients that crash
      // without sending a detach request.
      const entry = byId.get(sessionId);
      if (!entry) return;
      // Only a detach that releases a recorded attach-ref may decrement
      // `attachCount`. Duplicate detaches, unknown/anonymous clientIds
      // and owner-style registrations (spawn owner, restore initiator)
      // carry no ledger ref, so they can no longer steal another
      // attacher's count and trigger a premature kill. The
      // registration ref is still dropped unconditionally below —
      // unregisterClient is idempotent and an owner's explicit goodbye
      // must keep the close-on-last-detach path reachable.
      if (clientId !== undefined && releaseAttachRef(entry, clientId)) {
        if (entry.attachCount > 0) entry.attachCount--;
      }
      unregisterClient(entry, clientId);
      // Last registered client left. Whether that means close, kill, or
      // nothing at all lives in one place now: a pending prompt (active OR
      // queued — `pendingPromptCount` covers the FIFO hand-off gap), an
      // unsettled Agent, or a child that has not confirmed it is unheld all
      // hold the session open, and the deferred close fires from whichever
      // path settles last. The JSONL transcript on disk survives either way,
      // so session/load can restore it later.
      await maybeCloseIdleSession(entry, 'last_client_detached');
    },

    killAllSync() {
      // Synchronous best-effort SIGKILL on EVERY alive channel
      // (typically 1, but during a `killSession`-then-`spawnOrAttach`
      // overlap there can be 2). Set `shuttingDown` so any racing
      // async path fails fast.
      //
      // BkUyD: iterate `aliveChannels` (the OS-level "still alive"
      // source of truth) — `channelInfo` only points at the CURRENT
      // attach target, missing any dying channel whose
      // `channel.exited` hasn't fired yet.
      shuttingDown = true;
      cancelIdleTimer();
      stopSessionReaper();
      const channels = Array.from(aliveChannels);
      const entries = Array.from(byId.values());
      defaultEntry = undefined;
      byId.clear();
      for (const entry of entries) {
        emitSessionLifecycle({
          type: 'removed',
          sessionId: entry.sessionId,
          workspaceCwd: entry.workspaceCwd,
          reason: 'kill_all',
        });
      }
      for (const info of channels) {
        info.channelLiveness?.stop();
        try {
          info.channel.killSync();
        } catch {
          /* best-effort — already-dead child / pid race */
        }
      }
    },

    shutdown(options) {
      if (shutdownPromise) return shutdownPromise;
      const shutdownReason = options?.reason ?? 'daemon_shutdown';
      let resolveShutdown: (() => void) | undefined;
      let rejectShutdown: ((reason?: unknown) => void) | undefined;
      shutdownPromise = new Promise<void>((resolve, reject) => {
        resolveShutdown = resolve;
        rejectShutdown = reject;
      });
      void (async () => {
        // Set BEFORE the snapshot so any racing `spawnOrAttach` triggered
        // by an in-flight HTTP connection after `runQwenServe.close()`
        // entered the bridge.shutdown() phase fails fast instead of
        // spawning a child this teardown won't see.
        shuttingDown = true;
        unregisterJournalGrowthSessionLimits?.();
        cancelIdleTimer();
        stopSessionReaper();
        const entries = Array.from(byId.values());
        // Snapshot every alive channel (typically 1; up to 2 during a
        // `killSession`-then-`spawnOrAttach` overlap) — entries are
        // intentionally NOT removed from `aliveChannels` here; their
        // `channel.exited` handlers clear them once the OS has reaped
        // each child. That preserves the BkUyD invariant: a
        // double-Ctrl+C arriving mid-SIGTERM-grace can still find every
        // alive channel via `killAllSync`. Marking each `isDying` makes
        // them invisible to any racing `ensureChannel` call — but
        // `shuttingDown` already blocks new `spawnOrAttach` upstream,
        // so this is mostly belt-and-suspenders (a direct internal
        // `ensureChannel` past the gate would still see the dying
        // state and not attach).
        const channels = Array.from(aliveChannels);
        for (const ci of channels) {
          ci.isDying = true;
          ci.channelLiveness?.stop();
        }
        // Drain mediator pending state before clearing byId so awaiting
        // `requestPermission` callers unwind. Each `forgetSession`
        // settles all matching pending as session_closed; the bridge's
        // per-entry index gets cleared alongside.
        for (const e of entries) {
          permissionMediator.forgetSession(e.sessionId);
          e.pendingPermissionIds.clear();
          e.pendingInteractions.clear();
        }
        defaultEntry = undefined;
        byId.clear();
        // Publish a terminal `session_died` BEFORE closing each bus so SSE
        // subscribers can distinguish "daemon shut down" from a transient
        // network error and don't sit indefinitely retrying. The
        // channel.exited handler also publishes this on a child crash,
        // but at shutdown time the entry has already been removed from
        // `byId` (above), so the handler's `byId.get(...)` is undefined
        // and the automatic publish wouldn't fire.
        for (const e of entries) {
          telemetry.metrics?.sessionLifecycle('die');
          emitSessionLifecycle({
            type: 'removed',
            sessionId: e.sessionId,
            workspaceCwd: e.workspaceCwd,
            reason: shutdownReason,
          });
          // DAEMON-002/005: pending prompts owe their formal terminal
          // before the bus closes.
          flushPromptTerminals(
            e,
            'daemon_shutdown',
            'daemon shut down before the prompt completed',
          );
          try {
            e.events.publish({
              type: 'session_died',
              data: { sessionId: e.sessionId, reason: shutdownReason },
            });
          } catch {
            /* bus already closed */
          }
          e.events.close();
        }
        // Wait for in-flight channel + session spawns. The snapshot
        // above only sees what's already registered; a doSpawn past
        // `newSession()` but pre-`byId.set` is missed, as is an
        // `ensureChannel` past `channelFactory()` but pre-`channelInfo
        // = info`. The late-shutdown re-checks at doSpawn/ensureChannel
        // catch both — but without these awaits, `bridge.shutdown()`
        // would resolve before they finish, and the orphan stderr
        // error from a half-built child would fire AFTER the daemon
        // claimed graceful shutdown (log-confusing).
        const inFlightSessionAwaits = Array.from(inFlightSpawns.values()).map(
          (p): Promise<void> =>
            p.then(
              () => undefined,
              () => undefined,
            ),
        );
        const inFlightRestoreAwaits = Array.from(inFlightRestores.values()).map(
          (restore): Promise<void> =>
            restore.settlementPromise.then(
              () => undefined,
              () => undefined,
            ),
        );
        const inFlightChannelAwait: Promise<void> = inFlightChannelSpawn
          ? inFlightChannelSpawn.then(
              () => undefined,
              () => undefined,
            )
          : Promise.resolve();
        const teardownResults = await Promise.allSettled([
          ...channels.map((ci) => ci.channel.kill()),
          ...[...byId.values()].map((entry) => entry.attachments.close()),
          ...inFlightSessionAwaits,
          ...inFlightRestoreAwaits,
          inFlightChannelAwait,
        ]);
        const teardownFailures = teardownResults.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        if (teardownFailures.length === 1) throw teardownFailures[0];
        if (teardownFailures.length > 1) {
          throw new AggregateError(
            teardownFailures,
            'ACP bridge shutdown failed',
          );
        }
      })().then(resolveShutdown, rejectShutdown);
      return shutdownPromise;
    },

    async preheat() {
      if (shuttingDown) return;
      await telemetry.withSpan(
        'channel.preheat',
        { 'qwen-code.daemon.bridge.operation': 'channel.preheat' },
        async () => {
          const ci = await ensureChannel();
          const idleMs = resolvedChannelIdleTimeoutMs();
          if (idleMs > 0 && hasNoChannelWork(ci)) {
            await startIdleTimer(ci);
          }
        },
      );
    },
  };

  sendTrackedPrompt.fn = bridgeApi.sendPrompt.bind(bridgeApi);

  return bridgeApi;
}

/**
 * Race `p` against a timeout. The timeout REJECTS the returned
 * promise but does NOT abort the underlying operation — `p` keeps
 * running to completion (or its own failure) and its eventual
 * resolution is silently dropped.
 *
 * Stage 1 limitation: for `unstable_setSessionModel` the agent may
 * complete the model switch AFTER we surfaced the timeout to the
 * HTTP caller, leading to drift between caller's perceived model
 * and agent's actual model. Subscribers also see contradictory
 * SSE events (`model_switch_failed` from the timeout, then a late
 * `model_switched` if the agent succeeds). Acceptable for Stage 1
 * because:
 *   1. ACP's `unstable_setSessionModel` doesn't accept a cancel
 *      signal yet (the SDK's `prompt` does, hence `sendPrompt`'s
 *      explicit `cancel` notification on abort).
 *   2. Model switches complete in milliseconds in practice; a
 *      timeout firing means the agent is genuinely wedged, not
 *      just slow, and would have been DOA anyway.
 * Stage 2 will add abort plumbing once ACP exposes a cancel hook
 * for `unstable_setSessionModel`. Tracked in the model-change
 * concurrency notes in `applyModelServiceId`. BSA0C suggested a
 * `modelSwitchTimedOut` flag + `model_switch_late_success`
 * synthetic frame for full observability of the divergent state;
 * recorded as a Stage 2 follow-up so the timeout/late-success
 * handshake is implemented once across both ACP-side cancel and
 * the bridge-side state flag (rather than just papering over the
 * symptom).
 */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BridgeTimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([p, timeoutP]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** @deprecated Use `createAcpSessionBridge` instead. */
export const createHttpAcpBridge = createAcpSessionBridge;
