/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface PushSubscriptionRecord {
  /** Random 128-bit hex id. */
  id: string;
  /** Owning gateway token id. */
  tokenId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: number;
  /**
   * Allowlist of notification kinds this subscription wants. Absent/undefined
   * → receive ALL kinds (back-compat); empty array → receive NOTHING.
   */
  prefs?: string[];
  /**
   * Per-subscription quiet window. Raw `{from, to, timezone}` strings (the
   * same shape the policy `parseTimeOfDay` validates); when `now` falls inside
   * the window the notifier suppresses this subscription. Absent → never quiet.
   */
  quietHours?: { from: string; to: string; timezone: string };
  /**
   * Per-subscription rolling-hour push cap (anti-fatigue). Absent → the notifier
   * applies `DEFAULT_MAX_PER_HOUR` (30). Validated to an integer in [1, 240] at
   * the route before being stored.
   */
  maxPerHour?: number;
}

interface PersistShape {
  subscriptions: PushSubscriptionRecord[];
}

/**
 * Token-bound push subscriptions, persisted as JSON at mode 0600. Modeled on
 * TokenStore (private ctor + static async open). add() de-dups by
 * (tokenId, endpoint) and awaits the persist before resolving (durability).
 */
export class PushStore {
  private constructor(
    private readonly filePath: string,
    private records: PushSubscriptionRecord[],
    private readonly nowFn: () => number,
  ) {}

  static async open(
    filePath: string,
    nowFn: () => number = Date.now,
  ): Promise<PushStore> {
    let records: PushSubscriptionRecord[] = [];
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistShape;
      if (Array.isArray(parsed.subscriptions)) records = parsed.subscriptions;
    } catch {
      // Missing/corrupt file → start empty.
    }
    return new PushStore(filePath, records, nowFn);
  }

  /**
   * Enroll (tokenId, subscription). Idempotent: re-adding the same
   * (tokenId, endpoint) returns the existing record unchanged.
   */
  async add(
    tokenId: string,
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  ): Promise<PushSubscriptionRecord> {
    const existing = this.records.find(
      (r) => r.tokenId === tokenId && r.endpoint === sub.endpoint,
    );
    if (existing) return existing;

    const rec: PushSubscriptionRecord = {
      id: randomBytes(16).toString('hex'),
      tokenId,
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      createdAt: this.nowFn(),
    };
    this.records.push(rec);
    await this.persist();
    return rec;
  }

  listFor(tokenId: string): PushSubscriptionRecord[] {
    return this.records.filter((r) => r.tokenId === tokenId);
  }

  listAll(): PushSubscriptionRecord[] {
    return [...this.records];
  }

  get(id: string): PushSubscriptionRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  /**
   * Set (or clear) a subscription's notification prefs; persists. Returns false
   * if the id is absent. `prefs === undefined` removes the field so the record
   * reads "receive all"; otherwise a copy of the array is stored.
   */
  async setPrefs(id: string, prefs: string[] | undefined): Promise<boolean> {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return false;
    if (prefs === undefined) {
      delete rec.prefs;
    } else {
      rec.prefs = [...prefs];
    }
    await this.persist();
    return true;
  }

  /**
   * Set (or clear) a subscription's quiet window; persists. Returns false if
   * the id is absent. `undefined` removes the field (never quiet); otherwise a
   * fresh `{from, to, timezone}` copy of the (already-validated) strings is
   * stored.
   */
  async setQuietHours(
    id: string,
    quietHours: { from: string; to: string; timezone: string } | undefined,
  ): Promise<boolean> {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return false;
    if (quietHours === undefined) {
      delete rec.quietHours;
    } else {
      rec.quietHours = {
        from: quietHours.from,
        to: quietHours.to,
        timezone: quietHours.timezone,
      };
    }
    await this.persist();
    return true;
  }

  /**
   * Set (or clear) a subscription's `maxPerHour` cap; persists. Returns false if
   * the id is absent. `undefined` removes the field (→ the notifier's default
   * cap); otherwise the (already-validated) integer is stored.
   */
  async setMaxPerHour(
    id: string,
    maxPerHour: number | undefined,
  ): Promise<boolean> {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return false;
    if (maxPerHour === undefined) {
      delete rec.maxPerHour;
    } else {
      rec.maxPerHour = maxPerHour;
    }
    await this.persist();
    return true;
  }

  /** Remove by id; persists. Returns false if absent. */
  async remove(id: string): Promise<boolean> {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    if (this.records.length === before) return false;
    await this.persist();
    return true;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const body: PersistShape = { subscriptions: this.records };
    await writeFile(this.filePath, JSON.stringify(body, null, 2), {
      mode: 0o600,
    });
  }
}
