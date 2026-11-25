/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TurnSkillSnapshotLease } from '@qwen-code/qwen-code-core';

interface Reservation {
  sessionId: string;
  lease?: TurnSkillSnapshotLease;
  drained?: () => boolean;
  state: 'preparing' | 'queued' | 'running' | 'settled';
}

/** The child owns the files. A lost bridge response cannot dispose a running turn. */
export class TurnSkillLeases {
  private readonly entries = new Map<string, Reservation>();
  private readonly sweeps = new Map<string, ReturnType<typeof setTimeout>>();

  private scheduleCollection(sessionId: string, delay: number): void {
    if (this.sweeps.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.sweeps.delete(sessionId);
      void this.collect(sessionId).catch(() => {
        this.scheduleCollection(sessionId, 5_000);
      });
    }, delay);
    timer.unref();
    this.sweeps.set(sessionId, timer);
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
    if (entry.lease) {
      try {
        await entry.lease.dispose();
      } catch (error) {
        entry.state = 'settled';
        this.entries.set(key, entry);
        this.scheduleCollection(sessionId, 5_000);
        throw error;
      }
    }
  }

  settle(sessionId: string, key: string, drained?: () => boolean): void {
    const entry = this.entries.get(key);
    if (entry?.sessionId !== sessionId || entry.state !== 'running') return;
    entry.state = 'settled';
    entry.drained = drained;
    this.scheduleCollection(sessionId, 0);
  }

  async collect(sessionId: string, closed = false): Promise<void> {
    const pendingSweep = this.sweeps.get(sessionId);
    if (pendingSweep) clearTimeout(pendingSweep);
    this.sweeps.delete(sessionId);
    const discarded: Array<Promise<void>> = [];
    for (const [key, entry] of this.entries) {
      if (
        entry.sessionId !== sessionId ||
        entry.state === 'running' ||
        (!closed && entry.state !== 'settled')
      )
        continue;
      if (entry.state === 'settled' && entry.drained) {
        // Capture the original Session object. Reopening the same public id
        // cannot clear a detached shell, workflow or subagent from its old turn.
        let drained = false;
        try {
          drained = entry.drained();
        } catch {
          /* keep until verifiable */
        }
        if (!drained) {
          this.scheduleCollection(sessionId, 5_000);
          continue;
        }
      }
      this.entries.delete(key);
      if (entry.lease)
        discarded.push(
          entry.lease.dispose().catch((error) => {
            this.entries.set(key, { ...entry, state: 'settled' });
            this.scheduleCollection(sessionId, 5_000);
            throw error;
          }),
        );
    }
    await Promise.all(discarded);
  }
}
