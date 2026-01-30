/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cp from 'node:child_process';
import * as net from 'node:net';
import { DEFAULT_LSP_REQUEST_TIMEOUT_MS } from './constants.js';
import type { JsonRpcMessage } from './types.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

class JsonRpcConnection {
  private buffer = '';
  private nextId = 1;
  private disposed = false;
  private pendingRequests = new Map<string | number, PendingRequest>();
  private notificationHandlers: Array<(notification: JsonRpcMessage) => void> =
    [];
  private requestHandlers: Array<
    (request: JsonRpcMessage) => Promise<unknown>
  > = [];

  constructor(
    private readonly writer: (data: string) => void,
    private readonly disposer?: () => void,
  ) {}

  listen(readable: NodeJS.ReadableStream): void {
    readable.on('data', (chunk: Buffer) => this.handleData(chunk));
    readable.on('error', (error) =>
      this.disposePending(
        error instanceof Error ? error : new Error(String(error)),
      ),
    );
  }

  send(message: JsonRpcMessage): void {
    this.writeMessage(message);
  }

  onNotification(handler: (notification: JsonRpcMessage) => void): void {
    this.notificationHandlers.push(handler);
  }

  onRequest(handler: (request: JsonRpcMessage) => Promise<unknown>): void {
    this.requestHandlers.push(handler);
  }

  async initialize(params: unknown): Promise<unknown> {
    return this.sendRequest('initialize', params);
  }

  async shutdown(): Promise<void> {
    try {
      await this.sendRequest('shutdown', {});
    } catch (_error) {
      // Ignore shutdown errors – the server may already be gone.
    } finally {
      this.end();
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    return this.sendRequest(method, params);
  }

  end(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposePending();
    this.disposer?.();
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    if (this.disposed) {
      return Promise.resolve(undefined);
    }

    const id = this.nextId++;
    const payload: JsonRpcMessage = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const requestPromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP request timeout: ${method}`));
      }, DEFAULT_LSP_REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timer });
    });

    this.writeMessage(payload);
    return requestPromise;
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
    const handler = this.requestHandlers[this.requestHandlers.length - 1];
    if (!handler) {
      this.writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32601,
          message: `Method not supported: ${message.method}`,
        },
      });
      return;
    }

    try {
      const result = await handler(message);
      this.writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        result: result ?? null,
      });
    } catch (error) {
      this.writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: (error as Error).message ?? 'Internal error',
        },
      });
    }
  }

  private handleData(chunk: Buffer): void {
    if (this.disposed) {
      return;
    }

    this.buffer += chunk.toString('utf8');

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        break;
      }

      const header = this.buffer.slice(0, headerEnd);
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = Number(lengthMatch[1]);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      if (this.buffer.length < messageEnd) {
        break;
      }

      const body = this.buffer.slice(messageStart, messageEnd);
      this.buffer = this.buffer.slice(messageEnd);

      try {
        const message = JSON.parse(body);
        this.routeMessage(message);
      } catch {
        // ignore malformed messages
      }
    }
  }

  private routeMessage(message: JsonRpcMessage): void {
    if (typeof message?.id !== 'undefined' && !message.method) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(message.error.message || 'LSP request failed'),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message?.method && typeof message.id !== 'undefined') {
      void this.handleServerRequest(message);
      return;
    }

    if (message?.method) {
      for (const handler of this.notificationHandlers) {
        try {
          handler(message);
        } catch {
          // ignore handler errors
        }
      }
    }
  }

  private writeMessage(message: JsonRpcMessage): void {
    if (this.disposed) {
      return;
    }
    const json = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n`;
    this.writer(header + json);
  }

  private disposePending(error?: Error): void {
    for (const [, pending] of Array.from(this.pendingRequests)) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error('LSP connection closed'));
    }
    this.pendingRequests.clear();
  }
}

interface LspConnection {
  connection: JsonRpcConnection;
  process?: cp.ChildProcess;
  socket?: net.Socket;
}

interface SocketConnectionOptions {
  host?: string;
  port?: number;
  path?: string;
}

export class LspConnectionFactory {
  /**
   * 创建基于 stdio 的 LSP 连接
   */
  static async createStdioConnection(
    command: string,
    args: string[],
    options?: cp.SpawnOptions,
    timeoutMs = 10000,
  ): Promise<LspConnection> {
    return new Promise((resolve, reject) => {
      const spawnOptions: cp.SpawnOptions = {
        stdio: 'pipe',
        ...options,
      };
      const processInstance = cp.spawn(command, args, spawnOptions);

      const timeoutId = setTimeout(() => {
        reject(new Error('LSP server spawn timeout'));
        if (!processInstance.killed) {
          processInstance.kill();
        }
      }, timeoutMs);

      processInstance.once('error', (error) => {
        clearTimeout(timeoutId);
        reject(new Error(`Failed to spawn LSP server: ${error.message}`));
      });

      processInstance.once('spawn', () => {
        clearTimeout(timeoutId);

        if (!processInstance.stdout || !processInstance.stdin) {
          reject(new Error('LSP server stdio not available'));
          return;
        }

        const connection = new JsonRpcConnection(
          (payload) => processInstance.stdin?.write(payload),
          () => processInstance.stdin?.end(),
        );

        connection.listen(processInstance.stdout);
        processInstance.once('exit', () => connection.end());
        processInstance.once('close', () => connection.end());

        resolve({
          connection,
          process: processInstance,
        });
      });
    });
  }

  /**
   * 创建基于 TCP 的 LSP 连接
   */
  static async createTcpConnection(
    host: string,
    port: number,
    timeoutMs = 10000,
  ): Promise<LspConnection> {
    return LspConnectionFactory.createSocketConnection(
      { host, port },
      timeoutMs,
    );
  }

  /**
   * 创建基于 socket 的 LSP 连接（支持 TCP 或 unix socket）
   */
  static async createSocketConnection(
    options: SocketConnectionOptions,
    timeoutMs = 10000,
  ): Promise<LspConnection> {
    return new Promise((resolve, reject) => {
      let socketOptions: { path: string } | { host: string; port: number };

      if (options.path) {
        socketOptions = { path: options.path };
      } else {
        if (!options.port) {
          reject(new Error('Socket transport requires port or path'));
          return;
        }
        socketOptions = {
          host: options.host ?? '127.0.0.1',
          port: options.port,
        };
      }

      const socket = net.createConnection(socketOptions);

      const timeoutId = setTimeout(() => {
        reject(new Error('LSP server connection timeout'));
        socket.destroy();
      }, timeoutMs);

      const onError = (error: Error) => {
        clearTimeout(timeoutId);
        reject(new Error(`Failed to connect to LSP server: ${error.message}`));
      };

      socket.once('error', onError);

      socket.on('connect', () => {
        clearTimeout(timeoutId);
        socket.off('error', onError);

        const connection = new JsonRpcConnection(
          (payload) => socket.write(payload),
          () => socket.destroy(),
        );
        connection.listen(socket);
        socket.once('close', () => connection.end());
        socket.once('error', () => connection.end());

        resolve({
          connection,
          socket,
        });
      });
    });
  }

  /**
   * 关闭 LSP 连接
   */
  static async closeConnection(lspConnection: LspConnection): Promise<void> {
    if (lspConnection.connection) {
      try {
        await lspConnection.connection.shutdown();
      } catch (e) {
        console.warn('LSP shutdown failed:', e);
      } finally {
        lspConnection.connection.end();
      }
    }

    if (lspConnection.process && !lspConnection.process.killed) {
      lspConnection.process.kill();
    }

    if (lspConnection.socket && !lspConnection.socket.destroyed) {
      lspConnection.socket.destroy();
    }
  }
}
