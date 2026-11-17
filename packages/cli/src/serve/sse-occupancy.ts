/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request, Response } from 'express';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import type { DaemonLogger } from './daemon-logger.js';
import type { SseAdmissionCaps } from './daemon-status.js';
import {
  listenerIdentityOf,
  type ListenerKind,
} from './local-control/listener-identity.js';

/**
 * Long-lived stream surfaces that pin one HTTP listener slot per connection
 * (issue #17554). `restEvents` is the original `GET /session/:id/events`
 * stream; the rest were invisible to the SSE occupancy gauge and admission
 * cap before this module unified them. `acpWs` is not SSE, but a WebSocket
 * connection pins a listener slot exactly like a stream, so it counts here
 * too — the gauge measures slots, not frames.
 */
export type SseStreamSurface =
  | 'restEvents'
  | 'agentEvents'
  | 'generation'
  | 'artifactLibrary'
  | 'hostedEvents'
  | 'acpSse'
  | 'acpWs';

export interface StreamOccupancySnapshot {
  total: number;
  bySurface: Record<SseStreamSurface, number>;
  byListener: Record<ListenerKind, number>;
}

// Module-level state, matching the placement of the `activeSseCount` this
// module generalizes: direct embeds in one process share the counters, and
// tests assert before/after deltas.
const bySurface: Record<SseStreamSurface, number> = {
  restEvents: 0,
  agentEvents: 0,
  generation: 0,
  artifactLibrary: 0,
  hostedEvents: 0,
  acpSse: 0,
  acpWs: 0,
};
const byListener: Record<ListenerKind, number> = {
  primary: 0,
  'local-control': 0,
  'remote-access': 0,
};
let total = 0;

export function getSseOccupancy(): StreamOccupancySnapshot {
  return {
    total,
    bySurface: { ...bySurface },
    byListener: { ...byListener },
  };
}

export function getSurfaceCount(surface: SseStreamSurface): number {
  return bySurface[surface];
}

export interface SseAdmissionRefusal {
  listener: ListenerKind;
  scope: 'daemon' | 'listener';
  active: number;
  limit: number;
}

/**
 * Pure admission decision shared by the HTTP gate and the WS upgrade gate
 * (which has no Express response to refuse on). Returns the refusal details
 * when the stream must be shed, `undefined` when it may proceed. Checks the
 * daemon-wide aggregate cap first, then the arriving listener's clamp, so
 * the pairing listeners keep the same short-request headroom guarantee as
 * the primary listener.
 *
 * No reservation is taken (same window as the original REST cap): concurrent
 * handshakes already past this point can overshoot the cap by the number of
 * in-flight admissions. The listener's `maxConnections` remains the hard
 * backstop; the cap's job is to stop gradual accumulation from consuming the
 * headroom, which a reservation-free check does.
 */
export function evaluateSseAdmission(
  listener: ListenerKind,
  caps: SseAdmissionCaps | undefined,
): SseAdmissionRefusal | undefined {
  if (!caps) return undefined;
  if (caps.aggregate !== undefined && total >= caps.aggregate) {
    return { listener, scope: 'daemon', active: total, limit: caps.aggregate };
  }
  const listenerCap = caps.byListener[listener];
  if (listenerCap !== undefined && byListener[listener] >= listenerCap) {
    return {
      listener,
      scope: 'listener',
      active: byListener[listener],
      limit: listenerCap,
    };
  }
  return undefined;
}

export interface SseAdmissionCheck {
  surface: SseStreamSurface;
  req: Request;
  res: Response;
  /** Absent caps (direct embeds / unit fixtures) mean unlimited. */
  caps: SseAdmissionCaps | undefined;
  daemonLog?: DaemonLogger;
  /** Extra structured-log context, e.g. the REST route's `sessionId`. */
  logContext?: Record<string, unknown>;
}

/**
 * Admission gate shared by every HTTP stream surface. Returns `true` when
 * the stream may proceed; on saturation it sends the `503 + Retry-After: 5`
 * refusal itself and returns `false`.
 */
export function checkSseAdmission(check: SseAdmissionCheck): boolean {
  const { surface, req, res, caps, daemonLog, logContext } = check;
  const refusal = evaluateSseAdmission(listenerIdentityOf(req).kind, caps);
  if (!refusal) return true;
  refuseSseAdmission(res, { surface, ...refusal, daemonLog, logContext });
  return false;
}

function refuseSseAdmission(
  res: Response,
  refusal: SseAdmissionRefusal & {
    surface: SseStreamSurface;
    daemonLog?: DaemonLogger;
    logContext?: Record<string, unknown>;
  },
): void {
  const { surface, listener, scope, active, limit, daemonLog, logContext } =
    refusal;
  try {
    if (daemonLog) {
      daemonLog.warn('SSE connection limit reached', {
        surface,
        listener,
        scope,
        activeSseCount: active,
        limit,
        ...logContext,
      });
    } else {
      writeStderrLine(
        `qwen serve: SSE connection limit reached ` +
          `(active=${active}, limit=${limit}); ` +
          `rejecting new SSE client with 503`,
      );
    }
  } catch {
    // Diagnostics must not interfere with the rejection.
  }
  res.setHeader('Retry-After', '5');
  res.status(503).json({
    error:
      `Daemon SSE connection limit reached (${active}/${limit}). ` +
      `Retry after the Retry-After interval.`,
    code: 'sse_connection_limit_exceeded',
    limit,
    active,
    scope,
    ...(scope === 'listener' ? { listener } : {}),
  });
}

/**
 * Count one open stream against the shared occupancy. Returns an idempotent
 * `release()`. When `res` is provided the release is also hooked on
 * `res.once('close')` so the slot frees on every teardown path without
 * threading a release call through each surface's cleanup. Every HTTP
 * surface passes `res`; the REST events route additionally releases
 * explicitly in its `finalize` (idempotent, so the double path is safe) —
 * the explicit release keeps its counting timing, the close hook backstops
 * a client abort whose 'close' fired before the route's own listeners
 * registered.
 */
export function countSseStream(
  surface: SseStreamSurface,
  req: Request,
  res?: Response,
): () => void {
  const listener = listenerIdentityOf(req).kind;
  bySurface[surface] += 1;
  byListener[listener] += 1;
  total += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    bySurface[surface] -= 1;
    byListener[listener] -= 1;
    total -= 1;
  };
  if (res) {
    res.once('close', release);
    // 'close' already fired before registration (socket died between the
    // handshake and the count): release now instead of leaking the slot.
    if (res.destroyed) release();
  }
  return release;
}
