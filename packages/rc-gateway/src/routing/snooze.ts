/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** A snooze window. `scope` is 'all' or a single push kind. */
export interface SnoozeState {
  until: number;
  scope: string;
}

/**
 * A persisted, optionally kind-scoped snooze that suppresses push for a window.
 * Modeled on PushStore (private ctor + static async open + 0600 JSON persist).
 * `nowFn` is injectable so expiry is deterministic in tests. `active()` /
 * `isSnoozed()` are synchronous and lazily clear an expired snooze in memory
 * only (no persist on read).
 */
export class SnoozeStore {
  private constructor(
    private readonly filePath: string,
    private state: SnoozeState | null,
    private readonly nowFn: () => number,
  ) {}

  static async open(
    filePath: string,
    nowFn: () => number = Date.now,
  ): Promise<SnoozeStore> {
    let state: SnoozeState | null = null;
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<SnoozeState> | null;
      if (
        parsed &&
        typeof parsed.until === 'number' &&
        Number.isFinite(parsed.until) &&
        typeof parsed.scope === 'string'
      ) {
        state = { until: parsed.until, scope: parsed.scope };
      }
    } catch {
      // Missing/corrupt file → no snooze.
    }
    return new SnoozeStore(filePath, state, nowFn);
  }

  /** Set a snooze of `durationSec` from now, scoped to `scope`. Awaits persist. */
  async snooze(durationSec: number, scope: string): Promise<SnoozeState> {
    this.state = { until: this.nowFn() + durationSec * 1000, scope };
    await this.persist();
    return this.state;
  }

  /** Clear any snooze. Awaits persist. */
  async clear(): Promise<void> {
    this.state = null;
    await this.persist();
  }

  /** Current state if active (now < until), else null (lazily clears expired). */
  active(): SnoozeState | null {
    if (this.state && this.nowFn() < this.state.until) return this.state;
    this.state = null;
    return null;
  }

  /** True if a push of `kind` is currently suppressed. */
  isSnoozed(kind: string): boolean {
    const s = this.active();
    return !!s && (s.scope === 'all' || s.scope === kind);
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const body = this.state ?? {};
    await writeFile(this.filePath, JSON.stringify(body, null, 2), {
      mode: 0o600,
    });
  }
}
