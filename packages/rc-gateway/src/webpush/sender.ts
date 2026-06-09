/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import webpush, { WebPushError } from 'web-push';
import type { AuditRecorder } from '../auditLog.js';
import type { PushStore, PushSubscriptionRecord } from '../pushStore.js';
import type { VapidStore } from './vapid.js';
import type { PushPayload } from './payload.js';

export interface PushTransportResult {
  statusCode: number;
}

/** Pluggable send primitive; default wraps web-push.sendNotification. */
export type PushTransport = (
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payloadJson: string,
) => Promise<PushTransportResult>;

export interface PushSenderOptions {
  transport?: PushTransport;
  /** Backoff delays between attempts. Default [1s,2s,4s,8s,16s]. */
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BACKOFF = [1000, 2000, 4000, 8000, 16000];
const MAX_ATTEMPTS = 5;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function is2xx(code: number): boolean {
  return code >= 200 && code <= 299;
}

/** HTTP statuses meaning the endpoint is gone — safe to remove the sub. */
function isGone(code: number): boolean {
  return code === 404 || code === 410;
}

/**
 * Auth/config rejections (401/403). These are NOT a dead endpoint — they mean
 * the push request itself was rejected (bad VAPID JWT signature, wrong subject,
 * application-server-key mismatch). The condition is identical across every
 * subscription, so a single VAPID misconfig would otherwise wipe the entire
 * store; we KEEP the sub and fail fast (no retry — the config won't change
 * mid-loop).
 */
function isAuthError(code: number): boolean {
  return code === 401 || code === 403;
}

/**
 * Sends one payload to one subscription with retry + dead-subscription removal.
 *
 * Classification per attempt:
 *  - 2xx                  → audit push_sent, stop.
 *  - 404 / 410            → store.remove(id) + push_subscription_expired, stop.
 *  - 401 / 403            → push_send_failed{reason:'auth_error'}, KEEP the sub,
 *                           no retry (auth/config error — see isAuthError).
 *  - 429 / 5xx / network  → retry per backoff (max 5 attempts); after the last
 *                           attempt → push_send_failed{reason:
 *                           'transient_exhausted'}, keep the subscription.
 *
 * send() is best-effort and NEVER throws (like the audit log): the entire body
 * is wrapped in an outer try/catch, and each transport call has its own inner
 * try/catch that converts a network throw into a transient statusCode 0 so the
 * retry loop continues.
 */
export class PushSender {
  private readonly transport: PushTransport;
  private readonly backoffMs: number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private vapidConfigured = false;

  constructor(
    private readonly vapid: VapidStore,
    private readonly store: PushStore,
    private readonly audit?: AuditRecorder,
    opts: PushSenderOptions = {},
  ) {
    this.transport = opts.transport ?? this.defaultTransport;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private defaultTransport: PushTransport = async (sub, payloadJson) => {
    if (!this.vapidConfigured) {
      webpush.setVapidDetails(
        this.vapid.getSubject(),
        this.vapid.getApplicationServerKey(),
        this.vapid.getKeys().privateKey,
      );
      this.vapidConfigured = true;
    }
    const res = await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      payloadJson,
    );
    return { statusCode: res.statusCode };
  };

  /** Record an audit entry, swallowing any error (never propagates). */
  private async safeAudit(
    action: 'push_sent' | 'push_send_failed' | 'push_subscription_expired',
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.audit?.record({ action, detail });
    } catch {
      // best-effort
    }
  }

  /** Best-effort send of one payload to one subscription. Never throws. */
  async send(
    record: PushSubscriptionRecord,
    payload: PushPayload,
  ): Promise<void> {
    try {
      const payloadJson = JSON.stringify(payload);
      let lastCode = 0;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        let code: number;
        try {
          const res = await this.transport(
            { endpoint: record.endpoint, keys: record.keys },
            payloadJson,
          );
          code = res.statusCode;
        } catch (err) {
          // Network/transient throw (default transport maps WebPushError, but a
          // raw throw from any transport is treated as transient).
          code =
            err instanceof WebPushError && typeof err.statusCode === 'number'
              ? err.statusCode
              : 0;
        }
        lastCode = code;

        if (is2xx(code)) {
          await this.safeAudit('push_sent', {
            subscriptionId: record.id,
            kind: payload.kind,
          });
          return;
        }

        if (isGone(code)) {
          await this.store.remove(record.id);
          await this.safeAudit('push_subscription_expired', {
            subscriptionId: record.id,
            statusCode: code,
          });
          return;
        }

        if (isAuthError(code)) {
          // Keep the sub (don't wipe the store on one VAPID misconfig) and fail
          // fast (no retry — the config won't change across the backoff window).
          await this.safeAudit('push_send_failed', {
            subscriptionId: record.id,
            kind: payload.kind,
            statusCode: code,
            reason: 'auth_error',
          });
          return;
        }

        // Transient (429 / 5xx / 0). Retry if attempts remain.
        if (attempt < MAX_ATTEMPTS - 1) {
          await this.sleep(this.backoffMs[attempt] ?? 0);
        }
      }

      await this.safeAudit('push_send_failed', {
        subscriptionId: record.id,
        kind: payload.kind,
        statusCode: lastCode,
        reason: 'transient_exhausted',
      });
    } catch {
      // Outer guard: send() is best-effort and must never throw.
    }
  }
}
