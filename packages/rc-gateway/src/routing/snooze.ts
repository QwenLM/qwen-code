/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** A single snooze window. `scope` is 'all' or a single push kind. */
export interface SnoozeEntry {
  scope: string;
  until: number;
}

/** Back-compat alias for the cycle-15 single-state shape. */
export type SnoozeState = SnoozeEntry;

/** Legacy (cycle 15) on-disk single-state shape, still read for migration. */
interface LegacySnoozeFile {
  until?: unknown;
  scope?: unknown;
}
/** Current on-disk shape: a map of scope -> until. */
interface SnoozeFile {
  snoozes?: Record<string, unknown>;
}

/**
 * Persisted, kind-scoped snoozes that suppress push for a window. Each scope
 * ('all' or a single kind) has its OWN independent window, so a user can snooze
 * permission prompts and completions for different durations simultaneously
 * (cycle 77). Modeled on PushStore (private ctor + static async open + 0600 JSON
 * persist). `nowFn` is injectable so expiry is deterministic in tests. The read
 * accessors are synchronous and lazily drop expired entries in memory (no
 * persist on read).
 */
export class SnoozeStore {
  private constructor(
    private readonly filePath: string,
    /** scope -> absolute expiry (ms). */
    private state: Map<string, number>,
    private readonly nowFn: () => number,
  ) {}

  static async open(
    filePath: string,
    nowFn: () => number = Date.now,
  ): Promise<SnoozeStore> {
    const state = new Map<string, number>();
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as (SnoozeFile & LegacySnoozeFile) | null;
      if (parsed && typeof parsed === 'object') {
        if (parsed.snoozes && typeof parsed.snoozes === 'object') {
          // Current format: a map of scope -> until.
          for (const [scope, until] of Object.entries(parsed.snoozes)) {
            if (typeof until === 'number' && Number.isFinite(until)) {
              state.set(scope, until);
            }
          }
        } else if (
          typeof parsed.until === 'number' &&
          Number.isFinite(parsed.until) &&
          typeof parsed.scope === 'string'
        ) {
          // Legacy cycle-15 single-state file → migrate to one entry.
          state.set(parsed.scope, parsed.until);
        }
      }
    } catch {
      // Missing/corrupt file → no snooze.
    }
    return new SnoozeStore(filePath, state, nowFn);
  }

  /** Drop expired entries in memory (no persist). */
  private prune(): void {
    const now = this.nowFn();
    for (const [scope, until] of this.state) {
      if (now >= until) this.state.delete(scope);
    }
  }

  /**
   * Set a snooze of `durationSec` from now for `scope`, replacing only that
   * scope's window and leaving other scopes untouched. Awaits persist.
   */
  async snooze(durationSec: number, scope: string): Promise<SnoozeEntry> {
    this.prune();
    const until = this.nowFn() + durationSec * 1000;
    this.state.set(scope, until);
    await this.persist();
    return { scope, until };
  }

  /**
   * Clear one scope (when `scope` is given) or ALL snoozes (when omitted —
   * back-compat with the cycle-15 `clear()`). Awaits persist.
   */
  async clear(scope?: string): Promise<void> {
    if (scope === undefined) {
      this.state.clear();
    } else {
      this.state.delete(scope);
    }
    await this.persist();
  }

  /** Every active snooze window (expired entries pruned), sorted by scope. */
  activeList(): SnoozeEntry[] {
    this.prune();
    return [...this.state.entries()]
      .map(([scope, until]) => ({ scope, until }))
      .sort((a, b) => a.scope.localeCompare(b.scope));
  }

  /**
   * A single representative active snooze (for back-compat with callers that
   * expect one): the 'all' window if active, else the active window ending
   * latest, else null.
   */
  active(): SnoozeEntry | null {
    const list = this.activeList();
    if (list.length === 0) return null;
    const all = list.find((e) => e.scope === 'all');
    if (all) return all;
    return list.reduce((a, b) => (b.until > a.until ? b : a));
  }

  /** True if a push of `kind` is currently suppressed (its scope or 'all'). */
  isSnoozed(kind: string): boolean {
    const now = this.nowFn();
    const all = this.state.get('all');
    if (all !== undefined && now < all) return true;
    const own = this.state.get(kind);
    return own !== undefined && now < own;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const snoozes: Record<string, number> = {};
    for (const [scope, until] of this.state) snoozes[scope] = until;
    await writeFile(this.filePath, JSON.stringify({ snoozes }, null, 2), {
      mode: 0o600,
    });
  }
}
