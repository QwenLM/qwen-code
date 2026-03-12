/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { writeLockFile, removeLockFile } from './lock-file.js';
import { getWebUIHtml, getSessionsListHtml } from './web-ui.js';
import type { DaemonSessionInfo, DaemonWsMessage } from './types.js';
import { runDaemonSession } from './session-runner.js';

/** Maximum number of concurrent sessions allowed. */
const MAX_SESSIONS = 50;

/** Session idle timeout in milliseconds (30 minutes). */
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

interface ActiveSession {
  sessionId: string;
  clients: Set<WebSocket>;
  createdAt: string;
  prompt: string;
  abortController: AbortController | null;
  lastActivityAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * The daemon HTTP + WebSocket server.
 * Provides a web UI for interacting with Qwen Code sessions.
 */
export class DaemonServer {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly authToken: string;
  private readonly authTokenBuffer: Buffer;
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly cwd: string;
  private readonly port: number;
  private onStopRequested: (() => void) | null = null;

  constructor(cwd: string, port: number, authToken?: string) {
    this.cwd = cwd;
    this.port = port;
    this.authToken = authToken ?? randomUUID();
    this.authTokenBuffer = Buffer.from(this.authToken);
  }

  /** Start the daemon server. */
  async start(): Promise<{ port: number; authToken: string }> {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (ws, sessionId: string) =>
      this.handleWsConnection(ws, sessionId),
    );

    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }

      const token = url.searchParams.get('token') ?? '';
      if (!this.verifyToken(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const sessionId = url.searchParams.get('session') ?? '';
      const session = this.sessions.get(sessionId);
      if (!session) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.wss!.emit('connection', ws, sessionId);
      });
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, '127.0.0.1', () => {
        const addr = this.server!.address();
        const actualPort =
          typeof addr === 'object' && addr ? addr.port : this.port;

        writeLockFile({
          pid: process.pid,
          port: actualPort,
          authToken: this.authToken,
          cwd: this.cwd,
          startedAt: new Date().toISOString(),
        });

        resolve({ port: actualPort, authToken: this.authToken });
      });

      this.server!.on('error', (err) => {
        reject(err);
      });
    });
  }

  /** Stop the daemon server and clean up. */
  async stop(): Promise<void> {
    // Abort all active sessions and clear idle timers
    for (const session of this.sessions.values()) {
      session.abortController?.abort();
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
      }
      for (const client of session.clients) {
        client.close();
      }
    }
    this.sessions.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.server) {
      // Close all active connections so server.close() resolves promptly
      this.server.closeAllConnections();
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    removeLockFile();
  }

  /** Register a callback to be invoked when a stop is requested via API. */
  onStop(callback: () => void): void {
    this.onStopRequested = callback;
  }

  /** Get info about all active sessions. */
  getSessionsInfo(): DaemonSessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      clientCount: s.clients.size,
      createdAt: s.createdAt,
      prompt: s.prompt,
    }));
  }

  /** Constant-time token comparison to prevent timing attacks. */
  private verifyToken(token: string): boolean {
    const tokenBuffer = Buffer.from(token);
    if (tokenBuffer.length !== this.authTokenBuffer.length) {
      return false;
    }
    return timingSafeEqual(tokenBuffer, this.authTokenBuffer);
  }

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const token =
      url.searchParams.get('token') ??
      req.headers.authorization?.replace('Bearer ', '') ??
      '';

    // Health check endpoint (no auth required)
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', pid: process.pid }));
      return;
    }

    // All other routes require authentication
    if (!this.verifyToken(token)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }

    // API routes
    if (url.pathname === '/api/sessions') {
      this.handleApiSessions(res);
      return;
    }

    if (url.pathname === '/api/stop') {
      this.handleApiStop(req, res);
      return;
    }

    // Session list page
    if (url.pathname === '/' || url.pathname === '/sessions') {
      const sessions = this.getSessionsInfo().map((s) => ({
        sessionId: s.sessionId,
        prompt: s.prompt,
        createdAt: s.createdAt,
      }));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getSessionsListHtml(sessions, this.authToken));
      return;
    }

    // New session
    if (url.pathname === '/session/new') {
      if (this.sessions.size >= MAX_SESSIONS) {
        res.writeHead(429, { 'Content-Type': 'text/plain' });
        res.end(
          `Too many sessions (max: ${MAX_SESSIONS}). Close some sessions first.`,
        );
        return;
      }
      const sessionId = randomUUID();
      this.createSession(sessionId);
      res.writeHead(302, {
        Location: `/session/${sessionId}?token=${this.authToken}`,
      });
      res.end();
      return;
    }

    // Session page (only serve existing sessions)
    const sessionMatch = url.pathname.match(/^\/session\/([a-f0-9-]+)$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];
      if (!this.sessions.has(sessionId)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Session not found. Use /session/new to create one.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getWebUIHtml(sessionId, this.authToken));
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  private handleApiSessions(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.getSessionsInfo()));
  }

  private handleApiStop(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'stopping' }));
    // Notify the caller (daemon-entry) to handle shutdown
    setTimeout(() => {
      if (this.onStopRequested) {
        this.onStopRequested();
      }
    }, 100);
  }

  private createSession(sessionId: string): ActiveSession {
    const session: ActiveSession = {
      sessionId,
      clients: new Set(),
      createdAt: new Date().toISOString(),
      prompt: '',
      abortController: null,
      lastActivityAt: Date.now(),
      idleTimer: null,
    };
    this.sessions.set(sessionId, session);
    this.resetIdleTimer(session);
    return session;
  }

  /** Reset the idle timer for a session. Removes the session if idle too long. */
  private resetIdleTimer(session: ActiveSession): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }
    session.lastActivityAt = Date.now();
    session.idleTimer = setTimeout(() => {
      // Only remove if no clients connected and no active task
      if (session.clients.size === 0 && !session.abortController) {
        this.sessions.delete(session.sessionId);
      } else {
        // Still active, reset timer
        this.resetIdleTimer(session);
      }
    }, SESSION_IDLE_TIMEOUT_MS);
  }

  private handleWsConnection(ws: WebSocket, sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      ws.close();
      return;
    }

    session.clients.add(ws);
    this.resetIdleTimer(session);

    // Send connected confirmation
    this.sendToClient(ws, { type: 'connected', sessionId });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as DaemonWsMessage;
        this.handleWsMessage(session, ws, msg);
      } catch {
        this.sendToClient(ws, {
          type: 'error',
          data: 'Invalid message format',
        });
      }
    });

    ws.on('close', () => {
      session.clients.delete(ws);
      this.resetIdleTimer(session);
    });
  }

  private handleWsMessage(
    session: ActiveSession,
    _ws: WebSocket,
    msg: DaemonWsMessage,
  ): void {
    switch (msg.type) {
      case 'prompt':
        this.handlePrompt(session, String(msg.data ?? ''));
        break;
      case 'stop':
        session.abortController?.abort();
        break;
      default:
        break;
    }
  }

  private async handlePrompt(
    session: ActiveSession,
    prompt: string,
  ): Promise<void> {
    if (!prompt.trim()) return;

    // Reject if a prompt is already being processed for this session
    if (session.abortController) {
      this.broadcastToSession(session, {
        type: 'error',
        data: 'A prompt is already being processed. Stop it first or wait for it to finish.',
      });
      return;
    }

    if (!session.prompt) {
      session.prompt = prompt.slice(0, 200);
    }

    const abortController = new AbortController();
    session.abortController = abortController;
    this.resetIdleTimer(session);

    this.broadcastToSession(session, {
      type: 'status',
      data: 'processing',
    });

    try {
      await runDaemonSession({
        cwd: this.cwd,
        prompt,
        sessionId: session.sessionId,
        abortSignal: abortController.signal,
        onOutput: (text) => {
          this.broadcastToSession(session, { type: 'output', data: text });
        },
        onToolCall: (toolName) => {
          this.broadcastToSession(session, {
            type: 'status',
            data: `tool:${toolName}`,
          });
        },
        onError: (error) => {
          this.broadcastToSession(session, {
            type: 'error',
            data: error,
          });
        },
      });

      this.broadcastToSession(session, {
        type: 'status',
        data: abortController.signal.aborted ? 'stopped' : 'done',
      });
    } catch (err) {
      this.broadcastToSession(session, {
        type: 'error',
        data: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      session.abortController = null;
      this.resetIdleTimer(session);
    }
  }

  private broadcastToSession(
    session: ActiveSession,
    msg: DaemonWsMessage,
  ): void {
    const data = JSON.stringify(msg);
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  private sendToClient(ws: WebSocket, msg: DaemonWsMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}
