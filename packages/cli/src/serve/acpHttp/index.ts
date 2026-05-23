/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import type { HttpAcpBridge } from '@qwen-code/acp-bridge/bridgeTypes';
import { AcpDispatcher } from './dispatch.js';
import { ConnectionRegistry } from './connectionRegistry.js';
import { SseStream } from './sseStream.js';
import {
  RPC,
  error as rpcError,
  isRequest,
  parseInbound,
} from './jsonRpc.js';

export const ACP_CONNECTION_HEADER = 'acp-connection-id';
export const ACP_SESSION_HEADER = 'acp-session-id';

export interface MountAcpHttpOptions {
  boundWorkspace: string;
  /** Defaults to `process.env.QWEN_SERVE_ACP_HTTP !== '0'`. */
  enabled?: boolean;
  /** Mount path; defaults to `/acp`. */
  path?: string;
}

export interface AcpHttpHandle {
  dispose(): void;
  registry: ConnectionRegistry;
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
  const enabled =
    opts.enabled ?? process.env['QWEN_SERVE_ACP_HTTP'] !== '0';
  if (!enabled) return undefined;

  const path = opts.path ?? '/acp';
  const registry = new ConnectionRegistry();
  const dispatcher = new AcpDispatcher(bridge, opts.boundWorkspace);

  // ── POST /acp ──────────────────────────────────────────────────────
  app.post(path, async (req: Request, res: Response) => {
    const parsed = parseInbound(req.body);
    if (!parsed.ok) {
      res.status(400).json(parsed.error);
      return;
    }
    const message = parsed.message;

    // `initialize` mints a connection and replies inline (200 + JSON).
    if (isRequest(message) && message.method === 'initialize') {
      const conn = registry.create();
      res.setHeader('Acp-Connection-Id', conn.connectionId);
      res
        .status(200)
        .json(
          // success envelope: clients correlate by the request id.
          {
            jsonrpc: '2.0',
            id: message.id,
            result: dispatcher.buildInitializeResult(conn.connectionId),
          },
        );
      return;
    }

    const conn = registry.get(headerOf(req, ACP_CONNECTION_HEADER));
    if (!conn) {
      res
        .status(400)
        .json(
          rpcError(
            isRequest(message) ? message.id : null,
            RPC.INVALID_REQUEST,
            'Missing or unknown Acp-Connection-Id',
          ),
        );
      return;
    }

    // Per RFD: non-initialize POST acks 202; the reply rides an SSE stream.
    res.status(202).end();
    await dispatcher.handle(conn, message);
  });

  // ── GET /acp (SSE) ─────────────────────────────────────────────────
  app.get(path, (req: Request, res: Response) => {
    const conn = registry.get(headerOf(req, ACP_CONNECTION_HEADER));
    if (!conn) {
      res.status(400).json({ error: 'Missing or unknown Acp-Connection-Id' });
      return;
    }
    const sessionId = headerOf(req, ACP_SESSION_HEADER);

    if (!sessionId) {
      // Connection-scoped stream.
      const stream = new SseStream(res);
      stream.open();
      conn.attachConnStream(stream);
      return;
    }

    // Session-scoped stream: attach + start pumping bridge events.
    const binding = conn.getOrCreateSession(sessionId);
    const stream = new SseStream(res, () => binding.abort.abort());
    stream.open();
    conn.attachSessionStream(sessionId, stream);
    void dispatcher.pumpSessionEvents(conn, sessionId, binding.abort.signal);
  });

  // ── DELETE /acp ────────────────────────────────────────────────────
  app.delete(path, (req: Request, res: Response) => {
    const connectionId = headerOf(req, ACP_CONNECTION_HEADER);
    if (connectionId) registry.delete(connectionId);
    res.status(202).end();
  });

  return { dispose: () => registry.dispose(), registry };
}

function headerOf(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
