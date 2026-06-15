/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * APNs device-token subscriptions for the iOS native shell
 * (add-native-mobile-shells "APNs subscription registration"). Token-bound,
 * persisted as JSON at mode 0600 — mirrors {@link PushStore} (the webpush
 * sibling uses a JSON file, not sqlite, so this matches it rather than
 * introducing a second persistence story). Unique on (tokenId, deviceToken):
 * a repeat register refreshes `lastSeenAt`/`shellVersion` instead of duplicating.
 */
export interface ApnsSubscriptionRecord {
  id: string;
  tokenId: string;
  deviceToken: string;
  bundleId: string;
  shellVersion: string;
  createdAt: number;
  lastSeenAt: number;
}

interface PersistShape {
  subscriptions: ApnsSubscriptionRecord[];
}

export class ApnsStore {
  private constructor(
    private readonly filePath: string,
    private records: ApnsSubscriptionRecord[],
    private readonly nowFn: () => number,
  ) {}

  static async open(
    filePath: string,
    nowFn: () => number = Date.now,
  ): Promise<ApnsStore> {
    let records: ApnsSubscriptionRecord[] = [];
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistShape;
      if (Array.isArray(parsed.subscriptions)) records = parsed.subscriptions;
    } catch {
      // Missing/corrupt file → start empty.
    }
    return new ApnsStore(filePath, records, nowFn);
  }

  /**
   * Upsert (tokenId, deviceToken). A repeat for the same pair refreshes
   * `lastSeenAt` and `shellVersion`/`bundleId` and returns the existing row;
   * a fresh pair creates a new row. Awaits the persist before resolving.
   */
  async register(input: {
    tokenId: string;
    deviceToken: string;
    bundleId: string;
    shellVersion: string;
  }): Promise<ApnsSubscriptionRecord> {
    const now = this.nowFn();
    const existing = this.records.find(
      (r) => r.tokenId === input.tokenId && r.deviceToken === input.deviceToken,
    );
    if (existing) {
      existing.lastSeenAt = now;
      existing.shellVersion = input.shellVersion;
      existing.bundleId = input.bundleId;
      await this.persist();
      return existing;
    }
    const rec: ApnsSubscriptionRecord = {
      id: randomBytes(16).toString('hex'),
      tokenId: input.tokenId,
      deviceToken: input.deviceToken,
      bundleId: input.bundleId,
      shellVersion: input.shellVersion,
      createdAt: now,
      lastSeenAt: now,
    };
    this.records.push(rec);
    await this.persist();
    return rec;
  }

  listAll(): ApnsSubscriptionRecord[] {
    return [...this.records];
  }

  listForToken(tokenId: string): ApnsSubscriptionRecord[] {
    return this.records.filter((r) => r.tokenId === tokenId);
  }

  get(id: string): ApnsSubscriptionRecord | undefined {
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

  /**
   * Cascade-remove every subscription bound to `tokenId` (called on token
   * revocation). Returns the number removed; persists only if something changed.
   */
  async removeByToken(tokenId: string): Promise<number> {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.tokenId !== tokenId);
    const removed = before - this.records.length;
    if (removed > 0) await this.persist();
    return removed;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const body: PersistShape = { subscriptions: this.records };
    await writeFile(this.filePath, JSON.stringify(body, null, 2), {
      mode: 0o600,
    });
  }
}
