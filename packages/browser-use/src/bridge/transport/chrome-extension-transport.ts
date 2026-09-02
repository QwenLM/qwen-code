/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmod,
  lstat,
  open,
  readFile,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';

import {
  CHROME_BRIDGE_PROTOCOL_VERSION,
  CHROME_EXTENSION_ID,
  defaultChromeBridgeSocketPath,
  type BridgeEvent,
  type BridgeHello,
  type BridgeResponse,
} from '../protocol.js';
import { BrowserRuntimeError, type RuntimeErrorCode } from '../errors.js';
import { encodeFrame, FrameDecoder } from './framing.js';

export type BridgeEventListener = (event: BridgeEvent) => void;
export type BridgeConnectionListener = (connected: boolean) => void;

export interface ChromeBridge {
  start(): Promise<void>;
  isConnected(): boolean;
  request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;
  /** Subscribe to events pushed by the extension; returns an unsubscribe function. */
  onEvent(listener: BridgeEventListener): () => void;
  /** Observe validated connection loss/recovery so stateful clients can fail closed. */
  onConnectionChange(listener: BridgeConnectionListener): () => void;
  stop(): Promise<void>;
}

export interface ChromeExtensionTransportOptions {
  socketPath?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface SocketIdentity {
  dev: number;
  ino: number;
}

interface RecoveryLock {
  handle: FileHandle;
  path: string;
  contents: string;
}

export class ChromeExtensionTransport implements ChromeBridge {
  readonly socketPath: string;

  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private server: Server | undefined;
  private socket: Socket | undefined;
  private hello: BridgeHello | undefined;
  private socketIdentity: SocketIdentity | undefined;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly acceptedSockets = new Set<Socket>();
  private readonly eventListeners = new Set<BridgeEventListener>();
  private readonly connectionListeners = new Set<BridgeConnectionListener>();
  private readonly connectionWaiters = new Set<{
    resolve(): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();

  constructor(options: ChromeExtensionTransportOptions = {}) {
    this.socketPath = options.socketPath ?? defaultChromeBridgeSocketPath();
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async start(): Promise<void> {
    if (this.stopPromise !== undefined) await this.stopPromise;
    if (this.server?.listening === true) return;
    const attempt = (this.startPromise ??= this.startInternal());
    try {
      return await attempt;
    } finally {
      if (this.startPromise === attempt) this.startPromise = undefined;
    }
  }

  isConnected(): boolean {
    return (
      this.socket !== undefined &&
      !this.socket.destroyed &&
      this.hello !== undefined
    );
  }

  onEvent(listener: BridgeEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onConnectionChange(listener: BridgeConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  async request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    await this.start();
    await this.waitForConnection(Math.min(this.connectTimeoutMs, timeoutMs));
    const socket = this.socket;
    if (socket === undefined || socket.destroyed) {
      throw disconnectedError();
    }

    const id = randomUUID();
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BrowserRuntimeError(
            'OPERATION_TIMEOUT',
            `Chrome bridge request timed out: ${method}`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    socket.write(encodeFrame({ type: 'request', id, method, params }));
    return await response;
  }

  async stop(): Promise<void> {
    const attempt = (this.stopPromise ??= this.stopInternal(this.startPromise));
    try {
      return await attempt;
    } finally {
      if (this.stopPromise === attempt) this.stopPromise = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    try {
      try {
        await listen(server, this.socketPath);
      } catch (error) {
        if (
          !isAddressInUse(error) ||
          !(await recoverStaleSocketAndListen(server, this.socketPath))
        )
          throw error;
      }
      if (process.platform !== 'win32') {
        this.socketIdentity = await currentSocketIdentity(this.socketPath);
        if (this.socketIdentity === undefined)
          throw new Error('Chrome bridge did not create an owned Unix socket');
        await chmod(this.socketPath, 0o600);
      }
    } catch (error) {
      if (this.server === server) this.server = undefined;
      await closeServer(server);
      await unlinkOwnedSocket(this.socketPath, this.socketIdentity);
      this.socketIdentity = undefined;
      const message =
        error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
          ? `Chrome bridge socket is already in use: ${this.socketPath}`
          : 'Could not start the local Chrome bridge';
      throw new BrowserRuntimeError('TRANSPORT_UNAVAILABLE', message);
    }
  }

  private accept(socket: Socket): void {
    this.acceptedSockets.add(socket);
    const decoder = new FrameDecoder();
    let validated = false;
    const handshakeTimer = setTimeout(() => {
      if (!validated)
        socket.destroy(new Error('Chrome bridge hello timed out'));
    }, this.connectTimeoutMs);
    handshakeTimer.unref();
    socket.on('data', (chunk) => {
      try {
        for (const message of decoder.push(chunk)) {
          if (!validated) {
            if (!isObject(message) || message.type !== 'hello') continue;
            if (
              message.protocolVersion !== CHROME_BRIDGE_PROTOCOL_VERSION ||
              message.extensionId !== CHROME_EXTENSION_ID
            ) {
              socket.destroy(
                new Error(
                  'Chrome extension identity or protocol version did not match',
                ),
              );
              return;
            }
            validated = true;
            clearTimeout(handshakeTimer);
            this.promote(socket, message as unknown as BridgeHello);
            continue;
          }
          if (this.socket !== socket) return;
          this.handleMessage(message);
        }
      } catch {
        socket.destroy(new Error('Invalid Chrome bridge frame'));
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(handshakeTimer);
      this.acceptedSockets.delete(socket);
      if (this.socket === socket) this.disconnect(disconnectedError());
    });
  }

  private promote(socket: Socket, hello: BridgeHello): void {
    this.disconnect(disconnectedError('Chrome extension reconnected'));
    this.socket = socket;
    this.hello = hello;
    this.notifyConnectionChange(true);
    for (const waiter of this.connectionWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.connectionWaiters.clear();
  }

  private handleMessage(message: unknown): void {
    if (!isObject(message) || typeof message.type !== 'string') return;
    if (message.type === 'hello') return;
    // Accept events and responses only after validating the public extension id
    // and protocol version. This is compatibility validation, not same-user
    // peer authentication.
    if (this.hello === undefined) return;
    if (message.type === 'event') {
      if (
        typeof message.tabId !== 'number' ||
        typeof message.method !== 'string'
      )
        return;
      const event: BridgeEvent = {
        type: 'event',
        tabId: message.tabId,
        method: message.method,
        params: message.params,
        ...(typeof message.sessionId === 'string' && message.sessionId !== ''
          ? { sessionId: message.sessionId }
          : {}),
      };
      for (const listener of this.eventListeners) {
        try {
          listener(event);
        } catch {
          // A listener failure must not break the transport.
        }
      }
      return;
    }
    if (message.type !== 'response' || typeof message.id !== 'string') return;
    const response = message as unknown as BridgeResponse;
    const pending = this.pending.get(response.id);
    if (pending === undefined) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok) {
      pending.resolve(response.result);
    } else {
      const code = response.error?.code;
      pending.reject(
        new BrowserRuntimeError(
          bridgeRuntimeErrorCode(code),
          response.error?.message || 'Chrome extension operation failed',
        ),
      );
    }
  }

  private async waitForConnection(timeoutMs: number): Promise<void> {
    if (this.isConnected()) return;
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.connectionWaiters.delete(waiter);
          reject(
            disconnectedError(
              'Chrome extension is not connected. Load the extension and verify the Native Messaging host installation.',
            ),
          );
        }, timeoutMs),
      };
      this.connectionWaiters.add(waiter);
    });
  }

  private disconnect(error: BrowserRuntimeError): void {
    const wasConnected = this.hello !== undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.hello = undefined;
    if (socket !== undefined && !socket.destroyed) socket.destroy();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (wasConnected) this.notifyConnectionChange(false);
  }

  private notifyConnectionChange(connected: boolean): void {
    for (const listener of this.connectionListeners) {
      try {
        listener(connected);
      } catch {
        // Connection observers cannot be allowed to break the transport.
      }
    }
  }

  private async stopInternal(
    starting: Promise<void> | undefined,
  ): Promise<void> {
    await starting?.catch(() => undefined);
    this.disconnect(disconnectedError('Chrome bridge stopped'));
    for (const waiter of this.connectionWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(disconnectedError('Chrome bridge stopped'));
    }
    this.connectionWaiters.clear();
    for (const socket of this.acceptedSockets) socket.destroy();
    this.acceptedSockets.clear();
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) await closeServer(server);
    await unlinkOwnedSocket(this.socketPath, this.socketIdentity);
    this.socketIdentity = undefined;
  }
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function isAddressInUse(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
  );
}

async function recoverStaleSocketAndListen(
  server: Server,
  socketPath: string,
): Promise<boolean> {
  const lock = await acquireRecoveryLock(socketPath);
  if (lock === undefined) return false;
  try {
    if (!(await removeStaleSocket(socketPath))) return false;
    await listen(server, socketPath);
    return true;
  } finally {
    await releaseRecoveryLock(lock);
  }
}

/** Remove only an owned Unix socket that no process is accepting connections on. */
async function removeStaleSocket(socketPath: string): Promise<boolean> {
  if (process.platform === 'win32') return false;
  const info = await lstat(socketPath).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  });
  if (info === undefined) return true;
  if (!info.isSocket()) return false;
  if (typeof process.getuid === 'function' && info.uid !== process.getuid())
    return false;
  if (await socketAcceptsConnections(socketPath)) return false;
  const current = await lstat(socketPath).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  });
  if (current === undefined) return true;
  if (
    !current.isSocket() ||
    current.dev !== info.dev ||
    current.ino !== info.ino
  )
    return false;
  await unlink(socketPath).catch((error: unknown) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  });
  return true;
}

async function acquireRecoveryLock(
  socketPath: string,
): Promise<RecoveryLock | undefined> {
  if (process.platform === 'win32') return undefined;
  const path = `${socketPath}.recovery-lock`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const contents = JSON.stringify({ pid: process.pid, token: randomUUID() });
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(contents, 'utf8');
        return { handle, path, contents };
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(path).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'EEXIST')
      )
        throw error;
      const owner = await readRecoveryLockOwner(path);
      if (owner === undefined || processIsAlive(owner)) return undefined;
      await unlink(path).catch((unlinkError: unknown) => {
        if (
          !(
            unlinkError instanceof Error &&
            'code' in unlinkError &&
            unlinkError.code === 'ENOENT'
          )
        )
          throw unlinkError;
      });
    }
  }
  return undefined;
}

async function readRecoveryLockOwner(
  path: string,
): Promise<number | undefined> {
  const contents = await readFile(path, 'utf8').catch(() => '');
  try {
    const parsed = JSON.parse(contents) as unknown;
    return isObject(parsed) &&
      typeof parsed.pid === 'number' &&
      Number.isInteger(parsed.pid)
      ? parsed.pid
      : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      'code' in error &&
      error.code === 'ESRCH'
    );
  }
}

async function releaseRecoveryLock(lock: RecoveryLock): Promise<void> {
  await lock.handle.close().catch(() => undefined);
  const contents = await readFile(lock.path, 'utf8').catch(() => undefined);
  if (contents !== lock.contents) return;
  await unlink(lock.path).catch(() => undefined);
}

async function currentSocketIdentity(
  socketPath: string,
): Promise<SocketIdentity | undefined> {
  if (process.platform === 'win32') return undefined;
  const info = await lstat(socketPath).catch(() => undefined);
  if (info === undefined || !info.isSocket()) return undefined;
  return { dev: info.dev, ino: info.ino };
}

async function unlinkOwnedSocket(
  socketPath: string,
  identity: SocketIdentity | undefined,
): Promise<void> {
  if (process.platform === 'win32' || identity === undefined) return;
  const current = await currentSocketIdentity(socketPath);
  if (
    current === undefined ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  )
    return;
  await unlink(socketPath).catch((error: unknown) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  });
}

async function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const candidate = connect(socketPath);
    let settled = false;
    const finish = (active: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      candidate.destroy();
      resolve(active);
    };
    const timer = setTimeout(() => finish(true), 500);
    candidate.once('connect', () => finish(true));
    candidate.once('error', (error: Error) => {
      const code = 'code' in error ? error.code : undefined;
      finish(code !== 'ECONNREFUSED' && code !== 'ENOENT');
    });
  });
}

function bridgeRuntimeErrorCode(code: string | undefined): RuntimeErrorCode {
  switch (code) {
    case 'NOT_GRANTED':
      return 'TAB_NOT_GRANTED';
    case 'STALE_TAB':
      return 'STALE_TAB';
    case 'UNSUPPORTED_TAB':
      return 'UNSUPPORTED_TAB';
    default:
      return 'OPERATION_FAILED';
  }
}

function disconnectedError(
  message = 'Chrome extension disconnected',
): BrowserRuntimeError {
  return new BrowserRuntimeError('BROWSER_DISCONNECTED', message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
