/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
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
   */
  sendPrompt(sessionId: string, req: PromptRequest): Promise<PromptResponse>;

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
 * One ACP NDJSON channel to a single agent. Tests inject a fake by replacing
 * the channel factory; production uses `defaultSpawnChannelFactory`.
 */
export interface AcpChannel {
  stream: Stream;
  /** Best-effort terminate; resolves when teardown is complete. */
  kill(): Promise<void>;
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
   * Permission requestIds belonging to this session, kept so cancelSession
   * + shutdown can resolve them as `cancelled` per ACP requirement
   * (cancelled prompt MUST resolve outstanding requestPermission with
   * outcome.cancelled).
   */
  pendingPermissionIds: Set<string>;
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
      entry.events.publish({
        type: 'permission_request',
        data: {
          requestId,
          sessionId: entry.sessionId,
          toolCall: params.toolCall,
          options: params.options,
        },
      });
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
    await fs.writeFile(params.path, params.content, 'utf8');
    return {};
  }

  async readTextFile(
    params: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    const content = await fs.readFile(params.path, 'utf8');
    if (typeof params.line === 'number' || typeof params.limit === 'number') {
      const lines = content.split('\n');
      // ACP `ReadTextFileRequest.line` is 1-based per spec — clients passing
      // `{ line: 1, limit: 2 }` mean "the first two lines", not "skip the
      // first then take two". Convert to a 0-based slice index, clamping
      // values < 1 to 0 to be tolerant of unusual inputs.
      const startLine = params.line ?? 1;
      const start = startLine > 0 ? startLine - 1 : 0;
      const end = params.limit != null ? start + params.limit : undefined;
      return { content: lines.slice(start, end).join('\n') };
    }
    return { content };
  }
}

const DEFAULT_INIT_TIMEOUT_MS = 10_000;

export function createHttpAcpBridge(opts: BridgeOptions = {}): HttpAcpBridge {
  const sessionScope = opts.sessionScope ?? 'single';
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
  // KNOWN GAP: there is currently no path that removes a session from these
  // maps when its child process crashes between requests. The next prompt
  // against the dead session will fail (channel writes throw / responses
  // never arrive within `initTimeoutMs`), so the failure is surfaced — but
  // the entry stays in the maps as garbage until daemon shutdown. Stage 2's
  // in-process bridge eliminates the spawned-child failure mode entirely.
  const byWorkspace = new Map<string, SessionEntry>();
  const byId = new Map<string, SessionEntry>();
  // Daemon-wide pending permission table; requestIds are UUIDs so collisions
  // across sessions are infeasible in practice.
  const pendingPermissions = new Map<string, PendingPermission>();
  // Coalesces concurrent `spawnOrAttach` calls for the same workspace under
  // single-scope. Without this, two parallel callers would both pass the
  // `byWorkspace.get` check, both spawn, and one entry would be orphaned
  // (in `byId` but not in `byWorkspace`) — violating the
  // "at most one session per workspace" invariant.
  const inFlightSpawns = new Map<string, Promise<BridgeSession>>();

  const registerPending = (p: PendingPermission) => {
    pendingPermissions.set(p.requestId, p);
    const entry = byId.get(p.sessionId);
    if (entry) entry.pendingPermissionIds.add(p.requestId);
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
    const client = new BridgeClient(() => entry, registerPending);
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

      entry = {
        sessionId: newSessionResp.sessionId,
        workspaceCwd: workspaceKey,
        channel,
        connection,
        events: new EventBus(),
        promptQueue: Promise.resolve(),
        pendingPermissionIds: new Set(),
      };
      byWorkspace.set(workspaceKey, entry);
      byId.set(entry.sessionId, entry);

      // ACP `newSession` doesn't take a model id; honor the caller's
      // `modelServiceId` by issuing the unstable `setSessionModel` call
      // immediately after the session is established. If the agent rejects
      // the model id, surface it as a session-creation failure so the
      // caller doesn't think they got the requested model.
      if (modelServiceId) {
        try {
          const conn = entry.connection as unknown as {
            unstable_setSessionModel(p: {
              sessionId: string;
              modelId: string;
            }): Promise<unknown>;
          };
          await withTimeout(
            conn.unstable_setSessionModel({
              sessionId: entry.sessionId,
              modelId: modelServiceId,
            }),
            initTimeoutMs,
            'setSessionModel',
          );
        } catch (err) {
          // The session is half-initialized — a known sessionId on a real
          // child but pointing at the wrong model. Tear it down so the
          // caller can retry cleanly instead of inheriting silent drift.
          byWorkspace.delete(workspaceKey);
          byId.delete(entry.sessionId);
          throw err;
        }
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

  /** Resolve every pending request belonging to one session as cancelled. */
  const cancelPendingForSession = (sessionId: string) => {
    const entry = byId.get(sessionId);
    if (!entry) return;
    // Snapshot ids — resolvePending mutates the underlying set.
    const ids = Array.from(entry.pendingPermissionIds);
    for (const id of ids) {
      resolvePending(id, { outcome: { outcome: 'cancelled' } });
    }
  };

  return {
    get sessionCount() {
      return byId.size;
    },

    get pendingPermissionCount() {
      return pendingPermissions.size;
    },

    async spawnOrAttach(req) {
      if (!path.isAbsolute(req.workspaceCwd)) {
        throw new Error(
          `workspaceCwd must be an absolute path; got "${req.workspaceCwd}"`,
        );
      }
      const workspaceKey = path.resolve(req.workspaceCwd);

      if (sessionScope === 'single') {
        const existing = byWorkspace.get(workspaceKey);
        if (existing) {
          return {
            sessionId: existing.sessionId,
            workspaceCwd: existing.workspaceCwd,
            attached: true,
          };
        }
        // Coalesce: if another caller is already mid-spawn for this same
        // workspace, await their result. The reporter's call appears as an
        // attach (the spawn was someone else's, not theirs).
        const inFlight = inFlightSpawns.get(workspaceKey);
        if (inFlight) {
          const session = await inFlight;
          return { ...session, attached: true };
        }
      }

      const promise = doSpawn(workspaceKey, req.modelServiceId);
      if (sessionScope === 'single') {
        inFlightSpawns.set(workspaceKey, promise);
      }
      try {
        return await promise;
      } finally {
        // Always clear the in-flight slot whether the spawn resolved or
        // rejected — leaving a rejected promise behind would poison every
        // future call for this workspace.
        if (sessionScope === 'single') {
          inFlightSpawns.delete(workspaceKey);
        }
      }
    },

    async sendPrompt(sessionId, req) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      // Force the body's sessionId to match the routing id — a client that
      // sent a stale id in the body would otherwise be dispatched to the
      // wrong agent process.
      const normalized: PromptRequest = { ...req, sessionId };
      const result = entry.promptQueue.then(() =>
        entry.connection.prompt(normalized),
      );
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
      const key = path.resolve(workspaceCwd);
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
      const response = await conn.unstable_setSessionModel(normalized);
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

    async shutdown() {
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
      for (const e of entries) e.events.close();
      await Promise.all(entries.map((e) => e.channel.kill().catch(() => {})));
    },
  };
}

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
// lgtm[js/shell-command-constructed-from-input]
export const defaultSpawnChannelFactory: ChannelFactory = async (
  workspaceCwd,
) => {
  const cliEntry = process.argv[1];
  if (!cliEntry) {
    throw new Error(
      'Cannot determine CLI entry path for spawning the ACP child (process.argv[1] is empty).',
    );
  }
  // Each session takes ~3 file descriptors (stdin/stdout/stderr) for the
  // child plus a few sockets. Operators running many concurrent sessions
  // should bump `ulimit -n` accordingly. Stage 1 doesn't pre-flight FD
  // headroom — Stage 2 in-process drops the per-session FD cost entirely.
  // Child stderr is `inherit`ed so it lands in the daemon's stderr; this
  // is interleaved across sessions and hard to debug. Stage 4+ remote
  // sandboxes will isolate.
  const child = spawn(process.execPath, [cliEntry, '--acp'], {
    cwd: workspaceCwd,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: process.env,
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
  };
};

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
  });
}
