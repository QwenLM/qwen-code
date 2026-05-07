/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import type { PermissionMode } from '../nonInteractive/types.js';
import { PairingManager } from './PairingManager.js';
import {
  SessionRegistry,
  type SessionRegistryOptions,
} from './SessionRegistry.js';
import { APP_JS, INDEX_HTML, STYLES_CSS } from './staticAssets.js';
import {
  DEFAULT_MAX_CLIENTS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_PAIRING_TOKEN_TTL_MS,
  DEFAULT_REMOTE_CONTROL_PORT,
  buildCapabilities,
  eventToEnvelope,
  isRecord,
  makeEnvelope,
  parseRemoteEnvelope,
  requireStringField,
  type RemoteEnvelope,
  type RemoteHistoryPayload,
  type RemoteSessionCreatePayload,
} from './protocol.js';

interface ClientState {
  authenticated: boolean;
  subscriptions: Set<string>;
  ip: string;
}

export interface RemoteControlServerOptions {
  host?: string;
  port?: number;
  allowLan?: boolean;
  noUi?: boolean;
  maxPayloadBytes?: number;
  maxClients?: number;
  tokenTtlMs?: number;
  cwd: string;
  cliEntryPath: string;
  defaultModel?: string;
  defaultPermissionMode?: PermissionMode;
  registry?: SessionRegistry;
  registryOptions?: Partial<SessionRegistryOptions>;
}

export interface RemoteControlServerInfo {
  host: string;
  port: number;
  url: string;
  wsUrl: string;
  lanUrls: string[];
  lanWsUrls: string[];
  pairingToken: string;
  pairingExpiresAt: string;
}

const AUTH_WINDOW_MS = 60 * 1000;
const MAX_AUTH_FAILURES = 5;

export class RemoteControlServer {
  private readonly options: Required<
    Pick<
      RemoteControlServerOptions,
      | 'host'
      | 'port'
      | 'allowLan'
      | 'noUi'
      | 'maxPayloadBytes'
      | 'maxClients'
      | 'tokenTtlMs'
    >
  > &
    Omit<
      RemoteControlServerOptions,
      | 'host'
      | 'port'
      | 'allowLan'
      | 'noUi'
      | 'maxPayloadBytes'
      | 'maxClients'
      | 'tokenTtlMs'
    >;
  private readonly pairing = new PairingManager();
  private readonly registry: SessionRegistry;
  private readonly clients = new Map<WebSocket, ClientState>();
  private readonly authFailures = new Map<string, number[]>();
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private unsubscribeRegistry: (() => void) | null = null;
  private pairingToken: string | null = null;
  private pairingExpiresAt: string | null = null;

  constructor(options: RemoteControlServerOptions) {
    this.options = {
      host: options.host ?? '127.0.0.1',
      port: options.port ?? DEFAULT_REMOTE_CONTROL_PORT,
      allowLan: options.allowLan ?? false,
      noUi: options.noUi ?? false,
      maxPayloadBytes: options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      maxClients: options.maxClients ?? DEFAULT_MAX_CLIENTS,
      tokenTtlMs: options.tokenTtlMs ?? DEFAULT_PAIRING_TOKEN_TTL_MS,
      cwd: options.cwd,
      cliEntryPath: options.cliEntryPath,
      defaultModel: options.defaultModel,
      defaultPermissionMode: options.defaultPermissionMode,
      registry: options.registry,
      registryOptions: options.registryOptions,
    };
    this.assertHostAllowed();
    this.registry =
      options.registry ??
      new SessionRegistry({
        cwd: options.cwd,
        cliEntryPath: options.cliEntryPath,
        defaultModel: options.defaultModel,
        defaultPermissionMode: options.defaultPermissionMode,
        ...options.registryOptions,
      });
  }

  async start(): Promise<RemoteControlServerInfo> {
    if (this.server) {
      return this.getInfo();
    }

    const pairing = this.pairing.createPairingToken(this.options.tokenTtlMs);
    this.pairingToken = pairing.token;
    this.pairingExpiresAt = pairing.expiresAt;

    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({
      server: this.server,
      path: '/ws',
      maxPayload: this.options.maxPayloadBytes,
    });
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    this.unsubscribeRegistry = this.registry.subscribe((sessionId, event) => {
      this.broadcast(sessionId, eventToEnvelope(event));
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.options.port, this.options.host, () => {
        this.server?.off('error', reject);
        resolve();
      });
    });

    return this.getInfo();
  }

  async stop(): Promise<void> {
    this.unsubscribeRegistry?.();
    this.unsubscribeRegistry = null;
    this.registry.closeAll();
    for (const ws of this.clients.keys()) {
      ws.close(1001, 'Server stopping');
    }
    this.clients.clear();
    this.wss?.close();
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
    this.server = null;
    this.wss = null;
  }

  getInfo(): RemoteControlServerInfo {
    const address = this.server?.address();
    const port =
      typeof address === 'object' && address ? address.port : this.options.port;
    const host = this.options.host;
    const publicHost = this.getPrimaryPublicHost(host);
    const lanHosts = this.getLanHosts(host);
    return {
      host,
      port,
      url: `http://${formatUrlHost(publicHost)}:${port}`,
      wsUrl: `ws://${formatUrlHost(publicHost)}:${port}/ws`,
      lanUrls: lanHosts.map(
        (lanHost) => `http://${formatUrlHost(lanHost)}:${port}`,
      ),
      lanWsUrls: lanHosts.map(
        (lanHost) => `ws://${formatUrlHost(lanHost)}:${port}/ws`,
      ),
      pairingToken: this.pairingToken ?? '',
      pairingExpiresAt: this.pairingExpiresAt ?? '',
    };
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') {
      this.sendHttpJson(res, 200, {
        ok: true,
        sessions: this.registry.listSessions().length,
      });
      return;
    }
    if (url.pathname === '/api/pairing') {
      this.sendHttpJson(res, 200, {
        expiresAt: this.pairingExpiresAt,
      });
      return;
    }
    if (this.options.noUi) {
      this.sendHttpJson(res, 404, { error: 'UI disabled' });
      return;
    }
    if (url.pathname === '/') {
      this.sendHttp(res, 200, 'text/html; charset=utf-8', INDEX_HTML);
      return;
    }
    if (url.pathname === '/app.js') {
      this.sendHttp(res, 200, 'text/javascript; charset=utf-8', APP_JS);
      return;
    }
    if (url.pathname === '/styles.css') {
      this.sendHttp(res, 200, 'text/css; charset=utf-8', STYLES_CSS);
      return;
    }
    this.sendHttpJson(res, 404, { error: 'Not found' });
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    if (this.clients.size >= this.options.maxClients) {
      ws.close(1013, 'Too many clients');
      return;
    }
    if (!this.isAllowedOrigin(req.headers.origin)) {
      ws.close(1008, 'Origin not allowed');
      return;
    }

    const state: ClientState = {
      authenticated: false,
      subscriptions: new Set(),
      ip: req.socket.remoteAddress ?? 'unknown',
    };
    this.clients.set(ws, state);

    ws.on('message', (data) => {
      try {
        this.handleWsMessage(ws, state, JSON.parse(data.toString()));
      } catch (error) {
        this.sendError(
          ws,
          error instanceof Error ? error.message : String(error),
        );
      }
    });
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
  }

  private handleWsMessage(
    ws: WebSocket,
    state: ClientState,
    raw: unknown,
  ): void {
    const envelope = parseRemoteEnvelope(raw);
    if (!state.authenticated) {
      if (envelope.type !== 'auth/pair') {
        throw new Error('Authenticate before sending remote-control messages');
      }
      this.handleAuth(ws, state, envelope);
      return;
    }

    switch (envelope.type) {
      case 'session/list':
        this.send(ws, 'session/list/result', {
          sessions: this.registry.listSessions(),
        });
        break;
      case 'session/create':
        this.handleSessionCreate(ws, state, envelope);
        break;
      case 'session/attach':
        this.handleSessionAttach(ws, state, envelope);
        break;
      case 'history/resume':
        this.handleHistoryResume(ws, envelope);
        break;
      case 'user/submit':
        this.handleUserSubmit(ws, envelope);
        break;
      case 'tool/respond':
        this.handleToolRespond(ws, envelope);
        break;
      case 'control/interrupt':
        this.handleControlInterrupt(ws, envelope);
        break;
      case 'control/set_model':
        this.handleSetModel(ws, envelope);
        break;
      case 'control/set_permission_mode':
        this.handleSetPermissionMode(ws, envelope);
        break;
      case 'control/get_context_usage':
        this.handleGetContextUsage(ws, envelope);
        break;
      case 'session/close':
        {
          const sessionId = this.requireSessionId(envelope);
          this.registry.closeSession(sessionId);
          this.send(ws, 'command/ack', { command: envelope.type }, sessionId);
        }
        break;
      case 'ping':
        this.send(ws, 'pong', {});
        break;
      default:
        throw new Error(`Unsupported remote-control message: ${envelope.type}`);
    }
  }

  private handleAuth(
    ws: WebSocket,
    state: ClientState,
    envelope: RemoteEnvelope,
  ): void {
    const ip = state.ip;
    if (this.isRateLimited(ip)) {
      throw new Error('Too many authentication failures');
    }
    const payload = this.expectPayload(envelope);
    const token = requireStringField(payload, 'token');
    const isClientToken = this.pairing.verifyClientToken(token);
    const isPairingToken = this.pairing.verifyPairingToken(token);
    if (!isClientToken && !isPairingToken) {
      this.recordAuthFailure(ip);
      throw new Error('Invalid pairing token');
    }
    state.authenticated = true;
    const issued = isClientToken ? null : this.pairing.issueClientToken();
    this.send(ws, 'auth/result', {
      ok: true,
      capabilities: buildCapabilities(),
      clientToken: issued?.token,
      clientTokenExpiresAt: issued?.expiresAt,
      sessions: this.registry.listSessions(),
    });
  }

  private handleSessionCreate(
    ws: WebSocket,
    state: ClientState,
    envelope: RemoteEnvelope,
  ): void {
    const payload = this.expectOptionalPayload(
      envelope,
    ) as unknown as RemoteSessionCreatePayload;
    const session = this.registry.createSession(payload);
    state.subscriptions.add(session.id);
    this.send(ws, 'session/state', session, session.id);
    this.sendHistory(ws, session.id);
  }

  private handleSessionAttach(
    ws: WebSocket,
    state: ClientState,
    envelope: RemoteEnvelope,
  ): void {
    const sessionId =
      envelope.sessionId ??
      (isRecord(envelope.payload)
        ? requireStringField(envelope.payload, 'sessionId')
        : undefined);
    if (!sessionId) {
      throw new Error('sessionId is required');
    }
    state.subscriptions.add(sessionId);
    this.send(
      ws,
      'session/state',
      this.registry.getSession(sessionId),
      sessionId,
    );
    const payload = this.expectOptionalPayload(
      envelope,
    ) as unknown as RemoteHistoryPayload;
    this.sendHistory(ws, sessionId, payload.since);
  }

  private handleHistoryResume(ws: WebSocket, envelope: RemoteEnvelope): void {
    const sessionId = this.requireSessionId(envelope);
    const payload = this.expectOptionalPayload(
      envelope,
    ) as unknown as RemoteHistoryPayload;
    this.sendHistory(ws, sessionId, payload.since ?? envelope.seq);
  }

  private handleUserSubmit(ws: WebSocket, envelope: RemoteEnvelope): void {
    const sessionId = this.requireSessionId(envelope);
    const payload = this.expectPayload(envelope);
    const text = requireStringField(payload, 'text');
    this.registry.submit(sessionId, text);
    this.send(ws, 'command/ack', { command: envelope.type }, sessionId);
  }

  private handleToolRespond(ws: WebSocket, envelope: RemoteEnvelope): void {
    const sessionId = this.requireSessionId(envelope);
    const payload = this.expectPayload(envelope);
    const requestId = requireStringField(payload, 'requestId');
    const behavior = payload['behavior'];
    if (behavior !== 'allow' && behavior !== 'deny') {
      throw new Error('tool/respond behavior must be allow or deny');
    }
    this.registry.respondToTool(sessionId, {
      requestId,
      behavior,
      ...(typeof payload['message'] === 'string' && {
        message: payload['message'],
      }),
      ...('updatedInput' in payload && {
        updatedInput: payload['updatedInput'],
      }),
    });
    this.send(ws, 'command/ack', { command: envelope.type }, sessionId);
  }

  private handleControlInterrupt(
    ws: WebSocket,
    envelope: RemoteEnvelope,
  ): void {
    const sessionId = this.requireSessionId(envelope);
    const requestId = this.registry.interrupt(sessionId);
    this.send(
      ws,
      'command/ack',
      { command: envelope.type, requestId },
      sessionId,
    );
  }

  private handleSetModel(ws: WebSocket, envelope: RemoteEnvelope): void {
    const sessionId = this.requireSessionId(envelope);
    const payload = this.expectPayload(envelope);
    const requestId = this.registry.setModel(
      sessionId,
      requireStringField(payload, 'model'),
    );
    this.send(
      ws,
      'command/ack',
      { command: envelope.type, requestId },
      sessionId,
    );
  }

  private handleSetPermissionMode(
    ws: WebSocket,
    envelope: RemoteEnvelope,
  ): void {
    const sessionId = this.requireSessionId(envelope);
    const payload = this.expectPayload(envelope);
    const mode = requireStringField(payload, 'mode') as PermissionMode;
    if (!['default', 'plan', 'auto-edit', 'yolo'].includes(mode)) {
      throw new Error(`Invalid permission mode: ${mode}`);
    }
    const requestId = this.registry.setPermissionMode(sessionId, mode);
    this.send(
      ws,
      'command/ack',
      { command: envelope.type, requestId },
      sessionId,
    );
  }

  private handleGetContextUsage(ws: WebSocket, envelope: RemoteEnvelope): void {
    const sessionId = this.requireSessionId(envelope);
    const showDetails =
      isRecord(envelope.payload) && envelope.payload['showDetails'] === true;
    const requestId = this.registry.getContextUsage(sessionId, showDetails);
    this.send(
      ws,
      'command/ack',
      { command: envelope.type, requestId },
      sessionId,
    );
  }

  private sendHistory(ws: WebSocket, sessionId: string, since?: number): void {
    const replay = this.registry.replay(sessionId, since);
    this.send(
      ws,
      'history/replay',
      {
        events: replay.events.map((event) => eventToEnvelope(event)),
        truncated: replay.truncated,
      },
      sessionId,
    );
  }

  private broadcast(sessionId: string, envelope: RemoteEnvelope): void {
    for (const [ws, state] of this.clients.entries()) {
      if (
        state.authenticated &&
        (state.subscriptions.has(sessionId) ||
          envelope.type === 'session/state')
      ) {
        this.sendEnvelope(ws, envelope);
      }
    }
  }

  private send<TPayload>(
    ws: WebSocket,
    type: string,
    payload: TPayload,
    sessionId?: string,
  ): void {
    this.sendEnvelope(ws, makeEnvelope(type, payload, { sessionId }));
  }

  private sendEnvelope(ws: WebSocket, envelope: RemoteEnvelope): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(envelope));
    }
  }

  private sendError(ws: WebSocket, message: string): void {
    this.send(ws, 'error', { message });
  }

  private sendHttp(
    res: ServerResponse,
    statusCode: number,
    contentType: string,
    body: string,
  ): void {
    res.writeHead(statusCode, {
      'content-type': contentType,
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'",
    });
    res.end(body);
  }

  private sendHttpJson(
    res: ServerResponse,
    statusCode: number,
    body: unknown,
  ): void {
    this.sendHttp(
      res,
      statusCode,
      'application/json; charset=utf-8',
      JSON.stringify(body),
    );
  }

  private requireSessionId(envelope: RemoteEnvelope): string {
    if (!envelope.sessionId) {
      throw new Error('sessionId is required');
    }
    return envelope.sessionId;
  }

  private expectPayload(envelope: RemoteEnvelope): Record<string, unknown> {
    if (!isRecord(envelope.payload)) {
      throw new Error(`${envelope.type} payload must be an object`);
    }
    return envelope.payload;
  }

  private expectOptionalPayload(
    envelope: RemoteEnvelope,
  ): Record<string, unknown> {
    if (envelope.payload === undefined) {
      return {};
    }
    return this.expectPayload(envelope);
  }

  private isRateLimited(ip: string): boolean {
    const now = Date.now();
    const failures = (this.authFailures.get(ip) ?? []).filter(
      (time) => now - time < AUTH_WINDOW_MS,
    );
    this.authFailures.set(ip, failures);
    return failures.length >= MAX_AUTH_FAILURES;
  }

  private recordAuthFailure(ip: string): void {
    const failures = this.authFailures.get(ip) ?? [];
    failures.push(Date.now());
    this.authFailures.set(ip, failures);
  }

  private isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin) {
      return true;
    }
    try {
      const parsed = new URL(origin);
      if (['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
        return true;
      }
      return this.options.allowLan;
    } catch {
      return false;
    }
  }

  private assertHostAllowed(): void {
    const host = this.options.host;
    const isLoopback =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '';
    if (!isLoopback && !this.options.allowLan) {
      throw new Error(
        `Refusing to bind remote-control server to ${host} without --allow-lan`,
      );
    }
  }

  private getPrimaryPublicHost(host: string): string {
    if (host === '0.0.0.0' || host === '') {
      return '127.0.0.1';
    }
    if (host === '::') {
      return '::1';
    }
    return host;
  }

  private getLanHosts(host: string): string[] {
    if (!this.options.allowLan) {
      return [];
    }
    if (host !== '0.0.0.0' && host !== '' && host !== '::') {
      return isLoopbackHost(host) ? [] : [host];
    }

    const hosts: string[] = [];
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (!entry.internal && entry.family === 'IPv4') {
          hosts.push(entry.address);
        }
      }
    }
    return [...new Set(hosts)].sort();
  }
}

function formatUrlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
