/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Application, Request, Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import type { HttpAcpBridge } from '@qwen-code/acp-bridge/bridgeTypes';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import type { DaemonWorkspaceService } from '../workspace-service/types.js';
import type { WorkspaceFileSystemFactory } from '../fs/index.js';
import type { DeviceFlowRegistry } from '../auth/device-flow.js';
import { AcpDispatcher } from './dispatch.js';
import {
  ConnectionRegistry,
  type AcpConnection,
} from './connection-registry.js';
import { SseStream } from './sse-stream.js';
import { WsStream } from './ws-stream.js';
import type { RateLimitTier } from '../rate-limit.js';
import { RPC, error as rpcError, isRequest, parseInbound } from './json-rpc.js';

export const ACP_CONNECTION_HEADER = 'acp-connection-id';
export const ACP_SESSION_HEADER = 'acp-session-id';

/**
 * Grace window after the connection-scoped SSE stream closes before the
 * connection is reaped (if not reconnected and no session stream is live).
 * Long enough to ride out a transient blip / reconnect, short enough to free
 * `ownedSessions` + a `maxConnections` slot well before the 30-min idle TTL.
 */
const CONN_GRACE_MS = 10_000;

const WS_EXEMPT_METHODS = new Set([
  '_qwen/session/heartbeat',
  '_qwen/session/update_metadata',
]);

const WS_READ_METHODS = new Set([
  'session/list',
  '_qwen/session/context',
  '_qwen/session/supported_commands',
  '_qwen/session/context_usage',
  '_qwen/session/tasks',
  '_qwen/workspace/mcp',
  '_qwen/workspace/skills',
  '_qwen/workspace/providers',
  '_qwen/workspace/env',
  '_qwen/workspace/preflight',
  '_qwen/workspace/tools',
  '_qwen/workspace/mcp/tools',
  '_qwen/workspace/agents/list',
  '_qwen/workspace/agents/get',
  '_qwen/workspace/memory',
  '_qwen/workspace/auth/status',
  '_qwen/workspace/auth/device_flow/get',
  '_qwen/file/read',
  '_qwen/file/read_bytes',
  '_qwen/file/stat',
  '_qwen/file/list',
  '_qwen/file/glob',
]);

export interface MountAcpHttpOptions {
  boundWorkspace: string;
  workspace: DaemonWorkspaceService;
  fsFactory?: WorkspaceFileSystemFactory;
  deviceFlowRegistry?: DeviceFlowRegistry;
  enabled?: boolean;
  path?: string;
  maxConnections?: number;
  /** Bearer token for WS auth (WS bypasses Express middleware). */
  token?: string;
  /** Effective direct session shell policy for ACP initialize/dispatch. */
  sessionShellCommandEnabled?: boolean;
  /** Rate limit checker for WS messages (WS bypasses Express middleware). */
  checkRate?: (key: string, tier: RateLimitTier) => boolean;
}

export interface AcpHttpHandle {
  dispose(): void;
  registry: ConnectionRegistry;
  /** Attach HTTP server post-listen to enable WebSocket upgrade. */
  attachServer(server: import('node:http').Server): void;
}

/**
 * Mount the official ACP Streamable HTTP transport (RFD #721) on an
 * existing Express app, backed by the shared `HttpAcpBridge`. Additive:
 * the REST surface (`/session/*`) is untouched (design doc §6).
 *
 * Wire shape (single `/acp` endpoint):
 *   - POST   {initialize}  → 200 + capabilities JSON + `Acp-Connection-Id`
 *   - POST   {other}       → 202; reply delivered on a long-lived SSE stream
 *   - GET    (conn header) → connection-scoped SSE stream
 *   - GET    (conn+session)→ session-scoped SSE stream
 *   - DELETE               → 202; tears the connection down
 */
export function mountAcpHttp(
  app: Application,
  bridge: HttpAcpBridge,
  opts: MountAcpHttpOptions,
): AcpHttpHandle | undefined {
  const enabled = opts.enabled ?? process.env['QWEN_SERVE_ACP_HTTP'] !== '0';
  if (!enabled) return undefined;

  const path = opts.path ?? '/acp';
  const dispatcher = new AcpDispatcher(
    bridge,
    opts.boundWorkspace,
    opts.workspace,
    opts.fsFactory,
    opts.deviceFlowRegistry,
    opts.sessionShellCommandEnabled === true,
  );
  // When a session/connection tears down with a permission still pending,
  // cancel it on the bridge so the agent's prompt isn't left blocked.
  const registry = new ConnectionRegistry(
    (req, clientId) => dispatcher.cancelAbandonedPermission(req, clientId),
    // Best-effort bridge detach so a torn-down connection's bridge-stamped
    // client ids don't linger in the bridge's voter/known-client sets.
    (sessionId, clientId) => {
      void bridge.detachClient(sessionId, clientId).catch((err: unknown) => {
        writeStderrLine(
          `qwen serve: /acp detachClient(${sessionId}) failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    },
    opts.maxConnections,
  );

  // ── POST /acp ──────────────────────────────────────────────────────
  app.post(path, async (req: Request, res: Response) => {
    // RFD: Content-Type MUST be application/json; otherwise 415.
    const ct = req.headers['content-type'];
    if (!ct || !ct.startsWith('application/json')) {
      res.status(415).json({ error: 'Content-Type must be application/json' });
      return;
    }
    // RFD: batch JSON-RPC arrays → 501 Not Implemented.
    if (Array.isArray(req.body)) {
      res
        .status(501)
        .json({ error: 'Batch JSON-RPC requests are not supported' });
      return;
    }
    const parsed = parseInbound(req.body);
    if (!parsed.ok) {
      writeStderrLine(
        `qwen serve: /acp malformed request from ${req.socket?.remoteAddress}: ${parsed.error.error.message}`,
      );
      res.status(400).json(parsed.error);
      return;
    }
    const message = parsed.message;

    // `initialize` mints a connection and replies inline (200 + JSON).
    if (isRequest(message) && message.method === 'initialize') {
      const conn = registry.create(isLoopbackReq(req));
      if (!conn) {
        // Connection cap reached — shed load rather than grow unbounded.
        writeStderrLine(
          `qwen serve: /acp connection cap reached (max=${registry.connectionCap}), rejecting initialize`,
        );
        res.setHeader('Retry-After', '5');
        res
          .status(503)
          .json(
            rpcError(
              message.id,
              RPC.INTERNAL_ERROR,
              'Too many ACP connections; retry later',
            ),
          );
        return;
      }
      const requestedVersion =
        message.params &&
        typeof message.params === 'object' &&
        !Array.isArray(message.params)
          ? (message.params as Record<string, unknown>)['protocolVersion']
          : undefined;
      res.setHeader('Acp-Connection-Id', conn.connectionId);
      res.status(200).json({
        // success envelope: clients correlate by the request id.
        jsonrpc: '2.0',
        id: message.id,
        result: dispatcher.buildInitializeResult(
          conn.connectionId,
          requestedVersion,
        ),
      });
      writeStderrLine(
        `qwen serve: /acp connection established ${conn.connectionId.slice(0, 8)} ` +
          `(loopback=${conn.fromLoopback}, active=${registry.size})`,
      );
      return;
    }

    const connHeader = headerOf(req, ACP_CONNECTION_HEADER);
    if (!connHeader) {
      res
        .status(400)
        .json(
          rpcError(
            isRequest(message) ? message.id : null,
            RPC.INVALID_REQUEST,
            'Missing Acp-Connection-Id',
          ),
        );
      return;
    }
    const conn = registry.get(connHeader);
    if (!conn) {
      res
        .status(404)
        .json(
          rpcError(
            isRequest(message) ? message.id : null,
            RPC.INVALID_REQUEST,
            'Unknown Acp-Connection-Id',
          ),
        );
      return;
    }

    // Rate limit ACP HTTP POST (mirrors the WS checkRate path).
    if (opts.checkRate && isRequest(message)) {
      const m = message.method;
      if (!WS_EXEMPT_METHODS.has(m)) {
        const tier: RateLimitTier =
          m === 'session/prompt' || m === '_qwen/session/prompt'
            ? 'prompt'
            : WS_READ_METHODS.has(m)
              ? 'read'
              : 'mutation';
        const httpKey = (req.socket?.remoteAddress ?? 'http-unknown').replace(
          /^::ffff:/,
          '',
        );
        if (!opts.checkRate(httpKey, tier)) {
          res.setHeader('Retry-After', '5');
          res.status(429).json({
            error: 'Rate limit exceeded',
            code: 'rate_limit_exceeded',
            tier,
          });
          return;
        }
      }
    }

    // Per RFD: non-initialize POST acks 202; the reply rides an SSE stream.
    res.status(202).end();
    // Response already sent — `handle` delivers everything else over SSE, so
    // swallow+log any late rejection rather than let it escape as an
    // unhandled rejection (which could take the daemon down).
    await dispatcher
      .handle(
        conn,
        message,
        headerOf(req, ACP_SESSION_HEADER),
        isLoopbackReq(req),
      )
      .catch((err: unknown) => {
        writeStderrLine(
          `qwen serve: /acp handle error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  });

  // ── GET /acp (SSE) ─────────────────────────────────────────────────
  app.get(path, (req: Request, res: Response) => {
    // RFD: Accept MUST include text/event-stream; otherwise 406.
    const accept = req.headers['accept'] ?? '';
    if (!accept.includes('text/event-stream')) {
      res
        .status(406)
        .json({ error: 'Accept header must include text/event-stream' });
      return;
    }
    const connHeader = headerOf(req, ACP_CONNECTION_HEADER);
    if (!connHeader) {
      res.status(400).json({ error: 'Missing Acp-Connection-Id' });
      return;
    }
    const conn = registry.get(connHeader);
    if (!conn) {
      res.status(404).json({ error: 'Unknown Acp-Connection-Id' });
      return;
    }
    const sessionId = headerOf(req, ACP_SESSION_HEADER);

    if (!sessionId) {
      // Connection-scoped stream. onClose logs the disconnect so a
      // half-dead connection (conn stream gone, replies silently buffering)
      // leaves an operator breadcrumb.
      const connId = conn.connectionId;
      const stream = new SseStream(
        res,
        () => {
          writeStderrLine(
            `qwen serve: /acp connection stream closed (${connId.slice(0, 8)})`,
          );
          // Grace-period reap: a dead connection otherwise locks its
          // ownedSessions + counts against maxConnections for the full 30-min
          // idle TTL. After the grace window, reap UNLESS a reconnect
          // re-attached the conn stream (clears the timer) OR a session
          // stream is still live (client is active — only the conn stream
          // blipped, don't kill its sessions/prompts).
          conn.clearGraceTimer();
          conn.connGraceTimer = setTimeout(() => {
            if (
              registry.get(connId) === conn &&
              conn.connStream === stream &&
              !conn.hasLiveSessionStream()
            ) {
              writeStderrLine(
                `qwen serve: /acp reaping connection ${connId.slice(0, 8)} (conn stream gone, no live session stream)`,
              );
              registry.delete(connId);
            }
          }, CONN_GRACE_MS);
          conn.connGraceTimer.unref?.();
        },
        () => conn.touch(),
      );
      stream.open();
      conn.attachConnStream(stream);
      return;
    }

    // Session-scoped stream — only for a session THIS connection owns
    // (created via session/new or attached via session/load|resume). Stops
    // one connection eavesdropping on another's session event stream.
    if (!conn.ownsSession(sessionId)) {
      res.status(403).json({ error: 'Session not owned by this connection' });
      return;
    }

    // Fresh controller per stream so a reconnect gets a live (non-aborted)
    // signal; `attachSessionStream` installs it and tears down any prior
    // stream/subscription. onClose aborts THIS stream's controller — a
    // stale stream closing can't cancel a newer subscription.
    const ac = new AbortController();
    const stream = new SseStream(
      res,
      () => {
        // Stream closed (tab close / network drop / crash): stop the event
        // pump AND abort any in-flight prompt for this session — otherwise
        // the agent keeps running (quota, FIFO) until idle TTL.
        ac.abort();
        // BUT only abort the prompt when THIS is still the session's live
        // stream. A reconnect already installed a newer stream — the prompt
        // must survive the old stream's close. CONTRACT: this identity guard
        // pairs with `attachSessionStream`'s install-before-close ordering
        // (connection-registry.ts) — keep both in lockstep.
        if (conn.sessions.get(sessionId)?.stream === stream) {
          conn.sessions.get(sessionId)?.promptAbort?.abort();
        }
      },
      () => conn.touch(),
    );
    // Open (write SSE headers + `retry:`) BEFORE attaching, so the protocol
    // handshake precedes any buffered frames the attach flushes.
    stream.open();
    conn.attachSessionStream(sessionId, stream, ac);
    // Identity-guarded close: only tear down if THIS stream is still the
    // session's current one (a reconnect between settle and this microtask
    // would otherwise kill the fresh stream).
    const closeIfCurrent = () => {
      if (conn.sessions.get(sessionId)?.stream === stream) {
        conn.closeSessionStream(sessionId);
      }
    };
    void dispatcher.pumpSessionEvents(conn, sessionId, ac.signal).then(
      // NORMAL completion (iterator returned `done` — subprocess ended): close
      // so the stream isn't a zombie heartbeating with nothing left to deliver.
      closeIfCurrent,
      (err: unknown) => {
        writeStderrLine(
          `qwen serve: /acp event pump error (${sessionId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        closeIfCurrent();
      },
    );
  });

  // ── DELETE /acp ────────────────────────────────────────────────────
  app.delete(path, (req: Request, res: Response) => {
    const connectionId = headerOf(req, ACP_CONNECTION_HEADER);
    if (!connectionId) {
      res.status(400).json({ error: 'Missing Acp-Connection-Id' });
      return;
    }
    // NOTE: like every other route, DELETE is gated only by the bearer
    // token — the daemon's trust boundary is "holds the token for this
    // single-workspace daemon", so any token-holder may tear down any
    // connection (same posture as the REST `DELETE /session/:id`). A
    // per-connection secret would add intra-token isolation; deferred with
    // the rest of the multi-tenant hardening (design §7).
    const existed = registry.delete(connectionId);
    if (existed) {
      writeStderrLine(
        `qwen serve: /acp connection deleted ${connectionId.slice(0, 8)} (remaining=${registry.size})`,
      );
    }
    res.status(202).end();
  });

  // ── WebSocket upgrade (ACP RFD) ────────────────────────────────────
  let wss: WebSocketServer | undefined;
  let upgradeListener:
    | ((req: IncomingMessage, socket: Duplex, head: Buffer) => void)
    | undefined;
  let upgradeServer: import('node:http').Server | undefined;

  function setupWebSocket(httpServer: import('node:http').Server): void {
    if (wss) return;
    wss = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 });
    upgradeServer = httpServer;
    const expectedTokenHash = opts.token
      ? createHash('sha256').update(opts.token).digest()
      : undefined;

    upgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      let url: URL;
      try {
        url = new URL(
          req.url ?? '/',
          `http://${req.headers.host ?? 'localhost'}`,
        );
      } catch {
        socket.destroy();
        return;
      }
      if (url.pathname !== path) {
        socket.destroy();
        return;
      }

      const fromLoopback = isLoopbackSocket(socket);

      // Host allowlist: mirror REST surface's hostAllowlist middleware
      // (auth.ts:196). Prevents DNS-rebinding attacks where a malicious
      // domain resolves to 127.0.0.1 and the browser sends the
      // attacker's Host header. Match the full host:port string like
      // the REST middleware does; extract port from the socket.
      if (fromLoopback) {
        const host = (req.headers['host'] ?? '').toLowerCase();
        const localPort = (socket as { localPort?: number }).localPort;
        const allowed = new Set([
          `localhost:${localPort}`,
          `127.0.0.1:${localPort}`,
          `[::1]:${localPort}`,
          `host.docker.internal:${localPort}`,
        ]);
        if (!allowed.has(host)) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      // CSRF: reject cross-origin WS upgrades. Browser-initiated requests
      // to 127.0.0.1 carry the external origin, so this check must apply
      // to loopback too (CSWSH defence).
      const origin = req.headers['origin'];
      if (origin) {
        try {
          const originHost = new URL(origin).hostname.replace(/^\[|\]$/g, '');
          if (
            originHost !== '127.0.0.1' &&
            originHost !== 'localhost' &&
            originHost !== '::1'
          ) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
          }
        } catch {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      // Auth: WS bypasses Express middleware. Same posture as REST:
      // loopback without token = allow; non-loopback/token-mismatch = reject.
      if (opts.token) {
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.includes(' ')) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        const scheme = authHeader
          .slice(0, authHeader.indexOf(' '))
          .toLowerCase();
        const credentials = authHeader
          .slice(authHeader.indexOf(' ') + 1)
          .trim();
        const actual = createHash('sha256').update(credentials).digest();
        if (
          scheme !== 'bearer' ||
          !expectedTokenHash ||
          !timingSafeEqual(expectedTokenHash, actual)
        ) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      } else if (!fromLoopback) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        let initialized = false;
        const initTimer = setTimeout(() => {
          if (!initialized) {
            writeStderrLine(
              `qwen serve: /acp WS initialize timeout (30s) from ${rawAddr}`,
            );
            ws.close(1002, 'Initialize timeout');
          }
        }, 30_000);
        initTimer.unref?.();
        let connRef: AcpConnection | undefined;
        let messageQueue = Promise.resolve();
        const rawAddr =
          (socket as unknown as { remoteAddress?: string }).remoteAddress ??
          'ws-unknown';
        const wsKey = rawAddr.startsWith('::ffff:')
          ? rawAddr.slice(7)
          : rawAddr;

        ws.on('error', (err) => {
          writeStderrLine(
            `qwen serve: /acp WS error: ${err instanceof Error ? err.message : String(err)}`,
          );
        });

        ws.on('message', (rawData: Buffer | string) => {
          messageQueue = messageQueue
            .then(() => handleWsMessage(rawData))
            .catch((err) => {
              writeStderrLine(
                `qwen serve: /acp WS message handler error: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        });

        async function handleWsMessage(
          rawData: Buffer | string,
        ): Promise<void> {
          let text: string;
          try {
            text =
              typeof rawData === 'string' ? rawData : rawData.toString('utf8');
          } catch {
            ws.close(1003, 'Only text frames supported');
            return;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            ws.send(
              JSON.stringify(rpcError(null, RPC.PARSE_ERROR, 'Parse error')),
            );
            return;
          }

          if (Array.isArray(parsed)) {
            ws.send(
              JSON.stringify({
                error: 'Batch JSON-RPC not supported',
              }),
            );
            return;
          }

          const inbound = parseInbound(parsed);
          if (!inbound.ok) {
            ws.send(JSON.stringify(inbound.error));
            return;
          }
          const message = inbound.message;

          if (!initialized) {
            if (!isRequest(message) || message.method !== 'initialize') {
              ws.send(
                JSON.stringify(
                  rpcError(
                    isRequest(message) ? message.id : null,
                    RPC.INVALID_REQUEST,
                    'First message must be initialize',
                  ),
                ),
              );
              ws.close(1002, 'Protocol error');
              return;
            }

            const conn = registry.create(fromLoopback);
            if (!conn) {
              ws.send(
                JSON.stringify(
                  rpcError(
                    message.id,
                    RPC.INTERNAL_ERROR,
                    'Too many connections',
                  ),
                ),
              );
              ws.close(1013, 'Connection cap');
              return;
            }

            const requestedVersion =
              message.params &&
              typeof message.params === 'object' &&
              !Array.isArray(message.params)
                ? (message.params as Record<string, unknown>)['protocolVersion']
                : undefined;

            // WS: single socket serves as conn stream + all session streams.
            const stream = new WsStream(
              ws,
              () => {
                writeStderrLine(
                  `qwen serve: /acp WS closed (${conn.connectionId.slice(0, 8)})`,
                );
                registry.delete(conn.connectionId);
              },
              () => conn.touch(),
            );
            conn.attachConnStream(stream);

            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                result: dispatcher.buildInitializeResult(
                  conn.connectionId,
                  requestedVersion,
                ),
              }),
            );

            initialized = true;
            clearTimeout(initTimer);
            connRef = conn;
            writeStderrLine(
              `qwen serve: /acp WS established ${conn.connectionId.slice(0, 8)} (loopback=${fromLoopback}, active=${registry.size})`,
            );
            return;
          }

          // Subsequent messages
          const conn = connRef;
          if (!conn || conn.destroyed) {
            ws.send(
              JSON.stringify(
                rpcError(null, RPC.INTERNAL_ERROR, 'Connection lost'),
              ),
            );
            ws.close(1011, 'Connection lost');
            return;
          }

          // Lazy session stream attachment for WS
          if (
            isRequest(message) &&
            message.params &&
            typeof message.params === 'object'
          ) {
            const sid = (message.params as Record<string, unknown>)[
              'sessionId'
            ];
            if (typeof sid === 'string' && conn.ownsSession(sid)) {
              const binding = conn.sessions.get(sid);
              if (
                binding &&
                !binding.stream &&
                conn.connStream &&
                !conn.connStream.isClosed
              ) {
                const ac = new AbortController();
                conn.attachSessionStream(sid, conn.connStream, ac);
                const myAbort = ac;
                const cleanupSession = () => {
                  const b = conn.sessions.get(sid);
                  if (b?.stream === conn.connStream && b?.abort === myAbort) {
                    conn.closeSessionStream(sid);
                  }
                };
                void dispatcher
                  .pumpSessionEvents(conn, sid, ac.signal)
                  .then(cleanupSession, (err: unknown) => {
                    writeStderrLine(
                      `qwen serve: /acp WS pump error (${sid}): ${err instanceof Error ? err.message : String(err)}`,
                    );
                    cleanupSession();
                  });
              }
            }
          }

          if (opts.checkRate && isRequest(message)) {
            const m = message.method;
            if (WS_EXEMPT_METHODS.has(m)) {
              // Heartbeat + metadata update: exempt from rate limiting
              // (mirrors REST resolveTier returning null for heartbeat)
            } else {
              const tier: RateLimitTier =
                m === 'session/prompt' || m === '_qwen/session/prompt'
                  ? 'prompt'
                  : WS_READ_METHODS.has(m)
                    ? 'read'
                    : 'mutation';
              if (!opts.checkRate(wsKey, tier)) {
                ws.send(
                  JSON.stringify(
                    rpcError(
                      message.id,
                      RPC.INTERNAL_ERROR,
                      'Rate limit exceeded',
                    ),
                  ),
                );
                return;
              }
            }
          }

          // Prompt is long-running (minutes); awaiting it would block
          // permission votes and cancel requests queued behind it → deadlock.
          // Fire-and-forget so the message queue stays unblocked.
          const isPrompt =
            isRequest(message) &&
            (message.method === 'session/prompt' ||
              message.method === '_qwen/session/prompt');
          const dispatchP = dispatcher
            .handle(conn, message, undefined, fromLoopback)
            .catch((err: unknown) => {
              writeStderrLine(
                `qwen serve: /acp WS handle error: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          if (!isPrompt) await dispatchP;
        }
      });
    };
    httpServer.on('upgrade', upgradeListener!);

    writeStderrLine(`qwen serve: /acp WebSocket transport enabled on ${path}`);
  }

  return {
    dispose: () => {
      if (upgradeServer && upgradeListener) {
        upgradeServer.removeListener('upgrade', upgradeListener);
        upgradeListener = undefined;
        upgradeServer = undefined;
      }
      registry.dispose();
      if (wss) {
        wss.close();
        wss = undefined;
      }
    },
    registry,
    attachServer(server: import('node:http').Server) {
      setupWebSocket(server);
    },
  };
}

function headerOf(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * True when the request's KERNEL-stamped peer address is loopback. Mirrors
 * the REST surface's `detectFromLoopback` (NOT derived from forgeable
 * headers like `X-Forwarded-For`). Replicated here rather than imported
 * from `server.ts` to avoid a server↔acp-http import cycle.
 */
function isLoopbackSocket(socket: Duplex): boolean {
  const addr = (socket as unknown as { remoteAddress?: string }).remoteAddress;
  if (typeof addr !== 'string') return false;
  return (
    addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.')
  );
}

function isLoopbackReq(req: Request): boolean {
  const addr = req.socket?.remoteAddress;
  if (typeof addr !== 'string') return false;
  // Match the REST surface's `detectFromLoopback`: the full 127.0.0.0/8
  // range + the IPv4-mapped block, not just three exact literals (a
  // container peer on 127.0.0.2 is legal loopback).
  return (
    addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.')
  );
}
