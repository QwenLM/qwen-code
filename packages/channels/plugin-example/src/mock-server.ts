/**
 * Mock Platform Server — programmatic API for integration tests.
 *
 * Provides a createMockServer() function that starts HTTP + WebSocket servers
 * and returns a handle for sending messages and cleaning up.
 *
 * Architecture:
 *   Test code calls server.sendMessage("Hello")
 *     → HTTP handler creates messageId, pushes via WebSocket to connected channel
 *     → Channel processes → responds via WebSocket
 *     → Server resolves the pending promise with agent response text
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

export interface MockServerHandle {
  /** Port the HTTP server is listening on */
  httpPort: number;
  /** Port the WebSocket server is listening on */
  wsPort: number;
  /** WebSocket URL for channels to connect to */
  wsUrl: string;
  /** Send a message through the full pipeline and wait for the agent response */
  sendMessage(
    text: string,
    options?: { senderId?: string; senderName?: string; chatId?: string },
  ): Promise<string>;
  /** Wait for a plugin channel to connect */
  waitForConnection(timeoutMs?: number): Promise<void>;
  /** Shut down both servers and reject pending requests */
  close(): Promise<void>;
}

export interface MockServerOptions {
  /** HTTP port (0 = random available port) */
  httpPort?: number;
  /** WebSocket port (0 = random available port) */
  wsPort?: number;
  /** Timeout for agent responses in ms (default: 120000) */
  responseTimeoutMs?: number;
}

export function createMockServer(
  options?: MockServerOptions,
): Promise<MockServerHandle> {
  const responseTimeoutMs = options?.responseTimeoutMs ?? 120_000;

  let pluginWs: WebSocket | null = null;
  let connectionResolver: (() => void) | null = null;

  const pendingRequests = new Map<
    string,
    {
      resolve: (result: { text: string; chunks: string[] }) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      chunks: string[];
    }
  >();

  // --- WebSocket server ---
  const wss = new WebSocketServer({ port: options?.wsPort ?? 0 });

  wss.on('connection', (ws) => {
    pluginWs = ws;

    if (connectionResolver) {
      connectionResolver();
      connectionResolver = null;
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'chunk' && msg.messageId) {
          const pending = pendingRequests.get(msg.messageId);
          if (pending) {
            pending.chunks.push(msg.text);
          }
        } else if (msg.type === 'outbound' && msg.messageId) {
          const pending = pendingRequests.get(msg.messageId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingRequests.delete(msg.messageId);
            pending.resolve({ text: msg.text, chunks: pending.chunks });
          }
        }
      } catch {
        // ignore
      }
    });

    ws.on('close', () => {
      if (pluginWs === ws) pluginWs = null;
    });
  });

  // --- HTTP server ---
  const httpServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          pluginConnected:
            pluginWs !== null && pluginWs.readyState === WebSocket.OPEN,
        }),
      );
      return;
    }

    if (req.method === 'POST' && req.url === '/message') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          const { senderId, senderName, chatId, text } = JSON.parse(body);
          if (!senderId || !text) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({ error: 'senderId and text are required' }),
            );
            return;
          }
          if (!pluginWs || pluginWs.readyState !== WebSocket.OPEN) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Plugin channel not connected' }));
            return;
          }

          const messageId = crypto.randomUUID();
          pluginWs.send(
            JSON.stringify({
              type: 'inbound',
              messageId,
              senderId,
              senderName: senderName || senderId,
              chatId: chatId || `dm-${senderId}`,
              text,
            }),
          );

          const responsePromise = new Promise<{
            text: string;
            chunks: string[];
          }>((resolve, reject) => {
            const timer = setTimeout(() => {
              pendingRequests.delete(messageId);
              reject(new Error('Timeout waiting for agent response'));
            }, responseTimeoutMs);
            pendingRequests.set(messageId, {
              resolve,
              reject,
              timer,
              chunks: [],
            });
          });

          responsePromise
            .then((result) => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  messageId,
                  text: result.text,
                  streaming: {
                    chunks: result.chunks.length,
                    bytes: result.chunks.reduce((n, c) => n + c.length, 0),
                  },
                }),
              );
            })
            .catch((err: Error) => {
              res.writeHead(504, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message }));
            });
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  // Start both servers and return the handle
  return new Promise<MockServerHandle>((resolve, reject) => {
    const wsAddress = wss.address();
    if (!wsAddress || typeof wsAddress === 'string') {
      reject(new Error('WebSocket server failed to bind'));
      return;
    }
    const wsPort = wsAddress.port;

    httpServer.listen(options?.httpPort ?? 0, () => {
      const httpAddress = httpServer.address();
      if (!httpAddress || typeof httpAddress === 'string') {
        reject(new Error('HTTP server failed to bind'));
        return;
      }
      const httpPort = httpAddress.port;

      const handle: MockServerHandle = {
        httpPort,
        wsPort,
        wsUrl: `ws://localhost:${wsPort}`,

        async sendMessage(text, opts) {
          const senderId = opts?.senderId || 'test-user';
          const senderName = opts?.senderName || 'Test User';
          const chatId = opts?.chatId || `dm-${senderId}`;

          if (!pluginWs || pluginWs.readyState !== WebSocket.OPEN) {
            throw new Error('Plugin channel not connected');
          }

          const messageId = crypto.randomUUID();
          pluginWs.send(
            JSON.stringify({
              type: 'inbound',
              messageId,
              senderId,
              senderName,
              chatId,
              text,
            }),
          );

          return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
              pendingRequests.delete(messageId);
              reject(new Error('Timeout waiting for agent response'));
            }, responseTimeoutMs);
            pendingRequests.set(messageId, {
              resolve: (result) => resolve(result.text),
              reject,
              timer,
              chunks: [],
            });
          });
        },

        async waitForConnection(timeoutMs = 10_000) {
          if (pluginWs && pluginWs.readyState === WebSocket.OPEN) return;
          return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error('Timeout waiting for channel connection'));
            }, timeoutMs);
            connectionResolver = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        },

        async close() {
          for (const [, pending] of pendingRequests) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Server shutting down'));
          }
          pendingRequests.clear();

          await new Promise<void>((r) => {
            wss.close(() => r());
          });
          await new Promise<void>((r) => {
            httpServer.close(() => r());
          });
        },
      };

      resolve(handle);
    });
  });
}
