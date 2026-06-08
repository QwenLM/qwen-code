/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RcScope } from '../scopes.js';
import { APPROVE, SESSION_READ } from '../scopes.js';
import type { TokenStore } from '../tokenStore.js';
import type { PushStore } from '../pushStore.js';
import type { PushSender } from './sender.js';
import { buildPayload, type PushPayload } from './payload.js';

/**
 * Per-kind required scope. A subscription only receives a kind if its owning
 * token holds the mapped scope; scope mismatches are silently skipped (no audit
 * noise, per the design).
 */
const KIND_SCOPE: Record<string, RcScope> = {
  'permission.required': APPROVE,
  'task.completed': SESSION_READ,
};

/**
 * Scope-filtered fan-out of push payloads. The notifier resolves each
 * subscription's owning-token scopes via TokenStore.scopesFor and only calls
 * the (best-effort, never-throwing) sender when the scope gate passes.
 */
export class PushNotifier {
  constructor(
    private readonly tokens: TokenStore,
    private readonly store: PushStore,
    private readonly sender: PushSender,
  ) {}

  /** Fan a daemon event out to all scope-eligible subscriptions. */
  async notify(
    event: { type: string; data: unknown },
    ctx: { sessionId: string; sessionName?: string },
  ): Promise<void> {
    const payload = buildPayload(event, ctx);
    if (!payload) return;
    const need = KIND_SCOPE[payload.kind];
    if (!need) return;
    await Promise.all(
      this.store.listAll().map(async (r) => {
        const scopes = this.tokens.scopesFor(r.tokenId);
        if (scopes && scopes.includes(need)) {
          await this.sender.send(r, payload);
        }
      }),
    );
  }

  /** Send a synthetic payload to one token's own subscriptions (test route). */
  async notifyToken(tokenId: string, payload: PushPayload): Promise<void> {
    const need = KIND_SCOPE[payload.kind];
    if (!need) return;
    const scopes = this.tokens.scopesFor(tokenId);
    if (!scopes || !scopes.includes(need)) return;
    await Promise.all(
      this.store.listFor(tokenId).map((r) => this.sender.send(r, payload)),
    );
  }
}
