/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { OwnerEvent, OwnerEventBus } from '../ownerEvents.js';

/** Heartbeat comment interval — keeps proxies alive + surfaces a dead socket. */
const HEARTBEAT_MS = 25_000;

/**
 * GET /rc/events — a live, OWNER-scoped stream of every audit record. Mounted
 * behind requireScope(OWNER); the frame is the audit record itself (a live audit
 * feed), so `policy_decision` / `policy_reloaded` / `policy_reload_failed` and
 * every other security event flow through with zero producer-side coupling.
 *
 * No upstream iterator to await (unlike the per-session relay), so headers are
 * sent immediately after subscribing. Backpressure-safe: a wedged client (a
 * slept laptop) would otherwise buffer `auth_failed` storms in memory, so on
 * `res.write() === false` the subscriber DROPS frames until `'drain'` and then
 * emits one `resync` marker (the durable record is always queryable via
 * /rc/audit). The bus cap (503) bounds concurrent streams.
 */
export function createOwnerEventsRoute(bus: OwnerEventBus): RequestHandler {
  return (req, res) => {
    // Drop, never buffer unboundedly: while the socket is full we skip frames
    // and count them, replaying a single resync marker once it drains.
    let dropping = false;
    let dropped = 0;

    const handler = (event: OwnerEvent): void => {
      if (dropping) {
        dropped++;
        return;
      }
      const ok = res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (!ok) {
        dropping = true;
        res.once('drain', () => {
          dropping = false;
          if (dropped > 0) {
            res.write(
              `event: resync\ndata: ${JSON.stringify({ dropped })}\n\n`,
            );
            dropped = 0;
          }
        });
      }
    };

    // Subscribe BEFORE writeHead so a capacity rejection is a clean JSON 503,
    // not a half-open stream. No await between here and writeHead, so no publish
    // can race in before the headers are sent.
    const unsubscribe = bus.subscribe(handler);
    if (!unsubscribe) {
      res.status(503).json({
        error: 'Too many event streams',
        code: 'too_many_streams',
      });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // Push headers out now and disable Nagle so each small SSE frame is sent
    // immediately (live delivery, not batched until the socket fills/closes).
    res.flushHeaders?.();
    req.socket?.setNoDelay?.(true);
    res.write(': ok\n\n');

    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    // Don't let the heartbeat keep the process (or a test) alive.
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  };
}
