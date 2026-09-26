/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The client side of `qwen serve`'s reverse tool channel: dial `/acp`, ACP
 * `initialize`, `mcp_register { server, sessionId }`, then answer the daemon's
 * `mcp_message` frames.
 *
 * It follows the Web Shell local-files bridge
 * (`packages/web-shell/client/local-files/bridge-client.ts`), whose retry rules
 * were measured, with one deliberate difference: a dropped connection ends the
 * relay instead of reconnecting, so control of this computer never resumes
 * without a fresh approval on it.
 */

import { DESKTOP_RELAY_SERVER_NAME } from './constants.js';
import { errorReply, type JsonRpcMessage } from './mcp-child-relay.js';

export interface WorkspaceSelector {
  kind: 'id' | 'cwd';
  value: string;
}

export interface RelaySocketHandlers {
  open(): void;
  message(data: string): void;
  close(code: number, reason: string): void;
}

export interface RelaySocket {
  send(data: string): void;
  close(): void;
}

export type OpenRelaySocket = (
  url: string,
  headers: Record<string, string>,
  handlers: RelaySocketHandlers,
) => RelaySocket;

export type AcpRelayPhase = 'connecting' | 'registering' | 'connected';

export type AcpRelayEnd =
  | { reason: 'stopped' }
  | { reason: 'closed'; detail: string }
  | { reason: 'failed'; code: string; message: string };

export interface AcpRelayOptions {
  daemonUrl: string;
  sessionId: string;
  token?: string;
  workspace?: WorkspaceSelector;
  clientVersion: string;
  rpc: { handle(message: unknown): Promise<JsonRpcMessage | undefined> };
  openSocket: OpenRelaySocket;
  onPhase?: (phase: AcpRelayPhase) => void;
  serverName?: string;
  maxRegisterAttempts?: number;
  initializeTimeoutMs?: number;
  registerTimeoutMs?: number;
}

const INITIALIZE_ID = 'desktop-relay-acp-initialize';
const DEFAULTS = {
  maxRegisterAttempts: 6,
  initializeTimeoutMs: 15_000,
  registerTimeoutMs: 30_000,
};

function relativeTo(daemonUrl: string, path: string): URL {
  const base = new URL(daemonUrl);
  return new URL(path, `${base.origin}${base.pathname.replace(/\/?$/, '/')}`);
}

/**
 * Same shape as the Web Shell's `buildAcpWsUrl`: the bare `/acp` upgrade binds
 * the primary workspace, and a secondary session needs the qualified route.
 */
export function buildAcpUrl(
  daemonUrl: string,
  workspace?: WorkspaceSelector,
): string {
  const url = relativeTo(
    daemonUrl,
    workspace === undefined
      ? 'acp'
      : `workspaces/${encodeURIComponent(workspace.value)}/acp`,
  );
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

interface InboundFrame {
  type?: unknown;
  id?: unknown;
  server?: unknown;
  payload?: unknown;
  code?: unknown;
  message?: unknown;
  result?: unknown;
  error?: unknown;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorText(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

export class AcpRelay {
  private readonly options: AcpRelayOptions;
  private readonly serverName: string;
  private socket: RelaySocket | undefined;
  private phase: AcpRelayPhase = 'connecting';
  private registerAttempts = 0;
  private registerRetryInFlight = false;
  private initializeTimer: ReturnType<typeof setTimeout> | undefined;
  private registerTimer: ReturnType<typeof setTimeout> | undefined;
  private ended: AcpRelayEnd | undefined;
  private resolveEnd: ((end: AcpRelayEnd) => void) | undefined;

  constructor(options: AcpRelayOptions) {
    this.options = options;
    this.serverName = options.serverName ?? DESKTOP_RELAY_SERVER_NAME;
  }

  /** Connects, and resolves once the relay has ended with the reason. */
  run(): Promise<AcpRelayEnd> {
    return new Promise((resolve) => {
      this.resolveEnd = resolve;
      this.setPhase('connecting');
      // A non-browser client may send the bearer as a plain header; the
      // daemon's cross-site check only applies to requests with an Origin.
      const headers: Record<string, string> = {};
      if (this.options.token) {
        headers['authorization'] = `Bearer ${this.options.token}`;
      }
      try {
        this.socket = this.options.openSocket(
          buildAcpUrl(this.options.daemonUrl, this.options.workspace),
          headers,
          {
            open: () => this.sendInitialize(),
            message: (data) => void this.onMessage(data),
            close: (code, reason) =>
              this.finish(
                this.phase !== 'connected' || (code !== 1000 && code !== 1001)
                  ? {
                      reason: 'failed',
                      code: 'connection_failed',
                      message: reason || `code ${code}`,
                    }
                  : { reason: 'closed', detail: reason || `code ${code}` },
              ),
          },
        );
      } catch (error) {
        this.finish({
          reason: 'failed',
          code: 'socket_open_failed',
          message: describe(error),
        });
      }
    });
  }

  /** Withdraws the tools from the session and closes the connection. */
  stop(): void {
    if (this.ended !== undefined) return;
    this.send({ type: 'mcp_unregister', server: this.serverName });
    this.finish({ reason: 'stopped' });
  }

  private setPhase(phase: AcpRelayPhase): void {
    this.phase = phase;
    this.options.onPhase?.(phase);
  }

  private sendInitialize(): void {
    if (this.ended !== undefined) return;
    this.send({
      jsonrpc: '2.0',
      id: INITIALIZE_ID,
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'qwen-desktop-relay',
          version: this.options.clientVersion,
        },
      },
    });
    // The daemon closes an uninitialized socket after 30 s; give up first so
    // the reason is ours rather than a bare close.
    this.initializeTimer = setTimeout(() => {
      this.initializeTimer = undefined;
      this.finish({
        reason: 'failed',
        code: 'initialize_timeout',
        message: 'the daemon did not answer ACP initialize',
      });
    }, this.options.initializeTimeoutMs ?? DEFAULTS.initializeTimeoutMs);
  }

  private sendRegister(): void {
    if (this.registerTimer) clearTimeout(this.registerTimer);
    this.registerAttempts += 1;
    this.setPhase('registering');
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
    if (this.ended !== undefined || this.registerRetryInFlight) return;
    this.registerRetryInFlight = true;
    try {
      const max =
        this.options.maxRegisterAttempts ?? DEFAULTS.maxRegisterAttempts;
      if (this.registerAttempts >= max) {
        this.finish({
          reason: 'failed',
          code: 'register_failed',
          message: `${reason} after ${this.registerAttempts} attempt(s)`,
        });
        return;
      }
      if (this.ended !== undefined || this.phase === 'connected') return;
      this.sendRegister();
    } finally {
      this.registerRetryInFlight = false;
    }
  }

  private async onMessage(data: string): Promise<void> {
    if (this.ended !== undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== 'object') return;
    const frame = parsed as InboundFrame;

    if (frame.id === INITIALIZE_ID && ('result' in frame || 'error' in frame)) {
      if (this.initializeTimer) clearTimeout(this.initializeTimer);
      this.initializeTimer = undefined;
      if (frame.error !== undefined && frame.error !== null) {
        this.finish({
          reason: 'failed',
          code: 'acp_initialize_failed',
          message: errorText(frame.error),
        });
        return;
      }
      this.sendRegister();
      return;
    }

    switch (frame.type) {
      case 'mcp_registered': {
        if (frame.server !== this.serverName) return;
        if (this.registerTimer) clearTimeout(this.registerTimer);
        this.registerTimer = undefined;
        this.registerAttempts = 0;
        this.setPhase('connected');
        return;
      }
      case 'mcp_error': {
        const message = String(frame.message ?? 'unknown error');
        if (
          frame.code === 'register_failed' ||
          (frame.code === 'rate_limited' && this.phase === 'registering')
        ) {
          if (this.registerTimer) clearTimeout(this.registerTimer);
          this.registerTimer = undefined;
          void this.retryRegister(message);
          return;
        }
        // One shed frame while connected; the registration stays live.
        if (frame.code === 'rate_limited') return;
        if (frame.code === 'already_registered') {
          // Our own earlier register is still being added at the daemon;
          // wait for it without spending the retry budget.
          if (this.registerTimer) clearTimeout(this.registerTimer);
          this.registerTimer = setTimeout(() => {
            this.registerTimer = undefined;
            if (this.ended !== undefined || this.phase !== 'registering') {
              return;
            }
            this.registerAttempts = Math.max(0, this.registerAttempts - 1);
            this.sendRegister();
          }, this.options.registerTimeoutMs ?? DEFAULTS.registerTimeoutMs);
          return;
        }
        this.finish({
          reason: 'failed',
          code: String(frame.code ?? 'mcp_error'),
          message,
        });
        return;
      }
      case 'mcp_message':
        await this.answer(frame);
        return;
      default:
        // ACP session traffic this client did not ask for.
        return;
    }
  }

  private async answer(frame: InboundFrame): Promise<void> {
    const id = frame.id;
    const payload = frame.payload;
    if (
      typeof id !== 'string' ||
      payload === null ||
      typeof payload !== 'object'
    ) {
      return;
    }
    if (frame.server !== undefined && frame.server !== this.serverName) return;
    const requestId = (payload as { id?: unknown }).id;
    let reply: JsonRpcMessage | undefined;
    try {
      reply = await this.options.rpc.handle(payload);
    } catch (error) {
      reply = errorReply(
        typeof requestId === 'string' || typeof requestId === 'number'
          ? requestId
          : null,
        -32603,
        describe(error),
      );
    }
    // A cancelled MCP call has no child reply, but the daemon still needs its
    // outer frame settled; otherwise its timeout disconnects the MCP server.
    if (
      reply === undefined &&
      (typeof requestId === 'string' || typeof requestId === 'number')
    ) {
      reply = errorReply(requestId, -32800, 'Request cancelled');
    }
    // Notifications get no reply, and a reply after the end has nowhere to go.
    if (reply === undefined || this.ended !== undefined) return;
    this.send({
      type: 'mcp_message',
      id,
      server: this.serverName,
      payload: reply,
    });
  }

  private finish(end: AcpRelayEnd): void {
    if (this.ended !== undefined) return;
    this.ended = end;
    if (this.initializeTimer) clearTimeout(this.initializeTimer);
    if (this.registerTimer) clearTimeout(this.registerTimer);
    this.initializeTimer = undefined;
    this.registerTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    try {
      socket?.close();
    } catch {
      // Already closing.
    }
    this.resolveEnd?.(end);
  }

  private send(frame: Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch {
      // A send on a closing socket surfaces as its close event.
    }
  }
}
