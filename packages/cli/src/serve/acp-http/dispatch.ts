/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import {
  APPROVAL_MODES,
  type ApprovalMode,
  BTW_MAX_INPUT_LENGTH,
  createDebugLogger,
  SessionService,
  SessionOrganizationError,
  type SessionGroupColor,
  BuiltinAgentRegistry,
  SubagentError,
  WorkspaceMemoryFileTooLargeError,
  WorkspaceMemoryWriteTimeoutError,
  writeWorkspaceContextFile,
  type SessionArchiveState,
  type SubagentLevel,
} from '@qwen-code/qwen-code-core';
// Import the permission error classes from the same module REST's
// `sendPermissionVoteError` uses, so `instanceof` matches the class the bridge
// actually throws (the core re-export is a distinct identity at runtime).
import {
  CancelSentinelCollisionError,
  InvalidPermissionOptionError,
  PermissionForbiddenError,
  PermissionPolicyNotImplementedError,
  SessionArchivingError,
} from '../acp-session-bridge.js';
import { FsError } from '../fs/errors.js';
import {
  TooManyActiveDeviceFlowsError,
  UnsupportedDeviceFlowProviderError,
  UpstreamDeviceFlowError,
} from '../auth/device-flow.js';
import type { HttpAcpBridge } from '@qwen-code/acp-bridge/bridgeTypes';
import type { BridgeEvent } from '@qwen-code/acp-bridge/eventBus';
import {
  SessionShellClientRequiredError,
  SessionShellDisabledError,
  WorkspaceMismatchError,
} from '@qwen-code/acp-bridge/bridgeErrors';
import { SessionArtifactValidationError } from '@qwen-code/acp-bridge/sessionArtifacts';
import { canonicalizeWorkspace } from '@qwen-code/acp-bridge/workspacePaths';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { MAX_WORKSPACE_PATH_LENGTH } from '../fs/paths.js';
import {
  MAX_READ_BYTES,
  type WorkspaceFileSystemFactory,
} from '../fs/index.js';
import {
  isPermissionRuleType,
  normalizePermissionRules,
  PermissionRulesValidationError,
  readPermissionRuleSet,
} from '../../config/permission-settings.js';
import { loadSettings } from '../../config/settings.js';
import { WorkspaceVoiceError } from '../../services/voice-service.js';
import { SetupGithubError, setupGithub } from '../../services/setup-github.js';
import {
  createSetupGithubFileOps,
  resolveSetupGithubProxy,
  sanitizeSetupGithubMessage,
  sanitizeSetupGithubResult,
  setupGithubEventData,
} from '../routes/workspace-setup-github.js';
import { parseWorkspaceVoiceUpdateParams } from '../routes/workspace-voice.js';
import { MAX_TRUST_REASON_LENGTH } from '../validation-limits.js';
import {
  publicErrorMessage,
  publicErrorStatus,
  type WorkspaceRememberTaskLane,
} from '../workspace-remember.js';
import { extractRememberErrorCode } from '../workspace-remember-errors.js';
import { MAX_REMEMBER_CONTENT_BYTES } from '../workspace-memory-remember-constants.js';
import type { DeviceFlowRegistry } from '../auth/device-flow.js';
import { collectWorkspaceMemoryStatus } from '../workspace-memory.js';
import {
  createDaemonSubagentManager,
  toSummary as agentToSummary,
  toDetail as agentToDetail,
} from '../workspace-agents.js';
import {
  InvalidCursorError,
  listWorkspaceSessionsForResponse,
} from '../server.js';
import { createSessionOrganizationService } from '../session-organization-helpers.js';
import {
  archiveDaemonSessions,
  assertSessionLoadable,
  deleteDaemonSessions,
  logSessionArchiveWarning,
  SessionArchiveCoordinator,
  unarchiveDaemonSessions,
} from '../server/session-archive.js';
import type {
  DaemonWorkspaceService,
  WorkspaceRequestContext,
} from '../workspace-service/types.js';
import {
  WorkspacePermissionRulesSessionRequiredError,
  WorkspaceSettingsPartialPersistError,
} from '../workspace-service/types.js';
import type {
  AcpConnection,
  ConnectionRegistry,
  PendingClientRequestRef,
} from './connection-registry.js';
import {
  QWEN_META_KEY,
  QWEN_METHOD_NS,
  RPC,
  error,
  isNotification,
  isObject,
  isRequest,
  isResponse,
  logSafe,
  notification,
  request,
  success,
  type JsonRpcId,
  type JsonRpcInbound,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './json-rpc.js';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const debugLogger = createDebugLogger('ACP_HTTP_DISPATCH');

type PermissionResponse = Parameters<
  HttpAcpBridge['respondToSessionPermission']
>[2];
type AddSessionArtifactInput = Parameters<
  HttpAcpBridge['addSessionArtifact']
>[1];

const SESSION_SHELL_METHOD = `${QWEN_METHOD_NS}session/shell`;
const INVALID_PERMISSION_OUTCOME_ERROR =
  '`outcome` must be `{ outcome: "cancelled" }` or `{ outcome: "selected", optionId: string }`';

const ALL_QWEN_VENDOR_METHODS: readonly string[] = [
  `${QWEN_METHOD_NS}session/heartbeat`,
  `${QWEN_METHOD_NS}session/context`,
  `${QWEN_METHOD_NS}session/supported_commands`,
  `${QWEN_METHOD_NS}session/update_metadata`,
  `${QWEN_METHOD_NS}session/update_organization`,
  `${QWEN_METHOD_NS}workspace/session_groups/list`,
  `${QWEN_METHOD_NS}workspace/session_groups/create`,
  `${QWEN_METHOD_NS}workspace/session_groups/update`,
  `${QWEN_METHOD_NS}workspace/session_groups/delete`,
  `${QWEN_METHOD_NS}workspace/mcp`,
  `${QWEN_METHOD_NS}workspace/skills`,
  `${QWEN_METHOD_NS}workspace/providers`,
  `${QWEN_METHOD_NS}workspace/env`,
  `${QWEN_METHOD_NS}workspace/preflight`,
  `${QWEN_METHOD_NS}workspace/init`,
  `${QWEN_METHOD_NS}workspace/trust`,
  `${QWEN_METHOD_NS}workspace/trust/request`,
  `${QWEN_METHOD_NS}workspace/permissions`,
  `${QWEN_METHOD_NS}workspace/permissions/set`,
  `${QWEN_METHOD_NS}workspace/voice`,
  `${QWEN_METHOD_NS}workspace/voice/set`,
  `${QWEN_METHOD_NS}workspace/setup-github`,
  `${QWEN_METHOD_NS}workspace/set_tool_enabled`,
  `${QWEN_METHOD_NS}workspace/restart_mcp_server`,
  // Wave 1: session extensions
  `${QWEN_METHOD_NS}session/recap`,
  `${QWEN_METHOD_NS}session/btw`,
  SESSION_SHELL_METHOD,
  `${QWEN_METHOD_NS}session/detach`,
  `${QWEN_METHOD_NS}session/context_usage`,
  `${QWEN_METHOD_NS}session/tasks`,
  `${QWEN_METHOD_NS}session/lsp`,
  `${QWEN_METHOD_NS}session/artifacts`,
  `${QWEN_METHOD_NS}session/artifacts/add`,
  `${QWEN_METHOD_NS}session/artifacts/remove`,
  // Wave 1: memory
  `${QWEN_METHOD_NS}workspace/memory`,
  `${QWEN_METHOD_NS}workspace/memory/write`,
  `${QWEN_METHOD_NS}workspace/memory/remember`,
  `${QWEN_METHOD_NS}workspace/memory/remember/get`,
  `${QWEN_METHOD_NS}workspace/memory/forget`,
  `${QWEN_METHOD_NS}workspace/memory/forget/get`,
  `${QWEN_METHOD_NS}workspace/memory/dream`,
  `${QWEN_METHOD_NS}workspace/memory/dream/get`,
  // Wave 1: files
  `${QWEN_METHOD_NS}file/read`,
  `${QWEN_METHOD_NS}file/read_bytes`,
  `${QWEN_METHOD_NS}file/stat`,
  `${QWEN_METHOD_NS}file/list`,
  `${QWEN_METHOD_NS}file/glob`,
  `${QWEN_METHOD_NS}file/write`,
  `${QWEN_METHOD_NS}file/edit`,
  // Wave 1: auth
  `${QWEN_METHOD_NS}workspace/auth/status`,
  `${QWEN_METHOD_NS}workspace/auth/device_flow/start`,
  `${QWEN_METHOD_NS}workspace/auth/device_flow/get`,
  `${QWEN_METHOD_NS}workspace/auth/device_flow/cancel`,
  // Wave 1: remaining workspace
  `${QWEN_METHOD_NS}workspace/tools`,
  `${QWEN_METHOD_NS}workspace/mcp/tools`,
  `${QWEN_METHOD_NS}workspace/mcp/resources`,
  `${QWEN_METHOD_NS}workspace/mcp/servers/add`,
  `${QWEN_METHOD_NS}workspace/mcp/servers/remove`,
  `${QWEN_METHOD_NS}sessions/delete`,
  `${QWEN_METHOD_NS}sessions/archive`,
  `${QWEN_METHOD_NS}sessions/unarchive`,
  // Wave 2: agents
  `${QWEN_METHOD_NS}workspace/agents/list`,
  `${QWEN_METHOD_NS}workspace/agents/get`,
  `${QWEN_METHOD_NS}workspace/agents/create`,
  `${QWEN_METHOD_NS}workspace/agents/update`,
  `${QWEN_METHOD_NS}workspace/agents/delete`,
];

function advertisedQwenVendorMethods(
  sessionShellCommandEnabled: boolean,
): string[] {
  return ALL_QWEN_VENDOR_METHODS.filter(
    (method) => sessionShellCommandEnabled || method !== SESSION_SHELL_METHOD,
  );
}

/**
 * Method names whose responses ride the CONNECTION-scoped stream (the
 * session stream may not exist yet / ownership not granted on failure).
 * Error frames must route the same way as their success path.
 */
const CONN_ROUTED_METHODS = new Set<string>([
  'authenticate',
  'session/new',
  'session/load',
  'session/resume',
  'session/list',
  'session/close',
  'session/fork',
  'session/permission',
  ...ALL_QWEN_VENDOR_METHODS,
]);

// SYNC: server.ts MAX_TOOL_NAME_LENGTH / MAX_SERVER_NAME_LENGTH (both 256).
// Keep in lockstep with the REST surface — a divergence means ACP clients get
// INVALID_PARAMS for names REST accepts (or vice versa). (Not extracted to a
// shared module to avoid churning the 2987-line server.ts near merge; a
// follow-up may lift all three to a `serve/limits.ts`.)
const MAX_NAME_LENGTH = 256;
const DEFAULT_FILE_GLOB_MAX_RESULTS = 5000;
const MAX_FILE_GLOB_MAX_RESULTS = 50_000;
const MAX_FILE_LINE_LIMIT = 2000;

class AcpParamError extends Error {}

function parseOptionalPositiveInteger(
  value: unknown,
  fallback: number,
  max: number,
): number | null {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  ) {
    return null;
  }
  return value;
}

function parseOptionalSafeIntegerInRange(
  value: unknown,
  min: number,
  max: number,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    return null;
  }
  return value;
}

/**
 * Validate an optional `cwd` param the same way the REST `POST /session`
 * route does: when present it must be a string, ≤ PATH_MAX, and absolute.
 * Closes the body-amplification DoS the REST code documents. Returns the
 * bound workspace when omitted.
 */
function parseOptionalWorkspaceCwd(
  params: Record<string, unknown>,
  boundWorkspace: string,
): string {
  if (!('cwd' in params) || params['cwd'] === undefined) return boundWorkspace;
  const cwd = params['cwd'];
  if (typeof cwd !== 'string') {
    throw new AcpParamError(
      '`cwd` must be a string absolute path when provided',
    );
  }
  if (cwd.length > MAX_WORKSPACE_PATH_LENGTH) {
    throw new AcpParamError(
      `\`cwd\` exceeds the ${MAX_WORKSPACE_PATH_LENGTH}-character limit`,
    );
  }
  // `path.isAbsolute` (platform-aware) — same as the REST route. A bare
  // `startsWith('/')` would reject valid Windows `C:\…`/UNC paths a client
  // gets back from `/capabilities.workspaceCwd`.
  if (!path.isAbsolute(cwd)) {
    throw new AcpParamError('`cwd` must be an absolute path when provided');
  }
  return cwd;
}

/** Validate a `session/prompt` body before it reaches the bridge/agent. */
function validatePrompt(params: Record<string, unknown>): void {
  const prompt = params['prompt'];
  if (!Array.isArray(prompt) || prompt.length === 0) {
    throw new AcpParamError(
      '`prompt` is required and must be a non-empty array of content blocks',
    );
  }
  if (
    !prompt.every(
      (b) => typeof b === 'object' && b !== null && !Array.isArray(b),
    )
  ) {
    throw new AcpParamError('each `prompt` element must be an object');
  }
}

function parsePermissionResponse(
  params: Record<string, unknown>,
): PermissionResponse {
  const outcome = params['outcome'];
  if (!isObject(outcome)) {
    throw new AcpParamError(INVALID_PERMISSION_OUTCOME_ERROR);
  }
  if (outcome['outcome'] !== 'cancelled') {
    if (
      outcome['outcome'] !== 'selected' ||
      typeof outcome['optionId'] !== 'string' ||
      outcome['optionId'].length === 0
    ) {
      throw new AcpParamError(INVALID_PERMISSION_OUTCOME_ERROR);
    }
  }

  // Whitelist only the fields the bridge contract defines — a rebuilt `outcome`
  // carrying just its validated keys, plus the ACP-reserved `_meta` passthrough
  // — rather than forwarding client-supplied keys. The previous copy-all let a
  // client inject arbitrary top-level args AND extra `outcome` sub-fields (e.g.
  // `{ outcome: { outcome: 'selected', optionId: 'allow', force: true } }`) into
  // the server-side bridge call; harmless today since the bridge reads only the
  // discriminant + optionId, but a needless client-controlled surface.
  const cleanOutcome =
    outcome['outcome'] === 'cancelled'
      ? { outcome: 'cancelled' as const }
      : { outcome: 'selected' as const, optionId: outcome['optionId'] };
  const response: Record<string, unknown> = { outcome: cleanOutcome };
  // `answers` is the one non-ACP permission-response field the bridge honours
  // (AskUserQuestion). Forward it under the same shape the bridge validates —
  // an object map of string values — so dropping it doesn't silently leave the
  // agent with no submitted answers.
  const answers = params['answers'];
  if (answers !== undefined) {
    if (
      isObject(answers) &&
      Object.values(answers).every((value) => typeof value === 'string')
    ) {
      response['answers'] = answers;
    } else {
      // Present but malformed: the bridge would reject it anyway, so it is
      // dropped — but log it, otherwise a client whose answers silently
      // vanished (agent sees none) has no server-side signal to chase.
      writeStderrLine(
        'qwen serve: /acp session/permission dropping invalid `answers` (expected an object map of string values)',
      );
    }
  }
  if (isObject(params['_meta'])) {
    response['_meta'] = params['_meta'];
  }
  return response as PermissionResponse;
}

function pickSessionArtifactInput(
  params: Record<string, unknown>,
): AddSessionArtifactInput {
  const {
    title,
    kind,
    storage,
    description,
    workspacePath,
    managedId,
    url,
    mimeType,
    sizeBytes,
    metadata,
  } = params;

  return {
    title,
    kind,
    storage,
    description,
    workspacePath,
    managedId,
    url,
    mimeType,
    sizeBytes,
    metadata,
  } as AddSessionArtifactInput;
}

/**
 * Map a thrown error to a JSON-RPC error code + a client-safe message.
 * Param-validation errors are echoed (they describe the client's own bad
 * input); bridge/internal errors are coded by class name with their
 * message preserved (the daemon's trust boundary is the bearer token, so
 * the operator-facing message is not a cross-tenant leak), and anything
 * unrecognized collapses to a generic INTERNAL_ERROR string.
 */
function toRpcError(err: unknown): {
  code: number;
  message: string;
  data?: Record<string, unknown>;
} {
  if (err instanceof AcpParamError || err instanceof InvalidCursorError) {
    return { code: RPC.INVALID_PARAMS, message: err.message };
  }
  if (err instanceof SessionOrganizationError) {
    const isServerSide = err.code === 'session_organization_store_unreadable';
    return {
      code: isServerSide ? RPC.INTERNAL_ERROR : RPC.INVALID_PARAMS,
      message: err.message,
      data: {
        errorKind: err.code,
        ...(err.field ? { field: err.field } : {}),
      },
    };
  }
  if (err instanceof SubagentError) {
    return { code: RPC.INVALID_PARAMS, message: err.message };
  }
  if (err instanceof FsError) {
    return {
      code: RPC.INVALID_PARAMS,
      message: err.message,
      data: { errorKind: err.kind, hint: err.hint },
    };
  }
  if (err instanceof WorkspaceMemoryFileTooLargeError) {
    return {
      code: RPC.INVALID_PARAMS,
      message: err.message,
      data: { errorKind: 'memory_file_too_large' },
    };
  }
  if (err instanceof WorkspaceMemoryWriteTimeoutError) {
    return {
      code: RPC.INTERNAL_ERROR,
      message: err.message,
      data: { errorKind: 'memory_write_timeout' },
    };
  }
  if (err instanceof WorkspaceVoiceError) {
    return {
      code:
        err.status >= 400 && err.status < 500
          ? RPC.INVALID_PARAMS
          : RPC.INTERNAL_ERROR,
      message: err.message,
      data: { errorKind: err.code },
    };
  }
  if (err instanceof WorkspaceSettingsPartialPersistError) {
    return {
      code: RPC.INTERNAL_ERROR,
      message: err.message,
      data: {
        errorKind: 'partial_persist_error',
        committedKeys: err.committedWrites.map((write) => write.key),
      },
    };
  }
  if (err instanceof TooManyActiveDeviceFlowsError) {
    return {
      code: RPC.INTERNAL_ERROR,
      message: err.message,
      data: { errorKind: 'too_many_active_flows' },
    };
  }
  if (err instanceof UnsupportedDeviceFlowProviderError) {
    return {
      code: RPC.INVALID_PARAMS,
      message: err.message,
      data: { errorKind: 'unsupported_provider' },
    };
  }
  if (err instanceof UpstreamDeviceFlowError) {
    return {
      code: RPC.INTERNAL_ERROR,
      message: err.message,
      data: { errorKind: 'upstream_error' },
    };
  }
  if (err instanceof SessionShellDisabledError) {
    return {
      code: RPC.INVALID_PARAMS,
      message: errMsg(err),
      data: { errorKind: 'session_shell_disabled' },
    };
  }
  if (err instanceof SessionShellClientRequiredError) {
    return {
      code: RPC.INVALID_PARAMS,
      message: errMsg(err),
      data: { errorKind: 'client_id_required' },
    };
  }
  if (err instanceof SessionArtifactValidationError) {
    return {
      code: RPC.INVALID_PARAMS,
      message: err.message,
      data: {
        errorKind: 'artifact_validation_failed',
        ...(err.field ? { field: err.field } : {}),
      },
    };
  }
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'SessionArchivedError':
      return {
        code: RPC.INTERNAL_ERROR,
        message: errMsg(err),
        data: {
          errorKind: 'session_archived',
          sessionId: (err as { sessionId?: unknown }).sessionId,
        },
      };
    case 'SessionConflictError':
      return {
        code: RPC.INTERNAL_ERROR,
        message: errMsg(err),
        data: {
          errorKind: 'session_conflict',
          sessionId: (err as { sessionId?: unknown }).sessionId,
        },
      };
    case 'SessionArchivingError':
      return {
        code: RPC.INTERNAL_ERROR,
        message: errMsg(err),
        data: {
          errorKind: 'session_archiving',
          sessionId: (err as { sessionId?: unknown }).sessionId,
        },
      };
    case 'SessionNotFoundError':
    case 'InvalidSessionScopeError':
    case 'WorkspaceMismatchError':
    case 'InvalidClientIdError':
      return { code: RPC.INVALID_PARAMS, message: errMsg(err) };
    case 'SessionLimitExceededError':
      return { code: RPC.INTERNAL_ERROR, message: errMsg(err) };
    case 'PromptQueueFullError': {
      const promptErr = err as {
        sessionId?: unknown;
        limit?: unknown;
        pendingCount?: unknown;
      };
      return {
        code: RPC.INTERNAL_ERROR,
        message: errMsg(err),
        data: {
          errorKind: 'prompt_queue_full',
          sessionId: promptErr.sessionId,
          limit: promptErr.limit,
          pendingCount: promptErr.pendingCount,
        },
      };
    }
    default:
      return {
        code: RPC.INTERNAL_ERROR,
        message: 'Internal error',
        data: { errorKind: 'internal' },
      };
  }
}

function rpcErrorFrame(id: JsonRpcId, err: unknown) {
  const { code, message, data } = toRpcError(err);
  return error(id, code, message, data);
}

/**
 * The ACP protocol version this transport speaks (ACP stable = 1).
 */
export const ACP_PROTOCOL_VERSION = 1;

/**
 * Routes JSON-RPC messages between the HTTP transport and the
 * `HttpAcpBridge`. Inbound client messages map to bridge calls; the
 * bridge's `BridgeEvent`s map back to JSON-RPC frames on the matching
 * session stream (see the design doc §4 translation table).
 */
export class AcpDispatcher {
  private readonly agentManager;

  constructor(
    private readonly bridge: HttpAcpBridge,
    private readonly boundWorkspace: string,
    private readonly workspace: DaemonWorkspaceService,
    private readonly workspaceRememberLane: WorkspaceRememberTaskLane,
    private readonly fsFactory?: WorkspaceFileSystemFactory,
    private readonly deviceFlowRegistry?: DeviceFlowRegistry,
    private readonly sessionShellCommandEnabled: boolean = false,
    private readonly registry?: ConnectionRegistry,
    private readonly archiveCoordinator: SessionArchiveCoordinator = new SessionArchiveCoordinator(),
  ) {
    this.agentManager = createDaemonSubagentManager(boundWorkspace);
  }

  private killOrphanSession(sessionId: string): void {
    void this.bridge
      .killSession(sessionId, { requireZeroAttaches: true })
      .catch((err) =>
        writeStderrLine(
          `qwen serve: /acp orphan killSession(${logSafe(sessionId)}) failed: ${logSafe(errMsg(err))}`,
        ),
      );
  }

  /**
   * Build the `WorkspaceRequestContext` for workspace-scoped operations
   * routed through the workspace service. The ACP dispatch has no session
   * context, so `sessionId` is omitted.
   */
  private wsCtx(conn: AcpConnection, method: string): WorkspaceRequestContext {
    return {
      originatorClientId: conn.clientId,
      route: `ACP ${method}`,
      workspaceCwd: this.boundWorkspace,
    };
  }

  private parseBoundWorkspaceParam(params: Record<string, unknown>): string {
    const rawWorkspace =
      typeof params['workspaceCwd'] === 'string'
        ? params['workspaceCwd']
        : undefined;
    if (rawWorkspace === undefined) {
      return this.boundWorkspace;
    }
    const requestedWorkspace = canonicalizeWorkspace(
      parseOptionalWorkspaceCwd({ cwd: rawWorkspace }, this.boundWorkspace),
    );
    if (requestedWorkspace !== this.boundWorkspace) {
      throw new WorkspaceMismatchError(this.boundWorkspace, requestedWorkspace);
    }
    return requestedWorkspace;
  }

  private parseSessionIds(params: Record<string, unknown>): string[] {
    const sessionIds = params['sessionIds'];
    if (
      !Array.isArray(sessionIds) ||
      sessionIds.length === 0 ||
      sessionIds.length > 100 ||
      !sessionIds.every((s) => typeof s === 'string')
    ) {
      throw new AcpParamError(
        '`sessionIds` must be non-empty string array (max 100)',
      );
    }
    return [...new Set(sessionIds as string[])];
  }

  private serializeSessionErrors(
    errors: Array<{ sessionId: string; error: unknown }>,
  ): Array<{ sessionId: string; error: string }> {
    return errors.map((e) => ({
      sessionId: e.sessionId,
      error: errMsg(e.error),
    }));
  }

  /**
   * Build the bridge context for a per-session call. Echoes the clientId the
   * bridge STAMPED at create/attach (the connection's own id is unregistered
   * and would be rejected) and threads `fromLoopback` so the `local-only`
   * permission policy can gate votes by transport — symmetric with the REST
   * surface's `detectFromLoopback(req)`.
   *
   * Throws when no stamped clientId is present: the only callers reach here
   * AFTER `requireOwned`, so the binding must exist and carry the bridge's
   * id. A missing id means an invariant broke (a `session/new`/`load` that
   * didn't record it) — fail loud rather than silently send an unregistered
   * id whose rejection surfaces asynchronously, far from the cause.
   */
  private sessionCtx(
    conn: AcpConnection,
    sessionId: string,
    fromLoopback: boolean,
  ): { clientId: string; fromLoopback: boolean } {
    const clientId = conn.sessions.get(sessionId)?.clientId;
    if (!clientId) {
      throw new Error(
        `no bridge-stamped clientId for session ${sessionId} (ownership invariant violated)`,
      );
    }
    return { clientId, fromLoopback };
  }

  /**
   * The session's ACP-shaped config options (model/mode/…), read from the
   * child's own session state. Returned in `session/new` and as the result
   * of `session/set_config_option`. Best-effort — `undefined` on error.
   */
  private async configOptionsFor(
    sessionId: string,
  ): Promise<unknown[] | undefined> {
    try {
      const ctx = (await this.bridge.getSessionContextStatus(sessionId)) as {
        state?: { configOptions?: unknown };
      };
      const co = ctx?.state?.configOptions;
      return Array.isArray(co) ? co : undefined;
    } catch (err) {
      writeStderrLine(
        `qwen serve: /acp configOptionsFor(${logSafe(sessionId)}) failed: ${logSafe(errMsg(err))}`,
      );
      return undefined;
    }
  }

  /**
   * Extract ACP-standard `SessionModelState` from configOptions.
   * ConfigOptions carry model info as `{ category: 'model', type: 'select',
   * currentValue, options }`. Maps to `{ currentModelId, availableModels }`.
   */
  private extractModelState(
    configOptions: unknown[] | undefined,
  ): { currentModelId: string; availableModels: unknown[] } | undefined {
    if (!configOptions) return undefined;
    const modelOpt = configOptions.find(
      (o) =>
        typeof o === 'object' &&
        o !== null &&
        (o as Record<string, unknown>)['category'] === 'model',
    ) as Record<string, unknown> | undefined;
    if (!modelOpt) return undefined;
    const currentModelId = String(modelOpt['currentValue'] ?? '');
    const options = Array.isArray(modelOpt['options'])
      ? modelOpt['options']
      : [];
    return {
      currentModelId,
      availableModels: options.map((opt: unknown) => {
        const o = opt as Record<string, unknown>;
        return { id: String(o['value'] ?? o['id'] ?? '') };
      }),
    };
  }

  /**
   * Extract ACP-standard `SessionModeState` from configOptions.
   * ConfigOptions carry mode info as `{ category: 'mode', type: 'select',
   * currentValue, options }`. Maps to `{ currentModeId, availableModes }`.
   */
  private extractModeState(
    configOptions: unknown[] | undefined,
  ): { currentModeId: string; availableModes: unknown[] } | undefined {
    if (!configOptions) return undefined;
    const modeOpt = configOptions.find(
      (o) =>
        typeof o === 'object' &&
        o !== null &&
        (o as Record<string, unknown>)['category'] === 'mode',
    ) as Record<string, unknown> | undefined;
    if (!modeOpt) return undefined;
    const currentModeId = String(modeOpt['currentValue'] ?? '');
    const options = Array.isArray(modeOpt['options']) ? modeOpt['options'] : [];
    return {
      currentModeId,
      availableModes: options.map((opt: unknown) => {
        const o = opt as Record<string, unknown>;
        return { id: String(o['value'] ?? o['id'] ?? '') };
      }),
    };
  }

  /**
   * Cancel a permission request the client abandoned (closed its stream /
   * connection before voting), so the bridge isn't left blocked. Invoked
   * by the connection-registry teardown path.
   */
  cancelAbandonedPermission(
    req: { sessionId: string; bridgeRequestId: string },
    clientId: string | undefined,
  ): boolean {
    try {
      this.bridge.respondToSessionPermission(
        req.sessionId,
        req.bridgeRequestId,
        { outcome: { outcome: 'cancelled' } } as unknown as Parameters<
          HttpAcpBridge['respondToSessionPermission']
        >[2],
        clientId !== undefined ? { clientId } : undefined,
      );
      return true;
    } catch (err) {
      // "Session already gone" is the common, expected path (treat as done).
      // Any OTHER failure means the mediator may still be stuck — log it AND
      // report failure so a caller can keep the pending entry for a later
      // teardown retry rather than dropping it.
      const msg = errMsg(err);
      if (/not found|unknown session/i.test(msg)) return true;
      writeStderrLine(
        `qwen serve: /acp cancelAbandonedPermission(${logSafe(req.sessionId)}) failed: ${logSafe(msg)}`,
      );
      return false;
    }
  }

  /**
   * Build the `initialize` result advertising standard + `_qwen` caps.
   * Negotiates the protocol version: we only implement stable V1, so we
   * clamp to `[1, ACP_PROTOCOL_VERSION]` — a client asking for 0/negative
   * (ACP marks V0 a pre-release fallback) or a future version gets `1`
   * rather than an echoed version we don't actually implement.
   */
  buildInitializeResult(
    connectionId: string,
    requestedVersion?: unknown,
  ): Record<string, unknown> {
    const requested =
      typeof requestedVersion === 'number' && Number.isFinite(requestedVersion)
        ? requestedVersion
        : ACP_PROTOCOL_VERSION;
    const negotiated = Math.max(1, Math.min(requested, ACP_PROTOCOL_VERSION));
    return {
      protocolVersion: negotiated,
      agentCapabilities: {
        loadSession: true,
        // Mirror acpAgent.ts promptCapabilities: #resolvePrompt handles audio
        // blocks identically to image (both become inlineData Parts).
        promptCapabilities: {
          image: true,
          audio: true,
          embeddedContext: true,
        },
        // Model + mode are exposed via the STANDARD `session/set_config_option`
        // (categories `model`/`mode`); advertise that here.
        configOptions: true,
        // Vendor extensions are advertised under `_meta` keyed by domain
        // (ACP convention, e.g. `_meta: { "zed.dev": … }`). Clients
        // feature-detect before calling `_qwen/…` methods.
        _meta: {
          [QWEN_META_KEY]: {
            connectionId,
            workspaceCwd: this.boundWorkspace,
            methods: advertisedQwenVendorMethods(
              this.sessionShellCommandEnabled,
            ),
          },
        },
      },
    };
  }

  /**
   * Gate a per-session operation on connection ownership. Sends a JSON-RPC
   * error and returns false when this connection never created/attached
   * the session (prevents driving or eavesdropping on another
   * connection's session). `session/new|load|resume` are the
   * ownership-GRANTING ops and skip this.
   */
  private requireOwned(
    conn: AcpConnection,
    sessionId: string,
    id: JsonRpcId | undefined,
  ): boolean {
    if (conn.ownsSession(sessionId)) return true;
    if (id === undefined) {
      // Notification (no id) for an unowned session: no wire response to
      // send, so log it — otherwise "my cancel did nothing" is undebuggable.
      writeStderrLine(
        `qwen serve: /acp notification for unowned session ${logSafe(sessionId)} (dropped)`,
      );
      return false;
    }
    conn.sendConn(
      error(
        id,
        RPC.INVALID_PARAMS,
        `Session ${sessionId} is not owned by this connection`,
      ),
    );
    return false;
  }

  private async withMutableOwned(
    conn: AcpConnection,
    sessionId: string,
    id: JsonRpcId | undefined,
    fn: () => Promise<void> | void,
  ): Promise<void> {
    if (!this.requireOwned(conn, sessionId, id)) return;
    await this.archiveCoordinator.runSharedMany([sessionId], async () => {
      await fn();
    });
  }

  private findPendingClientRequest(
    conn: AcpConnection,
    id: string,
  ): PendingClientRequestRef | undefined {
    const req = conn.pending.get(id);
    if (req) return { conn, id, req };
    return this.registry?.findPendingClientRequest(id);
  }

  private dropResolvedPermission(conn: AcpConnection, id: string): void {
    // Delete the exact resolved entry by its `conn.pending` map key. Under
    // multi-client attach, sibling connections can hold their own pending
    // entries sharing this one's `bridgeRequestId` (see
    // ConnectionRegistry.findPendingPermission), so re-matching by
    // `bridgeRequestId` could delete a sibling's entry and orphan the one we
    // just resolved. The siblings' now-moot entries are reaped at teardown.
    conn.pending.delete(id);
  }

  /**
   * Drop ONLY the calling connection's own pending permission entry for
   * `requestId`, never a sibling co-owner's. Under the consensus policy a vote
   * (or an unexpected vote error) from connection B must not delete connection
   * A's still-needed entry, which would stall the quorum. A connection that
   * never streamed the request holds no entry, so this is a no-op for it.
   */
  private dropOwnPendingPermission(
    conn: AcpConnection,
    requestId: string,
  ): void {
    for (const [pid, preq] of conn.pending) {
      if (preq.kind === 'permission' && preq.bridgeRequestId === requestId) {
        conn.pending.delete(pid);
        return;
      }
    }
  }

  /**
   * Handle one inbound POST message. Returns nothing — every reply is
   * delivered asynchronously on a long-lived SSE stream per the RFD
   * (`POST` itself answers `202`). `initialize` is handled by the caller
   * (it mints the connection) and never reaches here.
   */
  async handle(
    conn: AcpConnection,
    msg: JsonRpcInbound,
    sessionHeader?: string,
    reqLoopback?: boolean,
  ): Promise<void> {
    // Loopback is evaluated PER REQUEST (the permission-vote POST may arrive
    // from a different peer than `initialize`), falling back to the
    // connection's initialize-time value when the caller didn't supply it.
    const loopback = reqLoopback ?? conn.fromLoopback;

    // A client's JSON-RPC RESPONSE (to an agent→client request) — wrapped
    // so a throwing bridge call can't reject this promise after index.ts
    // already sent `202` (which would surface as an unhandled rejection).
    if (isResponse(msg)) {
      try {
        this.resolveClientResponse(conn, msg, loopback);
      } catch (err) {
        writeStderrLine(
          `qwen serve: /acp response handling error: ${logSafe(errMsg(err))}`,
        );
      }
      return;
    }
    if (!isRequest(msg) && !isNotification(msg)) return;

    const method = msg.method;
    const params = (isObject(msg.params) ? msg.params : {}) as Record<
      string,
      unknown
    >;
    const id = isRequest(msg) ? msg.id : undefined;

    // RFD §2.3: when both are present the `Acp-Session-Id` header and the
    // `sessionId` param MUST agree — reject divergence rather than let a
    // POST act on a session other than the one the header names.
    if (
      sessionHeader &&
      typeof params['sessionId'] === 'string' &&
      params['sessionId'] !== sessionHeader
    ) {
      if (id !== undefined) {
        conn.sendConn(
          error(
            id,
            RPC.INVALID_PARAMS,
            'Acp-Session-Id header does not match params.sessionId',
          ),
        );
      }
      return;
    }

    try {
      switch (method) {
        case 'authenticate':
          // HTTP transport authenticates via the daemon's bearer token
          // middleware; the ACP-level method is a success no-op.
          this.replyConn(conn, id, {});
          return;

        case 'session/new': {
          const cwd = parseOptionalWorkspaceCwd(params, this.boundWorkspace);
          // ACP standard: session/new MUST create a new isolated session.
          // Always use sessionScope 'thread' regardless of client params.
          // The REST surface (POST /session) supports 'single' for
          // backward compat, but the ACP endpoint follows the standard.
          const session = await this.bridge.spawnOrAttach({
            workspaceCwd: cwd,
            clientId: conn.clientId,
            sessionScope: 'thread',
          });
          // Teardown raced the spawn: the connection was destroyed while the
          // bridge call was in flight, so nothing will tear this session down.
          // Kill the orphan (no other client could have attached yet).
          if (conn.destroyed) {
            this.killOrphanSession(session.sessionId);
            return;
          }
          conn.getOrCreateSession(session.sessionId).clientId =
            session.clientId;
          conn.ownSession(session.sessionId);
          const configOptions = await this.configOptionsFor(session.sessionId);
          if (conn.destroyed) {
            this.killOrphanSession(session.sessionId);
            return;
          }
          // Build ACP-standard models/modes from configOptions.
          // configOptions carry model/mode as category-tagged entries;
          // the standard also expects top-level models/modes objects.
          const models = this.extractModelState(configOptions);
          const modes = this.extractModeState(configOptions);
          this.replyConn(conn, id, {
            sessionId: session.sessionId,
            ...(configOptions ? { configOptions } : {}),
            ...(models ? { models } : {}),
            ...(modes ? { modes } : {}),
          });
          return;
        }

        case 'session/load':
        case 'session/resume': {
          const sessionId = String(params['sessionId'] ?? '');
          if (!sessionId) {
            if (id !== undefined) {
              conn.sendConn(
                error(id, RPC.INVALID_PARAMS, '`sessionId` is required'),
              );
            }
            return;
          }
          // Reject if a session/close for this id is in flight — otherwise the
          // close's `finally` teardown would destroy the session we're about
          // to load (TOCTOU). Client should retry after the close settles.
          if (conn.closingSessions.has(sessionId)) {
            if (id !== undefined) {
              // The client's params are valid — the rejection is a server-side
              // timing race against an in-flight close, so use INTERNAL_ERROR
              // (-32603), not INVALID_PARAMS, to signal a transient/retryable
              // condition rather than a permanent parameter fault.
              conn.sendConn(
                error(
                  id,
                  RPC.INTERNAL_ERROR,
                  `session ${sessionId} is being closed; retry`,
                ),
              );
            }
            return;
          }
          const cwd = parseOptionalWorkspaceCwd(params, this.boundWorkspace);
          const restored = await this.archiveCoordinator.runSharedMany(
            [sessionId],
            async () => {
              await assertSessionLoadable(cwd, sessionId);
              return method === 'session/load'
                ? await this.bridge.loadSession({
                    sessionId,
                    workspaceCwd: cwd,
                    clientId: conn.clientId,
                  })
                : await this.bridge.resumeSession({
                    sessionId,
                    workspaceCwd: cwd,
                    clientId: conn.clientId,
                  });
            },
          );
          // Teardown raced the restore — EITHER the whole connection was
          // destroyed (`conn.destroyed`) OR a `session/close` for this id
          // started DURING the await (`closingSessions`); in the latter the
          // close's `finally` teardown would destroy the binding we're about
          // to create. Both need the same cleanup; only the client reply
          // differs. Cleanup depends on what restore did:
          //  - attached:true  → detachClient rolls back just our attach.
          //  - attached:false → restore SPAWNED a fresh session from disk;
          //    detachClient only decrements attachCount and does NOT reap
          //    (reaping is the spawn-owner's job) — so kill it.
          const closeRaced = conn.closingSessions.has(sessionId);
          if (conn.destroyed || closeRaced) {
            const cleanup = restored.attached
              ? this.bridge.detachClient(sessionId, restored.clientId)
              : this.bridge.killSession(sessionId, {
                  requireZeroAttaches: true,
                });
            void cleanup.catch((err) =>
              writeStderrLine(
                `qwen serve: /acp orphan ${restored.attached ? 'detach' : 'kill'}(${logSafe(sessionId)}) teardown-race: ${logSafe(errMsg(err))}`,
              ),
            );
            // Connection-still-alive close race → tell the client to retry.
            // Same rationale as the pre-await guard: a transient server-side
            // race, so INTERNAL_ERROR (-32603), not INVALID_PARAMS.
            if (closeRaced && !conn.destroyed && id !== undefined) {
              conn.sendConn(
                error(
                  id,
                  RPC.INTERNAL_ERROR,
                  `session ${sessionId} was closed during load; retry`,
                ),
              );
            }
            return;
          }
          conn.getOrCreateSession(sessionId).clientId = restored.clientId;
          conn.ownSession(sessionId);
          // ACP standard: load/resume response includes configOptions + models + modes
          const loadConfigOptions = await this.configOptionsFor(sessionId);
          const loadModels = this.extractModelState(loadConfigOptions);
          const loadModes = this.extractModeState(loadConfigOptions);
          this.replyConn(conn, id, {
            ...(restored.state ?? {}),
            ...(loadConfigOptions ? { configOptions: loadConfigOptions } : {}),
            ...(loadModels ? { models: loadModels } : {}),
            ...(loadModes ? { modes: loadModes } : {}),
          });
          return;
        }

        case 'session/list': {
          const workspaceCwd = this.parseBoundWorkspaceParam(params);
          const cursor =
            typeof params['cursor'] === 'string' ? params['cursor'] : undefined;
          const rawView =
            typeof params['view'] === 'string' ? params['view'] : undefined;
          let view: 'organized' | undefined;
          if (rawView !== undefined) {
            if (rawView !== 'organized') {
              throw new AcpParamError('`view` must be "organized"');
            }
            view = rawView;
          }
          const group =
            typeof params['group'] === 'string' ? params['group'] : undefined;
          if (group !== undefined && view !== 'organized') {
            throw new AcpParamError(
              '`group` requires `view` to be "organized"',
            );
          }
          const meta = isObject(params['_meta']) ? params['_meta'] : undefined;
          const metaSize =
            typeof meta?.['size'] === 'number'
              ? (meta['size'] as number)
              : undefined;
          const rawArchiveState =
            typeof params['archiveState'] === 'string'
              ? params['archiveState']
              : typeof meta?.['archiveState'] === 'string'
                ? meta['archiveState']
                : undefined;
          let archiveState: SessionArchiveState | undefined;
          if (rawArchiveState !== undefined) {
            if (
              rawArchiveState !== 'active' &&
              rawArchiveState !== 'archived'
            ) {
              throw new AcpParamError(
                '`archiveState` must be "active" or "archived"',
              );
            }
            archiveState = rawArchiveState;
          }
          const result = await listWorkspaceSessionsForResponse(
            this.bridge,
            workspaceCwd,
            { cursor, size: metaSize, archiveState, view, group },
          );
          this.replyConn(conn, id, {
            sessions: result.sessions.map((s) => ({
              sessionId: s.sessionId,
              workspaceCwd: s.workspaceCwd,
              cwd: s.workspaceCwd,
              createdAt: s.createdAt,
              updatedAt: s.updatedAt,
              displayName: s.displayName,
              title: s.displayName,
              clientCount: s.clientCount,
              hasActivePrompt: s.hasActivePrompt,
              isArchived: s.isArchived === true,
              ...(s.isPinned !== undefined ? { isPinned: s.isPinned } : {}),
              ...(s.pinnedAt !== undefined ? { pinnedAt: s.pinnedAt } : {}),
              ...(s.groupId !== undefined ? { groupId: s.groupId } : {}),
            })),
            ...(result.nextCursor != null
              ? { nextCursor: result.nextCursor }
              : {}),
            ...(result.liveMergeFailed ? { liveMergeFailed: true } : {}),
          });
          return;
        }

        case 'session/close': {
          const sessionId = String(params['sessionId'] ?? '');
          if (!this.requireOwned(conn, sessionId, id)) return;
          // Close the ownership gate before the coordinator await so
          // concurrent closes from this connection cannot both reach the bridge.
          conn.ownedSessions.delete(sessionId);
          conn.closingSessions.add(sessionId);
          let closeStarted = false;
          const closeSession = async () => {
            closeStarted = true;
            try {
              await this.bridge.closeSession(
                sessionId,
                this.sessionCtx(conn, sessionId, loopback),
              );
            } finally {
              // Local teardown must run even if the bridge close throws —
              // otherwise the SSE stream, abort controller, buffered frames and
              // pending permissions leak until idle TTL.
              try {
                conn.closeSessionStream(sessionId);
              } catch (teardownErr) {
                writeStderrLine(
                  `qwen serve: /acp session/close local teardown failed (${logSafe(sessionId)}): ${logSafe(errMsg(teardownErr))}`,
                );
              }
            }
          };
          try {
            try {
              await this.archiveCoordinator.runExclusiveMany(
                [sessionId],
                closeSession,
              );
            } catch (err) {
              const promptAbort = conn.sessions.get(sessionId)?.promptAbort;
              if (
                err instanceof SessionArchivingError &&
                err.lockKind === 'shared' &&
                promptAbort !== undefined
              ) {
                await this.archiveCoordinator.runSharedMany(
                  [sessionId],
                  closeSession,
                );
              } else {
                throw err;
              }
            }
          } catch (err) {
            if (!closeStarted) {
              conn.ownedSessions.add(sessionId);
            }
            throw err;
          } finally {
            conn.closingSessions.delete(sessionId);
          }
          this.replyConn(conn, id, {});
          return;
        }

        // ACP standard: session/fork — create a branched copy of an existing
        // session. Maps to bridge.branchSession().
        case 'session/fork': {
          const sessionId = String(params['sessionId'] ?? '');
          if (!sessionId) {
            if (id !== undefined) {
              conn.sendConn(
                error(id, RPC.INVALID_PARAMS, '`sessionId` is required'),
              );
            }
            return;
          }
          await this.withMutableOwned(conn, sessionId, id, async () => {
            const ctx = this.sessionCtx(conn, sessionId, loopback);
            const result = await this.bridge.branchSession(
              sessionId,
              {
                name:
                  typeof params['name'] === 'string'
                    ? params['name']
                    : undefined,
              },
              ctx,
            );
            if (conn.destroyed) {
              this.killOrphanSession(result.sessionId);
              return;
            }
            conn.getOrCreateSession(result.sessionId).clientId =
              result.clientId;
            conn.ownSession(result.sessionId);
            const configOptions = await this.configOptionsFor(result.sessionId);
            const models = this.extractModelState(configOptions);
            const modes = this.extractModeState(configOptions);
            this.replyConn(conn, id, {
              sessionId: result.sessionId,
              ...(configOptions ? { configOptions } : {}),
              ...(models ? { models } : {}),
              ...(modes ? { modes } : {}),
            });
          });
          return;
        }

        case 'session/cancel': {
          const sessionId = String(params['sessionId'] ?? '');
          await this.withMutableOwned(conn, sessionId, id, async () => {
            // Abort our local in-flight prompt controller too — cancelSession
            // tells the agent to wind down, but the HTTP-side `sendPrompt`
            // await must also be released so the session FIFO unblocks.
            conn.sessions.get(sessionId)?.promptAbort?.abort();
            await this.bridge.cancelSession(
              sessionId,
              // Forward client-supplied cancel fields (reason/context) while
              // force-stamping sessionId — mirrors the REST surface.
              { ...params, sessionId } as Parameters<
                HttpAcpBridge['cancelSession']
              >[1],
              this.sessionCtx(conn, sessionId, loopback),
            );
            // `session/cancel` is normally a notification (no id), but answer
            // the request-form so a client that sent an id isn't left hanging.
            if (id !== undefined) this.replySession(conn, sessionId, id, {});
          });
          return;
        }

        case 'session/prompt': {
          const sessionId = String(params['sessionId'] ?? '');
          await this.withMutableOwned(conn, sessionId, id, async () => {
            validatePrompt(params);
            await this.handlePrompt(conn, sessionId, id, params, loopback);
          });
          return;
        }

        case 'session/permission': {
          const requestId =
            typeof params['requestId'] === 'string' ? params['requestId'] : '';
          if (!requestId) {
            // Every failure mode below logs to stderr: a stuck permission
            // prompt is otherwise undebuggable from the server side (the
            // legacy `resolveClientResponse` path logs its vote/cancel
            // failures the same way).
            writeStderrLine(
              `qwen serve: /acp session/permission rejected: \`requestId\` is required`,
            );
            if (id !== undefined) {
              conn.sendConn(
                error(id, RPC.INVALID_PARAMS, '`requestId` is required', {
                  httpStatus: 400,
                  requestId,
                }),
              );
            }
            return;
          }
          let response: PermissionResponse;
          try {
            response = parsePermissionResponse(params);
          } catch (err) {
            // Map the validation throw to a structured 400 here so it carries
            // the same `{ httpStatus }` envelope as every other error path in
            // this handler — the outer dispatcher catch would otherwise emit a
            // plain INVALID_PARAMS with no httpStatus for SDK callers.
            if (err instanceof AcpParamError) {
              writeStderrLine(
                `qwen serve: /acp session/permission invalid params (requestId ${logSafe(requestId)}): ${logSafe(err.message)}`,
              );
              if (id !== undefined) {
                conn.sendConn(
                  error(id, RPC.INVALID_PARAMS, err.message, {
                    httpStatus: 400,
                    requestId,
                  }),
                );
              }
              return;
            }
            throw err;
          }
          const sessionIdParam =
            typeof params['sessionId'] === 'string' &&
            params['sessionId'].length > 0
              ? params['sessionId']
              : undefined;
          // Look up by the globally-unique `requestId` alone, then validate
          // the client's `sessionId` against the pending entry instead of
          // trusting it for routing. A mismatched `sessionId` previously fell
          // through to `sessionIdParam`, which (a) routed `requireOwned` and
          // the bridge vote at the wrong session and (b) left the real pending
          // entry to leak until teardown. Reject the mismatch explicitly.
          const pendingRef = this.registry?.findPendingPermission(requestId);
          if (
            sessionIdParam &&
            pendingRef &&
            sessionIdParam !== pendingRef.req.sessionId
          ) {
            writeStderrLine(
              `qwen serve: /acp session/permission vote rejected: requestId ${logSafe(requestId)} does not belong to session ${logSafe(sessionIdParam)}`,
            );
            if (id !== undefined) {
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  'requestId does not belong to the specified session',
                  { httpStatus: 409, sessionId: sessionIdParam, requestId },
                ),
              );
            }
            return;
          }
          // Require a registry hit before voting when the registry is
          // available. In the scoped `session/permission` route `sessionIdParam`
          // is always set, so a miss (unknown/stale/already-resolved request)
          // must NOT fall through to `sessionIdParam` and the bridge — that
          // reports the bridge's `false` as a thrown 409, whereas
          // DaemonClient/REST treat a missing request as `404 → false` (not an
          // exception). Reserve 409 for a present entry the bridge still rejects.
          if (this.registry && !pendingRef) {
            writeStderrLine(
              `qwen serve: /acp session/permission vote dropped: no pending request for requestId ${logSafe(requestId)}`,
            );
            if (id !== undefined) {
              conn.sendConn(
                error(id, RPC.INVALID_PARAMS, 'No pending permission request', {
                  httpStatus: 404,
                  requestId,
                }),
              );
            }
            return;
          }
          // The pending entry's own session is authoritative; fall back to the
          // client's `sessionId` only when there is no registry to consult.
          const sessionId = pendingRef?.req.sessionId ?? sessionIdParam;
          if (!sessionId) {
            writeStderrLine(
              `qwen serve: /acp session/permission vote dropped: no pending request for requestId ${logSafe(requestId)}`,
            );
            if (id !== undefined) {
              conn.sendConn(
                error(id, RPC.INVALID_PARAMS, 'No pending permission request', {
                  httpStatus: 404,
                  requestId,
                }),
              );
            }
            return;
          }
          // Inline ownership check (not the shared `requireOwned`) so the
          // rejection carries the same `{ httpStatus }` envelope as every other
          // error path in this handler — SDK callers classify permission-vote
          // failures by `error.data.httpStatus`, and this is the likeliest
          // cross-connection failure (right session header, no `session/new` on
          // this connection).
          if (!conn.ownsSession(sessionId)) {
            writeStderrLine(
              `qwen serve: /acp session/permission vote rejected: session ${logSafe(sessionId)} not owned by this connection (requestId ${logSafe(requestId)})`,
            );
            if (id !== undefined) {
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  'Session not owned by this connection',
                  { httpStatus: 403, sessionId, requestId },
                ),
              );
            }
            return;
          }
          let accepted: boolean;
          try {
            accepted = this.bridge.respondToSessionPermission(
              sessionId,
              requestId,
              response,
              this.sessionCtx(conn, sessionId, loopback),
            );
          } catch (err) {
            // Mirror REST's `sendPermissionVoteError` so ACP SDK callers get the
            // same shapes for normal permission outcomes instead of a generic
            // internal error from the outer dispatcher catch: a forged optionId
            // is a 400 (the requestId is known, the option isn't), a
            // policy-denied vote is a 403 (well-formed, authenticated, refused).
            if (err instanceof InvalidPermissionOptionError) {
              writeStderrLine(
                `qwen serve: /acp session/permission invalid option (${logSafe(sessionId)}, requestId ${logSafe(requestId)}): ${logSafe(err.message)}`,
              );
              if (id !== undefined) {
                conn.sendConn(
                  error(id, RPC.INVALID_PARAMS, err.message, {
                    httpStatus: 400,
                    code: 'invalid_option_id',
                    requestId: err.requestId,
                    optionId: err.optionId,
                  }),
                );
              }
              return;
            }
            if (err instanceof PermissionForbiddenError) {
              writeStderrLine(
                `qwen serve: /acp session/permission forbidden (${logSafe(sessionId)}, requestId ${logSafe(requestId)}): ${logSafe(err.message)}`,
              );
              if (id !== undefined) {
                conn.sendConn(
                  error(id, RPC.INVALID_PARAMS, err.message, {
                    httpStatus: 403,
                    code: 'permission_forbidden',
                    requestId: err.requestId,
                    sessionId: err.sessionId,
                    reason: err.reason,
                  }),
                );
              }
              return;
            }
            if (err instanceof PermissionPolicyNotImplementedError) {
              // Operator's settings name a policy whose mediator hasn't landed
              // in this build. 501 (not 500) so the SDK can say "daemon older
              // than your settings expect; upgrade".
              writeStderrLine(
                `qwen serve: /acp session/permission policy not implemented (${logSafe(sessionId)}, requestId ${logSafe(requestId)}): ${logSafe(err.message)}`,
              );
              if (id !== undefined) {
                conn.sendConn(
                  error(id, RPC.INTERNAL_ERROR, err.message, {
                    httpStatus: 501,
                    code: 'permission_policy_not_implemented',
                    policy: err.policy,
                  }),
                );
              }
              return;
            }
            if (err instanceof CancelSentinelCollisionError) {
              // Agent/daemon contract violation (agent's option set includes
              // the cancel sentinel), not a client mistake — 500 with a stable
              // code so the SDK can distinguish it from unrelated internals.
              writeStderrLine(
                `qwen serve: /acp session/permission cancel-sentinel collision (${logSafe(sessionId)}, requestId ${logSafe(requestId)}): ${logSafe(err.message)}`,
              );
              if (id !== undefined) {
                conn.sendConn(
                  error(id, RPC.INTERNAL_ERROR, err.message, {
                    httpStatus: 500,
                    code: 'cancel_sentinel_collision',
                    requestId: err.requestId,
                    sentinel: err.sentinel,
                  }),
                );
              }
              return;
            }
            // Truly unexpected bridge/sessionCtx failure: the mediator may be
            // left blocking the agent's prompt. Mirror the legacy
            // `resolveClientResponse` path — cancel as a fallback (dropping the
            // entry only if the cancel landed, else keep it for teardown to
            // retry) — then rethrow so the outer dispatcher catch maps the
            // error for the wire.
            writeStderrLine(
              `qwen serve: /acp session/permission vote failed (${logSafe(sessionId)}, requestId ${logSafe(requestId)}): ${logSafe(errMsg(err))}`,
            );
            const cancelled = this.cancelAbandonedPermission(
              { sessionId, bridgeRequestId: requestId },
              pendingRef?.conn.sessions.get(sessionId)?.clientId,
            );
            // Drop only the VOTING connection's own entry (consistent with the
            // success path) — never `pendingRef`, which may be a sibling/the
            // originator. Deleting the originator's entry would stall a quorum
            // still waiting on its vote. If the voter has no own entry, leave
            // everything for teardown.
            if (cancelled) {
              this.dropOwnPendingPermission(conn, requestId);
            }
            throw err;
          }
          if (!accepted) {
            // The bridge mediator had no outstanding request to resolve
            // (already voted/cancelled — e.g. a duplicate or racing vote).
            // Do NOT delete the registry entry here: matching the legacy
            // `resolveClientResponse` contract, keep it until teardown's
            // `abandonPendingForSession` releases the mediator. Deleting now
            // would (a) conflate "no pending entry" with "bridge rejected a
            // present vote" and (b) make a legitimate retry on another
            // connection fail with a misleading "no pending" error.
            writeStderrLine(
              `qwen serve: /acp session/permission vote not accepted by bridge (${logSafe(sessionId)}, requestId ${logSafe(requestId)})`,
            );
            if (id !== undefined) {
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  'Permission vote not accepted (request already resolved)',
                  {
                    httpStatus: 409,
                    sessionId,
                    requestId,
                  },
                ),
              );
            }
            return;
          }
          // Drop ONLY the voting connection's own pending entry for this
          // request — never the first registry-wide match (`pendingRef`), which
          // may belong to a sibling connection. Under the consensus policy
          // `respondToSessionPermission` returns true for an intermediate
          // "recorded" vote, so deleting a sibling's entry here would drop a
          // co-owner's still-needed outbound request and could stall the quorum
          // until timeout/teardown. A cross-connection voter that never streamed
          // the request has no own entry — leave the originator's for teardown.
          this.dropOwnPendingPermission(conn, requestId);
          // Log the success too (every failure branch logs): an operator
          // grepping a stuck prompt can then tell "vote accepted here" apart
          // from "vote never arrived" or "vote landed on another connection".
          writeStderrLine(
            `qwen serve: /acp session/permission vote accepted (${logSafe(sessionId)}, requestId ${logSafe(requestId)}, connection ${logSafe(conn.connectionId.slice(0, 8))})`,
          );
          this.replyConn(conn, id, {});
          return;
        }

        // STANDARD method (SDK 0.14.1, non-`unstable_`): model + mode live
        // here under categories `model`/`mode`, routed to the existing bridge
        // setters. Replaces the old vendor `_qwen/session/set_model`.
        case 'session/set_config_option': {
          const sessionId = String(params['sessionId'] ?? '');
          await this.withMutableOwned(conn, sessionId, id, async () => {
            const configId = String(params['configId'] ?? '');
            const rawValue = params['value'];
            const ctx = this.sessionCtx(conn, sessionId, loopback);
            // Validate value at the boundary like REST (empty/null is rejected
            // rather than forwarded as "" to the bridge).
            if (typeof rawValue !== 'string' || rawValue.length === 0) {
              if (id !== undefined) {
                this.replySession(
                  conn,
                  sessionId,
                  id,
                  undefined,
                  error(
                    id,
                    RPC.INVALID_PARAMS,
                    '`value` must be a non-empty string',
                  ),
                );
              }
              return;
            }
            if (configId === 'model') {
              await this.bridge.setSessionModel(
                sessionId,
                { modelId: rawValue } as unknown as Parameters<
                  HttpAcpBridge['setSessionModel']
                >[1],
                ctx,
              );
            } else if (configId === 'mode') {
              if (!APPROVAL_MODES.includes(rawValue as ApprovalMode)) {
                if (id !== undefined) {
                  this.replySession(
                    conn,
                    sessionId,
                    id,
                    undefined,
                    error(
                      id,
                      RPC.INVALID_PARAMS,
                      `invalid mode "${rawValue}" (expected one of: ${APPROVAL_MODES.join(', ')})`,
                    ),
                  );
                }
                return;
              }
              await this.bridge.setSessionApprovalMode(
                sessionId,
                rawValue as ApprovalMode,
                { persist: params['persist'] === true },
                ctx,
              );
            } else {
              if (id !== undefined) {
                this.replySession(
                  conn,
                  sessionId,
                  id,
                  undefined,
                  error(
                    id,
                    RPC.INVALID_PARAMS,
                    `Unknown configId: ${configId}`,
                  ),
                );
              }
              return;
            }
            // Response returns the updated config option set (per ACP).
            const configOptions = await this.configOptionsFor(sessionId);
            this.replySession(conn, sessionId, id, { configOptions });
          });
          return;
        }

        // ACP standard: session/set_mode — dedicated method for mode changes.
        // Maps to the same bridge call as set_config_option with configId='mode'.
        case 'session/set_mode': {
          const sessionId = String(params['sessionId'] ?? '');
          if (!sessionId) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INVALID_PARAMS, '`sessionId` is required'),
              );
            return;
          }
          await this.withMutableOwned(conn, sessionId, id, async () => {
            const modeId = String(params['modeId'] ?? '');
            if (!modeId || !APPROVAL_MODES.includes(modeId as ApprovalMode)) {
              if (id !== undefined) {
                this.replySession(
                  conn,
                  sessionId,
                  id,
                  undefined,
                  error(
                    id,
                    RPC.INVALID_PARAMS,
                    `invalid modeId "${modeId}" (expected one of: ${APPROVAL_MODES.join(', ')})`,
                  ),
                );
              }
              return;
            }
            const ctx = this.sessionCtx(conn, sessionId, loopback);
            await this.bridge.setSessionApprovalMode(
              sessionId,
              modeId as ApprovalMode,
              { persist: false },
              ctx,
            );
            this.replySession(conn, sessionId, id, {});
          });
          return;
        }

        // ACP standard (unstable): session/set_model — dedicated method for
        // model changes. Maps to the same bridge call as set_config_option
        // with configId='model'.
        case 'session/set_model': {
          const sessionId = String(params['sessionId'] ?? '');
          if (!sessionId) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INVALID_PARAMS, '`sessionId` is required'),
              );
            return;
          }
          await this.withMutableOwned(conn, sessionId, id, async () => {
            const modelId = String(params['modelId'] ?? '');
            if (!modelId) {
              if (id !== undefined) {
                this.replySession(
                  conn,
                  sessionId,
                  id,
                  undefined,
                  error(id, RPC.INVALID_PARAMS, '`modelId` is required'),
                );
              }
              return;
            }
            const ctx = this.sessionCtx(conn, sessionId, loopback);
            await this.bridge.setSessionModel(
              sessionId,
              { modelId, sessionId },
              ctx,
            );
            this.replySession(conn, sessionId, id, {});
          });
          return;
        }

        case `${QWEN_METHOD_NS}session/heartbeat`: {
          const sessionId = String(params['sessionId'] ?? '');
          if (!this.requireOwned(conn, sessionId, id)) return;
          const result = this.bridge.recordHeartbeat(
            sessionId,
            this.sessionCtx(conn, sessionId, loopback),
          );
          this.replyConn(conn, id, result as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}session/context`: {
          const sessionId = String(params['sessionId'] ?? '');
          if (!this.requireOwned(conn, sessionId, id)) return;
          this.replyConn(
            conn,
            id,
            await this.bridge.getSessionContextStatus(sessionId),
          );
          return;
        }

        case `${QWEN_METHOD_NS}session/supported_commands`: {
          const sessionId = String(params['sessionId'] ?? '');
          if (!this.requireOwned(conn, sessionId, id)) return;
          this.replyConn(
            conn,
            id,
            await this.bridge.getSessionSupportedCommandsStatus(sessionId),
          );
          return;
        }

        case `${QWEN_METHOD_NS}session/update_metadata`: {
          const sessionId = String(params['sessionId'] ?? '');
          await this.withMutableOwned(conn, sessionId, id, async () => {
            const metadata = isObject(params['metadata'])
              ? (params['metadata'] as Record<string, unknown>)
              : {};
            const result = this.bridge.updateSessionMetadata(
              sessionId,
              metadata as unknown as Parameters<
                HttpAcpBridge['updateSessionMetadata']
              >[1],
              this.sessionCtx(conn, sessionId, loopback),
            );
            this.replyConn(conn, id, result as unknown);
          });
          return;
        }

        case `${QWEN_METHOD_NS}session/update_organization`: {
          const sessionId = String(params['sessionId'] ?? '');
          if (!sessionId) {
            throw new AcpParamError('`sessionId` is required');
          }
          // Organization is workspace-scoped UI state. It can target persisted or
          // archived sessions without a live ACP owner, matching the REST route.
          if ('isPinned' in params && typeof params['isPinned'] !== 'boolean') {
            throw new AcpParamError('`isPinned` must be a boolean');
          }
          if (
            'groupId' in params &&
            params['groupId'] !== null &&
            typeof params['groupId'] !== 'string'
          ) {
            throw new AcpParamError('`groupId` must be a string or null');
          }
          await this.archiveCoordinator.runSharedMany([sessionId], async () => {
            const sessionService = new SessionService(this.boundWorkspace);
            let exists =
              await sessionService.sessionExistsInAnyState(sessionId);
            if (!exists) {
              try {
                const liveSummary = this.bridge.getSessionSummary(sessionId);
                exists = liveSummary.workspaceCwd === this.boundWorkspace;
              } catch {
                exists = false;
              }
            }
            if (!exists) {
              throw new AcpParamError(`Session not found: ${sessionId}`);
            }
            const organization = await createSessionOrganizationService(
              this.boundWorkspace,
            ).updateSessionOrganization(sessionId, {
              ...(typeof params['isPinned'] === 'boolean'
                ? { isPinned: params['isPinned'] }
                : {}),
              ...('groupId' in params
                ? { groupId: params['groupId'] as string | null }
                : {}),
            });
            this.replyConn(conn, id, { sessionId, ...organization });
          });
          return;
        }

        case `${QWEN_METHOD_NS}workspace/session_groups/list`: {
          const workspaceCwd = this.parseBoundWorkspaceParam(params);
          const groups =
            await createSessionOrganizationService(workspaceCwd).listGroups();
          this.replyConn(conn, id, groups);
          return;
        }

        case `${QWEN_METHOD_NS}workspace/session_groups/create`: {
          const workspaceCwd = this.parseBoundWorkspaceParam(params);
          const group = await createSessionOrganizationService(
            workspaceCwd,
          ).createGroup({
            name: params['name'] as string,
            color: params['color'] as SessionGroupColor,
          });
          this.replyConn(conn, id, { group });
          return;
        }

        case `${QWEN_METHOD_NS}workspace/session_groups/update`: {
          const workspaceCwd = this.parseBoundWorkspaceParam(params);
          const groupId = String(params['groupId'] ?? '');
          if (!groupId) {
            throw new AcpParamError('`groupId` is required');
          }
          const group = await createSessionOrganizationService(
            workspaceCwd,
          ).updateGroup(groupId, {
            ...('name' in params ? { name: params['name'] as string } : {}),
            ...('color' in params
              ? { color: params['color'] as SessionGroupColor }
              : {}),
            ...('order' in params ? { order: params['order'] as number } : {}),
          });
          this.replyConn(conn, id, { group });
          return;
        }

        case `${QWEN_METHOD_NS}workspace/session_groups/delete`: {
          const workspaceCwd = this.parseBoundWorkspaceParam(params);
          const groupId = String(params['groupId'] ?? '');
          if (!groupId) {
            throw new AcpParamError('`groupId` is required');
          }
          const deleted =
            await createSessionOrganizationService(workspaceCwd).deleteGroup(
              groupId,
            );
          this.replyConn(conn, id, { deleted });
          return;
        }

        case `${QWEN_METHOD_NS}workspace/mcp`:
          this.replyConn(
            conn,
            id,
            await this.workspace.getWorkspaceMcpStatus(
              this.wsCtx(conn, method),
            ),
          );
          return;
        case `${QWEN_METHOD_NS}workspace/skills`:
          this.replyConn(
            conn,
            id,
            await this.workspace.getWorkspaceSkillsStatus(
              this.wsCtx(conn, method),
            ),
          );
          return;
        case `${QWEN_METHOD_NS}workspace/providers`:
          this.replyConn(
            conn,
            id,
            await this.workspace.getWorkspaceProvidersStatus(
              this.wsCtx(conn, method),
            ),
          );
          return;
        case `${QWEN_METHOD_NS}workspace/env`:
          this.replyConn(
            conn,
            id,
            await this.workspace.getWorkspaceEnvStatus(
              this.wsCtx(conn, method),
            ),
          );
          return;
        case `${QWEN_METHOD_NS}workspace/preflight`:
          this.replyConn(
            conn,
            id,
            await this.workspace.getWorkspacePreflightStatus(
              this.wsCtx(conn, method),
            ),
          );
          return;

        case `${QWEN_METHOD_NS}workspace/init`: {
          const rawForce = params['force'];
          if (rawForce !== undefined && typeof rawForce !== 'boolean') {
            if (id !== undefined) {
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  '`force` must be a boolean when provided',
                ),
              );
            }
            return;
          }
          const force = rawForce === true;
          const result = await this.workspace.initWorkspace(
            this.wsCtx(conn, method),
            { force },
          );
          this.replyConn(conn, id, result as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}workspace/trust`: {
          const result = await this.workspace.getWorkspaceTrustStatus(
            this.wsCtx(conn, method),
          );
          this.replyConn(conn, id, result as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}workspace/trust/request`: {
          const desiredState = params['desiredState'];
          if (desiredState !== 'trusted' && desiredState !== 'untrusted') {
            if (id !== undefined) {
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  '`desiredState` must be "trusted" or "untrusted"',
                ),
              );
            }
            return;
          }
          const reason = params['reason'];
          if (
            reason !== undefined &&
            (typeof reason !== 'string' ||
              reason.length > MAX_TRUST_REASON_LENGTH)
          ) {
            if (id !== undefined) {
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  `\`reason\` must be a string up to ${MAX_TRUST_REASON_LENGTH} chars`,
                ),
              );
            }
            return;
          }
          const ctx = this.wsCtx(conn, method);
          const status = await this.workspace.getWorkspaceTrustStatus(ctx);
          if (!status.folderTrustEnabled) {
            if (id !== undefined) {
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_REQUEST,
                  'Folder trust is disabled for this workspace',
                ),
              );
            }
            return;
          }
          const result = await this.workspace.requestWorkspaceTrustChange(ctx, {
            desiredState,
            ...(reason !== undefined ? { reason } : {}),
          });
          this.replyConn(conn, id, result as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}workspace/permissions`: {
          const result = await this.workspace.getWorkspacePermissionsStatus(
            this.wsCtx(conn, method),
          );
          this.replyConn(conn, id, result as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}workspace/permissions/set`: {
          const scope = params['scope'];
          if (scope !== 'user' && scope !== 'workspace') {
            if (id !== undefined) {
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  '`scope` must be "user" or "workspace"',
                ),
              );
            }
            return;
          }

          const ruleType = params['ruleType'];
          if (!isPermissionRuleType(ruleType)) {
            if (id !== undefined) {
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  '`ruleType` must be "allow", "ask", or "deny"',
                ),
              );
            }
            return;
          }

          let rules: string[];
          try {
            const settings = loadSettings(this.boundWorkspace);
            const scopeSettings =
              scope === 'workspace'
                ? settings.workspace.settings
                : settings.user.settings;
            const existingRules =
              readPermissionRuleSet(scopeSettings)[ruleType];
            rules = normalizePermissionRules(params['rules'], {
              existingRules,
            });
          } catch (err) {
            if (err instanceof PermissionRulesValidationError) {
              if (id !== undefined) {
                conn.sendConn(error(id, RPC.INVALID_PARAMS, err.message));
              }
              return;
            }
            throw err;
          }

          let result: unknown;
          try {
            result = await this.workspace.setWorkspacePermissionRules(
              this.wsCtx(conn, method),
              { scope, ruleType, rules },
            );
          } catch (err) {
            if (
              err instanceof WorkspacePermissionRulesSessionRequiredError &&
              id !== undefined
            ) {
              conn.sendConn(
                error(id, RPC.INVALID_PARAMS, err.message, {
                  errorKind: 'permission_session_required',
                }),
              );
              return;
            }
            throw err;
          }
          this.replyConn(conn, id, result as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}workspace/voice`: {
          const result = await this.workspace.getWorkspaceVoiceStatus(
            this.wsCtx(conn, method),
          );
          this.replyConn(conn, id, result as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}workspace/voice/set`: {
          const update = parseWorkspaceVoiceUpdateParams(params);
          if ('error' in update) {
            if (id !== undefined) {
              conn.sendConn(error(id, RPC.INVALID_PARAMS, update.error));
            }
            return;
          }

          const result = await this.workspace.setWorkspaceVoiceSettings(
            this.wsCtx(conn, method),
            update,
          );
          this.replyConn(conn, id, result as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}workspace/setup-github`: {
          if (params['consent'] !== true) {
            if (id !== undefined) {
              conn.sendConn(
                error(id, RPC.INVALID_PARAMS, '`consent` must be true', {
                  errorKind: 'github_setup_consent_required',
                }),
              );
            }
            return;
          }
          if (!this.fsFactory) {
            if (id !== undefined) {
              conn.sendConn(
                error(id, RPC.INTERNAL_ERROR, 'File system not configured', {
                  errorKind: 'internal_error',
                }),
              );
            }
            return;
          }
          try {
            const result = await setupGithub({
              cwd: this.boundWorkspace,
              workspaceRoot: this.boundWorkspace,
              proxy: resolveSetupGithubProxy(this.boundWorkspace),
              abortSignal: conn.abortSignal,
              fileOps: createSetupGithubFileOps(
                this.fsFactory,
                `ACP ${method}`,
                conn.clientId,
              ),
            });
            this.bridge.publishWorkspaceEvent({
              type: 'github_setup_completed',
              data: setupGithubEventData(result),
              ...(conn.clientId ? { originatorClientId: conn.clientId } : {}),
            } as BridgeEvent);
            this.replyConn(conn, id, result as unknown);
          } catch (err) {
            if (err instanceof SetupGithubError && id !== undefined) {
              conn.sendConn(
                error(
                  id,
                  err.status >= 500 ? RPC.INTERNAL_ERROR : RPC.INVALID_PARAMS,
                  sanitizeSetupGithubMessage(err.message, this.boundWorkspace),
                  {
                    errorKind: err.code,
                    ...(err.partial
                      ? {
                          partial: true,
                          result: err.partialResult
                            ? sanitizeSetupGithubResult(
                                err.partialResult,
                                this.boundWorkspace,
                              )
                            : null,
                        }
                      : {}),
                  },
                ),
              );
              return;
            }
            throw err;
          }
          return;
        }

        case `${QWEN_METHOD_NS}workspace/set_tool_enabled`: {
          const toolName = String(params['toolName'] ?? '');
          if (!toolName || toolName.length > MAX_NAME_LENGTH) {
            if (id !== undefined) {
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  `\`toolName\` is required and must be ≤ ${MAX_NAME_LENGTH} chars`,
                ),
              );
            }
            return;
          }
          const result = await this.workspace.setWorkspaceToolEnabled(
            this.wsCtx(conn, method),
            toolName,
            params['enabled'] === true,
          );
          this.replyConn(conn, id, result as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}workspace/restart_mcp_server`: {
          const serverName = String(params['serverName'] ?? '');
          if (!serverName || serverName.length > MAX_NAME_LENGTH) {
            if (id !== undefined) {
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  `\`serverName\` is required and must be ≤ ${MAX_NAME_LENGTH} chars`,
                ),
              );
            }
            return;
          }
          const rawIdx = params['entryIndex'];
          if (
            rawIdx !== undefined &&
            (typeof rawIdx !== 'number' ||
              !Number.isInteger(rawIdx) ||
              rawIdx < 0)
          ) {
            if (id !== undefined) {
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  '`entryIndex` must be a non-negative integer',
                ),
              );
            }
            return;
          }
          const result = await this.workspace.restartMcpServer(
            this.wsCtx(conn, method),
            serverName,
            rawIdx !== undefined ? { entryIndex: rawIdx } : undefined,
          );
          this.replyConn(conn, id, result as unknown);
          return;
        }

        // ── Wave 1+2: ACP/REST parity methods ───────────────────────

        case `${QWEN_METHOD_NS}session/recap`: {
          const sessionId = String(params['sessionId'] ?? '');
          await this.withMutableOwned(conn, sessionId, id, async () => {
            const result = await this.bridge.generateSessionRecap(
              sessionId,
              this.sessionCtx(conn, sessionId, loopback),
            );
            this.replyConn(conn, id, result as unknown);
          });
          return;
        }

        case `${QWEN_METHOD_NS}session/btw`: {
          const sessionId = String(params['sessionId'] ?? '');
          await this.withMutableOwned(conn, sessionId, id, async () => {
            const rawQ = params['question'];
            if (
              typeof rawQ !== 'string' ||
              rawQ.trim().length === 0 ||
              rawQ.length > BTW_MAX_INPUT_LENGTH
            ) {
              if (id !== undefined)
                conn.sendConn(
                  error(
                    id,
                    RPC.INVALID_PARAMS,
                    `\`question\` required, non-empty, max ${BTW_MAX_INPUT_LENGTH} chars`,
                  ),
                );
              return;
            }
            const result = await this.bridge.generateSessionBtw(
              sessionId,
              rawQ.trim(),
              undefined,
              this.sessionCtx(conn, sessionId, loopback),
            );
            this.replyConn(conn, id, result as unknown);
          });
          return;
        }

        case `${QWEN_METHOD_NS}session/shell`: {
          const sessionId = String(params['sessionId'] ?? '');
          if (!this.sessionShellCommandEnabled) {
            if (id !== undefined) {
              conn.sendConn(rpcErrorFrame(id, new SessionShellDisabledError()));
            }
            return;
          }
          await this.withMutableOwned(conn, sessionId, id, async () => {
            const binding = conn.sessions.get(sessionId);
            const clientId = binding?.clientId;
            if (!clientId) {
              if (id !== undefined) {
                conn.sendConn(
                  rpcErrorFrame(id, new SessionShellClientRequiredError()),
                );
              }
              return;
            }
            const rawCmd = params['command'];
            if (typeof rawCmd !== 'string' || rawCmd.trim().length === 0) {
              if (id !== undefined)
                conn.sendConn(
                  error(
                    id,
                    RPC.INVALID_PARAMS,
                    '`command` required and must be non-empty',
                  ),
                );
              return;
            }

            const logSessionId = logSafe(sessionId.slice(0, 8));
            const logClientId = logSafe(String(conn.clientId?.slice(0, 8)));
            const logCommand = logSafe(rawCmd.slice(0, 120));
            writeStderrLine(
              `qwen serve: /acp session/shell session=${logSessionId} client=${logClientId} cmd=${logCommand}`,
            );
            const result = await this.bridge.executeShellCommand(
              sessionId,
              rawCmd,
              binding.abort.signal,
              this.sessionCtx(conn, sessionId, loopback),
            );
            this.replyConn(conn, id, result as unknown);
          });
          return;
        }

        case `${QWEN_METHOD_NS}session/detach`: {
          const sessionId = String(params['sessionId'] ?? '');
          await this.withMutableOwned(conn, sessionId, id, async () => {
            const ctx = this.sessionCtx(conn, sessionId, loopback);
            await this.bridge.detachClient(sessionId, ctx.clientId);
            this.replyConn(conn, id, { ok: true });
          });
          return;
        }

        case `${QWEN_METHOD_NS}session/context_usage`: {
          const sessionId = String(params['sessionId'] ?? '');
          if (!this.requireOwned(conn, sessionId, id)) return;
          const result = await this.bridge.getSessionContextUsageStatus(
            sessionId,
            { detail: params['detail'] === true },
          );
          this.replyConn(conn, id, result as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}session/tasks`: {
          const sessionId = String(params['sessionId'] ?? '');
          if (!this.requireOwned(conn, sessionId, id)) return;
          const result = await this.bridge.getSessionTasksStatus(sessionId);
          this.replyConn(conn, id, result as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}session/lsp`: {
          const sessionId = String(params['sessionId'] ?? '');
          if (!this.requireOwned(conn, sessionId, id)) return;
          const result = await this.bridge.getSessionLspStatus(sessionId);
          this.replyConn(conn, id, result as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}session/artifacts`: {
          const sessionId = String(params['sessionId'] ?? '');
          if (!this.requireOwned(conn, sessionId, id)) return;
          const result = await this.bridge.getSessionArtifacts(sessionId);
          this.replyConn(conn, id, result as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}session/artifacts/add`: {
          const sessionId = String(params['sessionId'] ?? '');
          await this.withMutableOwned(conn, sessionId, id, async () => {
            const result = await this.bridge.addSessionArtifact(
              sessionId,
              pickSessionArtifactInput(params),
              this.sessionCtx(conn, sessionId, loopback),
            );
            this.replyConn(conn, id, result as unknown);
          });
          return;
        }

        case `${QWEN_METHOD_NS}session/artifacts/remove`: {
          const sessionId = String(params['sessionId'] ?? '');
          await this.withMutableOwned(conn, sessionId, id, async () => {
            const artifactId = String(params['artifactId'] ?? '');
            if (!artifactId) {
              if (id !== undefined) {
                conn.sendConn(
                  error(id, RPC.INVALID_PARAMS, '`artifactId` is required'),
                );
              }
              return;
            }
            const result = await this.bridge.removeSessionArtifact(
              sessionId,
              artifactId,
              this.sessionCtx(conn, sessionId, loopback),
            );
            this.replyConn(conn, id, result as unknown);
          });
          return;
        }

        case `${QWEN_METHOD_NS}workspace/memory`: {
          const result = await collectWorkspaceMemoryStatus(
            this.boundWorkspace,
          );
          this.replyConn(conn, id, result as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}workspace/memory/write`: {
          const content = params['content'];
          if (typeof content !== 'string') {
            if (id !== undefined)
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  '`content` required, must be string',
                ),
              );
            return;
          }
          if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INVALID_PARAMS, '`content` exceeds 1MB limit'),
              );
            return;
          }
          const rawScope = params['scope'];
          if (
            rawScope !== undefined &&
            rawScope !== 'workspace' &&
            rawScope !== 'global'
          ) {
            if (id !== undefined)
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  '`scope` must be "workspace" or "global"',
                ),
              );
            return;
          }
          const scope = (rawScope as 'workspace' | 'global') ?? 'workspace';
          const rawMode = params['mode'];
          if (
            rawMode !== undefined &&
            rawMode !== 'append' &&
            rawMode !== 'replace'
          ) {
            if (id !== undefined)
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  '`mode` must be "append" or "replace"',
                ),
              );
            return;
          }
          const mode = (rawMode as 'append' | 'replace') ?? 'append';
          writeStderrLine(
            `qwen serve: /acp workspace/memory/write scope=${scope} mode=${mode} client=${conn.clientId?.slice(0, 8)} bytes=${Buffer.byteLength(content, 'utf8')}`,
          );
          const wr = await writeWorkspaceContextFile({
            scope,
            mode,
            content,
            projectRoot: this.boundWorkspace,
          });
          this.replyConn(conn, id, {
            ok: true,
            filePath: wr.filePath,
            bytesWritten: wr.bytesWritten,
            changed: wr.changed,
          });
          if (wr.changed) {
            try {
              this.bridge.publishWorkspaceEvent({
                type: 'memory_changed',
                data: {
                  scope,
                  filePath: wr.filePath,
                  mode,
                  bytesWritten: wr.bytesWritten,
                },
                originatorClientId: conn.clientId,
              });
            } catch {
              /* best-effort */
            }
          }
          return;
        }

        case `${QWEN_METHOD_NS}workspace/memory/remember`: {
          const content = params['content'];
          if (typeof content !== 'string' || !content.trim()) {
            if (id !== undefined) {
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  '`content` must be a non-empty string',
                ),
              );
            }
            return;
          }
          if (Buffer.byteLength(content, 'utf8') > MAX_REMEMBER_CONTENT_BYTES) {
            if (id !== undefined) {
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  `\`content\` exceeds the ${MAX_REMEMBER_CONTENT_BYTES}-byte limit`,
                ),
              );
            }
            return;
          }
          const rawContextMode = params['contextMode'] ?? 'workspace';
          if (rawContextMode !== 'workspace' && rawContextMode !== 'clean') {
            if (id !== undefined) {
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  '`contextMode` must be "workspace", "clean", or omitted',
                ),
              );
            }
            return;
          }
          try {
            const available =
              await this.bridge.isWorkspaceMemoryRememberAvailable();
            if (!available) {
              if (id !== undefined) {
                conn.sendConn(
                  error(
                    id,
                    -32009,
                    'Managed memory is unavailable for this daemon workspace',
                    {
                      errorKind: 'managed_memory_unavailable',
                      httpStatus: 409,
                    },
                  ),
                );
              }
              return;
            }
            const task = this.workspaceRememberLane.enqueue({
              content: content.trim(),
              contextMode: rawContextMode,
              ...(conn.clientId ? { originatorClientId: conn.clientId } : {}),
            });
            this.replyConn(conn, id, task);
          } catch (err) {
            const code = extractRememberErrorCode(err);
            if (id !== undefined) {
              conn.sendConn(
                error(id, -32099, publicErrorMessage(code, 'remember'), {
                  errorKind: code,
                  httpStatus: publicErrorStatus(code),
                }),
              );
            } else {
              debugLogger.warn(
                'workspace memory remember notification failed:',
                err,
              );
            }
          }
          return;
        }

        case `${QWEN_METHOD_NS}workspace/memory/remember/get`: {
          const taskId = params['taskId'];
          if (typeof taskId !== 'string' || taskId.length === 0) {
            if (id !== undefined) {
              conn.sendConn(error(id, RPC.INVALID_PARAMS, '`taskId` required'));
            }
            return;
          }
          const task = this.workspaceRememberLane.get(
            taskId,
            conn.clientId,
            'remember',
          );
          if (!task) {
            if (id !== undefined) {
              conn.sendConn(
                error(id, -32004, 'Workspace memory remember task not found', {
                  errorKind: 'remember_task_not_found',
                  httpStatus: 404,
                }),
              );
            }
            return;
          }
          this.replyConn(conn, id, task);
          return;
        }

        case `${QWEN_METHOD_NS}workspace/memory/forget`: {
          const query = params['query'];
          const trimmedQuery = typeof query === 'string' ? query.trim() : '';
          if (!trimmedQuery) {
            if (id !== undefined) {
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  '`query` must be a non-empty string',
                ),
              );
            }
            return;
          }
          if (
            Buffer.byteLength(trimmedQuery, 'utf8') > MAX_REMEMBER_CONTENT_BYTES
          ) {
            if (id !== undefined) {
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  `\`query\` exceeds the ${MAX_REMEMBER_CONTENT_BYTES}-byte limit`,
                ),
              );
            }
            return;
          }
          try {
            const available =
              await this.bridge.isWorkspaceMemoryRememberAvailable();
            if (!available) {
              if (id !== undefined) {
                conn.sendConn(
                  error(
                    id,
                    -32009,
                    'Managed memory is unavailable for this daemon workspace',
                    {
                      errorKind: 'managed_memory_unavailable',
                      httpStatus: 409,
                    },
                  ),
                );
              }
              return;
            }
            const task = this.workspaceRememberLane.enqueueForget({
              query: trimmedQuery,
              ...(conn.clientId ? { originatorClientId: conn.clientId } : {}),
            });
            this.replyConn(conn, id, task);
          } catch (err) {
            const code = extractRememberErrorCode(err, 'forget_failed');
            if (id !== undefined) {
              conn.sendConn(
                error(id, -32099, publicErrorMessage(code, 'forget'), {
                  errorKind: code,
                  httpStatus: publicErrorStatus(code),
                }),
              );
            } else {
              debugLogger.warn(
                'workspace memory forget notification failed:',
                err,
              );
            }
          }
          return;
        }

        case `${QWEN_METHOD_NS}workspace/memory/forget/get`: {
          const taskId = params['taskId'];
          if (typeof taskId !== 'string' || taskId.length === 0) {
            if (id !== undefined) {
              conn.sendConn(error(id, RPC.INVALID_PARAMS, '`taskId` required'));
            }
            return;
          }
          const task = this.workspaceRememberLane.get(
            taskId,
            conn.clientId,
            'forget',
          );
          if (!task) {
            if (id !== undefined) {
              conn.sendConn(
                error(id, -32004, 'Workspace memory forget task not found', {
                  errorKind: 'forget_task_not_found',
                  httpStatus: 404,
                }),
              );
            }
            return;
          }
          this.replyConn(conn, id, task);
          return;
        }

        case `${QWEN_METHOD_NS}workspace/memory/dream`: {
          try {
            const available =
              await this.bridge.isWorkspaceMemoryRememberAvailable();
            if (!available) {
              if (id !== undefined) {
                conn.sendConn(
                  error(
                    id,
                    -32009,
                    'Managed memory is unavailable for this daemon workspace',
                    {
                      errorKind: 'managed_memory_unavailable',
                      httpStatus: 409,
                    },
                  ),
                );
              }
              return;
            }
            const task = this.workspaceRememberLane.enqueueDream({
              ...(conn.clientId ? { originatorClientId: conn.clientId } : {}),
            });
            this.replyConn(conn, id, task);
          } catch (err) {
            const code = extractRememberErrorCode(err, 'dream_failed');
            if (id !== undefined) {
              conn.sendConn(
                error(id, -32099, publicErrorMessage(code, 'dream'), {
                  errorKind: code,
                  httpStatus: publicErrorStatus(code),
                }),
              );
            } else {
              debugLogger.warn(
                'workspace memory dream notification failed:',
                err,
              );
            }
          }
          return;
        }

        case `${QWEN_METHOD_NS}workspace/memory/dream/get`: {
          const taskId = params['taskId'];
          if (typeof taskId !== 'string' || taskId.length === 0) {
            if (id !== undefined) {
              conn.sendConn(error(id, RPC.INVALID_PARAMS, '`taskId` required'));
            }
            return;
          }
          const task = this.workspaceRememberLane.get(
            taskId,
            conn.clientId,
            'dream',
          );
          if (!task) {
            if (id !== undefined) {
              conn.sendConn(
                error(id, -32004, 'Workspace memory dream task not found', {
                  errorKind: 'dream_task_not_found',
                  httpStatus: 404,
                }),
              );
            }
            return;
          }
          this.replyConn(conn, id, task);
          return;
        }

        case `${QWEN_METHOD_NS}file/read`: {
          const p = String(params['path'] ?? '');
          if (!p) {
            if (id !== undefined)
              conn.sendConn(error(id, RPC.INVALID_PARAMS, '`path` required'));
            return;
          }
          if (!this.fsFactory) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INTERNAL_ERROR, 'File system not configured'),
              );
            return;
          }
          const fs = this.fsFactory.forRequest({
            originatorClientId: conn.clientId,
            route: `ACP ${method}`,
          });
          const maxBytes = parseOptionalSafeIntegerInRange(
            params['maxBytes'],
            1,
            MAX_READ_BYTES,
          );
          if (maxBytes === null) {
            if (id !== undefined)
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  `\`maxBytes\` must be a positive integer in [1, ${MAX_READ_BYTES}]`,
                ),
              );
            return;
          }
          const line = parseOptionalSafeIntegerInRange(
            params['line'],
            1,
            Number.MAX_SAFE_INTEGER,
          );
          if (line === null) {
            if (id !== undefined)
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  '`line` must be a positive integer',
                ),
              );
            return;
          }
          const limit = parseOptionalSafeIntegerInRange(
            params['limit'],
            1,
            MAX_FILE_LINE_LIMIT,
          );
          if (limit === null) {
            if (id !== undefined)
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  `\`limit\` must be a positive integer in [1, ${MAX_FILE_LINE_LIMIT}]`,
                ),
              );
            return;
          }
          const resolved = await fs.resolve(p, 'read');
          const out = await fs.readText(resolved, { maxBytes, line, limit });
          this.replyConn(conn, id, {
            path: p,
            content: out.content,
            ...out.meta,
          } as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}file/read_bytes`: {
          if (!this.fsFactory) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INTERNAL_ERROR, 'File system not configured'),
              );
            return;
          }
          const p = String(params['path'] ?? '');
          if (!p) {
            if (id !== undefined)
              conn.sendConn(error(id, RPC.INVALID_PARAMS, '`path` required'));
            return;
          }
          const fs = this.fsFactory.forRequest({
            originatorClientId: conn.clientId,
            route: `ACP ${method}`,
          });
          const offset = parseOptionalSafeIntegerInRange(
            params['offset'],
            0,
            Number.MAX_SAFE_INTEGER,
          );
          if (offset === null) {
            if (id !== undefined)
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  '`offset` must be a non-negative safe integer',
                ),
              );
            return;
          }
          const maxBytes = parseOptionalSafeIntegerInRange(
            params['maxBytes'],
            1,
            MAX_READ_BYTES,
          );
          if (maxBytes === null) {
            if (id !== undefined)
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  `\`maxBytes\` must be a positive integer in [1, ${MAX_READ_BYTES}]`,
                ),
              );
            return;
          }
          const resolved = await fs.resolve(p, 'read');
          const buf = await fs.readBytesWindow(resolved, { offset, maxBytes });
          this.replyConn(conn, id, { path: p, ...buf } as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}file/stat`: {
          if (!this.fsFactory) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INTERNAL_ERROR, 'File system not configured'),
              );
            return;
          }
          const p = String(params['path'] ?? '');
          if (!p) {
            if (id !== undefined)
              conn.sendConn(error(id, RPC.INVALID_PARAMS, '`path` required'));
            return;
          }
          const fs = this.fsFactory.forRequest({
            originatorClientId: conn.clientId,
            route: `ACP ${method}`,
          });
          const resolved = await fs.resolve(p, 'read');
          const result = await fs.stat(resolved);
          this.replyConn(conn, id, { path: p, ...result } as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}file/list`: {
          if (!this.fsFactory) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INTERNAL_ERROR, 'File system not configured'),
              );
            return;
          }
          const p = String(params['path'] ?? '');
          if (!p) {
            if (id !== undefined)
              conn.sendConn(error(id, RPC.INVALID_PARAMS, '`path` required'));
            return;
          }
          const fs = this.fsFactory.forRequest({
            originatorClientId: conn.clientId,
            route: `ACP ${method}`,
          });
          const resolved = await fs.resolve(p, 'read');
          const MAX_LIST = 2000;
          const entries = await fs.list(resolved, { maxEntries: MAX_LIST + 1 });
          const truncated = entries.length > MAX_LIST;
          this.replyConn(conn, id, {
            path: p,
            entries: truncated ? entries.slice(0, MAX_LIST) : entries,
            truncated,
          } as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}file/glob`: {
          const pattern = String(params['pattern'] ?? '');
          if (!pattern) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INVALID_PARAMS, '`pattern` required'),
              );
            return;
          }
          if (!this.fsFactory) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INTERNAL_ERROR, 'File system not configured'),
              );
            return;
          }
          const fs = this.fsFactory.forRequest({
            originatorClientId: conn.clientId,
            route: `ACP ${method}`,
          });
          const maxResults = parseOptionalPositiveInteger(
            params['maxResults'],
            DEFAULT_FILE_GLOB_MAX_RESULTS,
            MAX_FILE_GLOB_MAX_RESULTS,
          );
          if (maxResults === null) {
            if (id !== undefined)
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  '`maxResults` must be an integer between 1 and 50000',
                ),
              );
            return;
          }
          const matches = await fs.glob(pattern, {
            maxResults: maxResults + 1,
          });
          const truncated = matches.length > maxResults;
          this.replyConn(conn, id, {
            pattern,
            matches: truncated ? matches.slice(0, maxResults) : matches,
            truncated,
          } as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}file/write`: {
          const p = String(params['path'] ?? '');
          if (!p) {
            if (id !== undefined)
              conn.sendConn(error(id, RPC.INVALID_PARAMS, '`path` required'));
            return;
          }
          if (typeof params['content'] !== 'string') {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INVALID_PARAMS, '`content` must be string'),
              );
            return;
          }
          if (!this.fsFactory) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INTERNAL_ERROR, 'File system not configured'),
              );
            return;
          }
          const fs = this.fsFactory.forRequest({
            originatorClientId: conn.clientId,
            route: `ACP ${method}`,
          });
          const resolved = await fs.resolve(p, 'write');
          if (
            Buffer.byteLength(params['content'] as string, 'utf8') >
            10 * 1024 * 1024
          ) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INVALID_PARAMS, 'content exceeds 10MB limit'),
              );
            return;
          }
          await fs.writeTextOverwrite(resolved, params['content'] as string);
          this.replyConn(conn, id, { ok: true, path: p });
          return;
        }

        case `${QWEN_METHOD_NS}file/edit`: {
          const p = String(params['path'] ?? '');
          if (!p) {
            if (id !== undefined)
              conn.sendConn(error(id, RPC.INVALID_PARAMS, '`path` required'));
            return;
          }
          if (
            typeof params['oldText'] !== 'string' ||
            typeof params['newText'] !== 'string'
          ) {
            if (id !== undefined)
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  '`oldText` and `newText` must be strings',
                ),
              );
            return;
          }
          if (!this.fsFactory) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INTERNAL_ERROR, 'File system not configured'),
              );
            return;
          }
          const fs = this.fsFactory.forRequest({
            originatorClientId: conn.clientId,
            route: `ACP ${method}`,
          });
          const resolved = await fs.resolve(p, 'write');
          const result = await fs.edit(
            resolved,
            params['oldText'] as string,
            params['newText'] as string,
          );
          this.replyConn(conn, id, { ok: true, path: p, ...result } as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}workspace/auth/status`: {
          if (!this.deviceFlowRegistry) {
            this.replyConn(conn, id, { pendingDeviceFlows: [] });
            return;
          }
          const pending = this.deviceFlowRegistry.listPending();
          const projected = pending.map((v) => ({
            deviceFlowId: v.deviceFlowId,
            providerId: v.providerId,
            expiresAt: v.expiresAt,
          }));
          this.replyConn(conn, id, { pendingDeviceFlows: projected });
          return;
        }

        case `${QWEN_METHOD_NS}workspace/auth/device_flow/start`: {
          if (!this.deviceFlowRegistry) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INTERNAL_ERROR, 'Device flow not configured'),
              );
            return;
          }
          const providerId = String(params['providerId'] ?? '');
          if (!providerId) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INVALID_PARAMS, '`providerId` required'),
              );
            return;
          }
          const startResult = await this.deviceFlowRegistry.start({
            providerId:
              providerId as import('../auth/device-flow.js').DeviceFlowProviderId,
            initiatorClientId: conn.clientId,
          });
          const { view, attached } = startResult;
          const gated =
            view.initiatorClientId === conn.clientId
              ? view
              : {
                  deviceFlowId: view.deviceFlowId,
                  providerId: view.providerId,
                  status: view.status,
                  expiresAt: view.expiresAt,
                };
          this.replyConn(conn, id, { view: gated, attached } as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}workspace/auth/device_flow/get`: {
          if (!this.deviceFlowRegistry) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INTERNAL_ERROR, 'Device flow not configured'),
              );
            return;
          }
          const flowId = String(params['id'] ?? '');
          if (!flowId) {
            if (id !== undefined)
              conn.sendConn(error(id, RPC.INVALID_PARAMS, '`id` required'));
            return;
          }
          const view = this.deviceFlowRegistry.get(flowId);
          if (!view) {
            if (id !== undefined)
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  `Device flow "${flowId}" not found`,
                ),
              );
            return;
          }
          const gated =
            view.initiatorClientId === conn.clientId
              ? view
              : {
                  deviceFlowId: view.deviceFlowId,
                  providerId: view.providerId,
                  status: view.status,
                  expiresAt: view.expiresAt,
                };
          this.replyConn(conn, id, gated as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}workspace/auth/device_flow/cancel`: {
          if (!this.deviceFlowRegistry) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INTERNAL_ERROR, 'Device flow not configured'),
              );
            return;
          }
          const flowId = String(params['id'] ?? '');
          if (!flowId) {
            if (id !== undefined)
              conn.sendConn(error(id, RPC.INVALID_PARAMS, '`id` required'));
            return;
          }
          const flowView = this.deviceFlowRegistry.get(flowId);
          if (
            flowView &&
            flowView.initiatorClientId &&
            flowView.initiatorClientId !== conn.clientId
          ) {
            if (id !== undefined)
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  'Only the flow initiator can cancel',
                ),
              );
            return;
          }
          const cancelResult = this.deviceFlowRegistry.cancel(
            flowId,
            conn.clientId,
          );
          if (!cancelResult) {
            if (id !== undefined)
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  `Device flow "${flowId}" not found`,
                ),
              );
            return;
          }
          this.replyConn(conn, id, {
            ok: true,
            alreadyTerminal: cancelResult.alreadyTerminal,
          });
          return;
        }

        case `${QWEN_METHOD_NS}workspace/tools`: {
          const result = await this.bridge.getWorkspaceToolsStatus();
          this.replyConn(conn, id, result as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}workspace/mcp/tools`: {
          const serverName = String(params['serverName'] ?? '');
          if (!serverName) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INVALID_PARAMS, '`serverName` required'),
              );
            return;
          }
          const result =
            await this.bridge.getWorkspaceMcpToolsStatus(serverName);
          this.replyConn(conn, id, result as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}workspace/mcp/resources`: {
          const serverName = String(params['serverName'] ?? '');
          if (!serverName) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INVALID_PARAMS, '`serverName` required'),
              );
            return;
          }
          const result =
            await this.bridge.getWorkspaceMcpResourcesStatus(serverName);
          this.replyConn(conn, id, result as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}workspace/mcp/servers/add`: {
          const name = String(params['name'] ?? '');
          if (!name || name.length > MAX_NAME_LENGTH) {
            if (id !== undefined)
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  `\`name\` required, max ${MAX_NAME_LENGTH} chars`,
                ),
              );
            return;
          }
          const config = params['config'];
          if (!config || typeof config !== 'object' || Array.isArray(config)) {
            if (id !== undefined)
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  '`config` required, must be object',
                ),
              );
            return;
          }
          const result = await this.bridge.addRuntimeMcpServer(
            name,
            config as Record<string, unknown>,
            conn.clientId,
          );
          this.replyConn(conn, id, result as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}workspace/mcp/servers/remove`: {
          const name = String(params['name'] ?? '');
          if (!name || name.length > MAX_NAME_LENGTH) {
            if (id !== undefined)
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  `\`name\` required, max ${MAX_NAME_LENGTH} chars`,
                ),
              );
            return;
          }
          const result = await this.bridge.removeRuntimeMcpServer(
            name,
            conn.clientId,
          );
          this.replyConn(conn, id, result as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}sessions/delete`: {
          const ids = this.parseSessionIds(params);
          const svc = new SessionService(this.boundWorkspace);
          const result = await deleteDaemonSessions({
            sessionIds: ids,
            service: svc,
            bridge: this.bridge,
            coordinator: this.archiveCoordinator,
            onError: ({ phase, sessionId, error }) => {
              const safeSessionId = logSafe(sessionId.slice(0, 8));
              const safeMessage = logSafe(error);
              writeStderrLine(
                `qwen serve: /acp sessions/delete ${phase}Session(${safeSessionId}) failed: ${safeMessage}`,
              );
            },
          });
          this.replyConn(conn, id, result as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}sessions/archive`: {
          const ids = this.parseSessionIds(params);
          const svc = new SessionService(this.boundWorkspace, {
            onWarning: logSessionArchiveWarning,
          });
          const result = await archiveDaemonSessions({
            sessionIds: ids,
            service: svc,
            bridge: this.bridge,
            coordinator: this.archiveCoordinator,
          });
          this.replyConn(conn, id, {
            archived: result.archived,
            alreadyArchived: result.alreadyArchived,
            notFound: result.notFound,
            errors: this.serializeSessionErrors(result.errors),
          } as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}sessions/unarchive`: {
          const ids = this.parseSessionIds(params);
          const svc = new SessionService(this.boundWorkspace, {
            onWarning: logSessionArchiveWarning,
          });
          const result = await unarchiveDaemonSessions({
            sessionIds: ids,
            service: svc,
            coordinator: this.archiveCoordinator,
          });
          this.replyConn(conn, id, {
            unarchived: result.unarchived,
            alreadyActive: result.alreadyActive,
            notFound: result.notFound,
            errors: this.serializeSessionErrors(result.errors),
          } as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}workspace/agents/list`: {
          const agents = await this.agentManager.listSubagents({ force: true });
          this.replyConn(conn, id, {
            v: 1,
            workspaceCwd: this.boundWorkspace,
            agents: agents.map(agentToSummary),
          });
          return;
        }

        case `${QWEN_METHOD_NS}workspace/agents/get`: {
          const agentType = String(params['agentType'] ?? '');
          if (!agentType) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INVALID_PARAMS, '`agentType` required'),
              );
            return;
          }
          const config = await this.agentManager.loadSubagent(agentType);
          if (!config) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INVALID_PARAMS, `Agent "${agentType}" not found`),
              );
            return;
          }
          this.replyConn(conn, id, agentToDetail(config) as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}workspace/agents/create`: {
          const scope = params['scope'];
          if (scope !== 'workspace' && scope !== 'global') {
            if (id !== undefined)
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  '`scope` must be "workspace" or "global"',
                ),
              );
            return;
          }
          const name = params['name'];
          if (typeof name !== 'string' || !name.trim()) {
            if (id !== undefined)
              conn.sendConn(error(id, RPC.INVALID_PARAMS, '`name` required'));
            return;
          }
          const level: SubagentLevel =
            scope === 'workspace' ? 'project' : 'user';
          if (BuiltinAgentRegistry.isBuiltinAgent(name)) {
            if (id !== undefined)
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  `Cannot shadow built-in agent "${name}"`,
                ),
              );
            return;
          }
          const collision = await this.agentManager.loadSubagent(name, level);
          if (collision) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INVALID_PARAMS, `Agent "${name}" already exists`),
              );
            return;
          }
          await this.agentManager.createSubagent(
            {
              name,
              level,
              description:
                typeof params['description'] === 'string'
                  ? params['description']
                  : '',
              systemPrompt:
                typeof params['systemPrompt'] === 'string'
                  ? params['systemPrompt']
                  : '',
              tools: Array.isArray(params['tools'])
                ? (params['tools'] as string[])
                : undefined,
              model:
                typeof params['model'] === 'string'
                  ? params['model']
                  : undefined,
            },
            { level },
          );
          const created = await this.agentManager.loadSubagent(name, level);
          this.replyConn(conn, id, {
            ok: true,
            agent: created ? agentToDetail(created) : null,
          } as unknown);
          try {
            this.bridge.publishWorkspaceEvent({
              type: 'agent_changed',
              data: { change: 'created', name, level },
              originatorClientId: conn.clientId,
            });
          } catch {
            /* best-effort */
          }
          return;
        }

        case `${QWEN_METHOD_NS}workspace/agents/update`: {
          const agentType = String(params['agentType'] ?? '');
          if (!agentType) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INVALID_PARAMS, '`agentType` required'),
              );
            return;
          }
          const existing = await this.agentManager.loadSubagent(agentType);
          if (!existing) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INVALID_PARAMS, `Agent "${agentType}" not found`),
              );
            return;
          }
          const MAX_FIELD_BYTES = 256 * 1024;
          const updates: Record<string, unknown> = {};
          if (typeof params['description'] === 'string') {
            if (
              Buffer.byteLength(params['description'], 'utf8') > MAX_FIELD_BYTES
            ) {
              if (id !== undefined)
                conn.sendConn(
                  error(
                    id,
                    RPC.INVALID_PARAMS,
                    '`description` exceeds 256KB limit',
                  ),
                );
              return;
            }
            updates['description'] = params['description'];
          }
          if (typeof params['systemPrompt'] === 'string') {
            if (
              Buffer.byteLength(params['systemPrompt'], 'utf8') >
              MAX_FIELD_BYTES
            ) {
              if (id !== undefined)
                conn.sendConn(
                  error(
                    id,
                    RPC.INVALID_PARAMS,
                    '`systemPrompt` exceeds 256KB limit',
                  ),
                );
              return;
            }
            updates['systemPrompt'] = params['systemPrompt'];
          }
          if (Array.isArray(params['tools'])) {
            if (params['tools'].length > 256) {
              if (id !== undefined)
                conn.sendConn(
                  error(
                    id,
                    RPC.INVALID_PARAMS,
                    '`tools` exceeds 256-entry limit',
                  ),
                );
              return;
            }
            if (
              !params['tools'].every(
                (t: unknown) =>
                  typeof t === 'string' && (t as string).length <= 256,
              )
            ) {
              if (id !== undefined)
                conn.sendConn(
                  error(
                    id,
                    RPC.INVALID_PARAMS,
                    '`tools` elements must be strings ≤256 chars',
                  ),
                );
              return;
            }
            updates['tools'] = params['tools'];
          }
          if (typeof params['model'] === 'string')
            updates['model'] = params['model'];
          if (Object.keys(updates).length === 0) {
            if (id !== undefined)
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  'at least one updatable field required',
                ),
              );
            return;
          }
          await this.agentManager.updateSubagent(
            agentType,
            updates,
            existing.level,
          );
          const updated = await this.agentManager.loadSubagent(
            agentType,
            existing.level,
          );
          this.replyConn(conn, id, {
            ok: true,
            agent: updated ? agentToDetail(updated) : null,
          } as unknown);
          try {
            this.bridge.publishWorkspaceEvent({
              type: 'agent_changed',
              data: {
                change: 'updated',
                name: agentType,
                level: existing.level,
              },
              originatorClientId: conn.clientId,
            });
          } catch {
            /* best-effort */
          }
          return;
        }

        case `${QWEN_METHOD_NS}workspace/agents/delete`: {
          const agentType = String(params['agentType'] ?? '');
          if (!agentType) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INVALID_PARAMS, '`agentType` required'),
              );
            return;
          }
          const scope =
            typeof params['scope'] === 'string' ? params['scope'] : undefined;
          const level: SubagentLevel | undefined =
            scope === 'workspace'
              ? 'project'
              : scope === 'global'
                ? 'user'
                : undefined;
          const existing = await this.agentManager.loadSubagent(
            agentType,
            level,
          );
          if (!existing) {
            if (id !== undefined)
              conn.sendConn(
                error(id, RPC.INVALID_PARAMS, `Agent "${agentType}" not found`),
              );
            return;
          }
          await this.agentManager.deleteSubagent(agentType, existing.level);
          this.replyConn(conn, id, { ok: true });
          try {
            this.bridge.publishWorkspaceEvent({
              type: 'agent_changed',
              data: {
                change: 'deleted',
                name: agentType,
                level: existing.level,
              },
              originatorClientId: conn.clientId,
            });
          } catch {
            /* best-effort */
          }
          return;
        }

        default:
          if (id !== undefined) {
            conn.sendConn(
              error(id, RPC.METHOD_NOT_FOUND, `Unknown method: ${method}`),
            );
          }
          return;
      }
    } catch (err) {
      // Full detail to stderr for the operator; a coded, client-safe shape
      // on the wire (raw bridge messages may carry internal paths/details).
      writeStderrLine(
        `qwen serve: /acp dispatch error (${logSafe(method)}): ${logSafe(errMsg(err))}`,
      );
      if (id !== undefined) {
        const { code, message, data } = toRpcError(err);
        const frame = error(id, code, message, data);
        // Route the error the SAME way as the method's success path. Inferring
        // from `params.sessionId` would misroute conn-scoped method failures
        // (session/load|resume|close|…) to a session stream that doesn't exist
        // yet — the client waiting on the connection stream never sees them.
        const sessionId =
          typeof params['sessionId'] === 'string'
            ? (params['sessionId'] as string)
            : undefined;
        if (sessionId && !CONN_ROUTED_METHODS.has(method)) {
          this.replySession(conn, sessionId, id, undefined, frame);
        } else {
          conn.sendConn(frame);
        }
      }
    }
  }

  /**
   * Bind a session-scoped SSE stream to the bridge's event stream,
   * translating each `BridgeEvent` into a JSON-RPC frame (design §4.2).
   */
  async pumpSessionEvents(
    conn: AcpConnection,
    sessionId: string,
    signal: AbortSignal,
    lastEventId?: number,
  ): Promise<void> {
    try {
      // `lastEventId` (from the `Last-Event-ID` reconnect header) drives the
      // EventBus ring replay: events with `id > lastEventId` still buffered
      // are replayed before live events flow, recovering content frames lost
      // in a mid-turn proxy gap (§1.8). `undefined` ⇒ live-only, as before.
      const iterable = this.bridge.subscribeEvents(sessionId, {
        signal,
        ...(lastEventId !== undefined ? { lastEventId } : {}),
      });
      // On resume, `attachSessionStream` defers id-less buffered replies (e.g. a
      // `session/prompt` result produced during the detach gap) so they land
      // AFTER the content chunks that preceded them. Each deferred reply carries
      // a WATERMARK (`anchorId` = the bus head id when it was produced); release
      // it only once the pump has DELIVERED through that id. We track the highest
      // delivered id and, after each content frame, release replies the pump has
      // now caught up to (`releaseDeferredSessionReplies`).
      //
      // `replay_complete` is the boundary for the REPLAY range only: it releases
      // replies anchored within the replayed frames and stops gating new replies
      // on the replay window. Replies anchored ABOVE the replay range (the turn
      // was still running at reconnect, so the tail arrives as LIVE events after
      // `replay_complete`) keep deferring until the per-event release below
      // delivers their content — a result produced during a slow replay must not
      // jump ahead of that tail (§1.8 W1, MsyIt).
      //
      // NOT released on `state_resync_required`: the EventBus emits that frame
      // FIRST, before the replay frames (both the `epoch_reset` and
      // `ring_evicted` paths fall through to the replay loop + `replay_complete`).
      // It is id-less, so the per-event release skips it anyway.
      let lastDeliveredId = lastEventId ?? 0;
      // A `state_resync_required` means the ring evicted frames (overflow /
      // epoch reset), so an anchor event a deferred reply is waiting on may
      // never be delivered. Track it so `endReplayDeferral` can release ALL
      // deferred replies (anchor guarantee void) instead of stranding them
      // behind an unreachable watermark — the cascading-freeze fix.
      let sawEviction = false;
      for await (const event of iterable) {
        if (signal.aborted) break;
        // Count event delivery as connection activity so a long, quiet prompt
        // (no inbound HTTP) isn't reaped by the idle-TTL sweep.
        conn.touch();
        this.translateEvent(conn, sessionId, event);
        if (event.type === 'state_resync_required') sawEviction = true;
        if (typeof event.id === 'number') {
          lastDeliveredId = event.id;
          conn.releaseDeferredSessionReplies(sessionId, event.id);
        }
        if (event.type === 'replay_complete') {
          conn.endReplayDeferral(sessionId, lastDeliveredId, sawEviction);
          // Operator breadcrumb for "did resume recover the gap?": one line per
          // resumed stream stating the cursor it resumed from, how far delivery
          // reached, the bus-reported replayed count, and whether the ring had
          // evicted frames (a gap the replay could not fully backfill).
          const replayedCount = (event.data as { replayedCount?: number })
            ?.replayedCount;
          writeStderrLine(
            `qwen serve: /acp replay complete (${logSafe(sessionId)}) ` +
              `from=${lastEventId ?? 'none'} delivered_through=${lastDeliveredId} ` +
              `count=${replayedCount ?? 'n/a'} evicted=${sawEviction}`,
          );
        }
      }
      // Safety: a live-only subscription (no cursor → no replay boundary) or a
      // clean end without a boundary frame still releases anything STILL deferred
      // (its anchored content will never arrive now) — but NOT if this pump was
      // aborted. An abort means the stream was detached/reclaimed; flushing here
      // could drain the deferred reply onto a RECLAIMING stream ahead of its own
      // replay (reintroducing the very out-of-order delivery the deferral
      // prevents). The reclaiming pump owns the buffer then and will release
      // after its replay boundary. On an iterator error mid-replay the catch
      // below performs the SAME flush (a re-throw with the stream still open
      // closes it outright rather than detaching with grace, so the buffered
      // replies must be released there too — otherwise they are lost).
      if (!signal.aborted) conn.flushBufferedSessionFrames(sessionId);
    } catch (err) {
      // Symmetric for the SYNC `subscribeEvents` throw and a MID-STREAM
      // iterator error: surface a `stream_error` to the client, then re-throw
      // so the caller's `.catch()` closes the stream. Returning would leave a
      // zombie SSE stream (heartbeats, no events, no reconnect signal).
      if (!signal.aborted) {
        // The iterator has terminated (errored), so no more content frames will
        // arrive through this pump and the ordering constraint the deferral
        // protected against no longer applies. Flush any still-deferred session
        // replies onto the (still-open) stream BEFORE signalling stream_error:
        // the re-throw drives `onPumpSettled`, and while the stream is still
        // open that takes the `closeSessionStream` branch (full teardown, NOT a
        // detach-with-grace), which would otherwise DROP the buffered replies
        // instead of preserving them for a reconnect. Same safety flush as the
        // happy-path completion above.
        conn.flushBufferedSessionFrames(sessionId);
        conn.sendSession(
          sessionId,
          notification(`${QWEN_METHOD_NS}notify`, {
            kind: 'stream_error',
            error: errMsg(err),
          }),
        );
      }
      throw err;
    }
    // Normal completion (iterator returned `done` — e.g. the subprocess ended
    // cleanly). The caller's `.then` closes the stream so it isn't left as a
    // zombie heartbeating with nothing more to deliver.
  }

  private translateEvent(
    conn: AcpConnection,
    sessionId: string,
    event: BridgeEvent,
  ): void {
    switch (event.type) {
      case 'session_update': {
        // `event.data` is the ACP `SessionNotification` (params shape).
        // `event.id` is the bus cursor → SSE `id:` line for `Last-Event-ID`
        // resume (the content frames §1.8 recovers all flow through here).
        conn.sendSession(
          sessionId,
          notification('session/update', event.data),
          event.id,
        );
        return;
      }
      case 'permission_request': {
        const data = event.data as {
          requestId: string;
          sessionId: string;
          toolCall: unknown;
          options: unknown;
        };
        // A permission request MUST reach a LIVE session stream. Going
        // through `sendSession` would (a) silently drop the frame if the
        // session was torn down (lookup-only), or (b) buffer it pre-attach
        // where `pushCapped` could evict it under event throughput — either
        // way the `pending` entry is orphaned and the agent's prompt blocks
        // on a vote forever. So deliver DIRECTLY to a live stream, and if
        // there is none, cancel (deny-safe) rather than register+stall.
        const binding = conn.sessions.get(sessionId);
        if (!binding?.stream || binding.stream.isClosed) {
          // KNOWN GAP (tracked as the §1.7 cross-connection permission
          // follow-up): when this fires DURING a reconnect grace window
          // (`binding.graceTimer` set), the prompt is intentionally kept alive,
          // but the permission is still cancel-denied here — so a client
          // reconnecting within grace can't vote on it (ring replay re-delivers
          // the request, but the mediator already resolved it cancelled). Log a
          // breadcrumb so an operator can correlate an auto-denied permission
          // with a transient disconnect. The structural fix (defer the
          // permission across grace) belongs with the permission-coordination
          // follow-up, not this content-stream PR.
          if (binding?.graceTimer) {
            writeStderrLine(
              `qwen serve: /acp permission cancel during reconnect grace ` +
                `(${logSafe(sessionId)}); vote not deferred (see §1.7 follow-up)`,
            );
          }
          const cancelled = this.cancelAbandonedPermission(
            { sessionId, bridgeRequestId: data.requestId },
            // Pass the bridge-stamped clientId when the binding still exists
            // (stream closed but session live) — only `undefined` when the
            // session is fully gone.
            binding?.clientId,
          );
          // Unlike resolveClientResponse (where the pending entry exists and
          // teardown can retry), this path returns BEFORE `conn.pending.set` —
          // so `abandonPendingForSession` will NOT find it. A failed cancel
          // here means the mediator is stuck permanently, not just until
          // teardown. Log clearly so the operator knows there is no automatic
          // recovery; manual intervention (restart the agent session) is needed.
          if (!cancelled) {
            writeStderrLine(
              `qwen serve: /acp permission cancel FAILED for ${logSafe(sessionId)} (mediator stuck; no automatic recovery)`,
            );
          }
          return;
        }
        // Idempotent under ring replay: a `permission_request` is an
        // id-bearing ring event, so a reconnect whose `Last-Event-ID` precedes
        // a still-unanswered request replays it here. Reuse the existing
        // pending entry for this bridge requestId (re-send the SAME outbound id
        // for catch-up) instead of minting a second id + entry — which would
        // orphan one until teardown and double-prompt a client that doesn't
        // dedupe on `_meta.requestId`.
        //
        // KNOWN LIMITATION (already-resolved replay): if the client ALREADY
        // voted, the vote handler consumed the pending entry, so the scan below
        // finds no match and mints a fresh entry + re-sends the prompt. The
        // re-sent prompt carries the SAME `_meta.requestId`, so a conformant
        // client (the dedupe contract this whole replay path already relies on)
        // recognises and drops it; the only residual is a transient orphan
        // pending entry, reaped by `abandonPendingForSession` at teardown — the
        // agent does NOT stall, since its permission was resolved by the prior
        // vote. Full response-replay idempotency for non-deduping clients (an
        // LRU of resolved requestIds re-sending the recorded outcome) belongs
        // with the permission-coordination follow-up (§1.7), not this
        // content-stream PR, as it would add resolved-permission state to the
        // vote path.
        let id: string | undefined;
        for (const [existingId, p] of conn.pending) {
          if (
            p.kind === 'permission' &&
            p.sessionId === sessionId &&
            p.bridgeRequestId === data.requestId
          ) {
            id = existingId;
            break;
          }
        }
        if (id === undefined) {
          id = conn.nextId();
          conn.pending.set(id, {
            sessionId,
            bridgeRequestId: data.requestId,
            kind: 'permission',
          });
        }
        // INVARIANT: this sends straight to `binding.stream` (not via
        // `conn.sendSession`) and is safe ONLY because `translateEvent` runs
        // synchronously from the pump — `binding.stream` was checked non-null
        // above and cannot be detached mid-call. Do NOT introduce an `await`
        // between that check and this send: a detach during the gap would set
        // `binding.stream = undefined` and this would throw `TypeError`.
        void binding.stream.send(
          request(id, 'session/request_permission', {
            sessionId: data.sessionId,
            toolCall: data.toolCall,
            options: data.options,
            _meta: { [QWEN_META_KEY]: { requestId: data.requestId } },
          }),
          // Carry the bus cursor: a permission request is a real sequenced
          // event, so the client must resume past it.
          event.id,
        );
        return;
      }
      case 'stream_error': {
        conn.sendSession(
          sessionId,
          notification(`${QWEN_METHOD_NS}notify`, {
            // Spread first so a stray `kind` in event.data can't shadow the
            // discriminator the client's error handler keys on.
            ...(event.data as object),
            kind: 'stream_error',
          }),
          // Pass the bus cursor through if present; a synthetic terminal frame
          // has no bus id (event.id undefined) so no SSE `id:` line is written.
          event.id,
        );
        return;
      }
      default: {
        // client_evicted / slow_client_warning / state_resync_required /
        // model_switched / approval_mode_changed / … → opaque qwen notify.
        // `event.id` is undefined for the synthetic control frames (no SSE
        // `id:` line, so they don't burn a slot in the resume sequence) and
        // set for ring-backed daemon events.
        conn.sendSession(
          sessionId,
          notification(`${QWEN_METHOD_NS}notify`, {
            kind: event.type,
            data: event.data,
          }),
          event.id,
        );
      }
    }
  }

  /**
   * Resolve a client's JSON-RPC response to an agent→client request.
   * `fromLoopback` is the CURRENT request's loopback bit (the vote POST may
   * arrive from a different peer than `initialize`).
   */
  private resolveClientResponse(
    conn: AcpConnection,
    msg: JsonRpcResponse,
    fromLoopback: boolean,
  ): void {
    // Our outbound request ids are strings (`_qwen_perm_<conn>_N`); a client echoes
    // the same id verbatim. Anything else can't match a pending entry.
    const id = msg.id;
    if (typeof id !== 'string') return;
    const pendingRef = this.findPendingClientRequest(conn, id);
    if (!pendingRef) return;
    const pendingConn = pendingRef.conn;
    const pending = pendingRef.req;
    if (pendingConn !== conn && !conn.ownsSession(pending.sessionId)) {
      // Mirror the `session/permission` handler: never drop a cross-connection
      // vote silently. The POST already returned 202, so without a log line the
      // operator has no grep-friendly signal to correlate against a permission
      // prompt that stays blocked until teardown's `abandonPendingForSession`.
      writeStderrLine(
        `qwen serve: /acp permission vote dropped: responding connection ${logSafe(
          conn.connectionId.slice(0, 8),
        )} does not own session ${logSafe(pending.sessionId)} (requestId ${logSafe(
          pending.bridgeRequestId,
        )})`,
      );
      return;
    }
    // NOTE: do NOT delete the pending entry yet. Keep it until either the
    // bridge vote OR the cancel fallback runs — if both somehow fail, the
    // entry survives so a later session/connection teardown
    // (`abandonPendingForSession`) can still release the mediator.

    try {
      // A client error response is a cancellation; otherwise validate +
      // whitelist the result through the SAME `parsePermissionResponse` the
      // `session/permission` handler uses. This PR widened this path to any
      // co-owning connection (via `findPendingClientRequest`), so without the
      // shared validator a co-owner could inject arbitrary top-level args and
      // extra `outcome` sub-fields straight to the bridge. A malformed result
      // throws here (as the old direct cast made the bridge throw) and is
      // caught below, where the cancel fallback always releases the mediator.
      const vote =
        'error' in msg
          ? { outcome: { outcome: 'cancelled' } }
          : parsePermissionResponse(
              isObject((msg as { result: unknown }).result)
                ? (msg as { result: Record<string, unknown> }).result
                : {},
            );
      this.bridge.respondToSessionPermission(
        pending.sessionId,
        pending.bridgeRequestId,
        vote as unknown as Parameters<
          HttpAcpBridge['respondToSessionPermission']
        >[2],
        this.sessionCtx(conn, pending.sessionId, fromLoopback),
      );
      this.dropResolvedPermission(pendingConn, id);
    } catch (err) {
      writeStderrLine(
        `qwen serve: /acp permission vote failed (${logSafe(pending.sessionId)}): ${logSafe(errMsg(err))}`,
      );
      // Cancel BEFORE deleting, and ONLY drop the entry if the cancel
      // landed. If it also failed, keep the entry so teardown's
      // `abandonPendingForSession` can retry — otherwise the mediator is
      // permanently stuck with no recovery path.
      const cancelled = this.cancelAbandonedPermission(
        pending,
        pendingConn.sessions.get(pending.sessionId)?.clientId,
      );
      if (cancelled) this.dropResolvedPermission(pendingConn, id);
    }
  }

  private async handlePrompt(
    conn: AcpConnection,
    sessionId: string,
    id: JsonRpcId | undefined,
    params: Record<string, unknown>,
    fromLoopback: boolean,
  ): Promise<void> {
    // Park the controller on the binding so `session/cancel` and
    // session/connection teardown can abort an in-flight prompt — otherwise
    // a disconnecting client leaves the agent running, burning model quota
    // and holding the session's prompt FIFO.
    const binding = conn.getOrCreateSession(sessionId);
    // Abort any prior in-flight prompt for this session before replacing the
    // controller — two concurrent `session/prompt`s would otherwise orphan
    // the first (it runs to completion in the bridge FIFO, burning quota,
    // and `session/cancel` could only reach the latest controller).
    binding.promptAbort?.abort();
    const abort = new AbortController();
    binding.promptAbort = abort;
    try {
      const result = await this.bridge.sendPrompt(
        sessionId,
        // SECURITY NOTE: `params.sessionId` already equals the routing
        // `sessionId` (both from the same params), so there's no routing
        // divergence today. If the bridge ever trusts an additional
        // `sendPrompt` field by name (e.g. a priority/temperature override),
        // force-stamp it here like the REST surface does (`{ ...body,
        // sessionId, prompt }`) so it can't become client-controlled.
        params as unknown as Parameters<HttpAcpBridge['sendPrompt']>[1],
        abort.signal,
        this.sessionCtx(conn, sessionId, fromLoopback),
      );
      if (id !== undefined) this.replySession(conn, sessionId, id, result);
    } catch (err) {
      const { code, message, data } = toRpcError(err);
      if (id !== undefined) {
        this.replySession(
          conn,
          sessionId,
          id,
          undefined,
          error(id, code, message, data),
        );
      } else {
        // Notification-form prompt (no id): no response frame to send, so a
        // failure would vanish silently — log it for the operator.
        writeStderrLine(
          `qwen serve: /acp prompt error (${logSafe(sessionId)}, notification): ${logSafe(errMsg(err))}`,
        );
      }
    } finally {
      if (binding.promptAbort === abort) binding.promptAbort = undefined;
    }
  }

  private replyConn(
    conn: AcpConnection,
    id: JsonRpcId | undefined,
    result: unknown,
  ): void {
    if (id === undefined) return;
    conn.sendConn(success(id, result));
  }

  private replySession(
    conn: AcpConnection,
    sessionId: string,
    id: JsonRpcId | undefined,
    result: unknown,
    errorFrame?: ReturnType<typeof error>,
  ): void {
    if (id === undefined) return;
    const frame = errorFrame ?? success(id, result);
    // If the session was torn down mid-flight (e.g. a concurrent
    // `session/close`), the binding + session stream are gone and
    // `sendSession` is lookup-only — it would SILENTLY DROP this frame,
    // violating the JSON-RPC one-response-per-request contract. Fall back to
    // the connection-scoped stream so an id'd request always gets its reply.
    if (conn.sessions.has(sessionId)) {
      // Out-of-band reply: `sendSessionReply` defers it behind an in-flight ring
      // replay so a prompt finishing mid-replay can't overtake not-yet-sent
      // content frames (§1.8 W1). Anchor the reply to the bus head id NOW —
      // every content event that should precede it has id ≤ this — so the pump
      // releases it only after delivering through that id, even when the tail
      // content is still flowing as live events behind `replay_complete`.
      //
      // The ACP binding can outlive the bridge session for a beat (concurrent
      // teardown); `getSessionLastEventId` throws then. Fall back to an
      // unanchored defer (released at the next boundary) — never let a missing
      // watermark turn a reply into a thrown error.
      let anchorId: number | undefined;
      try {
        anchorId = this.bridge.getSessionLastEventId(sessionId);
      } catch (err) {
        // Expected on the teardown race; log a breadcrumb so an operator can
        // tell that benign case apart from an unexpected bridge regression that
        // starts exercising this fallback (which would otherwise be invisible).
        anchorId = undefined;
        writeStderrLine(
          `qwen serve: /acp replySession(${logSafe(sessionId)}) ` +
            `anchor unavailable, deferring unanchored: ` +
            logSafe(err instanceof Error ? err.message : String(err)),
        );
      }
      conn.sendSessionReply(sessionId, frame, anchorId);
    } else {
      // Fallback fired — log it so an operator can correlate "reply arrived on
      // the connection stream, not the session stream" with a mid-flight
      // session teardown.
      writeStderrLine(
        `qwen serve: /acp replySession(${logSafe(sessionId)}) binding gone mid-flight, ` +
          `reply routed to connection stream ${conn.connectionId.slice(0, 8)}`,
      );
      conn.sendConn(frame);
    }
  }
}

// Re-export so tests can reference the request type without the json-rpc path.
export type { JsonRpcRequest };
