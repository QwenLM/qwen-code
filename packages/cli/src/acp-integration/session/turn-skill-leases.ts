/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TurnSkillSnapshotLease } from '@qwen-code/qwen-code-core';

interface Reservation {
  sessionId: string;
  lease?: TurnSkillSnapshotLease;
  state: 'preparing' | 'queued' | 'running' | 'settled';
}

/** The child owns the files. A lost bridge response cannot dispose a running turn. */
export class TurnSkillLeases {
  private readonly entries = new Map<string, Reservation>();
  private readonly sweeps = new Map<string, ReturnType<typeof setTimeout>>();

  collectWhenDrained(sessionId: string, drained: () => boolean): void {
    if (this.sweeps.has(sessionId)) return;
    const deadline = Date.now() + 5 * 60_000;
    const schedule = (delay: number) => {
      if (Date.now() >= deadline) return;
      const timer = setTimeout(async () => {
        this.sweeps.delete(sessionId);
        try {
          if (drained()) {
            await this.collect(sessionId);
            return;
          }
        } catch {
          // Keep the reservation reachable for the next cleanup attempt.
        }
        schedule(5_000);
      }, delay);
      timer.unref();
      this.sweeps.set(sessionId, timer);
    };
    schedule(0);
  }

  async prepare(
    sessionId: string,
    key: string,
    capture: () => Promise<TurnSkillSnapshotLease>,
  ): Promise<string> {
    if (this.entries.has(key) || this.entries.size >= 128) {
      throw new Error('Skill snapshot reservation unavailable');
    }
    const entry: Reservation = { sessionId, state: 'preparing' };
    this.entries.set(key, entry);
    try {
      const lease = await capture();
      if (this.entries.get(key) !== entry) {
        await lease.dispose();
        throw new Error('Skill snapshot reservation closed during preparation');
      }
      entry.lease = lease;
      entry.state = 'queued';
      return lease.snapshot.digest;
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    }
  }

  claim(sessionId: string, key: string): TurnSkillSnapshotLease {
    const entry = this.entries.get(key);
    if (
      entry?.sessionId !== sessionId ||
      entry.state !== 'queued' ||
      !entry.lease
    ) {
      throw new Error('Prepared skill snapshot unavailable for this prompt');
    }
    entry.state = 'running';
    return entry.lease;
  }

  async releaseQueued(sessionId: string, key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (
      entry?.sessionId !== sessionId ||
      entry.state === 'running' ||
      entry.state === 'settled'
    )
      return;
    this.entries.delete(key);
    await entry.lease?.dispose();
  }

  settle(sessionId: string, key: string): void {
    const entry = this.entries.get(key);
    if (entry?.sessionId === sessionId && entry.state === 'running')
      entry.state = 'settled';
  }

  async collect(sessionId: string, closed = false): Promise<void> {
    const pendingSweep = this.sweeps.get(sessionId);
    if (pendingSweep) clearTimeout(pendingSweep);
    this.sweeps.delete(sessionId);
    const discarded: Array<Promise<void>> = [];
    for (const [key, entry] of this.entries) {
      if (
        entry.sessionId !== sessionId ||
        (!closed && entry.state !== 'settled')
      )
        continue;
      this.entries.delete(key);
      if (entry.lease)
        discarded.push(
          entry.lease.dispose().catch((error) => {
            this.entries.set(key, { ...entry, state: 'settled' });
            throw error;
          }),
        );
    }
    await Promise.all(discarded);
  }
}
