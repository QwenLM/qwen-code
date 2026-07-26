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
import type { PromptEventBroadcaster } from './promptEventBroadcaster.js';
import { computeBridgeHints } from '../bridges/hints.js';
import { BRIDGE } from '../scopes.js';
import { SessionWal } from '../wal.js';
import type { WalFrame } from '../wal.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/** Per-session WAL instances, keyed by sessionId. */
const walRegistry = new Map<string, SessionWal>();

function getWal(sessionId: string, walDir: string): SessionWal {
  let wal = walRegistry.get(sessionId);
  if (!wal) {
    wal = new SessionWal({ dir: walDir, sessionId });
    walRegistry.set(sessionId, wal);
  }
  return wal;
}

/**
 * GET /session/:id/events — relay the daemon's SSE stream downstream,
 * preserving event ids and forwarding Last-Event-ID. Aborts the upstream
 * subscription when the client disconnects OR when the caller's token is
 * revoked (the registry fires the same abort controller). Audits attach/detach.
 *
 * WAL integration: every daemon frame is appended to a per-session WAL so
 * that reconnecting clients can replay missed events without re-connecting to
 * the daemon. When a client reconnects with Last-Event-ID older than the WAL
 * horizon, the gateway responds 412 with a `replay_truncated` JSON body.
 */
export function createSessionEventsRoute(
  daemon: DaemonClient,
  registry: ConnectionRegistry,
  audit?: AuditRecorder,
  usageBroadcaster?: UsageTickBroadcaster,
  walDir?: string,
  promptEventBroadcaster?: PromptEventBroadcaster,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    // Reject a malformed/path-traversal-shaped id BEFORE any WAL path join
    // (getWal/SessionWal joins the raw id into a file path) or daemon call —
    // mirrors every sibling session route (fork.ts, rewind.ts, lineage.ts,
    // idleToggle.ts). Unconditional (not gated on walDir being set) so this
    // stays correct if a future deploy wires walDir where it's undefined today.
    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
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

    // WAL replay: when a client reconnects with Last-Event-ID and we have a
    // WAL directory, attempt to serve missed events from the WAL before
    // falling through to the live daemon stream.
    if (walDir !== undefined && Number.isFinite(lastEventId)) {
      const wal = getWal(sessionId, walDir);
      const replay = wal.replayFrom(lastEventId!);
      if (replay.truncated) {
        // The resume point has fallen out of the WAL; signal the client to
        // re-subscribe from the earliest available event.
        res.status(412).json({
          type: 'replay_truncated',
          data: {
            earliestAvailableId: replay.earliestAvailableId,
            reason: replay.reason,
          },
        });
        return;
      }
      // If there are buffered events, we can serve them immediately and then
      // transition to the live daemon stream below. We track the last replayed
      // id so the daemon subscription starts from there instead.
      if (replay.events.length > 0) {
        // Determine the live daemon resume cursor: the latest replayed id.
        const latestReplayed = replay.events[replay.events.length - 1]!.id;

        const abort = new AbortController();
        const tokenId = req.rcClient?.id;
        const unregister = tokenId
          ? registry.register(tokenId, abort)
          : () => {};
        req.on('close', () => abort.abort());

        let attached = false;
        let unregisterUsage = (): void => {};
        let unregisterPromptEventsWal = (): void => {};
        try {
          const iterator = daemon.subscribeEvents(sessionId, {
            lastEventId: latestReplayed,
            signal: abort.signal,
          });
          // Peek at the first live event to confirm the daemon is reachable
          // before sending 200.
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
          unregisterUsage =
            usageBroadcaster?.register(sessionId, (tick) =>
              writeUsageTick(res, tick),
            ) ?? (() => {});
          // Inject gateway-side events (e.g. stream_error / prompt_timeout).
          unregisterPromptEventsWal =
            promptEventBroadcaster?.register(sessionId, (ev) =>
              writeGatewayEvent(res, ev),
            ) ?? (() => {});
          // Emit synthetic client_joined as the first SSE frame.
          writePresenceJoined(res, actorTokenId, req.rcClient?.scopes ?? []);
          // Emit the WAL-replayed events first.
          for (const ev of replay.events) {
            writeFrame(res, ev);
          }
          // Then stream live events from the daemon.
          if (!first.done) writeFrame(res, first.value);
          for await (const ev of iterator) {
            writeFrame(res, ev);
          }
          // Daemon stream ended gracefully: emit client_left before closing.
          writePresenceLeft(res, actorTokenId, 'disconnect');
          res.end();
        } catch {
          if (abort.signal.aborted) {
            writePresenceLeft(res, actorTokenId, 'disconnect');
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
          unregisterPromptEventsWal();
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
        return;
      }
    }

    const abort = new AbortController();
    const tokenId = req.rcClient?.id;
    const unregister = tokenId ? registry.register(tokenId, abort) : () => {};
    req.on('close', () => abort.abort());

    // Resolve WAL instance once for appending throughout this connection.
    const wal = walDir !== undefined ? getWal(sessionId, walDir) : undefined;

    let attached = false;
    let unregisterUsage = (): void => {};
    let unregisterPromptEvents = (): void => {};
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
      // Inject gateway-side events (e.g. stream_error / prompt_timeout) emitted
      // by the prompt route when the execution deadline fires.
      unregisterPromptEvents =
        promptEventBroadcaster?.register(sessionId, (ev) =>
          writeGatewayEvent(res, ev),
        ) ?? (() => {});
      // Emit synthetic client_joined as the first SSE frame on this stream.
      // No id: line — synthetic frames must not advance the Last-Event-ID cursor.
      writePresenceJoined(res, actorTokenId, req.rcClient?.scopes ?? []);
      if (!first.done) {
        appendToWal(wal, first.value);
        writeFrame(res, first.value);
      }
      for await (const ev of iterator) {
        appendToWal(wal, ev);
        writeFrame(res, ev);
      }
      // Daemon stream ended gracefully: emit client_left before closing.
      writePresenceLeft(res, actorTokenId, 'disconnect');
      res.end();
    } catch {
      if (abort.signal.aborted) {
        // Client disconnected (or token evicted): try to emit client_left
        // before the socket disappears. Guard: socket may already be gone.
        writePresenceLeft(res, actorTokenId, 'disconnect');
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
      unregisterPromptEvents();
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

/**
 * Append a daemon event to the WAL if a WAL instance is available and the
 * event carries a numeric id (terminal/synthetic frames without an id are
 * not persisted since they must never advance the Last-Event-ID cursor).
 */
function appendToWal(
  wal: SessionWal | undefined,
  ev: { id?: number; v?: number; type?: string; data?: unknown },
): void {
  if (wal === undefined || ev.id === undefined) return;
  const frame: WalFrame = {
    id: ev.id,
    v: (ev as { v?: number }).v ?? 1,
    type: ev.type ?? 'unknown',
    data: ev.data,
  };
  wal.append(frame);
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
 * Write a gateway-injected event (no `id:` line — synthetic frames must not
 * advance the Last-Event-ID cursor) to the SSE stream. Used to deliver events
 * such as `stream_error` with `{ code: "prompt_timeout" }` that originate from
 * the gateway rather than the daemon. Guards against writing after stream end.
 */
function writeGatewayEvent(
  res: Response,
  ev: { type: string; data: unknown },
): void {
  if (res.writableEnded) return;
  try {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  } catch {
    // Socket already closed; ignore.
  }
}

/**
 * Write a synthetic `client_joined` frame (no `id:` line) as the very first
 * SSE frame on a newly attached stream. The client sees itself join. Synthetic:
 * must not advance the Last-Event-ID cursor.
 */
function writePresenceJoined(
  res: Response,
  tokenId: string | undefined,
  scopes: string[],
): void {
  res.write(
    `data: ${JSON.stringify({
      type: 'client_joined',
      data: {
        tokenId: tokenId ?? null,
        scopes,
        attachedAt: new Date().toISOString(),
      },
    })}\n\n`,
  );
}

/**
 * Write a synthetic `client_left` frame (no `id:` line) just before the stream
 * closes. Must be called BEFORE `res.end()` so the frame reaches the client.
 * Guards against writing to an already-ended response.
 */
function writePresenceLeft(
  res: Response,
  tokenId: string | undefined,
  reason: 'disconnect' | 'revoked' | 'evicted',
): void {
  if (res.writableEnded) return;
  try {
    res.write(
      `data: ${JSON.stringify({
        type: 'client_left',
        data: { tokenId: tokenId ?? null, reason },
      })}\n\n`,
    );
  } catch {
    // Socket already closed; ignore.
  }
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
