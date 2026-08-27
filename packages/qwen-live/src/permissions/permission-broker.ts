/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Voice-side permission handling.
 *
 * Design points carried over from the split design doc (§7):
 * - "allow always" never reaches the backend as a persistent grant. The
 *   protocol vote is always a one-shot allow; the standing rule lives here
 *   with a TTL and is applied by silently auto-answering similar requests.
 * - A request resolved elsewhere (WebShell) retracts the queued spoken ask.
 */

import type {
  BackendAdaptor,
  BackendHandle,
  PermissionOption,
} from '../adaptor/types.js';

const DEFAULT_RULE_TTL_MS = 30 * 60_000;
const MAX_RULES = 64;

export interface PendingPermission {
  requestHandle: string;
  requestId: string;
  backend: BackendHandle;
  sessionHandle: string;
  title: string;
  options: readonly PermissionOption[];
  createdAt: number;
}

export interface PermissionBrokerOptions {
  adaptor: BackendAdaptor;
  now?: () => number;
  ruleTtlMs?: number;
  log?: (
    type: 'permission.request' | 'permission.decision',
    payload: Record<string, unknown>,
  ) => void;
}

export type SpokenPermissionDecision = 'allow' | 'allow_always' | 'deny';

export interface PermissionAskEvent {
  pending: PendingPermission;
  /** True when a standing rule answered it silently — nothing to speak. */
  autoAnswered: boolean;
}

interface StandingRule {
  sessionHandle: string;
  titleKey: string;
  expiresAt: number;
}

/** Group similar requests: tool name plus the first token of its detail. */
function titleKeyOf(title: string): string {
  const [head = '', detail = ''] = title.split(':', 2);
  const firstWord = detail.trim().split(/\s+/)[0] ?? '';
  return `${head.trim().toLowerCase()}:${firstWord.toLowerCase()}`;
}

export class PermissionBroker {
  private readonly pending = new Map<string, PendingPermission>();
  private readonly pendingByRequestId = new Map<string, string>();
  private rules: StandingRule[] = [];
  private seq = 0;
  private readonly now: () => number;
  private readonly ruleTtlMs: number;

  constructor(private readonly options: PermissionBrokerOptions) {
    this.now = options.now ?? Date.now;
    this.ruleTtlMs = options.ruleTtlMs ?? DEFAULT_RULE_TTL_MS;
  }

  /**
   * A permission_request arrived from the backend. Returns what the caller
   * should do: speak the ask, or nothing (a standing rule auto-answered).
   */
  async onRequest(fields: {
    requestId: string;
    backend: BackendHandle;
    sessionHandle: string;
    title: string;
    options: readonly PermissionOption[];
  }): Promise<PermissionAskEvent> {
    const pending: PendingPermission = {
      requestHandle: `req_${++this.seq}`,
      requestId: fields.requestId,
      backend: fields.backend,
      sessionHandle: fields.sessionHandle,
      title: fields.title,
      options: fields.options,
      createdAt: this.now(),
    };
    this.pending.set(pending.requestHandle, pending);
    this.pendingByRequestId.set(pending.requestId, pending.requestHandle);
    this.options.log?.('permission.request', {
      requestHandle: pending.requestHandle,
      requestId: pending.requestId,
      session: pending.sessionHandle,
      title: pending.title,
    });

    if (this.matchesRule(pending)) {
      await this.deliver(pending, 'allow', true);
      return { pending, autoAnswered: true };
    }
    return { pending, autoAnswered: false };
  }

  /** The user answered aloud (via the respond_permission tool). */
  async respond(
    requestHandle: string,
    decision: SpokenPermissionDecision,
  ): Promise<'delivered' | 'already_resolved' | 'not_found'> {
    const pending = this.pending.get(requestHandle.trim());
    if (!pending) return 'not_found';
    if (decision === 'allow_always') {
      this.remember(pending);
    }
    return await this.deliver(
      pending,
      decision === 'deny' ? 'deny' : 'allow',
      false,
    );
  }

  /** A resolution arrived from the event stream (possibly our own vote). */
  onResolved(requestId: string): PendingPermission | undefined {
    const handle = this.pendingByRequestId.get(requestId);
    if (handle === undefined) return undefined;
    this.pendingByRequestId.delete(requestId);
    const pending = this.pending.get(handle);
    this.pending.delete(handle);
    return pending;
  }

  resolveHandle(requestHandle: string): PendingPermission | undefined {
    return this.pending.get(requestHandle.trim());
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private matchesRule(pending: PendingPermission): boolean {
    const now = this.now();
    this.rules = this.rules.filter((rule) => rule.expiresAt > now);
    const key = titleKeyOf(pending.title);
    return this.rules.some(
      (rule) =>
        rule.sessionHandle === pending.sessionHandle && rule.titleKey === key,
    );
  }

  private remember(pending: PendingPermission): void {
    this.rules.push({
      sessionHandle: pending.sessionHandle,
      titleKey: titleKeyOf(pending.title),
      expiresAt: this.now() + this.ruleTtlMs,
    });
    while (this.rules.length > MAX_RULES) this.rules.shift();
  }

  private async deliver(
    pending: PendingPermission,
    decision: 'allow' | 'deny',
    auto: boolean,
  ): Promise<'delivered' | 'already_resolved'> {
    const outcome = await this.options.adaptor.respondPermission(
      pending.backend,
      pending.requestId,
      decision,
    );
    this.options.log?.('permission.decision', {
      requestHandle: pending.requestHandle,
      requestId: pending.requestId,
      decision,
      auto,
      outcome,
    });
    if (outcome === 'delivered' || outcome === 'already_resolved') {
      this.pending.delete(pending.requestHandle);
      this.pendingByRequestId.delete(pending.requestId);
    }
    return outcome;
  }
}
