/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import * as http from 'http';
import * as crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { Config } from '@qwen-code/qwen-code-core';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import type {
  AuthState,
  ClientMessage,
  ConnectionInfo,
  ConversationMessage,
  QRConnectionData,
  RemoteControlConfig,
  ServerMessage,
  SessionState,
  WSMessage,
} from '../types.js';
import {
  DEFAULT_REMOTE_CONTROL_CONFIG,
  AuthState as AuthStates,
} from '../types.js';
import { escapeHtml } from '../utils/htmlSanitizer.js';
import { getCliVersion } from '../../utils/version.js';

const debug = createDebugLogger('REMOTE_CONTROL');

// Security constants
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB max message size
const MAX_AUTH_ATTEMPTS = 5;
const AUTH_WINDOW_MS = 60 * 1000; // 1 minute
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Rate limiting state for authentication attempts
 */
interface AuthRateLimitState {
  attempts: number;
  firstAttemptTime: number;
  blockedUntil?: number;
}

/**
 * Client connection state
 * FIX: Added clientIp field to store IP at connection time for proper rate limiting
 */
interface ClientConnection {
  ws: WebSocket;
  sessionId: string;
  authState: AuthState;
  connectedAt: number;
  lastActivity: number;
  isAuthenticated: boolean;
  clientIp: string; // FIX: Store IP at connection time for rate limiting
}

/**
 * Remote Control Server
 *
 * Provides HTTP and WebSocket endpoints for remote clients to connect
 * to and interact with a local Qwen Code session.
 *
 * Security features:
 * - Token-based authentication (tokens sent via WebSocket messages, not URLs)
 * - Rate limiting on authentication attempts (per-client-IP)
 * - Connection limits
 * - Message size validation
 * - Idle session timeout
 * - Input sanitization
 * - Proxy-aware IP detection for rate limiting
 */
export class RemoteControlServer {
  private httpServer?: http.Server;
  private wsServer?: WebSocketServer;
  private config: RemoteControlConfig;
  private clients: Map<string, ClientConnection> = new Map();
  private sessionMessageHistory: ConversationMessage[] = [];
  private sessionState: SessionState;
  private authToken: string;
  private authRateLimits: Map<string, AuthRateLimitState> = new Map();
  private idleCleanupInterval?: NodeJS.Timeout;
  private serverVersion: string = 'unknown';

  constructor(config?: Partial<RemoteControlConfig>) {
    this.config = { ...DEFAULT_REMOTE_CONTROL_CONFIG, ...config };
    // Version will be set asynchronously in initialize()

    this.sessionState = {
      sessionId: crypto.randomUUID(),
      sessionName: this.config.sessionName || 'Qwen Code Session',
      startTime: Date.now(),
      status: 'active',
      workingDirectory: process.cwd(),
      model: 'unknown',
      approvalMode: 'default',
    };

    // Generate cryptographically secure auth token
    this.authToken = crypto.randomBytes(32).toString('hex');
  }

  /**
   * Initialize the server with Qwen Code config
   * @param qwenConfig - Qwen Code configuration object
   */
  async initialize(qwenConfig: Config): Promise<void> {
    this.sessionState.sessionId =
      qwenConfig.getSessionId() || this.sessionState.sessionId;
    this.sessionState.model = qwenConfig.getModel() || this.sessionState.model;
    this.sessionState.approvalMode = 'default';
    this.serverVersion = await getCliVersion();
  }

  /**
   * Start the HTTP and WebSocket servers
   * @returns Promise that resolves when server is started
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Create HTTP server for serving static files and health checks
        this.httpServer = http.createServer((req, res) => {
          this.handleHttpRequest(req, res);
        });

        // Create WebSocket server
        this.wsServer = new WebSocketServer({
          server: this.httpServer,
          path: '/ws',
          maxPayload: MAX_MESSAGE_SIZE,
        });

        this.wsServer.on('connection', (ws, req) => {
          this.handleWebSocketConnection(ws, req);
        });

        this.wsServer.on('error', (error) => {
          debug.debug('WebSocket server error: %s', error.message);
        });

        // Start listening
        this.httpServer.listen(this.config.port, this.config.host, () => {
          // FIX: Always use ws:// until TLS is implemented
          debug.debug(
            'Remote control server started on ws://%s:%d',
            this.config.host,
            this.config.port,
          );
          resolve();
        });

        this.httpServer.on('error', (error) => {
          reject(new Error(`Failed to start server: ${error.message}`));
        });

        // Start idle cleanup interval
        this.startIdleCleanup();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop the server and clean up resources
   * @returns Promise that resolves when server is stopped
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      // Stop idle cleanup
      if (this.idleCleanupInterval) {
        clearInterval(this.idleCleanupInterval);
        this.idleCleanupInterval = undefined;
      }

      // Close all WebSocket connections
      for (const client of this.clients.values()) {
        client.ws.close(1001, 'Server shutting down');
      }
      this.clients.clear();
      this.authRateLimits.clear();

      // Close WebSocket server
      if (this.wsServer) {
        this.wsServer.close(() => {
          debug.debug('WebSocket server closed');
        });
      }

      // Close HTTP server
      if (this.httpServer) {
        this.httpServer.close(() => {
          debug.debug('HTTP server closed');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Start periodic cleanup of idle connections
   */
  private startIdleCleanup(): void {
    this.idleCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, client] of this.clients.entries()) {
        if (now - client.lastActivity > IDLE_TIMEOUT_MS) {
          client.ws.close(1000, 'Idle timeout');
          this.clients.delete(id);
          debug.debug('Closed idle connection: %s', id);
        }
      }
      // Clean up old rate limit entries
      for (const [ip, state] of this.authRateLimits.entries()) {
        if (now - state.firstAttemptTime > AUTH_WINDOW_MS * 2) {
          this.authRateLimits.delete(ip);
        }
      }
    }, CLEANUP_INTERVAL_MS);
  }

  /**
   * Handle HTTP requests
   * FIX: Validate Host header before using it to prevent crashes on malformed headers
   * @param req - HTTP request object
   * @param res - HTTP response object
   */
  private handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    // FIX: Validate Host header before using it
    const hostHeader =
      typeof req.headers.host === 'string' ? req.headers.host : '';
    let url: URL;
    try {
      const baseUrl =
        hostHeader.trim() !== '' ? `http://${hostHeader}` : 'http://localhost';
      url = new URL(req.url || '/', baseUrl);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request');
      return;
    }

    // Health check endpoint
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          sessionId: this.sessionState.sessionId,
        }),
      );
      return;
    }

    // FIX: Connection info endpoint - no longer requires token in URL
    // Token is sent via WebSocket auth message instead
    if (url.pathname === '/api/connect') {
      const connectionInfo: ConnectionInfo = {
        sessionId: this.sessionState.sessionId,
        sessionName: this.sessionState.sessionName,
        serverVersion: this.serverVersion,
        capabilities: ['realtime', 'history', 'control'],
        authState: AuthStates.PENDING,
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(connectionInfo));
      return;
    }

    // FIX: QR code data endpoint - no longer requires token in URL
    if (url.pathname === '/api/qr-data') {
      const qrData: QRConnectionData = this.getQRConnectionData();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(qrData));
      return;
    }

    // Serve static files (web UI)
    if (url.pathname === '/' || url.pathname === '/index.html') {
      this.serveStaticFile(res, 'index.html', 'text/html');
      return;
    }

    if (url.pathname.endsWith('.js')) {
      this.serveStaticFile(
        res,
        url.pathname.slice(1),
        'application/javascript',
      );
      return;
    }

    if (url.pathname.endsWith('.css')) {
      this.serveStaticFile(res, url.pathname.slice(1), 'text/css');
      return;
    }

    // 404 for everything else
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  /**
   * Serve static files from the client directory
   * @param res - HTTP response object
   * @param filename - Name of file to serve
   * @param _contentType - MIME type (unused, kept for API compatibility)
   */
  private async serveStaticFile(
    res: http.ServerResponse,
    filename: string,
    _contentType: string,
  ): Promise<void> {
    try {
      if (filename === 'index.html') {
        const html = this.generateWebUI();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'X-XSS-Protection': '1; mode=block',
        });
        res.end(html);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
    } catch (_error) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  }

  /**
   * Generate a simple web UI for remote control
   * FIX: Removed auth token from HTML page - token must be entered manually
   * and sent via WebSocket auth message, not embedded in page source
   * @returns HTML string for the web UI
   */
  private generateWebUI(): string {
    // FIX: Use relative WebSocket path so browser uses correct protocol (ws/wss)
    const wsPath = '/ws';
    const sessionName = escapeHtml(this.sessionState.sessionName);
    const sessionId = escapeHtml(this.sessionState.sessionId.slice(0, 8));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:;">
  <title>Qwen Code Remote Control</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 16px;
      padding: 40px;
      max-width: 500px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    h1 { color: #333; margin-bottom: 10px; font-size: 24px; }
    .subtitle { color: #666; margin-bottom: 30px; font-size: 14px; }
    .status {
      background: #f0f0f0;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .status-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .status-row:last-child { margin-bottom: 0; }
    .status-label { color: #666; font-size: 12px; }
    .status-value { color: #333; font-weight: 600; font-size: 14px; }
    .status-value.session-id { font-family: monospace; font-size: 12px; }
    .token-entry {
      background: #f8f9fa;
      border: 2px dashed #ccc;
      border-radius: 8px;
      padding: 20px;
      text-align: center;
      margin-bottom: 20px;
    }
    .token-entry p { color: #666; margin-bottom: 15px; }
    .token-entry input {
      padding: 12px;
      font-size: 14px;
      width: 100%;
      max-width: 350px;
      border: 1px solid #ddd;
      border-radius: 8px;
      margin-bottom: 10px;
      box-sizing: border-box;
    }
    .token-entry button {
      padding: 12px 24px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      cursor: pointer;
      font-weight: 600;
    }
    .token-entry button:hover { background: #5a6fd6; }
    .instructions {
      color: #666;
      font-size: 13px;
      line-height: 1.6;
    }
    .instructions ol { margin-left: 20px; margin-top: 10px; }
    .instructions li { margin-bottom: 8px; }
    .connecting { display: none; text-align: center; padding: 30px; }
    .connecting.active { display: block; }
    .spinner {
      width: 40px;
      height: 40px;
      border: 4px solid #f0f0f0;
      border-top-color: #667eea;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 15px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .connected { display: none; }
    .connected.active { display: block; }
    .message-area {
      background: #f8f9fa;
      border-radius: 8px;
      padding: 20px;
      margin-top: 20px;
      max-height: 300px;
      overflow-y: auto;
    }
    .message {
      margin-bottom: 15px;
      padding: 10px;
      border-radius: 6px;
    }
    .message.user { background: #e3f2fd; margin-left: 20%; }
    .message.assistant { background: #f0f0f0; margin-right: 20%; }
    .message-meta { font-size: 11px; color: #999; margin-top: 5px; }
    .input-area { display: flex; gap: 10px; margin-top: 20px; }
    .input-area input {
      flex: 1;
      padding: 12px 15px;
      border: 1px solid #ddd;
      border-radius: 8px;
      font-size: 14px;
    }
    .input-area button {
      padding: 12px 24px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      cursor: pointer;
      font-weight: 600;
    }
    .input-area button:hover { background: #5a6fd6; }
    .input-area button:disabled { background: #ccc; cursor: not-allowed; }
    .security-warning {
      background: #fff3cd;
      border: 1px solid #ffc107;
      border-radius: 8px;
      padding: 15px;
      margin-bottom: 20px;
      font-size: 13px;
      color: #856404;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Qwen Code Remote Control</h1>
    <p class="subtitle">Connect to your local Qwen Code session</p>

    <div class="security-warning" id="security-warning" style="display: none;">
      <strong>Security Warning:</strong> You are connecting over an unencrypted connection.
      Only use this on trusted networks.
    </div>

    <div class="status">
      <div class="status-row">
        <span class="status-label">Session</span>
        <span class="status-value">${sessionName}</span>
      </div>
      <div class="status-row">
        <span class="status-label">Session ID</span>
        <span class="status-value session-id">${sessionId}...</span>
      </div>
      <div class="status-row">
        <span class="status-label">Status</span>
        <span class="status-value" id="connection-status">Enter token to connect</span>
      </div>
    </div>

    <div class="token-entry" id="token-entry">
      <p>Enter the auth token displayed in your terminal:</p>
      <input type="text" id="token-input" placeholder="Paste your auth token here" />
      <button id="connect-btn">Connect</button>
    </div>

    <div class="connecting" id="connecting">
      <div class="spinner"></div>
      <p>Connecting to session...</p>
    </div>

    <div class="connected" id="connected">
      <div class="message-area" id="message-area">
        <div class="message assistant">
          <div>Connected to Qwen Code Remote Control!</div>
          <div class="message-meta">System - Just now</div>
        </div>
      </div>
      <div class="input-area">
        <input type="text" id="message-input" placeholder="Type a message..." />
        <button id="send-btn">Send</button>
      </div>
    </div>
  </div>

  <script>
    // FIX: Token is entered by user, not hardcoded in page
    let token = null;

    // Use relative WebSocket path - browser uses page protocol (ws/wss)
    const wsPath = '${wsPath}';
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = protocol + '//' + window.location.host + wsPath;

    const statusEl = document.getElementById('connection-status');
    const tokenEntry = document.getElementById('token-entry');
    const tokenInput = document.getElementById('token-input');
    const connectBtn = document.getElementById('connect-btn');
    const connectingEl = document.getElementById('connecting');
    const connectedEl = document.getElementById('connected');

    connectBtn.addEventListener('click', () => {
      token = tokenInput.value.trim();
      if (token) {
        connect();
      }
    });

    let ws = null;

    function connect() {
      if (!token) return;

      statusEl.textContent = 'Connecting...';
      connectingEl.classList.add('active');
      tokenEntry.style.display = 'none';

      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        // Send auth request with token in message body (not URL)
        ws.send(JSON.stringify({
          version: 1,
          payload: { type: 'auth_request', token }
        }));
      };

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        handleMessage(message);
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        statusEl.textContent = 'Connection error';
        connectingEl.classList.remove('active');
        tokenEntry.style.display = 'block';
      };

      ws.onclose = () => {
        console.log('Disconnected');
        statusEl.textContent = 'Disconnected - Reconnecting...';
        setTimeout(connect, 3000);
      };
    }

    function handleMessage(message) {
      const { payload } = message;

      switch (payload.type) {
        case 'auth_response':
          if (payload.success) {
            statusEl.textContent = 'Connected';
            connectingEl.classList.remove('active');
            connectedEl.classList.add('active');
            document.getElementById('security-warning').style.display = 'none';

            // Request session sync
            ws.send(JSON.stringify({
              version: 1,
              payload: { type: 'sync_request' }
            }));
          } else {
            statusEl.textContent = 'Authentication failed: ' + (payload.message || 'Invalid token');
            connectingEl.classList.remove('active');
            tokenEntry.style.display = 'block';
          }
          break;

        case 'sync_response':
          // Load session history
          payload.messages.forEach(msg => addMessage(msg));
          break;

        case 'message_update':
          addMessage(payload.message);
          break;

        case 'session_update':
          // Update session state
          break;

        case 'error':
          console.error('Server error:', payload.message);
          break;
      }
    }

    function addMessage(msg) {
      const div = document.createElement('div');
      div.className = 'message ' + (msg.type === 'user' ? 'user' : 'assistant');
      div.innerHTML = '<div>' + escapeHtml(msg.content) + '</div>' +
        '<div class="message-meta">' + escapeHtml(msg.type) + ' - ' +
        new Date(msg.timestamp).toLocaleTimeString() + '</div>';
      document.getElementById('message-area').appendChild(div);
      document.getElementById('message-area').scrollTop = document.getElementById('message-area').scrollHeight;
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function sendMessage() {
      const content = document.getElementById('message-input').value.trim();
      if (!content || !ws) return;

      const id = Date.now().toString();
      ws.send(JSON.stringify({
        version: 1,
        payload: { type: 'user_input', content, id }
      }));

      document.getElementById('message-input').value = '';
    }

    document.getElementById('send-btn').addEventListener('click', sendMessage);
    document.getElementById('message-input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendMessage();
    });
  </script>
</body>
</html>`;
  }

  /**
   * Get QR connection data for display
   * FIX: No longer includes token in URL - token entered manually
   * @returns QR connection data object
   */
  getQRConnectionData(): QRConnectionData {
    return {
      url: `ws://${this.config.host}:${this.config.port}/ws`,
      expiresAt: Date.now() + this.config.tokenExpiryMs,
      sessionId: this.sessionState.sessionId,
      // FIX: Don't expose token in QR data - it should be entered manually
    };
  }

  /**
   * Get client IP address from request for rate limiting
   * FIX: Now checks proxy headers (X-Forwarded-For, X-Real-IP, CF-Connecting-IP)
   * before falling back to direct socket address
   * @param req - HTTP request object
   * @returns Client IP address
   */
  private getClientIp(req: http.IncomingMessage): string {
    // Check proxy headers first (for reverse proxy deployments)
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
      const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
      const firstIp = ips.split(',')[0].trim();
      if (firstIp) return firstIp;
    }

    const realIp = req.headers['x-real-ip'];
    if (realIp) return Array.isArray(realIp) ? realIp[0] : realIp;

    const cfConnectingIp = req.headers['cf-connecting-ip'];
    if (cfConnectingIp)
      return Array.isArray(cfConnectingIp) ? cfConnectingIp[0] : cfConnectingIp;

    // Fall back to direct socket address
    return req.socket.remoteAddress || 'unknown';
  }

  /**
   * Check and update rate limit for authentication attempts
   * @param clientIp - Client IP address
   * @returns True if rate limit exceeded, false otherwise
   */
  private checkRateLimit(clientIp: string): boolean {
    const now = Date.now();
    let state = this.authRateLimits.get(clientIp);

    if (!state) {
      state = { attempts: 0, firstAttemptTime: now };
      this.authRateLimits.set(clientIp, state);
    }

    // Reset if window has passed
    if (now - state.firstAttemptTime > AUTH_WINDOW_MS) {
      state = { attempts: 0, firstAttemptTime: now };
      this.authRateLimits.set(clientIp, state);
    }

    // Check if blocked
    if (state.blockedUntil && now < state.blockedUntil) {
      return true;
    }

    // Increment attempt counter
    state.attempts++;

    // Block if too many attempts
    if (state.attempts > MAX_AUTH_ATTEMPTS) {
      state.blockedUntil = now + AUTH_WINDOW_MS;
      return true;
    }

    return false;
  }

  /**
   * Handle new WebSocket connection
   * FIX: Now captures client IP at connection time and stores it in ClientConnection
   * @param ws - WebSocket object
   * @param req - HTTP request object
   */
  private handleWebSocketConnection(
    ws: WebSocket,
    req: http.IncomingMessage,
  ): void {
    const clientId = crypto.randomUUID();
    const clientIp = this.getClientIp(req); // FIX: Capture IP at connection time

    // Check connection limit
    if (this.clients.size >= this.config.maxConnections) {
      ws.close(1013, 'Server at capacity');
      return;
    }

    // FIX: Store clientIp in ClientConnection for rate limiting
    const client: ClientConnection = {
      ws,
      sessionId: this.sessionState.sessionId,
      authState: AuthStates.PENDING,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      isAuthenticated: false,
      clientIp, // FIX: Store IP at connection time
    };

    this.clients.set(clientId, client);
    debug.debug('New WebSocket connection: %s from %s', clientId, clientIp);

    ws.on('message', (data) => {
      try {
        // Validate message size
        const rawData = data.toString();
        if (rawData.length > MAX_MESSAGE_SIZE) {
          ws.close(1009, 'Message too large');
          return;
        }

        const message = JSON.parse(rawData) as WSMessage<ClientMessage>;
        this.handleClientMessage(clientId, message);
      } catch (error) {
        debug.debug(
          'Error parsing message: %s',
          error instanceof Error ? error.message : String(error),
        );
        this.sendError(clientId, 'parse_error', 'Invalid message format');
      }
    });

    ws.on('close', () => {
      debug.debug('Client disconnected: %s', clientId);
      this.clients.delete(clientId);
    });

    ws.on('error', (error) => {
      debug.debug('WebSocket error for %s: %s', clientId, error.message);
    });

    // Send initial connection acknowledgment
    this.sendMessage(clientId, {
      version: 1,
      payload: {
        type: 'session_update',
        session: {
          status: 'active',
        },
      },
    });
  }

  /**
   * Handle message from client
   * @param clientId - Client identifier
   * @param message - WebSocket message object
   */
  private handleClientMessage(
    clientId: string,
    message: WSMessage<ClientMessage>,
  ): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    client.lastActivity = Date.now();
    const payload = message.payload;

    switch (payload.type) {
      case 'auth_request':
        this.handleAuthRequest(clientId, payload);
        break;

      case 'sync_request':
        this.handleSyncRequest(clientId, payload);
        break;

      case 'user_input':
        this.handleUserInput(clientId, payload);
        break;

      case 'command_request':
        this.handleCommandRequest(clientId, payload);
        break;

      case 'control_command':
        this.handleControlCommand(clientId, payload);
        break;

      case 'ping':
        this.handlePing(clientId, payload);
        break;

      default:
        // Ignore unknown message types
        break;
    }
  }

  /**
   * Handle authentication request
   * FIX: Now uses stored clientIp from ClientConnection instead of trying to
   * extract IP from WebSocket (which doesn't have remoteAddress)
   * @param clientId - Client identifier
   * @param request - Authentication request object
   */
  private handleAuthRequest(
    clientId: string,
    request: ClientMessage & { type: 'auth_request' },
  ): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // FIX: Use stored clientIp from ClientConnection
    if (this.checkRateLimit(client.clientIp)) {
      this.sendMessage(clientId, {
        version: 1,
        payload: {
          type: 'auth_response',
          success: false,
          state: AuthStates.EXPIRED,
          sessionId: this.sessionState.sessionId,
          message:
            'Too many authentication attempts. Please wait before trying again.',
        },
      });
      return;
    }

    const isValid = request.token === this.authToken;

    if (isValid) {
      client.authState = AuthStates.AUTHENTICATED;
      client.isAuthenticated = true;

      debug.debug('Client %s authenticated successfully', clientId);
    } else {
      client.authState = AuthStates.EXPIRED;
      debug.debug('Client %s authentication failed', clientId);
    }

    this.sendMessage(clientId, {
      version: 1,
      payload: {
        type: 'auth_response',
        success: isValid,
        state: client.authState,
        sessionId: this.sessionState.sessionId,
        message: isValid ? 'Authentication successful' : 'Invalid token',
      },
    });
  }

  /**
   * Handle session sync request
   * @param clientId - Client identifier
   * @param _request - Sync request object (unused, kept for API compatibility)
   */
  private handleSyncRequest(
    clientId: string,
    _request: ClientMessage & { type: 'sync_request' },
  ): void {
    const client = this.clients.get(clientId);
    if (!client || !client.isAuthenticated) return;

    // Send full session state and message history
    this.sendMessage(clientId, {
      version: 1,
      payload: {
        type: 'sync_response',
        session: this.sessionState,
        messages: this.sessionMessageHistory,
        hasMore: false,
      },
    });
  }

  /**
   * Handle user input from remote client
   * @param clientId - Client identifier
   * @param request - User input request object
   */
  private handleUserInput(
    clientId: string,
    request: ClientMessage & { type: 'user_input' },
  ): void {
    const client = this.clients.get(clientId);
    if (!client || !client.isAuthenticated) return;

    debug.debug(
      'Received user input from %s: %s...',
      clientId,
      request.content.substring(0, 50),
    );

    // Acknowledge receipt
    this.sendMessage(clientId, {
      version: 1,
      payload: {
        type: 'user_input_ack',
        id: request.id,
        status: 'accepted',
      },
    });

    // TODO: Forward to Qwen Code core for processing
    // This would integrate with the main conversation loop
  }

  /**
   * Handle command execution request
   * @param clientId - Client identifier
   * @param request - Command request object
   */
  private handleCommandRequest(
    clientId: string,
    request: ClientMessage & { type: 'command_request' },
  ): void {
    const client = this.clients.get(clientId);
    if (!client || !client.isAuthenticated) return;

    // Execute command and return result
    this.sendMessage(clientId, {
      version: 1,
      payload: {
        type: 'command_response',
        requestId: request.command,
        success: false,
        error: 'Command execution not yet implemented',
      },
    });
  }

  /**
   * Handle control command
   * @param clientId - Client identifier
   * @param request - Control command request object
   */
  private handleControlCommand(
    clientId: string,
    request: ClientMessage & { type: 'control_command' },
  ): void {
    const client = this.clients.get(clientId);
    if (!client || !client.isAuthenticated) return;

    // Handle pause/resume/stop/restart
    this.sendMessage(clientId, {
      version: 1,
      payload: {
        type: 'control_command_ack',
        command: request.command,
        success: false,
        message: 'Control commands not yet implemented',
      },
    });
  }

  /**
   * Handle ping message
   * @param clientId - Client identifier
   * @param request - Ping request object
   */
  private handlePing(
    clientId: string,
    request: ClientMessage & { type: 'ping' },
  ): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    const latency = Date.now() - request.timestamp;

    this.sendMessage(clientId, {
      version: 1,
      payload: {
        type: 'pong',
        timestamp: Date.now(),
        latency,
      },
    });
  }

  /**
   * Send message to a specific client
   * @param clientId - Client identifier
   * @param message - WebSocket message object
   */
  private sendMessage(
    clientId: string,
    message: WSMessage<ServerMessage>,
  ): void {
    const client = this.clients.get(clientId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) return;

    try {
      client.ws.send(JSON.stringify(message));
    } catch (error) {
      debug.debug(
        'Error sending message to %s: %s',
        clientId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Send error message to a client
   * @param clientId - Client identifier
   * @param code - Error code
   * @param message - Error message
   */
  private sendError(clientId: string, code: string, message: string): void {
    this.sendMessage(clientId, {
      version: 1,
      payload: {
        type: 'error',
        code,
        message,
      },
    });
  }

  /**
   * Broadcast message to all authenticated clients
   * @param payload - Message payload to broadcast
   */
  broadcastMessage(payload: ServerMessage): void {
    for (const clientId of this.clients.keys()) {
      const client = this.clients.get(clientId);
      if (client?.isAuthenticated) {
        this.sendMessage(clientId, {
          version: 1,
          payload,
        });
      }
    }
  }

  /**
   * Add a message to the session history
   * @param message - Conversation message to add
   */
  addMessageToHistory(message: ConversationMessage): void {
    this.sessionMessageHistory.push(message);

    // Broadcast to all connected clients
    this.broadcastMessage({
      type: 'message_update',
      message,
    });
  }

  /**
   * Update session state
   * @param updates - Partial session state updates
   */
  updateSessionState(updates: Partial<SessionState>): void {
    this.sessionState = { ...this.sessionState, ...updates };

    // Broadcast to all connected clients
    this.broadcastMessage({
      type: 'session_update',
      session: updates,
    });
  }

  /**
   * Get connection info for display
   * FIX: Always returns ws:// URL - secure flag is deprecated until TLS is implemented
   * @returns Connection information object
   */
  getConnectionInfo(): { url: string; token: string; port: number } {
    return {
      url: `ws://${this.config.host}:${this.config.port}/ws`, // Always ws until TLS implemented
      token: this.authToken,
      port: this.config.port,
    };
  }
}
