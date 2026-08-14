/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonClient } from '@qwen-code/sdk';

/** Result of spawning a new daemon bound to a workspace. */
export interface PooledDaemonSpawn {
  client: DaemonClient;
  stop: () => Promise<void>;
  workspaceCwd: string;
}

export interface DaemonPoolOptions {
  /** The boot daemon, already running, used when a create omits cwd. */
  defaultDaemon: DaemonClient;
  defaultWorkspaceCwd: string;
  /** Spawn a NEW daemon bound to `cwd`; returns once it is reachable. */
  spawn: (cwd: string) => Promise<PooledDaemonSpawn>;
  maxDaemons?: number; // default 3
  idleReapMs?: number; // default 15*60_000
  now?: () => number; // injectable clock (default Date.now)
}

interface Entry {
  client: DaemonClient;
  stop: () => Promise<void>;
  sessions: Set<string>;
  lastUsed: number;
}

/**
 * Pool of `qwen serve` daemons, one per project workspace, plus the
 * always-on default daemon. This task covers only spawn/reuse-by-workspace
 * and default-daemon routing; session-id routing, idle reaping, and the
 * pool cap land in a later task.
 */
export class DaemonPool {
  private readonly byWorkspace = new Map<string, Entry>();
  private readonly spawning = new Map<string, Promise<DaemonClient>>();
  private readonly now: () => number;

  constructor(private readonly opts: DaemonPoolOptions) {
    this.now = opts.now ?? Date.now;
  }

  private isDefault(cwd?: string) {
    return !cwd || cwd === this.opts.defaultWorkspaceCwd;
  }

  /** Reachable daemon for `cwd` (spawn if new). Empty/undefined → default. */
  async getOrSpawn(cwd?: string): Promise<DaemonClient> {
    if (this.isDefault(cwd)) return this.opts.defaultDaemon;
    const key = cwd!;
    const existing = this.byWorkspace.get(key);
    if (existing) {
      existing.lastUsed = this.now();
      return existing.client;
    }
    const inflight = this.spawning.get(key);
    if (inflight) return inflight;
    const p = (async () => {
      const s = await this.opts.spawn(key);
      this.byWorkspace.set(key, {
        client: s.client,
        stop: s.stop,
        sessions: new Set(),
        lastUsed: this.now(),
      });
      this.spawning.delete(key);
      return s.client;
    })();
    this.spawning.set(key, p);
    return p;
  }

  /** Live pooled daemons (excl. default). */
  size() {
    return this.byWorkspace.size;
  }

  workspaces() {
    return [...this.byWorkspace.keys()];
  }
}
