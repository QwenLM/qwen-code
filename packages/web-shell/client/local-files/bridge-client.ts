/**
 * 4c — the reverse-channel client for the local-files bridge.
 *
 * Owns one `/acp` WebSocket for the lifetime of a granted directory: ACP
 * `initialize`, then `mcp_register { server, sessionId }`, then answering the
 * daemon's `mcp_message` frames from {@link LocalFilesMcpServer}.
 *
 * Three behaviours here are not optional, because each was measured rather than
 * assumed (see `docs/design/2026-09-03-client-filesystem-bridge.md` §3):
 *
 *  - Registration needs a LIVE ACP channel. A preheated child can be reaped
 *    before we ask, and the daemon answers `register_failed`; the daemon's own
 *    CDP path retries 20x250ms for the same reason, so we re-warm and retry.
 *  - Closing the socket is the teardown signal: the daemon removes the
 *    server itself, so a reconnect must register again from scratch.
 *  - Session scope is what keeps these tools out of sibling sessions, so the
 *    `sessionId` is part of every register frame.
 *
 * Framework-free on purpose (no React, no DOM globals beyond the injected
 * socket and lock manager) so the whole state machine runs in a node test.
 */

import {
  LOCAL_FILES_SERVER_NAME,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './mcp-server.js';

/**
 * The RPC surface the bridge drives. {@link LocalFilesMcpServer} satisfies it;
 * declared structurally so the state machine is testable without a filesystem.
 */
export interface LocalFilesRpcServer {
  handle(message: JsonRpcRequest): Promise<JsonRpcResponse | undefined>;
}

export const LOCAL_FILES_CLIENT_NAME = 'qwen-web-shell-local-files';
/** Cross-tab ownership: one bridge per browser profile, not one per tab. */
export const LOCAL_FILES_LOCK_NAME = 'qwen-local-files-bridge';

const WS_BEARER_SUBPROTOCOL_PREFIX = 'qwen-bearer.';
const WS_AUTH_SUBPROTOCOL = 'qwen-ws';
const ACP_PATH = 'acp';
const INITIALIZE_ID = 'local-files-acp-initialize';

export type LocalFilesBridgeState =
  | { phase: 'idle' }
  | { phase: 'held-elsewhere' }
  | { phase: 'connecting'; attempt: number }
  | { phase: 'registering'; attempt: number }
  | { phase: 'connected'; toolCount: number }
  | { phase: 'reconnecting'; attempt: number; reason: string }
  | { phase: 'stopped' }
  | { phase: 'failed'; code: string; message: string };

export interface WebSocketHandlers {
  open(): void;
  message(data: unknown): void;
  error(): void;
  close(code: number, reason: string): void;
}

/** The slice of a WebSocket this client drives. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  setHandlers(handlers: WebSocketHandlers): void;
}

export type OpenSocket = (url: string, protocols: string[]) => WebSocketLike;

/** `navigator.locks`, narrowed to the one call we make. */
export interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<void>,
  ): Promise<unknown>;
}

export interface LocalFilesBridgeOptions {
  baseUrl: string;
  sessionId: string;
  server: LocalFilesRpcServer;
  openSocket: OpenSocket;
  token?: string;
  serverName?: string;
  clientInfo?: { name: string; version: string };
  /** Re-warm the ACP child before retrying a failed registration. */
  rewarm?: () => Promise<void>;
  locks?: LockManagerLike | null;
  maxRegisterAttempts?: number;
  maxReconnectAttempts?: number;
  reconnectBaseDelayMs?: number;
  initializeTimeoutMs?: number;
  registerTimeoutMs?: number;
  delay?: (ms: number) => Promise<void>;
  onState?: (state: LocalFilesBridgeState) => void;
  /**
   * The session's workspace when it is not the primary one: routes the socket
   * to the mount that owns the session. Omit for the primary workspace.
   */
  workspaceSelector?: AcpWorkspaceSelector;
}

const DEFAULTS = {
  maxRegisterAttempts: 6,
  maxReconnectAttempts: 8,
  reconnectBaseDelayMs: 500,
  initializeTimeoutMs: 15_000,
  registerTimeoutMs: 30_000,
  lockAttempts: 3,
  lockRetryDelayMs: 100,
};

/** Mirrors the bearer-subprotocol scheme the daemon's WS upgrade accepts. */
export function bearerSubprotocols(token: string | undefined): string[] {
  if (!token) return [];
  const bytes = new TextEncoder().encode(token);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  const encoded = btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  // The marker protocol is offered alongside the bearer one so the server
  // always has a non-secret protocol to echo back.
  return [WS_AUTH_SUBPROTOCOL, `${WS_BEARER_SUBPROTOCOL_PREFIX}${encoded}`];
}

/** Identifies the workspace a session belongs to, for the qualified route. */
export interface AcpWorkspaceSelector {
  kind: 'id' | 'cwd';
  value: string;
}

/**
 * Mirrors `TerminalPanel.buildWsUrl`: keep any base path, swap the scheme.
 *
 * The bare `/acp` upgrade binds the PRIMARY mount, so a session owned by a
 * secondary runtime would fail registration there; with a selector the URL
 * takes the workspace-qualified shape the daemon resolves per runtime (the
 * same route the voice stream uses).
 */
export function buildAcpWsUrl(
  baseUrl: string,
  selector?: AcpWorkspaceSelector,
): string {
  const base = new URL(baseUrl);
  const path =
    selector === undefined
      ? ACP_PATH
      : `workspaces/${encodeURIComponent(selector.value)}/${ACP_PATH}`;
  const url = new URL(
    path,
    `${base.origin}${base.pathname.replace(/\/?$/, '/')}`,
  );
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Production socket adapter: the only place a real `WebSocket` is touched.
 *
 * `setHandlers` MUST be called in the same synchronous block as this factory
 * (`connect()` does). A real socket starts connecting at construction, and an
 * `open` delivered before the handlers land would be dropped — leaving the
 * bridge stuck in `connecting` with no initialize sent and no timeout armed,
 * because the timeout is armed by `sendInitialize`.
 */
export function openBrowserSocket(
  url: string,
  protocols: string[],
): WebSocketLike {
  const ws = new WebSocket(url, protocols);
  let handlers: WebSocketHandlers | undefined;
  ws.onopen = () => handlers?.open();
  ws.onerror = () => handlers?.error();
  ws.onclose = (event) => handlers?.close(event.code, event.reason);
  ws.onmessage = (event) => handlers?.message(event.data);
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    setHandlers(next) {
      handlers = next;
    },
  };
}

interface InboundFrame {
  type?: unknown;
  id?: unknown;
  server?: unknown;
  payload?: unknown;
  toolCount?: unknown;
  code?: unknown;
  message?: unknown;
  jsonrpc?: unknown;
  result?: unknown;
  error?: unknown;
  method?: unknown;
}

export class LocalFilesBridge {
  private readonly options: LocalFilesBridgeOptions;
  private readonly serverName: string;
  private readonly delay: (ms: number) => Promise<void>;
  private socket: WebSocketLike | undefined;
  private state: LocalFilesBridgeState = { phase: 'idle' };
  private stopped = false;
  private running = false;
  private registerAttempts = 0;
  private reconnectAttempts = 0;
  private initializeTimer: ReturnType<typeof setTimeout> | undefined;
  private registerTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Single-flight for retryRegister: the timeout timer, a late
   * `register_failed` and a `rate_limited` shed can each spawn a continuation
   * while one is parked in rewarm; without this guard both send a register
   * and one logical failure consumes two of the six attempts.
   */
  private registerRetryInFlight = false;
  /** Resolves the run loop so the cross-tab lock is released. */
  private releaseRun: (() => void) | undefined;

  constructor(options: LocalFilesBridgeOptions) {
    this.options = options;
    this.serverName = options.serverName ?? LOCAL_FILES_SERVER_NAME;
    this.delay = options.delay ?? realDelay;
  }

  getState(): LocalFilesBridgeState {
    return this.state;
  }

  /**
   * Acquire the cross-tab lock and run until stopped. Resolves when the bridge
   * is done (stopped, failed, or another tab owns it).
   *
   * Calling `start()` on a bridge that is already running is a no-op; to
   * restart (a different session, a re-granted directory) call `stop()` first.
   */
  async start(): Promise<void> {
    // A second start() would run a second loop and overwrite releaseRun,
    // orphaning the first promise — which a re-run React effect would hit.
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    try {
      const locks = this.options.locks;
      if (!locks) {
        await this.run();
        return;
      }
      let owned = false;
      // A same-tab replacement stops the old bridge and starts this one in
      // the same task, while the old lock release is still settling; a single
      // ifAvailable attempt would misread that as another tab and park here
      // forever, so retry a few times before concluding held-elsewhere.
      const attempts = DEFAULTS.lockAttempts;
      for (
        let attempt = 0;
        attempt < attempts && !owned && !this.stopped;
        attempt++
      ) {
        if (attempt > 0) await this.delay(DEFAULTS.lockRetryDelayMs);
        if (this.stopped) break;
        await locks.request(
          LOCAL_FILES_LOCK_NAME,
          { ifAvailable: true },
          async (lock) => {
            // `ifAvailable` means the callback is skipped entirely when
            // another tab holds the lock; a null lock is the other way it can
            // decline. A stop() landing before the grant must release it
            // again instead of starting a run nobody can stop.
            if (lock === null || lock === undefined || this.stopped) return;
            owned = true;
            await this.run();
          },
        );
      }
      if (!owned && !this.stopped) this.setState({ phase: 'held-elsewhere' });
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.setState({ phase: 'stopped' });
    this.teardown();
  }

  /**
   * Release the socket, timers and cross-tab lock WITHOUT touching the state:
   * a failure path states its reason first and then tears down, and a `stop()`
   * here would overwrite that reason with `stopped`.
   */
  private teardown(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    const release = this.releaseRun;
    this.releaseRun = undefined;
    release?.();
  }

  private setState(next: LocalFilesBridgeState): void {
    this.state = next;
    this.options.onState?.(next);
  }

  private clearTimers(): void {
    if (this.initializeTimer) clearTimeout(this.initializeTimer);
    if (this.registerTimer) clearTimeout(this.registerTimer);
    this.initializeTimer = undefined;
    this.registerTimer = undefined;
  }

  private async run(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.releaseRun = resolve;
      // A stop() that landed between the lock grant and this point must not
      // orphan the promise: the lock callback would never settle and the
      // cross-tab lock would stay held until a page reload.
      if (this.stopped) {
        this.releaseRun = undefined;
        resolve();
        return;
      }
      void this.connect();
    });
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const attempt = this.reconnectAttempts + 1;
    this.setState({ phase: 'connecting', attempt });
    this.registerAttempts = 0;
    let socket: WebSocketLike;
    try {
      socket = this.options.openSocket(
        buildAcpWsUrl(this.options.baseUrl, this.options.workspaceSelector),
        bearerSubprotocols(this.options.token),
      );
    } catch (err) {
      this.fail('socket_open_failed', err);
      return;
    }
    this.socket = socket;
    socket.setHandlers({
      open: () => {
        // A stale open from a recycled socket must not initialize (or arm
        // timers over) the socket that replaced it.
        if (this.socket !== socket) return;
        this.sendInitialize();
      },
      message: (data) => {
        if (this.socket !== socket) return;
        void this.onMessage(data);
      },
      error: () => {
        // The close event follows and carries the reason we act on.
      },
      close: (code, reason) => {
        // A recycled socket's late close (the daemon's uninitialized-socket
        // timer) must not detach the healthy replacement.
        if (this.socket !== socket) return;
        void this.onClose(code, reason);
      },
    });
  }

  private sendInitialize(): void {
    const clientInfo = this.options.clientInfo ?? {
      name: LOCAL_FILES_CLIENT_NAME,
      version: '1.0.0',
    };
    this.send({
      jsonrpc: '2.0',
      id: INITIALIZE_ID,
      method: 'initialize',
      params: { clientInfo },
    });
    this.initializeTimer = setTimeout(() => {
      this.initializeTimer = undefined;
      // The daemon closes an uninitialized socket after 30s; give up on it
      // first so the user sees a reason instead of a silent hang, and so the
      // still-open socket is not leaked under the replacement.
      this.recycleSocket('initialize timeout');
    }, this.options.initializeTimeoutMs ?? DEFAULTS.initializeTimeoutMs);
  }

  private sendRegister(): void {
    // A retry path can re-arm while a previous timer is still live; never
    // orphan the old handle or it fires into an already-settled sequence.
    if (this.registerTimer) clearTimeout(this.registerTimer);
    const attempt = this.registerAttempts + 1;
    this.registerAttempts = attempt;
    this.setState({ phase: 'registering', attempt });
    this.send({
      type: 'mcp_register',
      server: this.serverName,
      sessionId: this.options.sessionId,
    });
    this.registerTimer = setTimeout(() => {
      this.registerTimer = undefined;
      void this.retryRegister('register timeout');
    }, this.options.registerTimeoutMs ?? DEFAULTS.registerTimeoutMs);
  }

  private async retryRegister(reason: string): Promise<void> {
    if (this.stopped || this.registerRetryInFlight) return;
    this.registerRetryInFlight = true;
    try {
      const socketAtEntry = this.socket;
      const max =
        this.options.maxRegisterAttempts ?? DEFAULTS.maxRegisterAttempts;
      if (this.registerAttempts >= max) {
        this.setState({
          phase: 'failed',
          code: 'register_failed',
          message: `${reason} after ${this.registerAttempts} attempt(s)`,
        });
        this.teardown();
        return;
      }
      // The usual cause is a cold or reaped ACP child; re-warm before retrying
      // instead of hammering a daemon that cannot answer yet.
      try {
        await this.options.rewarm?.();
      } catch {
        // A failed re-warm is not fatal: the retry may still find a live child.
      }
      if (this.stopped) return;
      // The ack can arrive while the re-warm is in flight; registering again
      // would be answered already_registered and fail the bridge terminally.
      if (this.state.phase === 'connected') return;
      // The socket that started this continuation is gone (dropped during the
      // re-warm): the replacement must answer initialize before it may
      // register, so abandon this continuation instead of jumping its queue.
      if (this.socket !== socketAtEntry) return;
      this.sendRegister();
    } finally {
      this.registerRetryInFlight = false;
    }
  }

  private async onMessage(data: unknown): Promise<void> {
    const text = typeof data === 'string' ? data : await stringifyData(data);
    if (text === undefined) return;
    let frame: InboundFrame;
    try {
      frame = JSON.parse(text) as InboundFrame;
    } catch {
      return;
    }
    // A frame can arrive during the close handshake after stop(); dispatching
    // it would let a dead bridge overwrite its replacement's status through
    // the shared onState callback.
    if (this.stopped) return;

    // ACP initialize reply.
    if (frame.id === INITIALIZE_ID && ('result' in frame || 'error' in frame)) {
      if (this.initializeTimer) {
        clearTimeout(this.initializeTimer);
        this.initializeTimer = undefined;
      }
      if (frame.error !== undefined && frame.error !== null) {
        this.fail(
          'acp_initialize_failed',
          typeof frame.error === 'object' && frame.error !== null
            ? (frame.error as { message?: unknown }).message
            : frame.error,
        );
        return;
      }
      this.sendRegister();
      return;
    }

    switch (frame.type) {
      case 'mcp_registered': {
        if (frame.server !== this.serverName) return;
        if (this.registerTimer) {
          clearTimeout(this.registerTimer);
          this.registerTimer = undefined;
        }
        // Reset the reconnect streak only once the bridge is actually USABLE.
        // Resetting on `open` instead would let a daemon that accepts sockets
        // and then drops them retry at the base delay forever, never reaching
        // the reconnect budget.
        this.reconnectAttempts = 0;
        // Same for the register budget: it bounds CONSECUTIVE failures, so a
        // bridge that has been healthy for hours keeps its full retry budget
        // for the next daemon-side removal.
        this.registerAttempts = 0;
        this.setState({
          phase: 'connected',
          toolCount: typeof frame.toolCount === 'number' ? frame.toolCount : 0,
        });
        return;
      }
      case 'mcp_error': {
        const message = String(frame.message ?? 'unknown error');
        if (frame.code === 'register_failed') {
          if (this.registerTimer) {
            clearTimeout(this.registerTimer);
            this.registerTimer = undefined;
          }
          void this.retryRegister(message);
          return;
        }
        if (frame.code === 'already_registered') {
          // Only this bridge's own earlier frame on this connection can
          // produce the code (the registrar is per-connection and the
          // cross-tab lock blocks a peer bridge): that attempt's add is
          // still in flight at the daemon, whose deadline far exceeds our
          // register timeout. Wait that attempt out instead of failing on
          // our duplicate; the re-arm must not consume the attempt budget
          // while the in-flight add is alive.
          if (this.registerTimer) {
            clearTimeout(this.registerTimer);
            this.registerTimer = undefined;
          }
          this.registerTimer = setTimeout(() => {
            this.registerTimer = undefined;
            if (this.stopped || this.state.phase !== 'registering') return;
            // Probe again without a re-warm (the daemon already holds our
            // name; only its ack is missing) and without consuming the
            // consecutive-failure budget: the in-flight add's own deadline is
            // an order of magnitude above this window, and its eventual
            // register_failed is what ends the wait.
            this.registerAttempts = Math.max(0, this.registerAttempts - 1);
            this.sendRegister();
          }, this.options.registerTimeoutMs ?? DEFAULTS.registerTimeoutMs);
          return;
        }
        if (frame.code === 'rate_limited') {
          // The daemon shed this one frame to keep service up; the connection
          // and the registration stay live. While registering, join the
          // retry budget; while connected, the agent-side request fails
          // through the registrar's own timeout. Terminating the bridge here
          // would turn a single shed frame into a session-level outage of
          // every tool until a manual reconnect.
          if (this.state.phase === 'registering') {
            void this.retryRegister(message);
          }
          return;
        }
        this.fail(String(frame.code ?? 'mcp_error'), message);
        return;
      }
      case 'mcp_message': {
        await this.answerRpc(frame);
        return;
      }
      default:
        // ACP session traffic we did not ask for; ignore it.
        return;
    }
  }

  private async answerRpc(frame: InboundFrame): Promise<void> {
    const id = frame.id;
    const payload = frame.payload;
    if (
      typeof id !== 'string' ||
      payload === null ||
      typeof payload !== 'object'
    ) {
      return;
    }
    // One connection may host several client-side servers; answering a frame
    // addressed to another one would reply with the wrong catalogue.
    if (frame.server !== undefined && frame.server !== this.serverName) return;
    const socket = this.socket;
    let reply: JsonRpcResponse | undefined;
    try {
      reply = await this.options.server.handle(payload as JsonRpcRequest);
    } catch (err) {
      const requestId = (payload as { id?: unknown }).id;
      reply = {
        jsonrpc: '2.0',
        id:
          typeof requestId === 'string' || typeof requestId === 'number'
            ? requestId
            : null,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
    // Notifications get no reply; sending one would confuse the daemon's
    // correlation table.
    if (reply === undefined) return;
    // A disconnect (or a recycle) landed while the tool ran: the reply has
    // nowhere honest to go, and answering on a replaced socket would mix
    // two connections' traffic.
    if (this.stopped || this.socket !== socket) return;
    this.send({
      type: 'mcp_message',
      id,
      server: this.serverName,
      payload: reply,
    });
  }

  private async onClose(code: number, reason: string): Promise<void> {
    this.clearTimers();
    const wasSocket = this.socket;
    this.socket = undefined;
    if (this.stopped) return;
    // Already detached: this is the close event answering our own teardown or
    // recycle, not a dropped connection.
    if (wasSocket === undefined) return;
    await this.scheduleReconnect(code, reason);
  }

  /**
   * Drop a socket that is still open but useless (an initialize that never
   * answered) and reconnect. Detaching before `close()` is what keeps the
   * resulting close event from being handled a second time.
   */
  private recycleSocket(reason: string): void {
    const socket = this.socket;
    this.socket = undefined;
    this.clearTimers();
    socket?.close();
    if (this.stopped) return;
    void this.scheduleReconnect(0, reason);
  }

  private async scheduleReconnect(code: number, reason: string): Promise<void> {
    this.reconnectAttempts += 1;
    const max =
      this.options.maxReconnectAttempts ?? DEFAULTS.maxReconnectAttempts;
    if (this.reconnectAttempts > max) {
      this.setState({
        phase: 'failed',
        code: 'disconnected',
        message: `lost the daemon connection after ${max} reconnect attempt(s) (last: ${reason || `code ${code}`})`,
      });
      this.teardown();
      return;
    }
    const base =
      this.options.reconnectBaseDelayMs ?? DEFAULTS.reconnectBaseDelayMs;
    const backoff = Math.min(base * 2 ** (this.reconnectAttempts - 1), 15_000);
    this.setState({
      phase: 'reconnecting',
      attempt: this.reconnectAttempts,
      reason: reason || `code ${code}`,
    });
    await this.delay(backoff);
    await this.connect();
  }

  private fail(code: string, cause: unknown): void {
    if (this.stopped) return;
    this.setState({
      phase: 'failed',
      code,
      message: cause instanceof Error ? cause.message : String(cause ?? code),
    });
    this.teardown();
  }

  private send(frame: Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch {
      // A send on a closing socket surfaces as the close event, which already
      // drives the reconnect path.
    }
  }
}

async function stringifyData(data: unknown): Promise<string | undefined> {
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  return undefined;
}
