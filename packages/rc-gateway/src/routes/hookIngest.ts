/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { OwnerEventBus } from '../ownerEvents.js';
import type { AuditRecorder } from '../auditLog.js';

/** Default token-bucket sizing: 50 burst, 10/s sustained. */
const DEFAULT_BUCKET_CAPACITY = 50;
const DEFAULT_REFILL_PER_SEC = 10;

export interface HookIngestDeps {
  ownerEvents: OwnerEventBus;
  /** The persistent ingest token (agents/hookIngestToken.ts). */
  ingestToken: string;
  audit?: AuditRecorder;
  bucketCapacity?: number;
  bucketRefillPerSec?: number;
  /** Injectable clock for deterministic rate-limit tests. */
  now?: () => number;
}

/** Continuous-refill token bucket. Pure arithmetic; no timers. */
class TokenBucket {
  private tokens: number;
  private lastMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    nowMs: number,
  ) {
    this.tokens = capacity;
    this.lastMs = nowMs;
  }

  tryTake(nowMs: number): boolean {
    const elapsedSec = Math.max(0, nowMs - this.lastMs) / 1000;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsedSec * this.refillPerSec,
    );
    this.lastMs = nowMs;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Loopback remote addresses (the gateway may bind loopback OR LAN+TLS). */
function isLoopbackRemote(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** Constant-time bearer comparison against the ingest token. */
function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header || !header.startsWith('Bearer ')) return false;
  const got = Buffer.from(header.slice(7).trim(), 'utf8');
  const want = Buffer.from(expected, 'utf8');
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * POST /rc/hooks/ingest — read-only hook mirror (design: "Hook event
 * mirror"). MUST be mounted BEFORE bearerResolve: the ingest token is not
 * a TokenStore token (same early-mount reason as POST /rc/pair/redeem).
 *
 * Order of gates: loopback (403) → ingest token (401) → envelope (400) →
 * token bucket (drop, 202 { accepted: false }). Rejections are audited
 * (`hook_ingest_rejected`) and NEVER mirrored. Overflow DROPS instead of
 * 429-ing (a hook runner must never enter a retry loop); the dropped count
 * is surfaced as `dropped: n` on the NEXT mirrored frame. Frames go to the
 * OWNER events stream only — hook payloads carry tool arguments, too
 * sensitive for read-scope session streams.
 */
export function createHookIngestRoute(deps: HookIngestDeps): RequestHandler {
  const now = deps.now ?? Date.now;
  const bucket = new TokenBucket(
    deps.bucketCapacity ?? DEFAULT_BUCKET_CAPACITY,
    deps.bucketRefillPerSec ?? DEFAULT_REFILL_PER_SEC,
    now(),
  );
  let droppedSinceLastMirror = 0;

  return (req, res) => {
    if (!isLoopbackRemote(req.socket.remoteAddress ?? undefined)) {
      void deps.audit?.record({
        action: 'hook_ingest_rejected',
        detail: { reason: 'non_loopback' },
      });
      res.status(403).json({ error: 'Loopback only', code: 'loopback_only' });
      return;
    }
    if (!tokenMatches(req.headers.authorization, deps.ingestToken)) {
      void deps.audit?.record({
        action: 'hook_ingest_rejected',
        detail: { reason: 'bad_token' },
      });
      res.status(401).json({ error: 'Unauthorized', code: 'unauthorized' });
      return;
    }

    const body = (req.body ?? {}) as {
      event?: unknown;
      sessionId?: unknown;
      toolName?: unknown;
      payload?: unknown;
    };
    const validOptional = (v: unknown): v is string | undefined =>
      v === undefined || typeof v === 'string';
    if (
      typeof body.event !== 'string' ||
      body.event.length === 0 ||
      !validOptional(body.sessionId) ||
      !validOptional(body.toolName)
    ) {
      res.status(400).json({
        error: 'Invalid hook envelope',
        code: 'invalid_hook_envelope',
      });
      return;
    }

    if (!bucket.tryTake(now())) {
      droppedSinceLastMirror += 1;
      // Drop, never 429: the hook runner must not retry-loop. 202 keeps the
      // runner's fire-and-forget POST happy.
      res.status(202).json({ accepted: false, dropped: true });
      return;
    }

    const dropped = droppedSinceLastMirror;
    droppedSinceLastMirror = 0;
    deps.ownerEvents.publish({
      type: 'hook_event',
      event: body.event,
      ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
      ...(body.toolName !== undefined ? { toolName: body.toolName } : {}),
      payload: body.payload,
      ...(dropped > 0 ? { dropped } : {}),
    });
    res.status(202).json({ accepted: true });
  };
}
