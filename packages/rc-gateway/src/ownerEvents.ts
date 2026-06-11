/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AuditRecord } from './auditLog.js';

/**
 * A frame broadcast on the owner-level event stream. A discriminated union so
 * future producers (e.g. a bespoke routing frame) can add variants without
 * breaking consumers; this slice ships only the audit-record variant.
 */
export type OwnerEvent = { type: 'audit'; record: AuditRecord };

export type OwnerEventHandler = (event: OwnerEvent) => void;

/**
 * Hard cap on concurrent owner subscribers — defense-in-depth atop the OWNER
 * scope gate so a bug or a misbehaving owner client can't open unbounded streams.
 */
export const MAX_OWNER_SUBSCRIBERS = 32;

/**
 * A synchronous in-memory pub/sub for owner-level events. Internal to the gateway
 * app (never exposed). `publish` runs inside the audit log's never-throw write
 * chain, so it MUST be synchronous and MUST NOT let a subscriber's failure
 * propagate.
 */
export class OwnerEventBus {
  private readonly handlers = new Set<OwnerEventHandler>();

  /** Current subscriber count. */
  get size(): number {
    return this.handlers.size;
  }

  /**
   * Register a handler. Returns an unsubscribe function, or null when the bus is
   * already at {@link MAX_OWNER_SUBSCRIBERS} (the caller should 503).
   */
  subscribe(handler: OwnerEventHandler): (() => void) | null {
    if (this.handlers.size >= MAX_OWNER_SUBSCRIBERS) return null;
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Fan an event out to every subscriber synchronously. Each handler runs in its
   * own try/catch so a throwing subscriber can neither break the others nor the
   * publisher (which is the audit write chain).
   */
  publish(event: OwnerEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // A subscriber's failure must not affect the publisher or other subs.
      }
    }
  }
}
