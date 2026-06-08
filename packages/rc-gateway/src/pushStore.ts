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
