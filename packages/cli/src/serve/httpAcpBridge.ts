/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk';
import {
  EventBus,
  type BridgeEvent,
  type SubscribeOptions,
} from './eventBus.js';
import type {
  CancelNotification,
  Client,
  PromptRequest,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SetSessionModelRequest,
  SetSessionModelResponse,
  Stream,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

/**
 * Stage 1 HTTP→ACP bridge.
 *
 * Per design §08 (Roadmap, Stage 1) and the issue body's Caveat:
 *   - Each session spawns its own `qwen --acp` child process.
 *   - HTTP request bodies are forwarded as ACP NDJSON over the child's stdin.
 *   - Child stdout NDJSON notifications publish onto each session's
 *     `EventBus`; HTTP SSE subscribers (`GET /session/:id/events`) drain
 *     it. Cross-client fan-out + `Last-Event-ID` reconnect supported.
 *   - Multi-client requests against the same session serialize through this
 *     bridge (FIFO; honors ACP's "one active prompt per session" invariant).
 *
 * Stage 2 replaces the spawn step with an in-process call into core's
 * ACP-equivalent API. The `HttpAcpBridge` interface stays the same so HTTP
 * route handlers don't need to change.
 */

export interface BridgeSpawnRequest {
  /** Absolute path to the workspace root the child inherits as cwd. */
  workspaceCwd: string;
  /** Optional explicit model service id; falls back to settings default. */
  modelServiceId?: string;
}

export interface BridgeSession {
  sessionId: string;
  workspaceCwd: string;
  /** True if this attach reused an existing session under `sessionScope: 'single'`. */
  attached: boolean;
}

/** Sparse summary used by `GET /workspace/:id/sessions`. */
export interface BridgeSessionSummary {
  sessionId: string;
  workspaceCwd: string;
}

export interface HttpAcpBridge {
  /**
   * Create a new session, or — under `sessionScope: 'single'` — attach to an
   * existing session for the same workspace.
   */
  spawnOrAttach(req: BridgeSpawnRequest): Promise<BridgeSession>;

  /**
   * Forward a prompt to the agent. Concurrent prompts against the same
   * session FIFO-serialize through a per-session queue (ACP guarantees
   * "one active prompt per session"). Throws `SessionNotFoundError` when
   * the id is unknown.
   *
   * Optional `signal` — abort cancels the in-flight prompt by sending an
   * ACP `cancel` notification to the agent (which causes the agent to
   * resolve its `prompt()` with `stopReason: 'cancelled'`). Used by the
   * SSE route to propagate `req.on('close')` so a disconnected HTTP
   * client unblocks the per-session FIFO instead of poisoning it.
   */
  sendPrompt(
    sessionId: string,
    req: PromptRequest,
    signal?: AbortSignal,
  ): Promise<PromptResponse>;

  /**
   * Cancel the in-flight prompt on the session. ACP-side this is a
   * notification, not a request — the agent acknowledges by resolving the
   * active `prompt()` with a `cancelled` stop reason. Throws
   * `SessionNotFoundError` when the id is unknown.
   */
  cancelSession(sessionId: string, req?: CancelNotification): Promise<void>;

  /**
   * Subscribe to the session's event stream. Returns an AsyncIterable that
   * yields published events; supports `Last-Event-ID` reconnect through
   * `opts.lastEventId`. Throws `SessionNotFoundError` when the id is
   * unknown.
   */
  subscribeEvents(
    sessionId: string,
    opts?: SubscribeOptions,
  ): AsyncIterable<BridgeEvent>;

  /**
   * Cast a vote on a pending `permission_request` (first-responder wins).
   * Returns true when the vote was accepted, false when the requestId is
   * unknown — either never existed or already resolved by another client.
   */
  respondToPermission(
    requestId: string,
    response: RequestPermissionResponse,
  ): boolean;

  /**
   * List all live sessions whose canonical workspace path matches the
   * supplied cwd. Empty array (not throw) when no sessions exist —
   * a session-picker UI shouldn't 404 just because the workspace is idle.
   */
  listWorkspaceSessions(workspaceCwd: string): BridgeSessionSummary[];

  /**
   * Switch the active model service for a session. Forwards through ACP's
   * (currently unstable) `unstable_setSessionModel` and broadcasts a
   * `model_switched` event so cross-client UIs reflect the change.
   * Throws `SessionNotFoundError` for unknown ids.
   */
  setSessionModel(
    sessionId: string,
    req: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse>;

  /**
   * Kill the agent process for the session and remove it from the maps.
   * Used by the HTTP route layer to reap orphans created when a client
   * disconnects mid-spawn (the server-side child kept being created
   * even though no caller will ever know the sessionId). Idempotent —
   * unknown / already-dead sessions are no-ops.
   */
  /**
   * Tear down a session — kill the child, drop from maps, publish
   * `session_died`. Idempotent on already-dead sessions.
   *
   * `requireZeroAttaches: true` makes the call a no-op when at
   * least one other client has called `spawnOrAttach` for this
   * entry and got `attached: true`. Used by the disconnect-reaper
   * in `server.ts` so a fast reattach by client B doesn't lose its
   * session to client A's "I disconnected mid-spawn" cleanup.
   */
  killSession(
    sessionId: string,
    opts?: { requireZeroAttaches?: boolean },
  ): Promise<void>;

  /** Test/inspection hook: number of live sessions. */
  readonly sessionCount: number;

  /** Test/inspection hook: number of permission requests awaiting a vote. */
  readonly pendingPermissionCount: number;

  /** Close all live child processes; called on daemon shutdown. */
  shutdown(): Promise<void>;
}

/**
 * Routes catch this to map to HTTP 404. Distinct from generic Error so the
 * route layer doesn't have to brittle-match on message text.
 */
export class SessionNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`No session with id "${sessionId}"`);
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}

/**
 * Thrown by `spawnOrAttach` when a fresh-spawn would push `sessionCount`
 * past `BridgeOptions.maxSessions`. The HTTP route maps this to 503
 * with a `Retry-After` hint. Attaches (same workspace under `single`
 * scope) never trip this — only NEW children. Distinct error type so
 * routes can branch without text-matching.
 */
export class SessionLimitExceededError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`Session limit reached (${limit})`);
    this.name = 'SessionLimitExceededError';
    this.limit = limit;
  }
}

/**
 * One ACP NDJSON channel to a single agent. Tests inject a fake by replacing
 * the channel factory; production uses `defaultSpawnChannelFactory`.
 */
export interface AcpChannel {
  stream: Stream;
  /** Best-effort terminate; resolves when teardown is complete. */
  kill(): Promise<void>;
  /**
   * Resolves when the channel has terminated for any reason — planned
   * (`kill()` called) OR unexpected (child process crashed, stream closed).
   * The bridge subscribes to this so a SessionEntry whose underlying
   * channel dies between requests is removed from `byWorkspace`/`byId`
   * instead of lingering as a stuck session.
   */
  exited: Promise<void>;
}

export type ChannelFactory = (workspaceCwd: string) => Promise<AcpChannel>;

export interface BridgeOptions {
  /**
   * §03 decision §1. `single` shares one session per workspace across HTTP
   * clients (live-collaboration default); `thread` gives each `spawnOrAttach`
   * call its own session for strict isolation.
   */
  sessionScope?: 'single' | 'thread';
  /** Channel factory; defaults to spawning `qwen --acp` as a child process. */
  channelFactory?: ChannelFactory;
  /** How long to wait for the child's `initialize` reply before giving up. */
  initializeTimeoutMs?: number;
  /**
   * Cap on concurrent live sessions. `spawnOrAttach` calls that would
   * cross this throw `SessionLimitExceededError`; attaches to an
   * existing session (same workspace under `single` scope) are not
   * counted. `0` / `Infinity` disable the cap. Defaults to 20 — see
   * `ServeOptions.maxSessions` for the rationale.
   */
  maxSessions?: number;
}

interface SessionEntry {
  sessionId: string;
  workspaceCwd: string;
  channel: AcpChannel;
  connection: ClientSideConnection;
  /** Per-session event bus drives `GET /session/:id/events`. */
  events: EventBus;
  /**
   * Tail of the per-session prompt queue. Each new prompt chains off the
   * resolved (or rejected) state of this promise so prompts run one at a
   * time in arrival order. Always resolves — failures are swallowed at the
   * tail so a prior failure doesn't block subsequent prompts; the original
   * caller still observes the rejection on its own returned promise.
   */
  promptQueue: Promise<void>;
  /**
   * Per-session model-change FIFO. Prevents two concurrent
   * `applyModelServiceId` calls (e.g. simultaneous attach-with-different-
   * model requests) from racing into `unstable_setSessionModel` and
   * leaving the agent in non-deterministic state. Always resolves —
   * failures swallowed at the tail like `promptQueue`.
   */
  modelChangeQueue: Promise<void>;
  /**
   * Cached "transport closed" promise. The first `sendPrompt` on a
   * session lazy-builds this from `channel.exited.then(throw)`; every
   * subsequent prompt's race uses the SAME promise so the listener
   * count on `channel.exited` stays at one regardless of how many
   * prompts run on the session over its lifetime.
   */
  transportClosedReject?: Promise<never>;
  /**
   * Permission requestIds belonging to this session, kept so cancelSession
   * + shutdown can resolve them as `cancelled` per ACP requirement
   * (cancelled prompt MUST resolve outstanding requestPermission with
   * outcome.cancelled).
   */
  pendingPermissionIds: Set<string>;
  /**
   * Count of times `spawnOrAttach` has returned `attached: true` for
   * this entry — i.e. a second-or-subsequent client claimed this
   * session under `sessionScope: 'single'`. Used by the disconnect-
   * reaper in `server.ts`: if the spawn-owner client disconnected
   * during the spawn handshake but another client has already
   * attached, the reaper must NOT tear the session down (option 1
   * from PR #3889 review BQ9tV — "track an attached-after-spawn
   * counter and skip kill if any other client attached"). The
   * increment + the killSession-skip-check both happen in the
   * synchronous portion of their respective async functions, so the
   * counter is observed atomically across the awaiting boundary.
   */
  attachCount: number;
}

interface PendingPermission {
  requestId: string;
  sessionId: string;
  resolve: (resp: RequestPermissionResponse) => void;
}

/**
 * Bridge `Client` implementation — the daemon's response surface for things
 * the agent asks the client (file reads/writes, permission prompts).
 *
 * Stage 1 behavior:
 *   - `requestPermission` publishes a `permission_request` event onto the
 *     session bus and awaits the first HTTP `POST /permission/:requestId`
 *     vote (first-responder wins). When the session is cancelled or the
 *     daemon shuts down, the pending promise resolves with
 *     `{ outcome: { outcome: 'cancelled' } }` per ACP spec.
 *   - `sessionUpdate` notifications publish onto the session's EventBus; SSE
 *     subscribers (`GET /session/:id/events`) drain it.
 *   - File reads/writes proxy to local fs (daemon and agent share the host).
 *
 * Stage 1 trust model: the spawned `qwen --acp` child runs as the same user
 * as the daemon, so the file-proxy methods do NOT enforce a workspace-cwd
 * sandbox. The agent could already read or write the same files via its
 * built-in tools (e.g. shell). Restricting the bridge here would be
 * theatre. Stage 4+ remote-sandbox deployments swap this `Client` for a
 * sandbox-aware variant — see issue #3803 §11.
 */
class BridgeClient implements Client {
  constructor(
    private readonly resolveEntry: () => SessionEntry | undefined,
    private readonly registerPending: (pending: PendingPermission) => void,
    /**
     * Roll back a `registerPending` call when the subsequent publish
     * fails (closed bus). Resolves the pending promise as cancelled
     * and removes it from the daemon-wide maps so a late
     * `respondToPermission` for this id returns 404 cleanly.
     */
    private readonly rollbackPending: (requestId: string) => void,
  ) {}

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const entry = this.resolveEntry();
    if (!entry) return { outcome: { outcome: 'cancelled' } };

    const requestId = randomUUID();
    return await new Promise<RequestPermissionResponse>((resolve) => {
      this.registerPending({
        requestId,
        sessionId: entry.sessionId,
        resolve,
      });
      // `publish()` returns `undefined` on a closed bus — the
      // shutdown path closes per-session buses BEFORE awaiting
      // `channel.kill()`, leaving a small window where the agent
      // can still issue `requestPermission`. If we registered the
      // pending entry above but the publish fails, no SSE
      // subscriber will ever see the request → no client can vote
      // → the pending promise never resolves → agent's
      // `requestPermission` hangs forever (a real bug, not a
      // theoretical one — the daemon's shutdown.kill() loop awaits
      // each child, and a child stuck waiting on permission would
      // pin shutdown until the kill timer expires).
      //
      // Resolve as `cancelled` immediately if the bus rejected
      // the publish. Mirrors the orphan-permission handling in
      // `registerPending` itself for the entry-already-gone case.
      const published = entry.events.publish({
        type: 'permission_request',
        data: {
          requestId,
          sessionId: entry.sessionId,
          toolCall: params.toolCall,
          options: params.options,
        },
      });
      if (!published) {
        // Roll back the pending registration and resolve cancelled.
        this.rollbackPending(requestId);
      }
    });
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const entry = this.resolveEntry();
    if (!entry) return;
    entry.events.publish({ type: 'session_update', data: params });
  }

  async writeTextFile(
    params: WriteTextFileRequest,
  ): Promise<WriteTextFileResponse> {
    // Stage 1 known divergence: this raw `fs.writeFile` reimplements file
    // I/O instead of delegating to core's filesystem service. The
    // user-visible scenarios where they differ:
    //   - BOM handling: this drops/re-encodes whatever the agent passed;
    //     core would preserve.
    //   - Non-UTF-8 source files: round-tripping through utf8 mangles
    //     content.
    //   - Original line endings: core preserves CRLF on Windows files;
    //     this writes whatever the agent buffered.
    // Wiring core's FileSystemService through the bridge requires
    // exposing it as a constructor dep; the cost-benefit is low for
    // Stage 1 (most agent-side tools call core directly, NOT through
    // these ACP fs methods) and Stage 2 in-process eliminates the
    // bridge fs proxy entirely. Tracked as a Stage 2 prerequisite.
    await fs.writeFile(params.path, params.content, 'utf8');
    return {};
  }

  async readTextFile(
    params: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    // Reject obviously-degenerate `limit` up front. Without this,
    // `sliceLineRange` hits the `end < start` path and returns an
    // unexpectedly-larger slice (or empty depending on internals).
    // ACP doesn't define semantics for limit ≤ 0, so treat as "no
    // bytes wanted".
    if (typeof params.limit === 'number' && params.limit <= 0) {
      return { content: '' };
    }
    const content = await fs.readFile(params.path, 'utf8');
    if (typeof params.line === 'number' || typeof params.limit === 'number') {
      // ACP `ReadTextFileRequest.line` is 1-based per spec — clients passing
      // `{ line: 1, limit: 2 }` mean "the first two lines", not "skip the
      // first then take two". Convert to a 0-based slice index, clamping
      // values < 1 to 0 to be tolerant of unusual inputs.
      const startLine = params.line ?? 1;
      const start = startLine > 0 ? startLine - 1 : 0;
      const end = params.limit != null ? start + params.limit : undefined;
      // Avoid `content.split('\n')` — allocating a per-line String[] for
      // a 100 MB file roughly doubles the memory footprint just to
      // extract a few lines. Manual scan walks `indexOf('\n', …)` only
      // until the end-of-range boundary is found, then slices a single
      // range of the original string. Stage 2 in-process replaces this
      // proxy entirely (the bridge stops reading user fs).
      return { content: sliceLineRange(content, start, end) };
    }
    return { content };
  }
}

const DEFAULT_INIT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_SESSIONS = 20;

export function createHttpAcpBridge(opts: BridgeOptions = {}): HttpAcpBridge {
  const sessionScope = opts.sessionScope ?? 'single';
  // `undefined` → default 20 (intentionally tight per #3803 N≈50 cliff).
  // `0` → explicitly unlimited (operator opt-out).
  // `Infinity` → unlimited (programmatic opt-out — accepted as a
  //              long-standing alias since the cap check is `>= max`).
  // `NaN` / negative → throw. A typo / parse error in CLI/config
  //                    silently disabling the daemon's only resource
  //                    guard is fail-OPEN behavior; gpt-5.5 flagged
  //                    this as critical (BRApy) — we'd rather fail
  //                    boot than serve unbounded.
  let maxSessions: number;
  if (opts.maxSessions === undefined) {
    maxSessions = DEFAULT_MAX_SESSIONS;
  } else if (Number.isNaN(opts.maxSessions)) {
    throw new TypeError(
      `Invalid maxSessions: NaN. Must be a number >= 0 ` +
        `(0 / Infinity = unlimited).`,
    );
  } else if (opts.maxSessions < 0) {
    throw new TypeError(
      `Invalid maxSessions: ${opts.maxSessions}. Must be >= 0 ` +
        `(0 / Infinity = unlimited).`,
    );
  } else if (opts.maxSessions === 0 || opts.maxSessions === Infinity) {
    maxSessions = Infinity;
  } else {
    maxSessions = opts.maxSessions;
  }
  if (sessionScope !== 'single' && sessionScope !== 'thread') {
    throw new TypeError(
      `Invalid sessionScope: ${JSON.stringify(sessionScope)}. ` +
        `Expected 'single' or 'thread'.`,
    );
  }
  const channelFactory = opts.channelFactory ?? defaultSpawnChannelFactory;
  const initTimeoutMs = opts.initializeTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  if (initTimeoutMs <= 0) {
    throw new TypeError(
      `Invalid initializeTimeoutMs: ${initTimeoutMs}. Must be > 0.`,
    );
  }

  // Single-scope reuse keyed by canonical workspace path.
  // Cleanup-on-crash: `channel.exited` (registered at line ~469) removes
  // the entry from both maps + cancels pending permissions + publishes
  // `session_died` + closes the EventBus when the child process dies
  // between requests. Stage 2's in-process bridge eliminates the
  // spawned-child failure mode entirely — but for Stage 1, the next
  // prompt against a crashed session sees `SessionNotFoundError`
  // (cleanup raced ahead of the request), not a hung channel write.
  const byWorkspace = new Map<string, SessionEntry>();
  const byId = new Map<string, SessionEntry>();
  // Daemon-wide pending permission table; requestIds are UUIDs so collisions
  // across sessions are infeasible in practice.
  const pendingPermissions = new Map<string, PendingPermission>();
  // Set by `shutdown()` so any in-flight `spawnOrAttach` that was
  // dispatched on an existing connection AFTER the shutdown snapshot
  // taken in `shutdown()` fails fast instead of creating a child the
  // shutdown path has no more visibility into. Without this, the
  // server.listen → bridge.shutdown ordering in `runQwenServe` leaves
  // a window between (a) shutdown snapshotting `byId` for kills and
  // (b) `server.close` rejecting new connections, during which a
  // late-arriving `POST /session` slips a fresh child past cleanup.
  let shuttingDown = false;
  // Coalesces concurrent `spawnOrAttach` calls for the same workspace under
  // single-scope. Without this, two parallel callers would both pass the
  // `byWorkspace.get` check, both spawn, and one entry would be orphaned
  // (in `byId` but not in `byWorkspace`) — violating the
  // "at most one session per workspace" invariant.
  const inFlightSpawns = new Map<string, Promise<BridgeSession>>();

  const registerPending = (p: PendingPermission) => {
    const entry = byId.get(p.sessionId);
    if (!entry) {
      // The session was torn down (channel.exited, killSession, shutdown)
      // between when the agent decided to ask for permission and when the
      // request reached this function. There's no SessionEntry to chain
      // the requestId onto and no SSE bus to publish `permission_request`
      // — nobody can vote, so the permission would hang the agent's
      // `requestPermission` forever. Resolve immediately as cancelled to
      // unwind the agent side; matches the shutdown / killSession path.
      p.resolve({ outcome: { outcome: 'cancelled' } });
      return;
    }
    pendingPermissions.set(p.requestId, p);
    entry.pendingPermissionIds.add(p.requestId);
  };

  /** Resolve a single pending request and clean up its bookkeeping. */
  const resolvePending = (
    requestId: string,
    response: RequestPermissionResponse,
  ): boolean => {
    const pending = pendingPermissions.get(requestId);
    if (!pending) return false;
    pendingPermissions.delete(requestId);
    const entry = byId.get(pending.sessionId);
    if (entry) {
      entry.pendingPermissionIds.delete(requestId);
      // Fan-out a follow-up event so other clients update their UI when the
      // race is decided. Best-effort — failure to publish (e.g. bus closed
      // mid-shutdown) doesn't block resolution.
      try {
        entry.events.publish({
          type: 'permission_resolved',
          data: { requestId, outcome: response.outcome },
        });
      } catch {
        /* bus closed during shutdown */
      }
    }
    pending.resolve(response);
    return true;
  };

  async function doSpawn(
    workspaceKey: string,
    modelServiceId?: string,
  ): Promise<BridgeSession> {
    const channel = await channelFactory(workspaceKey);
    let entry: SessionEntry | undefined;
    const client = new BridgeClient(
      () => entry,
      registerPending,
      (rid) =>
        // Roll back a register-then-publish-failed pending so the agent
        // doesn't hang waiting on a vote nobody can see.
        resolvePending(rid, { outcome: { outcome: 'cancelled' } }),
    );
    const connection = new ClientSideConnection(() => client, channel.stream);

    try {
      await withTimeout(
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
          },
          clientInfo: { name: 'qwen-serve-bridge', version: '0' },
        }),
        initTimeoutMs,
        'initialize',
      );
      const newSessionResp = await withTimeout(
        connection.newSession({
          cwd: workspaceKey,
          mcpServers: [],
        }),
        initTimeoutMs,
        'newSession',
      );

      // Late-shutdown re-check: shutdown() may have flipped while we
      // were in `connection.newSession` (~1s on cold start). If we
      // commit to the maps now, the snapshot in shutdown() already
      // missed this entry — child leaks past `process.exit(0)`. Tear
      // down what we have and surface to the caller.
      if (shuttingDown) {
        await channel.kill().catch(() => {});
        throw new Error('HttpAcpBridge is shutting down');
      }
      entry = {
        sessionId: newSessionResp.sessionId,
        workspaceCwd: workspaceKey,
        channel,
        connection,
        events: new EventBus(),
        promptQueue: Promise.resolve(),
        modelChangeQueue: Promise.resolve(),
        pendingPermissionIds: new Set(),
        attachCount: 0,
      };
      byWorkspace.set(workspaceKey, entry);
      byId.set(entry.sessionId, entry);

      // Cleanup if the child terminates between requests. `channel.exited`
      // resolves both for planned shutdown (we already removed the entry
      // before calling kill, so the `byId.get(...) === entry` check is
      // false and this is a no-op) AND for unplanned crashes (entry is
      // still in the maps → cancel pending permissions, publish a
      // `session_died` event so live SSE subscribers learn the session is
      // gone, close the bus, drop from maps).
      const liveEntry = entry;
      void channel.exited.then(() => {
        if (byId.get(liveEntry.sessionId) !== liveEntry) return;
        cancelPendingForSession(liveEntry.sessionId);
        try {
          liveEntry.events.publish({
            type: 'session_died',
            data: {
              sessionId: liveEntry.sessionId,
              reason: 'channel_closed',
            },
          });
        } catch {
          /* bus already closed */
        }
        byWorkspace.delete(liveEntry.workspaceCwd);
        byId.delete(liveEntry.sessionId);
        liveEntry.events.close();
      });

      // ACP `newSession` doesn't take a model id; honor the caller's
      // `modelServiceId` by issuing the unstable `setSessionModel` call
      // immediately after the session is established. Use the shared
      // `applyModelServiceId` helper so the call:
      //   - races against `transportClosedReject` (a wedged child
      //     during model switch fails fast instead of consuming the
      //     full init timeout — A09HD)
      //   - publishes `model_switched` / `model_switch_failed` to the
      //     bus so attached clients see the result
      //   - serializes through `entry.modelChangeQueue` for ordering
      //     against later attach-with-different-model calls
      //
      // On failure we DO NOT tear the session down. An earlier rev
      // tore it down so the caller "didn't inherit silent drift",
      // but that killed an already-functional session and left the
      // caller with a 500 and no sessionId to retry against. The
      // session is operational on the agent's default model — the
      // `model_switch_failed` event tells subscribers exactly what
      // happened, and the caller can retry the switch via
      // `POST /session/:id/model` once they know the sessionId.
      //
      // Swallow the rejection inline so the outer try/catch (which
      // would `channel.kill()`) doesn't fire. The publish inside
      // `applyModelServiceId` is the visible signal; the caller
      // gets a 200 and a sessionId regardless, and learns of the
      // model issue via the SSE stream.
      if (modelServiceId) {
        await applyModelServiceId(entry, modelServiceId, initTimeoutMs).catch(
          () => {
            // Already published `model_switch_failed`; don't take
            // down the session.
          },
        );
      }

      return {
        sessionId: entry.sessionId,
        workspaceCwd: entry.workspaceCwd,
        attached: false,
      };
    } catch (err) {
      await channel.kill().catch(() => {});
      throw err;
    }
  }

  /**
   * Send `unstable_setSessionModel` and broadcast a `model_switched`
   * event. Used at create-session time (via doSpawn) AND on attach when
   * the caller passes a modelServiceId — the existing session may be
   * running a different model.
   *
   * Serialized through `entry.modelChangeQueue` so two concurrent
   * attach-with-different-model requests can't race into the agent.
   * On failure, publishes a `model_switch_failed` event for cross-client
   * observability and re-throws so the HTTP caller sees the error
   * (session keeps running its previous model — that's the safer
   * default than tearing down a shared session because one client
   * asked for an unknown model).
   */
  async function applyModelServiceId(
    entry: SessionEntry,
    modelId: string,
    timeoutMs: number,
  ): Promise<void> {
    const conn = entry.connection as unknown as {
      unstable_setSessionModel(p: {
        sessionId: string;
        modelId: string;
      }): Promise<unknown>;
    };
    // Race against `transportClosedReject` so a child crash during
    // model switch fails the call immediately instead of waiting the
    // full `timeoutMs`. Matches what `sendPrompt` and `setSessionModel`
    // already do — without this, a callback-attach with a broken model
    // wedges the HTTP handler for 10s.
    const transportClosed = getTransportClosedReject(entry);
    const work = entry.modelChangeQueue.then(async () => {
      try {
        await Promise.race([
          withTimeout(
            conn.unstable_setSessionModel({
              sessionId: entry.sessionId,
              modelId,
            }),
            timeoutMs,
            'setSessionModel',
          ),
          transportClosed,
        ]);
        entry.events.publish({
          type: 'model_switched',
          data: { sessionId: entry.sessionId, modelId },
        });
      } catch (err) {
        // Surface the failure to ALL attached clients, not just the
        // caller — a shared session swallowing a denied model change
        // silently would surprise the others.
        entry.events.publish({
          type: 'model_switch_failed',
          data: {
            sessionId: entry.sessionId,
            requestedModelId: modelId,
            error: err instanceof Error ? err.message : String(err),
          },
        });
        throw err;
      }
    });
    // Tail swallows failures so subsequent model changes still run; the
    // original caller still observes the rejection on `work`.
    entry.modelChangeQueue = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  /**
   * Resolve every pending request belonging to one session as cancelled.
   *
   * **Scope contract (per ACP spec / live-collab default):**
   * Permissions are issued by the agent inline DURING an active
   * prompt — `requestPermission` returns a Promise the agent awaits
   * before continuing. Per the bridge's per-session FIFO + ACP's
   * "one active prompt per session" guarantee, ALL outstanding
   * permissions at any moment belong to the **currently active
   * prompt**. So "cancel all pending permissions for this session"
   * is equivalent to "cancel the active prompt's permissions" — and
   * that's exactly what ACP requires when a prompt is cancelled
   * ("cancelling a prompt MUST resolve outstanding requestPermission
   * calls with outcome.cancelled").
   *
   * **Multi-client live-collab caveat:** under `sessionScope: 'single'`
   * Client B may have been about to vote on A's pending permission
   * via SSE — when A disconnects mid-prompt, B's vote (if it arrives
   * after the abort) gets `404`. This is the right behavior: A's
   * prompt is being cancelled, so the permission belongs to a turn
   * that no longer matters. From B's side they see
   * `permission_resolved` with `outcome: cancelled` on the SSE
   * stream, then the prompt's `cancelled` stop reason. Voting on a
   * cancelled-prompt's permission was never going to drive the
   * agent forward anyway.
   */
  const cancelPendingForSession = (sessionId: string) => {
    const entry = byId.get(sessionId);
    if (!entry) return;
    // Snapshot ids — resolvePending mutates the underlying set.
    const ids = Array.from(entry.pendingPermissionIds);
    for (const id of ids) {
      resolvePending(id, { outcome: { outcome: 'cancelled' } });
    }
  };

  /**
   * Lazy-init the per-session `transportClosedReject` promise that
   * `sendPrompt` / `setSessionModel` / `applyModelServiceId` race their
   * ACP calls against. ONE listener is attached to `channel.exited`
   * over the session's lifetime (the first caller "wins" and creates
   * the promise; subsequent callers reuse it) — a per-call attach
   * would grow Node's listener list linearly with prompt count on
   * chatty sessions. The rejection message names the FIRST caller,
   * which can be misleading if a later method observes the failure;
   * the cost-benefit favors the single-listener invariant.
   */
  const getTransportClosedReject = (entry: SessionEntry): Promise<never> => {
    if (!entry.transportClosedReject) {
      entry.transportClosedReject = entry.channel.exited.then(() => {
        throw new Error(
          `agent channel closed mid-request (session ${entry.sessionId})`,
        );
      });
    }
    return entry.transportClosedReject;
  };

  return {
    get sessionCount() {
      return byId.size;
    },

    get pendingPermissionCount() {
      return pendingPermissions.size;
    },

    async spawnOrAttach(req) {
      if (shuttingDown) {
        // `runQwenServe.close()` calls `bridge.shutdown()` BEFORE
        // `server.close()`. During that window, established HTTP
        // connections can still hit `POST /session`. Refuse here so
        // late-arrivers don't spawn children the shutdown path won't
        // see — they'd otherwise leak past `process.exit(0)`.
        throw new Error('HttpAcpBridge is shutting down');
      }
      if (!path.isAbsolute(req.workspaceCwd)) {
        throw new Error(
          `workspaceCwd must be an absolute path; got "${req.workspaceCwd}"`,
        );
      }
      const workspaceKey = canonicalizeWorkspace(req.workspaceCwd);

      if (sessionScope === 'single') {
        const existing = byWorkspace.get(workspaceKey);
        if (existing) {
          // If the caller passed a modelServiceId on attach, the session
          // may currently be running a DIFFERENT model. Honor the request
          // by issuing setSessionModel — same call we'd use on
          // /session/:id/model. Surfaces a `model_switched` event so
          // every attached client sees the change. If the new model is
          // rejected, propagate as a spawn-style error rather than
          // silently returning an attach-with-stale-model.
          if (req.modelServiceId) {
            // Swallow: matches the create-session catch in `doSpawn`
            // below — a model-switch rejection on an already-running
            // session must NOT 500 the attach (the session is fully
            // operational on its current model; tearing it down or
            // returning an error without the sessionId would deny
            // the caller any way to recover). The
            // `model_switch_failed` SSE event is the visible signal.
            await applyModelServiceId(
              existing,
              req.modelServiceId,
              initTimeoutMs,
            ).catch(() => {});
          }
          // Bump attach counter so the spawn-owner's disconnect
          // reaper (server.ts: `requireZeroAttaches: true`) can see
          // that another client picked up this session and skip the
          // tear-down. Increment is synchronous → atomic against the
          // killSession sync-prefix check.
          existing.attachCount++;
          return {
            sessionId: existing.sessionId,
            workspaceCwd: existing.workspaceCwd,
            attached: true,
          };
        }
        // Coalesce: if another caller is already mid-spawn for this same
        // workspace, await their result. The reporter's call appears as an
        // attach (the spawn was someone else's, not theirs). If the
        // reporter asked for a different modelServiceId than the spawn
        // chose, apply it now.
        const inFlight = inFlightSpawns.get(workspaceKey);
        if (inFlight) {
          const session = await inFlight;
          if (req.modelServiceId) {
            const liveEntry = byId.get(session.sessionId);
            if (liveEntry) {
              // Same swallow as above — we picked up an in-flight
              // spawn, the session is real, model-switch failure
              // shouldn't deny us the sessionId.
              await applyModelServiceId(
                liveEntry,
                req.modelServiceId,
                initTimeoutMs,
              ).catch(() => {});
            }
          }
          // Same attach-counter bump as the direct-attach branch
          // above so the spawn-owner's disconnect reaper sees this
          // late-arriving attach. The in-flight branch is the more
          // common race target (the second caller actively waited
          // on the first caller's spawn).
          const attachedEntry = byId.get(session.sessionId);
          if (attachedEntry) attachedEntry.attachCount++;
          return { ...session, attached: true };
        }
      }

      // Cap check: count both registered sessions and in-flight spawns
      // (a fresh-spawn races that's about to register hasn't hit
      // `byId` yet but should still count toward the limit). Attaches
      // returned above bypass this — only NEW children are gated.
      if (byId.size + inFlightSpawns.size >= maxSessions) {
        throw new SessionLimitExceededError(maxSessions);
      }

      const promise = doSpawn(workspaceKey, req.modelServiceId);
      // Track in-flight spawns regardless of scope. Under `single`
      // this also serves the coalescing path above (a parallel
      // `spawnOrAttach` finds the entry and waits for the same
      // promise). Under `thread` we don't need coalescing — every
      // call gets its own session — but `shutdown()` snapshots
      // `inFlightSpawns.values()` to know which spawns to await
      // for graceful tear-down. Without this, a `thread`-scope
      // shutdown returns before in-progress spawns finish their
      // child cleanup, surfacing stderr noise after the daemon
      // claimed graceful shutdown. Use a unique key per spawn so
      // simultaneous thread-scope spawns don't collide on the
      // workspace key.
      const tracker =
        sessionScope === 'single'
          ? workspaceKey
          : `${workspaceKey}#${randomUUID()}`;
      inFlightSpawns.set(tracker, promise);
      try {
        return await promise;
      } finally {
        // Always clear the in-flight slot whether the spawn resolved
        // or rejected — leaving a rejected promise behind would
        // poison every future coalescing-path call for this
        // workspace (single-scope) or grow unbounded (thread-scope).
        inFlightSpawns.delete(tracker);
      }
    },

    async sendPrompt(sessionId, req, signal) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      // Pre-aborted: skip the queue entirely. Without this the prompt
      // chains onto promptQueue, waits its turn, and the FIFO worker
      // checks `signal.aborted` only AFTER reaching the head — wasted
      // queue churn on every retry-after-abort, plus a confusing trace
      // where the prompt appears to "run" before erroring.
      if (signal?.aborted) {
        throw new DOMException('Prompt aborted', 'AbortError');
      }
      // Force the body's sessionId to match the routing id — a client that
      // sent a stale id in the body would otherwise be dispatched to the
      // wrong agent process.
      const normalized: PromptRequest = { ...req, sessionId };
      const result = entry.promptQueue.then(() => {
        // If the caller aborted while we were queued behind earlier
        // prompts, don't even start this one.
        if (signal?.aborted) {
          throw new DOMException('Prompt aborted', 'AbortError');
        }
        const promptPromise = entry.connection.prompt(normalized);

        // Race against channel termination: if the underlying transport
        // dies (child crashed, stream torn down) WHILE the prompt is in
        // flight, the SDK's pending-request promise can hang because the
        // wire never delivers a response. Make the prompt fail-fast in
        // that case so the per-session FIFO doesn't poison the next
        // queued prompt with an unbounded await. See
        // `getTransportClosedReject` for the single-listener invariant.
        //
        // FIXME(stage-2): no absolute prompt deadline. A buggy agent
        // that ignores `cancel()` while keeping the channel alive can
        // hold this race open indefinitely — the abort path fires
        // `cancel()` and resolves pending permissions, but the
        // `promptPromise` itself only settles when the agent
        // cooperates. Stage 2 should add a configurable per-prompt
        // wall clock (e.g. `--prompt-deadline 30m`) into this race so
        // a wedged agent can't slow-leak prompt promises. Tracked
        // under #3803 follow-ups.
        const racedPromise = Promise.race([
          promptPromise,
          getTransportClosedReject(entry),
        ]);

        if (!signal) return racedPromise;
        // Wire the abort: when the signal fires (e.g. SSE route's
        // req.on('close')), tell the agent to wind down. ACP cancel is a
        // notification — the active prompt resolves with
        // stopReason: 'cancelled', then the next queued prompt can run.
        //
        // Also resolve any pending permission requests as `cancelled`.
        // ACP spec requires `cancel` to settle outstanding
        // `requestPermission` calls — `cancelSession()` already does
        // this; the abort path here was missing the call. Without it,
        // a client disconnecting while the agent is inside
        // `requestPermission` leaves the permission promise unresolved
        // forever (the agent is stuck waiting on a vote that no SSE
        // subscriber will ever cast).
        const onAbort = () => {
          cancelPendingForSession(sessionId);
          entry.connection.cancel({ sessionId }).catch(() => {
            // Cancel is fire-and-forget; the agent may already be dead.
          });
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
          // The aborted state can flip synchronously between the early-exit
          // check at the top of `sendPrompt` and addEventListener — re-check
          // after registration so a microsecond-window abort still fires
          // `cancel()` instead of letting the prompt run uncancellable.
          if (signal.aborted) onAbort();
          // Detach the listener once the prompt resolves so the
          // AbortController can be GC'd. The `.finally()` returns a
          // promise chained on `racedPromise`; if `racedPromise`
          // rejects, that returned promise rejects too — and we
          // never await it, so under Node's default
          // unhandled-rejection behavior the daemon could terminate
          // even though the route's own catch handles the original
          // rejection. Attach `.catch(() => {})` to the
          // listener-cleanup chain only — the caller's reference to
          // `racedPromise` (via `return racedPromise` below) still
          // surfaces failures normally.
          racedPromise
            .finally(() => signal.removeEventListener('abort', onAbort))
            .catch(() => {});
        }
        return racedPromise;
      });
      // Tail swallows failures so subsequent prompts still run. The caller
      // still sees rejections on its own `result` reference.
      entry.promptQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },

    async cancelSession(sessionId, req) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      // ACP spec: cancelling a prompt MUST resolve outstanding
      // requestPermission calls with outcome.cancelled. Do this *before*
      // forwarding the notification so the agent's wind-down sees the
      // resolutions.
      cancelPendingForSession(sessionId);
      // Cancel intentionally bypasses the prompt queue: it's a notification
      // that the agent uses to wind down the *currently active* prompt, not
      // something to wait behind queued work.
      //
      // CONTRACT (multi-prompt clients): cancel affects ONLY the active
      // prompt. Any prompts the client previously POSTed and that are
      // still queued behind the active one will continue to execute
      // after the active prompt resolves with `stopReason: 'cancelled'`.
      // This matches ACP's "cancel is a wind-down notification for the
      // current turn" semantics — multi-prompt queueing is a daemon
      // convenience, not in spec, so we don't extend cancel's reach
      // there. Clients that want a hard stop should stop posting new
      // prompts and call `cancelSession` after their last prompt
      // resolves, or kill the session via the channel-exit path.
      const notif: CancelNotification = req
        ? { ...req, sessionId }
        : { sessionId };
      await entry.connection.cancel(notif);
    },

    subscribeEvents(sessionId, subOpts) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      return entry.events.subscribe(subOpts);
    },

    respondToPermission(requestId, response) {
      return resolvePending(requestId, response);
    },

    listWorkspaceSessions(workspaceCwd) {
      if (!path.isAbsolute(workspaceCwd)) return [];
      const key = canonicalizeWorkspace(workspaceCwd);
      const out: BridgeSessionSummary[] = [];
      for (const entry of byId.values()) {
        if (entry.workspaceCwd === key) {
          out.push({
            sessionId: entry.sessionId,
            workspaceCwd: entry.workspaceCwd,
          });
        }
      }
      return out;
    },

    async setSessionModel(sessionId, req) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const normalized: SetSessionModelRequest = { ...req, sessionId };
      // The ACP SDK marks setSessionModel as unstable (not in spec yet); the
      // method on AgentSideConnection is `unstable_setSessionModel`. Cast
      // through the shape we know rather than couple to the prefix in case
      // it's renamed when the spec stabilizes.
      const conn = entry.connection as unknown as {
        unstable_setSessionModel(
          p: SetSessionModelRequest,
        ): Promise<SetSessionModelResponse>;
      };
      // Serialize through `entry.modelChangeQueue` so a `POST /session/:id/model`
      // can't race with `applyModelServiceId` (e.g. an attach-with-different-
      // modelServiceId) and leave the agent connection in an indeterminate
      // model. `applyModelServiceId` already chains on this queue; without
      // mirroring that here, two concurrent model changes interleave and the
      // last `model_switched` event published may not match the actual model
      // the agent is on.
      //
      // Race the agent call against `transportClosedReject` and a
      // `withTimeout` so a wedged child can't block the HTTP handler
      // forever. Matches `sendPrompt` (transport race) and
      // `applyModelServiceId` (timeout) — the absence of either was an
      // attack surface for "POST /session/:id/model never returns".
      // See `getTransportClosedReject` for the single-listener invariant.
      //
      // FIXME(stage-2): we reuse `initTimeoutMs` (default 10s) as the
      // model-switch deadline because the two values happen to share
      // a sensible order of magnitude today. They're conceptually
      // distinct (cold-start handshake vs in-flight model swap) and
      // a Stage 2 split into `modelSwitchTimeoutMs` would let
      // operators tune them independently — also a good time to
      // remove the no-abort behavior of `withTimeout` (it rejects
      // the promise but leaves the underlying ACP call running, so a
      // late-arriving `model_switched` can race a previously-fired
      // `model_switch_failed`). Both depend on ACP exposing a cancel
      // signal for `unstable_setSessionModel`.
      const transportClosed = getTransportClosedReject(entry);
      const work = entry.modelChangeQueue.then(() =>
        Promise.race([
          withTimeout(
            conn.unstable_setSessionModel(normalized),
            initTimeoutMs,
            'setSessionModel',
          ),
          transportClosed,
        ]),
      );
      // Tail-swallow on the queue so a model-change failure doesn't poison
      // every subsequent change (matches `applyModelServiceId`'s pattern).
      entry.modelChangeQueue = work.then(
        () => undefined,
        () => undefined,
      );
      let response: SetSessionModelResponse;
      try {
        response = await work;
      } catch (err) {
        // Mirror `applyModelServiceId`'s observability contract: surface
        // failed model changes on the SSE bus so subscribers can update
        // their UI / retry. Without this the only signal is the HTTP
        // 5xx, which doesn't reach passive viewers.
        try {
          entry.events.publish({
            type: 'model_switch_failed',
            data: {
              sessionId: entry.sessionId,
              requestedModelId: req.modelId,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        } catch {
          /* bus closed */
        }
        throw err;
      }
      try {
        entry.events.publish({
          type: 'model_switched',
          data: { sessionId: entry.sessionId, modelId: req.modelId },
        });
      } catch {
        /* bus closed */
      }
      return response;
    },

    async killSession(sessionId, opts) {
      const entry = byId.get(sessionId);
      if (!entry) return;
      // BQ9tV race guard: skip the reap if any other client already
      // attached to this entry. The disconnect-reaper in server.ts
      // sets `requireZeroAttaches: true` because it only wants to
      // reap when the spawn-owner that disconnected truly was the
      // sole client. Counter increment + this check both run
      // synchronously, so no microtask boundary lets a race slip
      // through.
      if (opts?.requireZeroAttaches && entry.attachCount > 0) return;
      // Remove from the maps eagerly so concurrent `spawnOrAttach`
      // can't reattach to a session we're tearing down. The
      // `channel.exited` cleanup at line 461-484 also removes from
      // these maps, but eager removal narrows the race window.
      byWorkspace.delete(entry.workspaceCwd);
      byId.delete(sessionId);
      // Resolve any still-pending permission as cancelled (matches the
      // shutdown path) so callers awaiting requestPermission unwind.
      for (const id of Array.from(entry.pendingPermissionIds)) {
        resolvePending(id, { outcome: { outcome: 'cancelled' } });
      }
      // Publish `session_died` BEFORE closing the bus. After the eager
      // `byId.delete` above, the channel.exited handler's
      // `byId.get(...) !== entry` guard short-circuits, so the
      // automatic publish at crash time wouldn't fire. SSE subscribers
      // need this terminal frame to know the session is gone.
      try {
        entry.events.publish({
          type: 'session_died',
          data: { sessionId, reason: 'killed' },
        });
      } catch {
        /* bus already closed */
      }
      entry.events.close();
      await entry.channel.kill().catch(() => {
        // Best-effort kill — channel may already be dead.
      });
    },

    async shutdown() {
      // Set BEFORE the snapshot so any racing `spawnOrAttach` triggered
      // by an in-flight HTTP connection after `runQwenServe.close()`
      // entered the bridge.shutdown() phase fails fast instead of
      // spawning a child this teardown won't see.
      shuttingDown = true;
      const entries = Array.from(byId.values());
      // Resolve every still-pending permission as cancelled before clearing
      // the maps so callers awaiting `requestPermission` unwind cleanly.
      for (const e of entries) {
        const ids = Array.from(e.pendingPermissionIds);
        for (const id of ids) {
          resolvePending(id, { outcome: { outcome: 'cancelled' } });
        }
      }
      byWorkspace.clear();
      byId.clear();
      pendingPermissions.clear();
      // Publish a terminal `session_died` BEFORE closing each bus so SSE
      // subscribers can distinguish "daemon shut down" from a transient
      // network error and don't sit indefinitely retrying. The
      // channel.exited handler also publishes this on a child crash,
      // but at shutdown time the entry has already been removed from
      // `byId` (above), so the handler's `byId.get(...) !== entry`
      // guard would short-circuit and the event would never fire.
      for (const e of entries) {
        try {
          e.events.publish({
            type: 'session_died',
            data: { sessionId: e.sessionId, reason: 'daemon_shutdown' },
          });
        } catch {
          /* bus already closed */
        }
        e.events.close();
      }
      // Wait for in-flight spawns too. The snapshot above only sees
      // sessions already in `byId`; a `doSpawn` past `channelFactory()`
      // but still inside `connection.newSession` (~1s on cold start) is
      // not yet registered. Without the await, `bridge.shutdown()`
      // resolves before the late re-check at doSpawn:472 tears down its
      // half-built channel — the orphan's stderr error fires AFTER the
      // daemon claimed graceful shutdown (log-confusing). Settle on
      // each, ignoring rejections so a single failure doesn't poison
      // the others.
      const inFlightAwaits = Array.from(inFlightSpawns.values()).map(
        (p): Promise<void> =>
          p.then(
            () => undefined,
            () => undefined,
          ),
      );
      await Promise.all([
        ...entries.map((e) => e.channel.kill().catch(() => {})),
        ...inFlightAwaits,
      ]);
    },
  };
}

/**
 * Extract the line range `[startLine, endLine)` (0-based) from a string
 * without allocating a per-line array. Equivalent to
 * `content.split('\n').slice(startLine, endLine).join('\n')` but
 * O(file size) string scan rather than O(file size) string + O(line
 * count) array. Matters for the partial-read path of `readTextFile`
 * where the limit is small and the file is large.
 */
function sliceLineRange(
  content: string,
  startLine: number,
  endLine: number | undefined,
): string {
  // Find the byte offset where line `startLine` begins.
  let offset = 0;
  for (let i = 0; i < startLine; i++) {
    const nl = content.indexOf('\n', offset);
    if (nl === -1) return '';
    offset = nl + 1;
  }
  if (endLine === undefined) return content.slice(offset);
  // Walk `endLine - startLine` newlines forward to find the end byte.
  let end = offset;
  const want = endLine - startLine;
  for (let i = 0; i < want; i++) {
    const nl = content.indexOf('\n', end);
    if (nl === -1) return content.slice(offset);
    end = nl + 1;
  }
  // Trim the trailing `\n` so the slice mirrors `lines.slice(...).join('\n')`.
  return content.slice(offset, end > offset ? end - 1 : end);
}

/**
 * Canonicalize a workspace path so two callers referring to the same
 * directory get the same `byWorkspace` key. `path.resolve` alone collapses
 * `..` and `.` segments and absolutizes, but on case-insensitive filesystems
 * (macOS APFS, Windows NTFS) `/Work/A` and `/work/a` are the same directory
 * yet `resolve` returns them verbatim — two `byWorkspace` entries form for
 * one physical workspace and `sessionScope: 'single'` silently degrades to
 * "one per spelling".
 *
 * `realpathSync.native` (when the path exists) walks symlinks and returns
 * the on-disk casing; this matches what `config.ts` / `settings.ts` /
 * `sandbox.ts` use for their own workspace resolution. When the path
 * doesn't exist (test fixtures, ahead-of-mkdir flows) we fall back to
 * the resolved-but-uncanonicalized form rather than throwing — the
 * downstream `spawn({cwd})` will fail with a useful ENOENT if the
 * workspace truly doesn't exist.
 *
 * NOTE: This is an undocumented cross-module contract — `config.ts`,
 * `settings.ts`, `sandbox.ts`, and this file all need to canonicalize
 * the same way for `sessionScope: 'single'` re-attach to work
 * correctly across paths. Stage 2 in-process (issue #3803 §10) will
 * collapse the bridge into core, removing the bridge-side path
 * resolution entirely; until then, *any* change to how those modules
 * resolve workspace paths needs a matching change here. A shared
 * `canonicalizeWorkspace` utility under `packages/cli/src/utils/`
 * (or `packages/core/src/utils/`) was considered but deferred:
 * the call sites use slightly different fallback policies, and a
 * lowest-common-denominator extraction would force changes in
 * unrelated subsystems mid-Stage-1.
 */
function canonicalizeWorkspace(p: string): string {
  const resolved = path.resolve(p);
  try {
    // FIXME(stage-2): switch to `fs.promises.realpath` once the
    // bridge call sites become async-friendly. This sync syscall
    // runs on the hot `spawnOrAttach` path and blocks the event
    // loop for one filesystem stat per call. Single-user loopback
    // (Stage 1's design target) doesn't notice; high-concurrency
    // deployments will. Stage 2 in-process refactor removes the
    // entire bridge-side path resolution anyway, but if Stage 2
    // ever lands without that change, switch to the async version.
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Race `p` against a timeout. The timeout REJECTS the returned
 * promise but does NOT abort the underlying operation — `p` keeps
 * running to completion (or its own failure) and its eventual
 * resolution is silently dropped.
 *
 * Stage 1 limitation: for `unstable_setSessionModel` the agent may
 * complete the model switch AFTER we surfaced the timeout to the
 * HTTP caller, leading to drift between caller's perceived model
 * and agent's actual model. Subscribers also see contradictory
 * SSE events (`model_switch_failed` from the timeout, then a late
 * `model_switched` if the agent succeeds). Acceptable for Stage 1
 * because:
 *   1. ACP's `unstable_setSessionModel` doesn't accept a cancel
 *      signal yet (the SDK's `prompt` does, hence `sendPrompt`'s
 *      explicit `cancel` notification on abort).
 *   2. Model switches complete in milliseconds in practice; a
 *      timeout firing means the agent is genuinely wedged, not
 *      just slow, and would have been DOA anyway.
 * Stage 2 will add abort plumbing once ACP exposes a cancel hook
 * for `unstable_setSessionModel`. Tracked in the model-change
 * concurrency notes in `applyModelServiceId`.
 */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`HttpAcpBridge ${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeoutP]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Default channel factory: spawn the current Node executable running this
 * CLI's entry script in `--acp` mode. `process.argv[1]` resolves to the qwen
 * entry script when launched via the `qwen` bin shim.
 *
 * Note on `cwd`: CodeQL flags the `workspaceCwd` flow into `spawn({cwd})`
 * as an "uncontrolled data used in path expression" finding. That's the
 * Stage 1 trust model speaking — the caller (a token-authenticated HTTP
 * client) is treated as an extension of the operator. The agent already
 * runs as the same UID with shell-tool access, so restricting the spawn
 * cwd to a sandbox here would be theatre. Stage 4+ remote-sandbox swaps
 * this factory for a sandbox-aware variant; see issue #3803 §11.
 */
export const defaultSpawnChannelFactory: ChannelFactory = async (
  workspaceCwd,
) => {
  // Resolution order:
  //   1. `QWEN_CLI_ENTRY` env override — escape hatch for non-standard
  //      launch paths (bundled binaries, npx wrappers, `node -e`,
  //      `tsx ./src/...`, custom shims, container images that
  //      relocate the entry script). Anyone hitting "process.argv[1]
  //      is empty" or "process.argv[1] points at the wrong file" can
  //      set this without code changes.
  //   2. `process.argv[1]` — works when launched via the `qwen` bin
  //      shim, which is the common path.
  // Fail loudly with an actionable error if neither resolves.
  const cliEntry = process.env['QWEN_CLI_ENTRY'] || process.argv[1];
  if (!cliEntry) {
    throw new Error(
      'Cannot determine CLI entry path for spawning the ACP child: ' +
        'process.argv[1] is empty and QWEN_CLI_ENTRY is unset. ' +
        'Set QWEN_CLI_ENTRY to the absolute path of the qwen entry ' +
        'script (e.g. `export QWEN_CLI_ENTRY=$(which qwen)`) to override.',
    );
  }
  // Each session takes ~3 file descriptors (stdin/stdout/stderr) for the
  // child plus a few sockets. Operators running many concurrent sessions
  // should bump `ulimit -n` accordingly. Stage 1 doesn't pre-flight FD
  // headroom — Stage 2 in-process drops the per-session FD cost entirely.
  // Child stderr is piped (NOT `inherit`ed) so we can prefix each
  // line with `[serve pid=… cwd=…]` before forwarding to the
  // daemon's stderr — see the prefix-and-forward loop below the
  // `spawn(...)` call. Sessions are still interleaved on the
  // daemon's stderr stream but each line carries its own session
  // identifier, so operators can `grep pid=12345` to pull one
  // session's trace cleanly. Stage 4+ remote sandboxes will isolate
  // stderr at the transport level.
  //
  // Note: spawning `process.execPath` only works when the entry script can
  // be loaded by raw Node. In dev (e.g. `npm run dev` via `tsx`) the entry
  // is a `.ts` file Node can't run; users should `npm run build` before
  // `qwen serve` or set `process.execPath` to a tsx-aware shim. Stage 1
  // accepts this — the daemon is meant for built deployments.
  // Pass through the daemon's full environment to the child, scrubbing
  // ONLY daemon-internal secrets (see SCRUBBED_CHILD_ENV_KEYS at module
  // scope). An earlier version used an allowlist, but that broke the
  // common deployment shape: users export `OPENAI_API_KEY` /
  // `ANTHROPIC_API_KEY` / `QWEN_*` / `DASHSCOPE_API_KEY` / a custom
  // `modelProviders[].envKey` to authenticate the agent's LLM calls,
  // and core's model config resolves those from `process.env`. An
  // exhaustive allowlist can't enumerate user-defined provider keys,
  // so the agent ends up unable to authenticate.
  //
  // Threat-model rationale: the agent already runs as the same UID
  // with shell-tool access — anything in `~/.bashrc`, `~/.npmrc`,
  // `~/.aws/credentials`, etc. is reachable by prompt injection
  // regardless of what we put in `env`. The env passthrough is not
  // the security boundary; the user-as-trust-root is. The only thing
  // we MUST scrub is `QWEN_SERVER_TOKEN` (daemon-only auth that
  // would let a prompt-injected shell turn the agent into an
  // authenticated client of its own daemon — escalation the agent
  // doesn't otherwise have).
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUBBED_CHILD_ENV_KEYS) {
    delete childEnv[key];
  }
  // CodeQL `js/path-injection` flags the `cwd: workspaceCwd` flow.
  // Stage 1 trust model accepts this — see the function-level comment
  // above for the design rationale. Defense-in-depth: the cwd is
  // canonicalized via `path.resolve()` upstream in `spawnOrAttach`,
  // and `spawn`'s `cwd` only changes the child's working directory,
  // it doesn't pass through any shell.
  //
  // NOTE: GitHub Code Scanning does NOT honor inline `// lgtm` /
  // `// codeql` annotations (LGTM.com retired in 2021). Suppressing
  // this alert requires either (a) UI dismissal as "won't fix" with
  // the rationale above, or (b) a repo-level
  // `.github/codeql/codeql-config.yml` query exclusion. Both are
  // out of scope for a code-only PR; flagging here for the human
  // reviewer.
  const child = spawn(process.execPath, [cliEntry, '--acp'], {
    cwd: workspaceCwd,
    // Pipe stderr (was: 'inherit') so we can prefix each line with
    // the spawn's pid + workspace, making per-session crash output
    // attributable. Bare 'inherit' sends every child's stderr to
    // the daemon's stderr verbatim and unprefixed — under any
    // multi-session load the operator's log becomes a salad of
    // unattributed traces.
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
  });

  // Forward child stderr to the daemon's stderr line-by-line, with a
  // `[serve pid=… cwd=…]` prefix on each line so operators can
  // correlate stack traces back to the spawning request. Best-effort:
  // a child that prints partial lines without a trailing newline is
  // flushed when the stream emits `end`.
  if (child.stderr) {
    let buf = '';
    const prefix = `[serve pid=${child.pid} cwd=${workspaceCwd}] `;
    // BRAp3 cap: a buggy child that writes a huge stderr line, or
    // never emits `\n`, would otherwise grow `buf` per spawn
    // unboundedly. 64 KiB is generous for the longest legitimate
    // stack trace line we'd expect from a Node child; anything
    // past that gets force-flushed with a `[truncated]` marker so
    // the operator still sees a prefix-attributed log line and
    // memory stays bounded. We DON'T drop content — we flush
    // chunks at the cap. (Picking 64 KiB matches our SSE per-frame
    // write budget; anything above this already implies the child
    // is misbehaving.)
    const STDERR_LINE_CAP_CHARS = 64 * 1024;
    const flush = (line: string) => {
      if (line.length > 0) process.stderr.write(prefix + line + '\n');
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        flush(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
      // Force-flush the unterminated tail if it's grown past the cap
      // — keeps memory bounded against a `\n`-less stderr storm.
      while (buf.length > STDERR_LINE_CAP_CHARS) {
        flush(buf.slice(0, STDERR_LINE_CAP_CHARS) + ' [truncated]');
        buf = buf.slice(STDERR_LINE_CAP_CHARS);
      }
    });
    child.stderr.on('end', () => {
      if (buf.length > 0) flush(buf);
    });
    child.stderr.on('error', () => {
      // Don't crash the daemon if the pipe breaks; the child is
      // already gone or about to be.
    });
  }

  // Build the `exited` promise BEFORE checking stdin/stdout so the listener
  // is in place before any error event can fire. We treat both `exit` and
  // `error` as termination — without an `error` listener Node would treat
  // an async spawn failure (ENOMEM, EACCES, …) as an unhandled error and
  // crash the whole daemon.
  const exited = new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    child.once('exit', finish);
    child.once('error', finish);
  });

  if (!child.stdin || !child.stdout) {
    child.kill('SIGKILL');
    throw new Error(
      'Spawned ACP child has no stdin/stdout — cannot establish NDJSON channel.',
    );
  }

  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(writable, readable);

  return {
    stream,
    kill: () => killChild(child),
    exited,
  };
};

const KILL_HARD_DEADLINE_MS = 10_000;

/**
 * Environment variables stripped from the spawned `qwen --acp` child's
 * environment. Everything else is passed through — see the
 * threat-model rationale at the call site in `defaultSpawnChannelFactory`.
 *
 * Currently just `QWEN_SERVER_TOKEN`: the daemon's own bearer token,
 * which the agent doesn't need (it speaks to the daemon over stdio,
 * not HTTP). Leaving it in the child's env would let prompt injection
 * turn the agent into an authenticated client of its own daemon — an
 * escalation the agent doesn't otherwise have.
 *
 * **WARNING**: this denylist is correct *only because the agent
 * already has unrestricted shell-tool access* — anything in the env
 * is reachable via `~/.bashrc`/`~/.aws/credentials`/etc. anyway.
 * Any future mode that **removes** shell-tool access (e.g. a
 * sandbox-locked agent variant) MUST switch this back to an
 * allowlist OR significantly expand the denylist to cover common
 * provider/CI/cloud secret prefixes (`OPENAI_*`, `ANTHROPIC_*`,
 * `AWS_*`, `GITHUB_TOKEN`, `CI_*`, `*_API_KEY`, `*_SECRET`, …).
 * See issue #3803 §11 for the Stage 4+ remote-sandbox plan.
 *
 * Defined at module scope so the Set is allocated once at load.
 */
const SCRUBBED_CHILD_ENV_KEYS: ReadonlySet<string> = new Set([
  'QWEN_SERVER_TOKEN',
]);

function killChild(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      child.removeListener('exit', finish);
      resolve();
    };
    child.once('exit', finish);
    try {
      child.kill('SIGTERM');
    } catch {
      finish();
      return;
    }
    setTimeout(() => {
      if (!resolved && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* swallow */
        }
      }
    }, 5_000).unref();
    // Even SIGKILL doesn't return if the child is in uninterruptible
    // sleep (D-state, e.g. NFS read blocked on a dead server). Without
    // this hard deadline, `bridge.shutdown()`'s `Promise.all` waits
    // forever on that one wedged child and SHUTDOWN_FORCE_CLOSE_MS in
    // `runQwenServe` only covers `server.close()`, not the bridge.
    // After the deadline give up: the child is probably stuck in a
    // kernel call we can't cancel, and `process.exit(0)` will reap it
    // when the daemon returns to its caller.
    setTimeout(() => {
      if (!resolved) finish();
    }, KILL_HARD_DEADLINE_MS).unref();
  });
}
