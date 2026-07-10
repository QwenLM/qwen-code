/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler, Response } from 'express';
import type { DaemonClient } from '@qwen-code/sdk';
import type { ConnectionRegistry } from '../connectionRegistry.js';
import type { AuditRecorder } from '../auditLog.js';
import type { UsageTickBroadcaster } from '../cost/usageTickBroadcaster.js';
import type { UsageTick } from '../cost/ingester.js';
import { computeBridgeHints } from '../bridges/hints.js';
import { BRIDGE } from '../scopes.js';

/**
 * GET /session/:id/events — relay the daemon's SSE stream downstream,
 * preserving event ids and forwarding Last-Event-ID. Aborts the upstream
 * subscription when the client disconnects OR when the caller's token is
 * revoked (the registry fires the same abort controller). Audits attach/detach.
 */
export function createSessionEventsRoute(
  daemon: DaemonClient,
  registry: ConnectionRegistry,
  audit?: AuditRecorder,
  usageBroadcaster?: UsageTickBroadcaster,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const actorTokenId = req.rcClient?.id;
    const shareId = req.rcClient?.shareId;
    const shareLabel = req.rcClient?.shareLabel;
    // Bridge presence (add-bridge-protocol): tag attach/detach so the owner's
    // /rc/events feed distinguishes a bridge joining/leaving from a normal client
    // ("Telegram-bridge attached"). The bridge attaches once per stream (not per
    // chat user), so no subActor here.
    const kind = req.rcClient?.scopes.includes(BRIDGE) ? 'bridge' : 'client';
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
    let unregisterUsage = (): void => {};
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
        shareId,
        shareLabel,
        detail: { kind },
      });
      // Inject coalesced usage_tick frames for this session (add-cost-tracking):
      // the ingester pushes ticks to the broadcaster on its 500ms timer (an await
      // boundary, never mid-frame), so a single synchronous write here can't
      // interleave with writeFrame's writes.
      unregisterUsage =
        usageBroadcaster?.register(sessionId, (tick) =>
          writeUsageTick(res, tick),
        ) ?? (() => {});
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
      unregisterUsage();
      unregister();
      if (attached) {
        void audit?.record({
          action: 'session_detached',
          actorTokenId,
          target: sessionId,
          shareId,
          shareLabel,
          detail: { kind },
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
  res.write(`data: ${JSON.stringify(enrich(ev))}\n\n`);
}

/**
 * Write a synthetic `usage_tick` frame (no `id:` — it is gateway-injected, not a
 * daemon event, so it must never advance the client's Last-Event-ID cursor). A
 * single write; fired only on the coalescer's timer, never mid-daemon-frame.
 */
function writeUsageTick(res: Response, tick: UsageTick): void {
  res.write(`data: ${JSON.stringify({ type: 'usage_tick', data: tick })}\n\n`);
}

/**
 * Gateway-side enrichment of a `permission_request` frame with `bridgeHints`
 * (add-bridge-protocol): whether the tool-call args are safe to inline into a
 * chat message. Computed here (not in the daemon — zero-edit) on the proxy path
 * so every subscriber, bridge or not, sees it; non-bridge clients ignore the
 * extra field. Other frame types pass through untouched. Returns a shallow copy
 * for permission_request so the daemon's parsed object isn't mutated.
 */
function enrich(ev: { id?: number; type?: string; data?: unknown }): unknown {
  if (ev.type !== 'permission_request') return ev;
  const data = (ev.data ?? {}) as Record<string, unknown>;
  const bridgeHints = computeBridgeHints(data['toolCall']);
  return { ...ev, data: { ...data, bridgeHints } };
}
