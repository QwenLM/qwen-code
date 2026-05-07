/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk';
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
 *   - Child stdout NDJSON notifications fan out to all SSE/WS subscribers
 *     attached to the session (Stage 1 buffers them in-memory; SSE wiring
 *     lands in the next PR).
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

  /** Test/inspection hook: number of live sessions. */
  readonly sessionCount: number;

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
  /** Stage 1 buffer; consumed by SSE wiring in the next PR. */
  notifications: SessionNotification[];
  /**
   * Tail of the per-session prompt queue. Each new prompt chains off the
   * resolved (or rejected) state of this promise so prompts run one at a
   * time in arrival order. Always resolves — failures are swallowed at the
   * tail so a prior failure doesn't block subsequent prompts; the original
   * caller still observes the rejection on its own returned promise.
   */
  promptQueue: Promise<void>;
}

/**
 * Bridge `Client` implementation — the daemon's response surface for things
 * the agent asks the client (file reads/writes, permission prompts).
 *
 * Stage 1 behavior:
 *   - `requestPermission` denies by default. The HTTP `/permission/:requestId`
 *     route in the next PR will let any attached client cast the deciding
 *     vote (first-responder wins).
 *   - `sessionUpdate` notifications are buffered on the session entry; the
 *     next PR drains the buffer through SSE.
 *   - File reads/writes proxy to local fs (daemon and agent share the host).
 */
class BridgeClient implements Client {
  constructor(private readonly resolveEntry: () => SessionEntry | undefined) {}

  async requestPermission(
    _params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return { outcome: { outcome: 'cancelled' } };
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const entry = this.resolveEntry();
    if (entry) entry.notifications.push(params);
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
      const start = params.line ?? 0;
      const end = params.limit != null ? start + params.limit : undefined;
      return { content: lines.slice(start, end).join('\n') };
    }
    return { content };
  }
}

const DEFAULT_INIT_TIMEOUT_MS = 10_000;

export function createHttpAcpBridge(opts: BridgeOptions = {}): HttpAcpBridge {
  const sessionScope = opts.sessionScope ?? 'single';
  const channelFactory = opts.channelFactory ?? defaultSpawnChannelFactory;
  const initTimeoutMs = opts.initializeTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;

  // Single-scope reuse keyed by canonical workspace path.
  const byWorkspace = new Map<string, SessionEntry>();
  const byId = new Map<string, SessionEntry>();

  return {
    get sessionCount() {
      return byId.size;
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
      }

      const channel = await channelFactory(workspaceKey);
      let entry: SessionEntry | undefined;
      const client = new BridgeClient(() => entry);
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
          notifications: [],
          promptQueue: Promise.resolve(),
        };
        byWorkspace.set(workspaceKey, entry);
        byId.set(entry.sessionId, entry);

        return {
          sessionId: entry.sessionId,
          workspaceCwd: entry.workspaceCwd,
          attached: false,
        };
      } catch (err) {
        await channel.kill().catch(() => {});
        throw err;
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
      // Cancel intentionally bypasses the prompt queue: it's a notification
      // that the agent uses to wind down the *currently active* prompt, not
      // something to wait behind queued work.
      const notif: CancelNotification = req
        ? { ...req, sessionId }
        : { sessionId };
      await entry.connection.cancel(notif);
    },

    async shutdown() {
      const entries = Array.from(byId.values());
      byWorkspace.clear();
      byId.clear();
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
 */
export const defaultSpawnChannelFactory: ChannelFactory = async (
  workspaceCwd,
) => {
  const cliEntry = process.argv[1];
  if (!cliEntry) {
    throw new Error(
      'Cannot determine CLI entry path for spawning the ACP child (process.argv[1] is empty).',
    );
  }
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
