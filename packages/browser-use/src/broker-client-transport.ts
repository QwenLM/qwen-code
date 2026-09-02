/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';

import { BrowserRuntimeError, type RuntimeErrorCode } from './bridge/errors.js';
import {
  CHROME_BRIDGE_PROTOCOL_VERSION,
  defaultChromeBridgeSocketPath,
  type BridgeEvent,
  type BridgeRequest,
  type BridgeResponse,
} from './bridge/protocol.js';
import {
  type BridgeConnectionListener,
  type BridgeEventListener,
  type ChromeBridge,
} from './bridge/transport/chrome-extension-transport.js';
import { encodeFrame, FrameDecoder } from './bridge/transport/framing.js';
import type {
  ClientHello,
  ClientWelcome,
  ConnectionState,
} from './broker/protocol.js';

export interface BrokerClientTransportOptions {
  socketPath?: string;
  clientId?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  ensureBroker?: (socketPath: string) => Promise<void> | void;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface ConnectionWaiter {
  resolve(): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

const CONNECT_RETRY_INTERVAL_MS = 25;

export class BrokerClientTransport implements ChromeBridge {
  readonly socketPath: string;
  readonly clientId: string;

  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly ensureBroker:
    | ((socketPath: string) => Promise<void> | void)
    | undefined;
  private socket: Socket | undefined;
  private brokerConnected = false;
  private extensionConnected = false;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<BridgeEventListener>();
  private readonly connectionListeners = new Set<BridgeConnectionListener>();
  private readonly connectionWaiters = new Set<ConnectionWaiter>();

  constructor(options: BrokerClientTransportOptions = {}) {
    this.socketPath = options.socketPath ?? defaultChromeBridgeSocketPath();
    this.clientId = options.clientId ?? randomUUID();
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.ensureBroker = options.ensureBroker;
  }

  async start(): Promise<void> {
    if (this.stopPromise !== undefined) await this.stopPromise;
    if (this.brokerConnected) return;
    const attempt = (this.startPromise ??= this.startInternal());
    try {
      await attempt;
    } finally {
      if (this.startPromise === attempt) this.startPromise = undefined;
    }
  }

  isConnected(): boolean {
    return this.brokerConnected && this.extensionConnected;
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
    await this.waitForExtension(Math.min(this.connectTimeoutMs, timeoutMs));
    const socket = this.socket;
    if (
      socket === undefined ||
      socket.destroyed ||
      !this.brokerConnected ||
      !this.extensionConnected
    ) {
      throw disconnectedError();
    }

    const id = randomUUID();
    const request: BridgeRequest = { type: 'request', id, method, params };
    const frame = encodeFrame(request);
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
    socket.write(frame, (error) => {
      if (error === null || error === undefined) return;
      const pending = this.pending.get(id);
      if (pending === undefined) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(disconnectedError());
    });
    return await response;
  }

  async stop(): Promise<void> {
    const attempt = (this.stopPromise ??= this.stopInternal());
    try {
      await attempt;
    } finally {
      if (this.stopPromise === attempt) this.stopPromise = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    const deadline = Date.now() + this.connectTimeoutMs;
    try {
      await this.connectOnce(remainingTime(deadline));
      return;
    } catch (error) {
      if (!isBrokerUnavailable(error) || this.ensureBroker === undefined) {
        throw transportUnavailable(error);
      }
    }

    try {
      await this.ensureBroker(this.socketPath);
    } catch (error) {
      throw transportUnavailable(error);
    }

    while (true) {
      const remaining = remainingTime(deadline);
      if (remaining <= 0) throw transportUnavailable();
      try {
        await this.connectOnce(remaining);
        return;
      } catch (error) {
        if (!isBrokerUnavailable(error)) throw transportUnavailable(error);
        const retryDelay = Math.min(CONNECT_RETRY_INTERVAL_MS, remaining);
        await delay(retryDelay);
      }
    }
  }

  private async connectOnce(timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) throw transportUnavailable();
    const socket = connect(this.socketPath);
    this.socket = socket;
    const decoder = new FrameDecoder();
    let welcomed = false;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined) resolve();
        else reject(error);
      };
      const timer = setTimeout(() => {
        const error = new Error('Browser broker handshake timed out');
        finish(error);
        socket.destroy(error);
      }, timeoutMs);

      socket.once('connect', () => {
        const hello: ClientHello = {
          type: 'client.hello',
          protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
          clientId: this.clientId,
        };
        socket.write(encodeFrame(hello));
      });
      socket.on('data', (chunk: Buffer) => {
        try {
          for (const message of decoder.push(chunk)) {
            if (!welcomed) {
              if (!isClientWelcome(message)) {
                const error = new Error('Invalid browser broker welcome');
                finish(error);
                socket.destroy(error);
                return;
              }
              if (message.protocolVersion !== CHROME_BRIDGE_PROTOCOL_VERSION) {
                const error = new Error(
                  'Browser broker protocol version did not match',
                );
                finish(error);
                socket.destroy(error);
                return;
              }
              welcomed = true;
              this.brokerConnected = true;
              this.setExtensionConnected(message.extensionConnected);
              finish();
              continue;
            }
            if (this.socket === socket) this.handleMessage(message);
          }
        } catch {
          const error = new Error('Invalid browser broker frame');
          finish(error);
          socket.destroy(error);
        }
      });
      socket.on('error', (error) => {
        if (!welcomed) finish(error);
      });
      socket.on('close', () => {
        if (!welcomed) finish(new Error('Browser broker disconnected'));
        if (this.socket === socket) this.disconnect(disconnectedError());
      });
    });
  }

  private handleMessage(message: unknown): void {
    if (isConnectionState(message)) {
      this.setExtensionConnected(message.connected);
      return;
    }
    if (isBridgeEvent(message)) {
      if (!this.extensionConnected) return;
      for (const listener of this.eventListeners) {
        try {
          listener(message);
        } catch {
          // A listener failure must not break the transport.
        }
      }
      return;
    }
    if (!isBridgeResponse(message) || !this.extensionConnected) return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(
      new BrowserRuntimeError(
        bridgeRuntimeErrorCode(message.error?.code),
        message.error?.message || 'Chrome extension operation failed',
      ),
    );
  }

  private async waitForExtension(timeoutMs: number): Promise<void> {
    if (!this.brokerConnected)
      throw disconnectedError('Browser broker disconnected');
    if (this.extensionConnected) return;
    await new Promise<void>((resolve, reject) => {
      const waiter: ConnectionWaiter = {
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

  private setExtensionConnected(connected: boolean): void {
    if (this.extensionConnected === connected) return;
    this.extensionConnected = connected;
    this.notifyConnectionChange(connected);
    if (connected) {
      for (const waiter of this.connectionWaiters) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      this.connectionWaiters.clear();
      return;
    }
    this.rejectPending(disconnectedError());
  }

  private disconnect(error: BrowserRuntimeError): void {
    const socket = this.socket;
    this.socket = undefined;
    this.brokerConnected = false;
    this.setExtensionConnected(false);
    if (socket !== undefined && !socket.destroyed) socket.destroy();
    this.rejectPending(error);
    for (const waiter of this.connectionWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.connectionWaiters.clear();
  }

  private rejectPending(error: BrowserRuntimeError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
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

  private async stopInternal(): Promise<void> {
    const socket = this.socket;
    if (socket !== undefined && !socket.destroyed) socket.destroy();
    await this.startPromise?.catch(() => undefined);
    this.disconnect(disconnectedError('Browser broker client stopped'));
  }
}

function isClientWelcome(value: unknown): value is ClientWelcome {
  return (
    isObject(value) &&
    value.type === 'client.welcome' &&
    typeof value.protocolVersion === 'number' &&
    typeof value.extensionConnected === 'boolean'
  );
}

function isConnectionState(value: unknown): value is ConnectionState {
  return (
    isObject(value) &&
    value.type === 'connection' &&
    typeof value.connected === 'boolean'
  );
}

function isBridgeEvent(value: unknown): value is BridgeEvent {
  return (
    isObject(value) &&
    value.type === 'event' &&
    typeof value.tabId === 'number' &&
    typeof value.method === 'string' &&
    (value.sessionId === undefined ||
      (typeof value.sessionId === 'string' && value.sessionId !== ''))
  );
}

function isBridgeResponse(value: unknown): value is BridgeResponse {
  return (
    isObject(value) &&
    value.type === 'response' &&
    typeof value.id === 'string' &&
    typeof value.ok === 'boolean'
  );
}

function bridgeRuntimeErrorCode(code: string | undefined): RuntimeErrorCode {
  switch (code) {
    case 'BROWSER_DISCONNECTED':
      return 'BROWSER_DISCONNECTED';
    case 'NOT_GRANTED':
      return 'TAB_NOT_GRANTED';
    case 'STALE_TAB':
      return 'STALE_TAB';
    case 'TAB_ALREADY_CLAIMED':
      return 'TAB_ALREADY_CLAIMED';
    case 'TAB_NOT_OWNED':
      return 'TAB_NOT_OWNED';
    case 'UNSUPPORTED_TAB':
      return 'UNSUPPORTED_TAB';
    default:
      return 'OPERATION_FAILED';
  }
}

function isBrokerUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ECONNREFUSED')
  );
}

function transportUnavailable(error?: unknown): BrowserRuntimeError {
  const suffix = error instanceof Error ? `: ${error.message}` : '';
  return new BrowserRuntimeError(
    'TRANSPORT_UNAVAILABLE',
    `Could not connect to the browser broker${suffix}`,
  );
}

function disconnectedError(
  message = 'Chrome extension disconnected',
): BrowserRuntimeError {
  return new BrowserRuntimeError('BROWSER_DISCONNECTED', message);
}

function remainingTime(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
