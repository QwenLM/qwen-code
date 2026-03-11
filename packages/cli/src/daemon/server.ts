/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { writeLockFile, removeLockFile } from './lock-file.js';
import { getWebUIHtml, getSessionsListHtml } from './web-ui.js';
import type { DaemonSessionInfo, DaemonWsMessage } from './types.js';
import { runDaemonSession } from './session-runner.js';

interface ActiveSession {
  sessionId: string;
  clients: Set<WebSocket>;
  createdAt: string;
  prompt: string;
  abortController: AbortController | null;
}

/**
 * The daemon HTTP + WebSocket server.
 * Provides a web UI for interacting with Qwen Code sessions.
 */
export class DaemonServer {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly authToken: string;
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly cwd: string;
  private readonly port: number;

  constructor(cwd: string, port: number, authToken?: string) {
    this.cwd = cwd;
    this.port = port;
    this.authToken = authToken ?? randomUUID();
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

      const token = url.searchParams.get('token');
      if (token !== this.authToken) {
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
    // Abort all active sessions
    for (const session of this.sessions.values()) {
      session.abortController?.abort();
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
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    removeLockFile();
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

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const token =
      url.searchParams.get('token') ??
      req.headers.authorization?.replace('Bearer ', '');

    // Health check endpoint (no auth required)
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', pid: process.pid }));
      return;
    }

    // All other routes require authentication
    if (token !== this.authToken) {
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
      this.handleApiStop(res);
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
      const sessionId = randomUUID();
      this.createSession(sessionId);
      res.writeHead(302, {
        Location: `/session/${sessionId}?token=${this.authToken}`,
      });
      res.end();
      return;
    }

    // Session page
    const sessionMatch = url.pathname.match(/^\/session\/([a-f0-9-]+)$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];
      if (!this.sessions.has(sessionId)) {
        this.createSession(sessionId);
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

  private handleApiStop(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'stopping' }));
    // Graceful shutdown after response is sent
    setTimeout(() => this.stop().then(() => process.exit(0)), 100);
  }

  private createSession(sessionId: string): ActiveSession {
    const session: ActiveSession = {
      sessionId,
      clients: new Set(),
      createdAt: new Date().toISOString(),
      prompt: '',
      abortController: null,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  private handleWsConnection(ws: WebSocket, sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      ws.close();
      return;
    }

    session.clients.add(ws);

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

    if (!session.prompt) {
      session.prompt = prompt.slice(0, 200);
    }

    const abortController = new AbortController();
    session.abortController = abortController;

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
