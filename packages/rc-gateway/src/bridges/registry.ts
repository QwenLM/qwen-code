/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** A bridge's advertised capabilities (what the chat service can render). */
export interface BridgeCapabilities {
  /** Human-facing name shown in the owner's bridge list (e.g. "Telegram"). */
  displayName: string;
  /** Can the bridge render inline action buttons (approve/deny)? */
  supportsActions: boolean;
  /** Does the chat service render markdown? */
  supportsMarkdown: boolean;
  /** Max message size the chat service accepts (0 = unknown/unbounded). */
  maxMessageBytes: number;
}

/** A registered bridge: its stable id + capabilities + the token that owns it. */
export interface BridgeRegistration extends BridgeCapabilities {
  /** The bridge's stable, self-declared id (registration is idempotent on it). */
  id: string;
  /** The bridge-scope token that registered it (for self deregister/PATCH). */
  tokenId: string;
  /** Epoch ms of the most recent register/heartbeat. */
  registeredAt: number;
}

/**
 * In-memory registry of live bridges (`add-bridge-protocol`). Registration is
 * advisory presence/capability metadata — it grants nothing — so it lives in
 * memory: a gateway restart drops it and each bridge re-registers on reconnect
 * (mirrors WorkingDeviceTracker / IdleSessionToggles). Idempotent on the bridge's
 * stable `id`. Every method is total (no I/O, never throws).
 */
export class BridgeRegistry {
  private readonly byId = new Map<string, BridgeRegistration>();

  /** Upsert a registration (register OR heartbeat — same call, idempotent). */
  register(reg: BridgeRegistration): void {
    this.byId.set(reg.id, reg);
  }

  /** The registration for `id`, or undefined. */
  get(id: string): BridgeRegistration | undefined {
    return this.byId.get(id);
  }

  /** The token id that registered `id` (for self-deregister authz), or undefined. */
  ownerTokenOf(id: string): string | undefined {
    return this.byId.get(id)?.tokenId;
  }

  /** All registrations (newest-registered first). */
  list(): BridgeRegistration[] {
    return [...this.byId.values()].sort(
      (a, b) => b.registeredAt - a.registeredAt,
    );
  }

  /** Drop a registration; returns true if it existed. */
  remove(id: string): boolean {
    return this.byId.delete(id);
  }
}
