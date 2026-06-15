/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * APNs delivery (add-native-mobile-shells "APNs delivery pipeline"). The HTTP/2
 * call to Apple is INJECTED ({@link ApnsTransport}) so all the routing logic —
 * success audit, 410/400 subscription removal, 429/5xx backoff-retry, dead-token
 * orphan safety — is unit-tested against a fake. The live transport
 * ({@link createHttp2ApnsTransport}) is the runtime ceiling (needs real Apple
 * credentials + a device + HTTP/2 reachability to Apple) and is NOT exercised in
 * CI — same posture as the matrix-E2EE adapter.
 */

import { connect, constants as H2 } from 'node:http2';
import type { AuditRecorder } from '../auditLog.js';
import type { ApnsStore, ApnsSubscriptionRecord } from './apnsStore.js';
import { buildApnsPayload } from './apnsPayload.js';
import type { PushPayload } from '../webpush/payload.js';

export interface ApnsPostRequest {
  host: string;
  deviceToken: string;
  topic: string;
  jwt: string;
  body: string;
}

export interface ApnsTransport {
  post(req: ApnsPostRequest): Promise<{ status: number; reason?: string }>;
}

export type ApnsSendResult =
  | { ok: true }
  | { ok: false; removed: true }
  | { ok: false; retriesExhausted: true }
  | { ok: false; rejected: true };

export interface ApnsSenderOptions {
  signer: { token(): string };
  transport: ApnsTransport;
  store: ApnsStore;
  bundleId: string;
  host: string;
  audit?: AuditRecorder;
  maxAttempts?: number;
  wait?: (ms: number) => Promise<void>;
  backoffMs?: (attempt: number) => number;
  /**
   * Orphan safety (advisor's Cycle C flag): a revoked token's device must never
   * still receive a push. When provided and it returns false, the subscription is
   * removed and NO send is attempted.
   */
  isTokenLive?: (tokenId: string) => boolean;
}

const defaultWait = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    if (typeof (t as { unref?: () => void }).unref === 'function') {
      (t as { unref: () => void }).unref();
    }
  });

export class ApnsSender {
  private readonly maxAttempts: number;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly backoffMs: (attempt: number) => number;

  constructor(private readonly opts: ApnsSenderOptions) {
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.wait = opts.wait ?? defaultWait;
    this.backoffMs = opts.backoffMs ?? ((n) => Math.min(30_000, 500 * 2 ** n));
  }

  async send(
    sub: ApnsSubscriptionRecord,
    payload: PushPayload,
  ): Promise<ApnsSendResult> {
    // Orphan guard: never deliver to a device bound to a revoked token.
    if (this.opts.isTokenLive && !this.opts.isTokenLive(sub.tokenId)) {
      await this.opts.store.remove(sub.id);
      await this.opts.audit?.record({
        action: 'apns_subscription_removed',
        target: sub.tokenId,
        detail: { subscriptionId: sub.id, reason: 'token_not_live' },
      });
      return { ok: false, removed: true };
    }

    const body = JSON.stringify(buildApnsPayload(payload));
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const { status } = await this.opts.transport.post({
        host: this.opts.host,
        deviceToken: sub.deviceToken,
        topic: this.opts.bundleId,
        jwt: this.opts.signer.token(),
        body,
      });

      if (status === 200) {
        await this.opts.audit?.record({
          action: 'push_routed',
          detail: { transport: 'apns', subscriptionId: sub.id },
        });
        return { ok: true };
      }

      if (status === 410 || status === 400) {
        await this.opts.store.remove(sub.id);
        await this.opts.audit?.record({
          action: 'apns_subscription_removed',
          target: sub.tokenId,
          detail: {
            subscriptionId: sub.id,
            reason: status === 410 ? 'unregistered' : 'bad_device_token',
          },
        });
        return { ok: false, removed: true };
      }

      if (status === 429 || status >= 500) {
        if (attempt < this.maxAttempts) {
          await this.wait(this.backoffMs(attempt));
          continue;
        }
        return { ok: false, retriesExhausted: true };
      }

      // Any other 4xx: a permanent reject that is neither retryable nor a
      // device-token problem — do not retry, do not remove.
      return { ok: false, rejected: true };
    }
    return { ok: false, retriesExhausted: true };
  }
}

/**
 * The live HTTP/2 transport to Apple. POSTs to `/3/device/<deviceToken>` with the
 * documented headers; opens a fresh connection per send (a production deployment
 * would pool).
 *
 * `connectOptions` is an ESCAPE HATCH FOR TESTS ONLY: it defaults to `undefined`,
 * so production gets node's strict TLS verification against the public Apple CA
 * chain. The integration test passes its self-signed CA (or `rejectUnauthorized:
 * false`) here to point the REAL transport at an in-process HTTP/2 server — there
 * is no code path by which production silently skips cert verification.
 */
export function createHttp2ApnsTransport(
  connectOptions?: import('node:http2').SecureClientSessionOptions,
): ApnsTransport {
  return {
    post: (req) =>
      new Promise((resolve, reject) => {
        const client = connect(`https://${req.host}`, connectOptions);
        client.on('error', reject);
        const stream = client.request({
          [H2.HTTP2_HEADER_METHOD]: 'POST',
          [H2.HTTP2_HEADER_PATH]: `/3/device/${req.deviceToken}`,
          'apns-topic': req.topic,
          'apns-push-type': 'alert',
          authorization: `bearer ${req.jwt}`,
          'content-type': 'application/json',
        });
        let status = 0;
        stream.on('response', (headers) => {
          status = Number(headers[H2.HTTP2_HEADER_STATUS]) || 0;
        });
        let bodyText = '';
        stream.setEncoding('utf8');
        stream.on('data', (c) => (bodyText += c));
        stream.on('end', () => {
          client.close();
          resolve({ status, reason: bodyText || undefined });
        });
        stream.on('error', (err) => {
          client.close();
          reject(err);
        });
        stream.write(req.body);
        stream.end();
      }),
  };
}

/** APNs host for the configured environment. */
export function apnsHost(environment: 'sandbox' | 'production'): string {
  return environment === 'production'
    ? 'api.push.apple.com'
    : 'api.sandbox.push.apple.com';
}
