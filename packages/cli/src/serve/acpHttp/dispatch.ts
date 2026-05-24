/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HttpAcpBridge } from '@qwen-code/acp-bridge/bridgeTypes';
import type { BridgeEvent } from '@qwen-code/acp-bridge/eventBus';
import type { AcpConnection } from './connectionRegistry.js';
import {
  QWEN_METHOD_NS,
  RPC,
  error,
  isNotification,
  isRequest,
  isResponse,
  notification,
  request,
  success,
  type JsonRpcId,
  type JsonRpcInbound,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './jsonRpc.js';

function logStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Matches the REST surface's `MAX_WORKSPACE_PATH_LENGTH` (PATH_MAX). */
const MAX_WORKSPACE_PATH_LENGTH = 4096;

class AcpParamError extends Error {}

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
    throw new AcpParamError('`cwd` must be a string absolute path when provided');
  }
  if (cwd.length > MAX_WORKSPACE_PATH_LENGTH) {
    throw new AcpParamError(
      `\`cwd\` exceeds the ${MAX_WORKSPACE_PATH_LENGTH}-character limit`,
    );
  }
  if (!cwd.startsWith('/')) {
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
function toRpcError(err: unknown): { code: number; message: string } {
  if (err instanceof AcpParamError) {
    return { code: RPC.INVALID_PARAMS, message: err.message };
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
    default:
      return { code: RPC.INTERNAL_ERROR, message: 'Internal error' };
  }
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
  constructor(
    private readonly bridge: HttpAcpBridge,
    private readonly boundWorkspace: string,
  ) {}

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
  ): { clientId: string; fromLoopback: boolean } {
    const clientId = conn.sessions.get(sessionId)?.clientId;
    if (!clientId) {
      throw new Error(
        `no bridge-stamped clientId for session ${sessionId} (ownership invariant violated)`,
      );
    }
    return { clientId, fromLoopback: conn.fromLoopback };
  }

  /**
   * Cancel a permission request the client abandoned (closed its stream /
   * connection before voting), so the bridge isn't left blocked. Invoked
   * by the connection-registry teardown path.
   */
  cancelAbandonedPermission(
    req: { sessionId: string; bridgeRequestId: string },
    clientId: string | undefined,
  ): void {
    try {
      this.bridge.respondToSessionPermission(
        req.sessionId,
        req.bridgeRequestId,
        { outcome: { outcome: 'cancelled' } } as never,
        clientId !== undefined ? { clientId } : undefined,
      );
    } catch {
      // Session already gone — nothing to cancel.
    }
  }

  /**
   * Build the `initialize` result advertising standard + `_qwen` caps.
   * Negotiates the protocol version down to what we support (ACP stable
   * = 1): we echo `min(requested, ACP_PROTOCOL_VERSION)`.
   */
  buildInitializeResult(
    connectionId: string,
    requestedVersion?: unknown,
  ): Record<string, unknown> {
    const requested =
      typeof requestedVersion === 'number' && Number.isFinite(requestedVersion)
        ? requestedVersion
        : ACP_PROTOCOL_VERSION;
    const negotiated = Math.min(requested, ACP_PROTOCOL_VERSION);
    return {
      protocolVersion: negotiated,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
        // Advertise qwen extensions so clients feature-detect before use.
        // Single home for the qwen block — `agentCapabilities._meta.qwen`
        // per design §5 (no redundant top-level duplicate).
        _meta: {
          qwen: {
            connectionId,
            workspaceCwd: this.boundWorkspace,
            methods: [
              `${QWEN_METHOD_NS}session/set_model`,
              `${QWEN_METHOD_NS}session/heartbeat`,
            ],
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
    if (id !== undefined) {
      conn.sendConn(
        error(
          id,
          RPC.INVALID_PARAMS,
          `Session ${sessionId} is not owned by this connection`,
        ),
      );
    }
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
  ): Promise<void> {
    // A client's JSON-RPC RESPONSE (to an agent→client request) — wrapped
    // so a throwing bridge call can't reject this promise after index.ts
    // already sent `202` (which would surface as an unhandled rejection).
    if (isResponse(msg)) {
      try {
        this.resolveClientResponse(conn, msg);
      } catch (err) {
        logStderr(`qwen serve: /acp response handling error: ${errMsg(err)}`);
      }
      return;
    }
    if (!isRequest(msg) && !isNotification(msg)) return;

    const method = msg.method;
    const params = (isObjectParams(msg.params) ? msg.params : {}) as Record<
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
          const session = await this.bridge.spawnOrAttach({
            workspaceCwd: cwd,
            clientId: conn.clientId,
          });
          // Record the clientId the bridge actually stamped — later
          // per-session calls MUST echo it (see SessionBinding.clientId).
          conn.getOrCreateSession(session.sessionId).clientId =
            session.clientId;
          conn.ownSession(session.sessionId);
          this.replyConn(conn, id, { sessionId: session.sessionId });
          return;
        }

        case 'session/load':
        case 'session/resume': {
          const sessionId = String(params['sessionId'] ?? '');
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
          conn.getOrCreateSession(sessionId).clientId = restored.clientId;
          conn.ownSession(sessionId);
          this.replyConn(conn, id, restored.state ?? {});
          return;
        }

        case 'session/list': {
          const sessions = this.bridge.listWorkspaceSessions(
            this.boundWorkspace,
          );
          this.replyConn(conn, id, { sessions });
          return;
        }

        case 'session/close': {
          const sessionId = String(params['sessionId'] ?? '');
          if (!this.requireOwned(conn, sessionId, id)) return;
          await this.bridge.closeSession(
            sessionId,
            this.sessionCtx(conn, sessionId),
          );
          conn.closeSessionStream(sessionId);
          this.replyConn(conn, id, {});
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
            undefined,
            this.sessionCtx(conn, sessionId),
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
          await this.handlePrompt(conn, sessionId, id, params);
          return;
        }

        case `${QWEN_METHOD_NS}session/set_model`: {
          const sessionId = String(params['sessionId'] ?? '');
          if (!this.requireOwned(conn, sessionId, id)) return;
          const result = await this.bridge.setSessionModel(
            sessionId,
            params as never,
            this.sessionCtx(conn, sessionId),
          );
          this.replySession(conn, sessionId, id, result as unknown);
          return;
        }

        case `${QWEN_METHOD_NS}session/heartbeat`: {
          const sessionId = String(params['sessionId'] ?? '');
          if (!this.requireOwned(conn, sessionId, id)) return;
          const result = this.bridge.recordHeartbeat(
            sessionId,
            this.sessionCtx(conn, sessionId),
          );
          this.replyConn(conn, id, result as unknown);
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
      logStderr(`qwen serve: /acp dispatch error (${method}): ${errMsg(err)}`);
      if (id !== undefined) {
        const { code, message } = toRpcError(err);
        const sessionId =
          typeof params['sessionId'] === 'string'
            ? (params['sessionId'] as string)
            : undefined;
        const frame = error(id, code, message);
        if (sessionId) this.replySession(conn, sessionId, id, undefined, frame);
        else conn.sendConn(frame);
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
    let iterable: AsyncIterable<BridgeEvent>;
    try {
      iterable = this.bridge.subscribeEvents(sessionId, { signal });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      conn.sendSession(
        sessionId,
        notification(`${QWEN_METHOD_NS}notify`, {
          kind: 'stream_error',
          error: message,
        }),
      );
      return;
    }
    for await (const event of iterable) {
      if (signal.aborted) break;
      // Count event delivery as connection activity so a long, quiet prompt
      // (no inbound HTTP) isn't reaped by the idle-TTL sweep.
      conn.touch();
      this.translateEvent(conn, sessionId, event);
    }
  }

  private translateEvent(
    conn: AcpConnection,
    sessionId: string,
    event: BridgeEvent,
  ): void {
    switch (event.type) {
      case 'session_update': {
        // `event.data` is the ACP `SessionNotification` (params shape).
        conn.sendSession(
          sessionId,
          notification('session/update', event.data),
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
        const id = conn.nextId();
        conn.pending.set(id, {
          sessionId,
          bridgeRequestId: data.requestId,
          kind: 'permission',
        });
        conn.sendSession(
          sessionId,
          request(id, 'session/request_permission', {
            sessionId: data.sessionId,
            toolCall: data.toolCall,
            options: data.options,
            _meta: { qwen: { requestId: data.requestId } },
          }),
        );
        return;
      }
      case 'stream_error': {
        conn.sendSession(
          sessionId,
          notification(`${QWEN_METHOD_NS}notify`, {
            kind: 'stream_error',
            ...(event.data as object),
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

  /** Resolve a client's JSON-RPC response to an agent→client request. */
  private resolveClientResponse(conn: AcpConnection, msg: JsonRpcResponse): void {
    // Our outbound request ids are strings (`_qwen_perm_N`); a client echoes
    // the same id verbatim. Anything else can't match a pending entry.
    const id = msg.id;
    if (typeof id !== 'string') return;
    const pending = conn.pending.get(id);
    if (!pending) return;
    conn.pending.delete(id);

    if ('error' in msg) {
      // Treat a client error response as a cancellation.
      this.bridge.respondToSessionPermission(
        pending.sessionId,
        pending.bridgeRequestId,
        { outcome: { outcome: 'cancelled' } } as never,
        this.sessionCtx(conn, pending.sessionId),
      );
      return;
    }
    const result = (msg as { result: unknown }).result;
    this.bridge.respondToSessionPermission(
      pending.sessionId,
      pending.bridgeRequestId,
      result as never,
      this.sessionCtx(conn, pending.sessionId),
    );
  }

  private async handlePrompt(
    conn: AcpConnection,
    sessionId: string,
    id: JsonRpcId | undefined,
    params: Record<string, unknown>,
  ): Promise<void> {
    // Park the controller on the binding so `session/cancel` and
    // session/connection teardown can abort an in-flight prompt — otherwise
    // a disconnecting client leaves the agent running, burning model quota
    // and holding the session's prompt FIFO.
    const binding = conn.getOrCreateSession(sessionId);
    const abort = new AbortController();
    binding.promptAbort = abort;
    try {
      const result = await this.bridge.sendPrompt(
        sessionId,
        params as never,
        abort.signal,
        this.sessionCtx(conn, sessionId),
      );
      if (id !== undefined) this.replySession(conn, sessionId, id, result);
    } catch (err) {
      const { code, message } = toRpcError(err);
      if (id !== undefined) {
        this.replySession(
          conn,
          sessionId,
          id,
          undefined,
          error(id, code, message),
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
    conn.sendSession(sessionId, errorFrame ?? success(id, result));
  }
}

function isObjectParams(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Re-export so tests can reference the request type without the jsonRpc path.
export type { JsonRpcRequest };
