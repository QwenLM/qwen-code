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
} from './jsonRpc.js';

function logStderr(line: string): void {
  process.stderr.write(`${line}\n`);
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
   * The clientId to echo on per-session bridge calls: the one the bridge
   * stamped at create/attach (stored on the binding), falling back to the
   * connection's own id when we somehow lack a binding.
   */
  private sessionCtx(
    conn: AcpConnection,
    sessionId: string,
  ): { clientId: string } {
    const clientId =
      conn.sessions.get(sessionId)?.clientId ?? conn.clientId;
    return { clientId };
  }

  /** Build the `initialize` result advertising standard + `_qwen` caps. */
  buildInitializeResult(connectionId: string): Record<string, unknown> {
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        // Advertise qwen extensions so clients feature-detect before use.
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
      _meta: { qwen: { connectionId } },
    };
  }

  /**
   * Handle one inbound POST message. Returns nothing — every reply is
   * delivered asynchronously on a long-lived SSE stream per the RFD
   * (`POST` itself answers `202`). `initialize` is handled by the caller
   * (it mints the connection) and never reaches here.
   */
  async handle(conn: AcpConnection, msg: JsonRpcInbound): Promise<void> {
    if (isResponse(msg)) {
      this.resolveClientResponse(conn, msg);
      return;
    }
    if (!isRequest(msg) && !isNotification(msg)) return;

    const method = msg.method;
    const params = (isObjectParams(msg.params) ? msg.params : {}) as Record<
      string,
      unknown
    >;
    const id = isRequest(msg) ? msg.id : undefined;

    try {
      switch (method) {
        case 'authenticate':
          // HTTP transport authenticates via the daemon's bearer token
          // middleware; the ACP-level method is a success no-op.
          this.replyConn(conn, id, {});
          return;

        case 'session/new': {
          const cwd =
            typeof params['cwd'] === 'string'
              ? (params['cwd'] as string)
              : this.boundWorkspace;
          const session = await this.bridge.spawnOrAttach({
            workspaceCwd: cwd,
            clientId: conn.clientId,
          });
          // Record the clientId the bridge actually stamped — later
          // per-session calls MUST echo it (see SessionBinding.clientId).
          conn.getOrCreateSession(session.sessionId).clientId =
            session.clientId;
          this.replyConn(conn, id, { sessionId: session.sessionId });
          return;
        }

        case 'session/load':
        case 'session/resume': {
          const sessionId = String(params['sessionId'] ?? '');
          const cwd =
            typeof params['cwd'] === 'string'
              ? (params['cwd'] as string)
              : this.boundWorkspace;
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
          await this.bridge.closeSession(
            sessionId,
            this.sessionCtx(conn, sessionId),
          );
          conn.closeSessionStream(sessionId);
          this.replyConn(conn, id, {});
          return;
        }

        case 'session/cancel': {
          // Notification — no reply.
          const sessionId = String(params['sessionId'] ?? '');
          await this.bridge.cancelSession(
            sessionId,
            undefined,
            this.sessionCtx(conn, sessionId),
          );
          return;
        }

        case 'session/prompt': {
          await this.handlePrompt(conn, id, params);
          return;
        }

        case `${QWEN_METHOD_NS}session/set_model`: {
          const sessionId = String(params['sessionId'] ?? '');
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
      const message = err instanceof Error ? err.message : String(err);
      logStderr(`qwen serve: /acp dispatch error (${method}): ${message}`);
      if (id !== undefined) {
        const sessionId =
          typeof params['sessionId'] === 'string'
            ? (params['sessionId'] as string)
            : undefined;
        const frame = error(id, RPC.INTERNAL_ERROR, message);
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
  private resolveClientResponse(
    conn: AcpConnection,
    msg: Extract<JsonRpcInbound, { id: JsonRpcId }>,
  ): void {
    const id = (msg as { id: JsonRpcId }).id;
    if (typeof id !== 'number') return;
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
    id: JsonRpcId | undefined,
    params: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = String(params['sessionId'] ?? '');
    const abort = new AbortController();
    try {
      const result = await this.bridge.sendPrompt(
        sessionId,
        params as never,
        abort.signal,
        this.sessionCtx(conn, sessionId),
      );
      if (id !== undefined) this.replySession(conn, sessionId, id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (id !== undefined) {
        this.replySession(
          conn,
          sessionId,
          id,
          undefined,
          error(id, RPC.INTERNAL_ERROR, message),
        );
      }
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
