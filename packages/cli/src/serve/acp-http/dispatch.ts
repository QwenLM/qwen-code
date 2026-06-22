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
  SessionService,
  BuiltinAgentRegistry,
  SubagentError,
  WorkspaceMemoryFileTooLargeError,
  WorkspaceMemoryWriteTimeoutError,
  writeWorkspaceContextFile,
  type SubagentLevel,
} from '@qwen-code/qwen-code-core';
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
} from '@qwen-code/acp-bridge/bridgeErrors';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { MAX_WORKSPACE_PATH_LENGTH } from '../fs/paths.js';
import {
  MAX_READ_BYTES,
  type WorkspaceFileSystemFactory,
} from '../fs/index.js';
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
import type {
  DaemonWorkspaceService,
  WorkspaceRequestContext,
} from '../workspace-service/types.js';
import type { AcpConnection } from './connection-registry.js';
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

const SESSION_SHELL_METHOD = `${QWEN_METHOD_NS}session/shell`;

const ALL_QWEN_VENDOR_METHODS: readonly string[] = [
  `${QWEN_METHOD_NS}session/heartbeat`,
  `${QWEN_METHOD_NS}session/context`,
  `${QWEN_METHOD_NS}session/supported_commands`,
  `${QWEN_METHOD_NS}session/update_metadata`,
  `${QWEN_METHOD_NS}workspace/mcp`,
  `${QWEN_METHOD_NS}workspace/skills`,
  `${QWEN_METHOD_NS}workspace/providers`,
  `${QWEN_METHOD_NS}workspace/env`,
  `${QWEN_METHOD_NS}workspace/preflight`,
  `${QWEN_METHOD_NS}workspace/init`,
  `${QWEN_METHOD_NS}workspace/set_tool_enabled`,
  `${QWEN_METHOD_NS}workspace/restart_mcp_server`,
  // Wave 1: session extensions
  `${QWEN_METHOD_NS}session/recap`,
  `${QWEN_METHOD_NS}session/btw`,
  SESSION_SHELL_METHOD,
  `${QWEN_METHOD_NS}session/detach`,
  `${QWEN_METHOD_NS}session/context_usage`,
  `${QWEN_METHOD_NS}session/tasks`,
  // Wave 1: memory
  `${QWEN_METHOD_NS}workspace/memory`,
  `${QWEN_METHOD_NS}workspace/memory/write`,
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
  `${QWEN_METHOD_NS}workspace/mcp/servers/add`,
  `${QWEN_METHOD_NS}workspace/mcp/servers/remove`,
  `${QWEN_METHOD_NS}sessions/delete`,
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
  const name = err instanceof Error ? err.name : '';
  switch (name) {
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
    private readonly fsFactory?: WorkspaceFileSystemFactory,
    private readonly deviceFlowRegistry?: DeviceFlowRegistry,
    private readonly sessionShellCommandEnabled: boolean = false,
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
          const restored =
            method === 'session/load'
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
          const cursor =
            typeof params['cursor'] === 'string' ? params['cursor'] : undefined;
          const meta = isObject(params['_meta']) ? params['_meta'] : undefined;
          const metaSize =
            typeof meta?.['size'] === 'number'
              ? (meta['size'] as number)
              : undefined;
          const result = await listWorkspaceSessionsForResponse(
            this.bridge,
            this.boundWorkspace,
            { cursor, size: metaSize },
          );
          this.replyConn(conn, id, {
            sessions: result.sessions.map((s) => ({
              sessionId: s.sessionId,
              cwd: s.workspaceCwd,
              title: s.displayName,
              updatedAt: s.updatedAt,
            })),
            ...(result.nextCursor != null
              ? { nextCursor: result.nextCursor }
              : {}),
          });
          return;
        }

        case 'session/close': {
          const sessionId = String(params['sessionId'] ?? '');
          if (!this.requireOwned(conn, sessionId, id)) return;
          // Close the ownership gate SYNCHRONOUSLY (before the await) so two
          // concurrent `session/close`s don't both pass `requireOwned` —
          // the second would otherwise send a misleading error and trigger a
          // redundant bridge close.
          conn.ownedSessions.delete(sessionId);
          // Mark closing so a concurrent session/load|resume of the SAME id
          // can't grant fresh ownership + create a new binding that this
          // close's `finally` teardown would then destroy (TOCTOU).
          conn.closingSessions.add(sessionId);
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
          if (!this.requireOwned(conn, sessionId, id)) return;
          const ctx = this.sessionCtx(conn, sessionId, loopback);
          const result = await this.bridge.branchSession(
            sessionId,
            {
              name:
                typeof params['name'] === 'string' ? params['name'] : undefined,
            },
            ctx,
          );
          if (conn.destroyed) {
            this.killOrphanSession(result.sessionId);
            return;
          }
          conn.getOrCreateSession(result.sessionId).clientId = result.clientId;
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
          return;
        }

        case 'session/cancel': {
          const sessionId = String(params['sessionId'] ?? '');
          if (!this.requireOwned(conn, sessionId, id)) return;
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
          return;
        }

        case 'session/prompt': {
          const sessionId = String(params['sessionId'] ?? '');
          if (!this.requireOwned(conn, sessionId, id)) return;
          validatePrompt(params);
          await this.handlePrompt(conn, sessionId, id, params, loopback);
          return;
        }

        // STANDARD method (SDK 0.14.1, non-`unstable_`): model + mode live
        // here under categories `model`/`mode`, routed to the existing bridge
        // setters. Replaces the old vendor `_qwen/session/set_model`.
        case 'session/set_config_option': {
          const sessionId = String(params['sessionId'] ?? '');
          if (!this.requireOwned(conn, sessionId, id)) return;
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
                error(id, RPC.INVALID_PARAMS, `Unknown configId: ${configId}`),
              );
            }
            return;
          }
          // Response returns the updated config option set (per ACP).
          const configOptions = await this.configOptionsFor(sessionId);
          this.replySession(conn, sessionId, id, { configOptions });
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
          if (!this.requireOwned(conn, sessionId, id)) return;
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
          if (!this.requireOwned(conn, sessionId, id)) return;
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
          if (!this.requireOwned(conn, sessionId, id)) return;
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
          if (!this.requireOwned(conn, sessionId, id)) return;
          const result = await this.bridge.generateSessionRecap(
            sessionId,
            this.sessionCtx(conn, sessionId, loopback),
          );
          this.replyConn(conn, id, result as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}session/btw`: {
          const sessionId = String(params['sessionId'] ?? '');
          if (!this.requireOwned(conn, sessionId, id)) return;
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
          if (!this.requireOwned(conn, sessionId, id)) return;
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
          return;
        }

        case `${QWEN_METHOD_NS}session/detach`: {
          const sessionId = String(params['sessionId'] ?? '');
          if (!this.requireOwned(conn, sessionId, id)) return;
          const ctx = this.sessionCtx(conn, sessionId, loopback);
          await this.bridge.detachClient(sessionId, ctx.clientId);
          this.replyConn(conn, id, { ok: true });
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
          const sessionIds = params['sessionIds'];
          if (
            !Array.isArray(sessionIds) ||
            sessionIds.length === 0 ||
            sessionIds.length > 100 ||
            !sessionIds.every((s) => typeof s === 'string')
          ) {
            if (id !== undefined)
              conn.sendConn(
                error(
                  id,
                  RPC.INVALID_PARAMS,
                  '`sessionIds` must be non-empty string array (max 100)',
                ),
              );
            return;
          }
          const ids = [...new Set(sessionIds as string[])];
          const closeErrors: Array<{ sessionId: string; error: string }> = [];
          const closedIds: string[] = [];
          await Promise.allSettled(
            ids.map(async (sid) => {
              try {
                await this.bridge.closeSession(sid);
                closedIds.push(sid);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (
                  err instanceof Error &&
                  err.name === 'SessionNotFoundError'
                ) {
                  closedIds.push(sid);
                } else {
                  const safeSessionId = logSafe(sid.slice(0, 8));
                  const safeMessage = logSafe(msg);
                  writeStderrLine(
                    `qwen serve: /acp sessions/delete closeSession(${safeSessionId}) failed: ${safeMessage}`,
                  );
                  closeErrors.push({ sessionId: sid, error: msg });
                }
              }
            }),
          );
          const svc = new SessionService(this.boundWorkspace);
          const removeResult = await svc.removeSessions(closedIds);
          for (const e of removeResult.errors) {
            const safeSessionId = logSafe(e.sessionId.slice(0, 8));
            const safeMessage = logSafe(errMsg(e.error));
            writeStderrLine(
              `qwen serve: /acp sessions/delete removeSessions(${safeSessionId}) failed: ${safeMessage}`,
            );
          }
          this.replyConn(conn, id, {
            removed: removeResult.removed,
            notFound: removeResult.notFound,
            errors: [
              ...closeErrors,
              ...removeResult.errors.map((e) => ({
                sessionId: e.sessionId,
                error: errMsg(e.error),
              })),
            ],
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
  ): Promise<void> {
    try {
      const iterable = this.bridge.subscribeEvents(sessionId, { signal });
      for await (const event of iterable) {
        if (signal.aborted) break;
        // Count event delivery as connection activity so a long, quiet prompt
        // (no inbound HTTP) isn't reaped by the idle-TTL sweep.
        conn.touch();
        this.translateEvent(conn, sessionId, event);
      }
    } catch (err) {
      // Symmetric for the SYNC `subscribeEvents` throw and a MID-STREAM
      // iterator error: surface a `stream_error` to the client, then re-throw
      // so the caller's `.catch()` closes the stream. Returning would leave a
      // zombie SSE stream (heartbeats, no events, no reconnect signal).
      if (!signal.aborted) {
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
        conn.sendSession(sessionId, notification('session/update', event.data));
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
        const id = conn.nextId();
        conn.pending.set(id, {
          sessionId,
          bridgeRequestId: data.requestId,
          kind: 'permission',
        });
        void binding.stream.send(
          request(id, 'session/request_permission', {
            sessionId: data.sessionId,
            toolCall: data.toolCall,
            options: data.options,
            _meta: { [QWEN_META_KEY]: { requestId: data.requestId } },
          }),
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
        );
        return;
      }
      default: {
        // client_evicted / slow_client_warning / state_resync_required /
        // model_switched / approval_mode_changed / … → opaque qwen notify.
        conn.sendSession(
          sessionId,
          notification(`${QWEN_METHOD_NS}notify`, {
            kind: event.type,
            data: event.data,
          }),
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
    // Our outbound request ids are strings (`_qwen_perm_N`); a client echoes
    // the same id verbatim. Anything else can't match a pending entry.
    const id = msg.id;
    if (typeof id !== 'string') return;
    const pending = conn.pending.get(id);
    if (!pending) return;
    // NOTE: do NOT delete the pending entry yet. Keep it until either the
    // bridge vote OR the cancel fallback runs — if both somehow fail, the
    // entry survives so a later session/connection teardown
    // (`abandonPendingForSession`) can still release the mediator.

    // A client error response is a cancellation; otherwise pass the result
    // through. The cast defers shape validation to the bridge, so a
    // MALFORMED result (e.g. `{}` with no `outcome`) makes the mediator
    // throw — caught below, where we fall back to an explicit cancel so the
    // mediator is always released. The pending entry is dropped only after a
    // successful vote/cancel (see the NOTE above), so a double-failure leaves
    // it for teardown to retry.
    const vote =
      'error' in msg
        ? { outcome: { outcome: 'cancelled' } }
        : (msg as { result: unknown }).result;
    try {
      this.bridge.respondToSessionPermission(
        pending.sessionId,
        pending.bridgeRequestId,
        vote as unknown as Parameters<
          HttpAcpBridge['respondToSessionPermission']
        >[2],
        this.sessionCtx(conn, pending.sessionId, fromLoopback),
      );
      conn.pending.delete(id); // vote landed — safe to drop
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
        conn.sessions.get(pending.sessionId)?.clientId,
      );
      if (cancelled) conn.pending.delete(id);
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
      conn.sendSession(sessionId, frame);
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
