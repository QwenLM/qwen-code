/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler, Response } from 'express';
import type { DaemonClient } from '@qwen-code/sdk';
import type { ConnectionRegistry } from '../connectionRegistry.js';
import type { AuditRecorder } from '../auditLog.js';

/**
 * GET /rc/session/:id/events — relay the daemon's SSE stream downstream,
 * preserving event ids and forwarding Last-Event-ID. Aborts the upstream
 * subscription when the client disconnects OR when the caller's token is
 * revoked (the registry fires the same abort controller). Audits attach/detach.
 */
export function createSessionEventsRoute(
  daemon: DaemonClient,
  registry: ConnectionRegistry,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const actorTokenId = req.rcClient?.id;
    const lastEventIdRaw = req.headers['last-event-id'];
    const lastEventId =
      typeof lastEventIdRaw === 'string' && lastEventIdRaw.length > 0
        ? Number(lastEventIdRaw)
        : undefined;

    const abort = new AbortController();
    const tokenId = req.rcClient?.id;
    const unregister = tokenId ? registry.register(tokenId, abort) : () => {};
    req.on('close', () => abort.abort());

    let attached = false;
    try {
      const iterator = daemon.subscribeEvents(sessionId, {
        lastEventId: Number.isFinite(lastEventId) ? lastEventId : undefined,
        signal: abort.signal,
      });
      const first = await iterator.next();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      attached = true;
      void audit?.record({
        action: 'session_attached',
        actorTokenId,
        target: sessionId,
      });
      if (!first.done) writeFrame(res, first.value);
      for await (const ev of iterator) {
        writeFrame(res, ev);
      }
      res.end();
    } catch {
      if (abort.signal.aborted) {
        res.end();
      } else if (!res.headersSent) {
        res.status(502).json({
          error: 'Daemon unavailable',
          code: 'daemon_unavailable',
        });
      } else {
        res.end();
      }
    } finally {
      unregister();
      if (attached) {
        void audit?.record({
          action: 'session_detached',
          actorTokenId,
          target: sessionId,
        });
      }
    }
  };
}

function writeFrame(
  res: Response,
  ev: { id?: number; type?: string; data?: unknown },
): void {
  if (ev.id !== undefined) res.write(`id: ${ev.id}\n`);
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
}
