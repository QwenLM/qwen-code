/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonClient,
  CreateSessionRequest,
  DaemonSession,
  SubscribeOptions,
  DaemonEvent,
  PromptRequest,
  PromptResult,
  DaemonSessionContextStatus,
  PermissionResponse,
  RewindSessionRequest,
  DaemonRewindResult,
  DaemonSessionSupportedCommandsStatus,
  DaemonApprovalMode,
  DaemonApprovalModeResult,
  RestoreSessionRequest,
  DaemonRestoredSession,
  DaemonCapabilities,
  DaemonSessionSummary,
} from '@qwen-code/sdk';

/** Result of spawning a new daemon bound to a workspace. */
export interface PooledDaemonSpawn {
  client: DaemonClient;
  stop: () => Promise<void>;
  workspaceCwd: string;
}

/**
 * The session-routing surface of `DaemonClient` that the gateway's routes
 * actually call through `deps.daemon` — exactly the 13 methods, signatures
 * copied verbatim from `DaemonClient` (packages/sdk-typescript/src/daemon/
 * DaemonClient.ts) so a real `DaemonClient` structurally satisfies this
 * interface with zero changes. `DaemonPool` is the other implementation: a
 * drop-in that routes each call to the pooled daemon owning the session (or
 * workspace) instead of a single daemon connection. Both are accepted
 * wherever the gateway holds `GatewayDeps.daemon`.
 */
export interface SessionDaemon {
  prompt(
    sessionId: string,
    req: PromptRequest,
    signal?: AbortSignal,
    clientId?: string,
  ): Promise<PromptResult>;
  capabilities(): Promise<DaemonCapabilities>;
  endSession(sessionId: string, clientId?: string): Promise<void>;
  subscribeEvents(
    sessionId: string,
    opts?: SubscribeOptions,
  ): AsyncGenerator<DaemonEvent>;
  respondToSessionPermission(
    sessionId: string,
    requestId: string,
    response: PermissionResponse,
    clientId?: string,
  ): Promise<boolean>;
  health(): Promise<{ status: string }>;
  createOrAttachSession(
    req: CreateSessionRequest,
    clientId?: string,
  ): Promise<DaemonSession>;
  sessionSupportedCommands(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionSupportedCommandsStatus>;
  rewindSession(
    sessionId: string,
    req: RewindSessionRequest,
    clientId?: string,
  ): Promise<DaemonRewindResult>;
  listWorkspaceSessions(workspaceCwd: string): Promise<DaemonSessionSummary[]>;
  setSessionApprovalMode(
    sessionId: string,
    mode: DaemonApprovalMode,
    opts?: { persist?: boolean; clientId?: string },
  ): Promise<DaemonApprovalModeResult>;
  sessionContext(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionContextStatus>;
  loadSession(
    sessionId: string,
    req?: RestoreSessionRequest,
    clientId?: string,
  ): Promise<DaemonRestoredSession>;
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

const DEFAULT_MAX_DAEMONS = 3;
const DEFAULT_IDLE_REAP_MS = 15 * 60_000;

/** Thrown when a session id isn't owned by any known daemon (unrecorded, or
 * its owning daemon was already reaped). Routes map this to a `404
 * session_not_found`. */
export class UnknownSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`Unknown session: ${sessionId}`);
    this.name = 'UnknownSessionError';
  }
}

/** Thrown when `getOrSpawn` needs to spawn a daemon for a new workspace but
 * the pool is at `maxDaemons` and every entry is busy (no idle victim to
 * evict). Routes map this to a `503 workspace_pool_full`. */
export class WorkspacePoolFullError extends Error {
  constructor(readonly maxDaemons: number) {
    super(`Workspace daemon pool is full (max ${maxDaemons})`);
    this.name = 'WorkspacePoolFullError';
  }
}

/**
 * Pool of `qwen serve` daemons, one per project workspace, plus the
 * always-on default daemon. Spawns/reuses a daemon per workspace cwd,
 * routes session-id-keyed calls to the daemon that owns the session, reaps
 * idle workspace daemons, and enforces a cap on concurrently running
 * workspace daemons (evicting the LRU idle one, or refusing when all are
 * busy).
 *
 * This is a drop-in for the session-routing surface of `DaemonClient` —
 * routes can hold a `DaemonPool` wherever they previously held a single
 * `DaemonClient`.
 */
export class DaemonPool implements SessionDaemon {
  private readonly byWorkspace = new Map<string, Entry>();
  private readonly spawning = new Map<string, Promise<DaemonClient>>();
  /** sessionId -> owning workspace key (`defaultWorkspaceCwd` for sessions
   * created on the default daemon). */
  private readonly ownerOf = new Map<string, string>();
  /**
   * Count of in-flight `createOrAttachSession` calls per workspace key
   * (never touched for the default workspace). Marked SYNCHRONOUSLY at
   * the very start of `createOrAttachSession`, before any `await` —
   * including before `getOrSpawn`, whose own first `await` already yields
   * a microtask even when its body resolves synchronously (an existing
   * entry's fast path). An entry can look idle (`sessions.size === 0`)
   * for the entire duration of a create's network round-trip; without
   * marking the key pending up front, a concurrent `getOrSpawn`'s cap
   * eviction could reclaim the entry mid-registration — stopping the
   * daemon while this call still returns what looks like a successful
   * `DaemonSession` whose backend is already dead.
   */
  private readonly pendingCreates = new Map<string, number>();
  private readonly now: () => number;
  private readonly maxDaemons: number;
  private readonly idleReapMs: number;
  private readonly reapTimer: ReturnType<typeof setInterval>;

  constructor(private readonly opts: DaemonPoolOptions) {
    this.now = opts.now ?? Date.now;
    this.maxDaemons = opts.maxDaemons ?? DEFAULT_MAX_DAEMONS;
    this.idleReapMs = opts.idleReapMs ?? DEFAULT_IDLE_REAP_MS;
    this.reapTimer = setInterval(() => this.reapIdle(), this.idleReapMs / 3);
    this.reapTimer.unref?.();
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

    if (this.byWorkspace.size >= this.maxDaemons) {
      this.reapIdle();
      if (this.byWorkspace.size >= this.maxDaemons) {
        this.evictLruIdle();
      }
    }

    const p = (async () => {
      try {
        const s = await this.opts.spawn(key);
        this.byWorkspace.set(key, {
          client: s.client,
          stop: s.stop,
          sessions: new Set(),
          lastUsed: this.now(),
        });
        return s.client;
      } finally {
        // Runs on both success AND rejection — a failed spawn must not
        // leave a stuck entry in `spawning` that poisons this cwd forever;
        // the next getOrSpawn(cwd) needs to be able to retry.
        this.spawning.delete(key);
      }
    })();
    this.spawning.set(key, p);
    return p;
  }

  /** An entry is idle only when it has no live sessions AND no in-flight
   * `createOrAttachSession` registering a new one on `key` — both
   * `reapIdle` and `evictLruIdle` must agree on this so a mid-create entry
   * is never reclaimed out from under its caller. */
  private isIdle(key: string, entry: Entry): boolean {
    return entry.sessions.size === 0 && !this.pendingCreates.has(key);
  }

  /** Stop the daemon, drop its entry, and scrub any of its session ids out
   * of `ownerOf` (defensive — under the current invariants an idle entry's
   * `sessions` set is already empty, but this keeps `ownerOf` from ever
   * accumulating a stale mapping if that invariant is ever violated). */
  private discardEntry(key: string, entry: Entry): void {
    for (const id of entry.sessions) {
      this.ownerOf.delete(id);
    }
    entry.stop().catch(() => {});
    this.byWorkspace.delete(key);
  }

  /** Evict the least-recently-used IDLE workspace entry to make room under
   * the cap. Throws `WorkspacePoolFullError` if every entry currently has
   * live sessions or an in-flight registration. */
  private evictLruIdle(): void {
    let lruKey: string | undefined;
    let lruEntry: Entry | undefined;
    for (const [key, entry] of this.byWorkspace) {
      if (this.isIdle(key, entry)) {
        if (!lruEntry || entry.lastUsed < lruEntry.lastUsed) {
          lruKey = key;
          lruEntry = entry;
        }
      }
    }
    if (!lruKey || !lruEntry) {
      throw new WorkspacePoolFullError(this.maxDaemons);
    }
    this.discardEntry(lruKey, lruEntry);
  }

  /** Reap every non-default entry that is idle (see `isIdle`) and has been
   * idle longer than `idleReapMs`. Safe to call directly (tests inject a
   * clock via `now`); also driven from a background timer. */
  reapIdle(): void {
    const cutoff = this.now();
    for (const [key, entry] of this.byWorkspace) {
      if (
        this.isIdle(key, entry) &&
        cutoff - entry.lastUsed > this.idleReapMs
      ) {
        this.discardEntry(key, entry);
      }
    }
  }

  // -- Session routing ------------------------------------------------

  /** Resolve the owning daemon for a session id. Bumps the entry's
   * `lastUsed` (a live-referenced session never looks idle). Throws
   * `UnknownSessionError` for an unrecorded id, or one whose owning
   * daemon has since been reaped. */
  private daemonForSession(id: string): DaemonClient {
    const key = this.ownerOf.get(id);
    if (key === undefined) throw new UnknownSessionError(id);
    if (key === this.opts.defaultWorkspaceCwd) return this.opts.defaultDaemon;
    const e = this.byWorkspace.get(key);
    if (!e) throw new UnknownSessionError(id); // daemon was reaped
    e.lastUsed = this.now();
    return e.client;
  }

  private removeSession(id: string): void {
    const key = this.ownerOf.get(id);
    if (key === undefined) return;
    this.ownerOf.delete(id);
    if (key === this.opts.defaultWorkspaceCwd) return; // never reaped
    const entry = this.byWorkspace.get(key);
    if (!entry) return;
    entry.sessions.delete(id);
    if (entry.sessions.size === 0) {
      entry.lastUsed = this.now();
    }
  }

  /** Resolve (spawn if needed) the daemon for `req.workspaceCwd`, create or
   * attach the session there, and record which daemon owns the returned
   * session id so later session-keyed calls route correctly.
   *
   * `key` is marked pending in `pendingCreates` SYNCHRONOUSLY, before the
   * `getOrSpawn` await — not after it resolves. Even when `getOrSpawn`
   * resolves an already-spawned entry (no internal await needed), `await
   * this.getOrSpawn(...)` still defers the rest of this function to a
   * later microtask; marking pending only after that await would leave a
   * window where a concurrent `getOrSpawn`'s cap eviction can see this
   * entry as idle (`sessions.size === 0`) and reclaim it mid-registration
   * — stopping the daemon while this call still returns what looks like a
   * successful `DaemonSession`. */
  async createOrAttachSession(
    req: CreateSessionRequest,
    clientId?: string,
  ): Promise<DaemonSession> {
    const key = this.isDefault(req.workspaceCwd)
      ? this.opts.defaultWorkspaceCwd
      : req.workspaceCwd!;
    const tracksPending = key !== this.opts.defaultWorkspaceCwd;
    if (tracksPending) {
      this.pendingCreates.set(key, (this.pendingCreates.get(key) ?? 0) + 1);
    }
    try {
      const client = await this.getOrSpawn(req.workspaceCwd);
      const session = await client.createOrAttachSession(req, clientId);
      this.ownerOf.set(session.sessionId, key);
      this.byWorkspace.get(key)?.sessions.add(session.sessionId);
      return session;
    } finally {
      if (tracksPending) {
        const n = (this.pendingCreates.get(key) ?? 1) - 1;
        if (n <= 0) this.pendingCreates.delete(key);
        else this.pendingCreates.set(key, n);
      }
    }
  }

  /**
   * `session_died` and `session_closed` are the SDK's own definition of a
   * session-lifecycle terminal — see `isSessionLifecycleTerminal` in
   * `@qwen-code/sdk`'s `daemon/events.ts` (`type === 'session_died' ||
   * type === 'session_closed'`) — so both reliably mean the daemon session
   * itself ended; pruning on them lets the entry become reapable.
   *
   * `client_evicted` is deliberately NOT included here, despite also being
   * a stream-terminal frame. `daemon/events.ts`'s own doc on
   * `DaemonSessionViewState.alive` says plainly: "For client_evicted and
   * stream_error this only describes the current stream, not the remote
   * daemon session's lifetime." Pruning on it would be actively wrong: a
   * slow SSE consumer can get evicted from ITS OWN stream while the
   * session is still alive on the daemon (and possibly still attached to
   * OTHER clients); treating that as session-terminal would drop the id
   * from tracking and let `reapIdle`/`evictLruIdle` reclaim (and `stop()`)
   * a daemon that is still serving a live session out from under those
   * other clients — worse than the wedge this pruning exists to prevent.
   */
  async *subscribeEvents(
    sessionId: string,
    opts: SubscribeOptions = {},
  ): AsyncGenerator<DaemonEvent> {
    const client = this.daemonForSession(sessionId);
    for await (const event of client.subscribeEvents(sessionId, opts)) {
      if (event.type === 'session_died' || event.type === 'session_closed') {
        this.removeSession(sessionId);
      }
      yield event;
    }
  }

  async prompt(
    sessionId: string,
    req: PromptRequest,
    signal?: AbortSignal,
    clientId?: string,
  ): Promise<PromptResult> {
    return this.daemonForSession(sessionId).prompt(
      sessionId,
      req,
      signal,
      clientId,
    );
  }

  async sessionContext(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionContextStatus> {
    return this.daemonForSession(sessionId).sessionContext(sessionId, clientId);
  }

  async respondToSessionPermission(
    sessionId: string,
    requestId: string,
    response: PermissionResponse,
    clientId?: string,
  ): Promise<boolean> {
    return this.daemonForSession(sessionId).respondToSessionPermission(
      sessionId,
      requestId,
      response,
      clientId,
    );
  }

  async endSession(sessionId: string, clientId?: string): Promise<void> {
    await this.daemonForSession(sessionId).endSession(sessionId, clientId);
    this.removeSession(sessionId);
  }

  async rewindSession(
    sessionId: string,
    req: RewindSessionRequest,
    clientId?: string,
  ): Promise<DaemonRewindResult> {
    return this.daemonForSession(sessionId).rewindSession(
      sessionId,
      req,
      clientId,
    );
  }

  async sessionSupportedCommands(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionSupportedCommandsStatus> {
    return this.daemonForSession(sessionId).sessionSupportedCommands(
      sessionId,
      clientId,
    );
  }

  async setSessionApprovalMode(
    sessionId: string,
    mode: DaemonApprovalMode,
    opts?: { persist?: boolean; clientId?: string },
  ): Promise<DaemonApprovalModeResult> {
    return this.daemonForSession(sessionId).setSessionApprovalMode(
      sessionId,
      mode,
      opts,
    );
  }

  async loadSession(
    sessionId: string,
    req: RestoreSessionRequest = {},
    clientId?: string,
  ): Promise<DaemonRestoredSession> {
    return this.daemonForSession(sessionId).loadSession(
      sessionId,
      req,
      clientId,
    );
  }

  // -- Daemon-global (default daemon) ----------------------------------

  health(): Promise<{ status: string }> {
    return this.opts.defaultDaemon.health();
  }

  capabilities(): Promise<DaemonCapabilities> {
    return this.opts.defaultDaemon.capabilities();
  }

  listWorkspaceSessions(workspaceCwd: string): Promise<DaemonSessionSummary[]> {
    return this.opts.defaultDaemon.listWorkspaceSessions(workspaceCwd);
  }

  /** Live pooled daemons (excl. default). */
  size() {
    return this.byWorkspace.size;
  }

  workspaces() {
    return [...this.byWorkspace.keys()];
  }
}
