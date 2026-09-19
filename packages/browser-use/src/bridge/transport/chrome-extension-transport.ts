/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { connect, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { clearTimeout, setTimeout } from 'node:timers';
import {
  CDP_REQUEST_TIMEOUT_MS,
  CHROME_BRIDGE_PROTOCOL_VERSION,
  CHROME_EXTENSION_ID,
  defaultChromeBridgeSocketPath,
  type BridgeEvent,
  type BridgeHello,
  type BridgeResponse,
} from '../protocol.js';
import {
  discoverChromeProfiles,
  type ChromeProfileDescriber,
  type ChromeProfileEndpoint,
} from '../discovery.js';
import { BrowserRuntimeError, type RuntimeErrorCode } from '../errors.js';
import { encodeFrame, FrameDecoder } from './framing.js';
import { verifySocketPeerPath } from '../socket-path.js';

export type BridgeEventListener = (event: BridgeEvent) => void;
export type BridgeConnectionListener = (connected: boolean) => void;

export interface ChromeBridge {
  profiles?(): Promise<ChromeProfileEndpoint[]>;
  selectProfile?(id: string): void;
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
  /** Names profiles and identifies Chrome's last-used one; best effort. */
  describeProfiles?: ChromeProfileDescriber;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  inputTarget?: { tabId: number; sessionId?: string };
}

export class ChromeExtensionTransport implements ChromeBridge {
  socketPath: string;
  private readonly explicitSocketPath: boolean;

  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly describeProfiles: ChromeProfileDescriber | undefined;
  private socket: Socket | undefined;
  private hello: BridgeHello | undefined;
  private selectedExtensionInstanceId: string | undefined;
  // Requested by selectProfile; becomes the binding only once a Host answers.
  private requestedExtensionInstanceId: string | undefined;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<BridgeEventListener>();
  private readonly connectionListeners = new Set<BridgeConnectionListener>();
  constructor(options: ChromeExtensionTransportOptions = {}) {
    this.socketPath = options.socketPath ?? defaultChromeBridgeSocketPath();
    this.explicitSocketPath = Boolean(
      options.socketPath ?? process.env['QWEN_BROWSER_USE_SOCKET_PATH']?.trim(),
    );
    this.connectTimeoutMs = options.connectTimeoutMs ?? 35_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.describeProfiles = options.describeProfiles;
  }

  async start(): Promise<void> {
    if (this.stopPromise !== undefined) await this.stopPromise;
    if (this.isConnected()) return;
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
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.stopPromise !== undefined) throw disconnectedError();
    return await this.sendRequest(method, params, timeoutMs);
  }

  private async sendRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    // A CDP command carries an operation deadline up to the 120s schema
    // ceiling, so its default response budget must outlive that and let the
    // caller's own deadline report first.
    const budget =
      timeoutMs ??
      (method === 'cdp.send' ? CDP_REQUEST_TIMEOUT_MS : this.requestTimeoutMs);
    const socket = this.socket;
    if (socket === undefined || socket.destroyed) {
      throw disconnectedError();
    }

    const id = randomUUID();
    const frame = encodeFrame({
      type: 'request',
      browserSessionId: this.hello?.browserSessionId,
      id,
      method,
      params,
    });
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BrowserRuntimeError(
            'OPERATION_TIMEOUT',
            `Chrome bridge request timed out: ${method}`,
          ),
        );
      }, budget);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        ...(method === 'cdp.send' &&
        typeof params.tabId === 'number' &&
        (params.sessionId === undefined ||
          typeof params.sessionId === 'string') &&
        (params.method === 'Input.dispatchMouseEvent' ||
          params.method === 'Input.dispatchKeyEvent' ||
          params.method === 'Input.insertText')
          ? {
              inputTarget: {
                tabId: params.tabId,
                ...(typeof params.sessionId === 'string'
                  ? { sessionId: params.sessionId }
                  : {}),
              },
            }
          : {}),
      });
    });
    try {
      socket.write(frame);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending !== undefined) clearTimeout(pending.timer);
      this.pending.delete(id);
      throw error;
    }
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

  async profiles(): Promise<ChromeProfileEndpoint[]> {
    if (!this.explicitSocketPath) {
      // The extension reconnects its Host on a 30s alarm, so an empty
      // snapshot does not mean that no browser exists.
      const deadline = Date.now() + this.connectTimeoutMs;
      for (;;) {
        const profiles = await discoverChromeProfiles();
        const compatible = profiles.filter(isCompatible);
        if (compatible.length > 0) return await this.describe(compatible);
        if (Date.now() >= deadline) {
          if (profiles.length > 0) throw versionMismatch();
          return [];
        }
        await delay(Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
      }
    }
    try {
      await this.start();
    } catch (error) {
      if (
        error instanceof BrowserRuntimeError &&
        error.code === 'BROWSER_DISCONNECTED'
      )
        return [];
      throw error;
    }
    return [
      {
        extensionInstanceId: this.hello!.extensionInstanceId,
        hostInstanceId: this.hello!.hostInstanceId!,
        protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
        extensionProtocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
        socketPath: this.socketPath,
        pid: 0,
      },
    ];
  }

  selectProfile(id: string): void {
    if (id === 'chrome' || id === 'extension') return;
    if (!id.startsWith('chrome:') || id.length <= 7)
      throw new BrowserRuntimeError('NOT_FOUND', 'Unknown Chrome profile');
    const profile = id.slice(7);
    if (
      this.selectedExtensionInstanceId !== undefined &&
      this.selectedExtensionInstanceId !== profile
    )
      throw new BrowserRuntimeError(
        'INVALID_ARGUMENT',
        'This Browser Use runtime is already bound to another Chrome profile. To select a different profile, reset the Node REPL kernel and run the Browser Use setup again.',
      );
    if (this.selectedExtensionInstanceId === undefined)
      this.requestedExtensionInstanceId = profile;
  }

  private async startInternal(): Promise<void> {
    try {
      await this.connectWithinDeadline(
        this.selectedExtensionInstanceId ?? this.requestedExtensionInstanceId,
      );
    } finally {
      // A profile that never answered must not pin later selections.
      this.requestedExtensionInstanceId = undefined;
    }
  }

  private async connectWithinDeadline(
    wanted: string | undefined,
  ): Promise<void> {
    const deadline = Date.now() + this.connectTimeoutMs;
    let lastError: unknown;
    let mismatch: BrowserRuntimeError | undefined;
    do {
      try {
        let endpoint: ChromeProfileEndpoint | undefined;
        if (!this.explicitSocketPath) {
          const profiles = await discoverChromeProfiles();
          endpoint =
            wanted === undefined
              ? await this.defaultProfile(profiles)
              : profiles.find(
                  (profile) => profile.extensionInstanceId === wanted,
                );
          if (endpoint === undefined) throw disconnectedError();
          if (!isCompatible(endpoint)) throw versionMismatch();
          this.socketPath = endpoint.socketPath;
        }
        await verifySocketPeerPath(this.socketPath);
        await this.connectHost(
          endpoint,
          wanted,
          Math.max(1, deadline - Date.now()),
        );
        return;
      } catch (error) {
        lastError = error;
        // A compatible Host may still appear, for example right after an
        // upgrade while another profile runs the previous extension, so a
        // mismatch is reported only once the wait is over.
        if (
          error instanceof BrowserRuntimeError &&
          error.code === 'EXTENSION_VERSION_MISMATCH'
        )
          mismatch = error;
        const code = (error as NodeJS.ErrnoException).code;
        // ECONNRESET and EPIPE come from a Host that is shutting down; its
        // replacement publishes a new record.
        if (
          code !== 'ENOENT' &&
          code !== 'ECONNREFUSED' &&
          code !== 'ECONNRESET' &&
          code !== 'EPIPE' &&
          !(error instanceof BrowserRuntimeError)
        )
          throw new BrowserRuntimeError(
            'TRANSPORT_UNAVAILABLE',
            `Could not connect to the local Chrome Host: ${errorMessage(error)}`,
          );
      }
      if (Date.now() < deadline)
        await delay(Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
    } while (Date.now() < deadline);
    if (mismatch !== undefined) throw mismatch;
    throw disconnectedError(
      `Chrome extension is not connected. Verify the Native Messaging host installation and reload the extension. ${errorMessage(lastError)}`,
    );
  }

  /**
   * Newest compatible Host by default; with several compatible profiles,
   * prefer the one Chrome last used, as a user would expect.
   */
  private async defaultProfile(
    profiles: ChromeProfileEndpoint[],
  ): Promise<ChromeProfileEndpoint | undefined> {
    const compatible = profiles.filter(isCompatible);
    if (compatible.length > 1)
      return (
        (await this.describe(compatible)).find((profile) => profile.lastUsed) ??
        compatible[0]
      );
    return compatible[0] ?? profiles[0];
  }

  private async describe(
    profiles: ChromeProfileEndpoint[],
  ): Promise<ChromeProfileEndpoint[]> {
    if (this.describeProfiles === undefined || profiles.length === 0)
      return profiles;
    const described = await this.describeProfiles(
      profiles.map((profile) => profile.extensionInstanceId),
    ).catch(() => new Map<string, { name: string; lastUsed: boolean }>());
    return profiles.map((profile) => {
      const description = described.get(profile.extensionInstanceId);
      return description === undefined
        ? profile
        : {
            ...profile,
            profileName: description.name,
            lastUsed: description.lastUsed,
          };
    });
  }

  private async connectHost(
    endpoint: ChromeProfileEndpoint | undefined,
    wanted: string | undefined,
    timeoutMs: number,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = connect(this.socketPath);
      const decoder = new FrameDecoder();
      const inbound: unknown[] = [];
      let validated = false;
      let draining = false;
      const timer = setTimeout(
        () => fail(disconnectedError('Chrome Host hello timed out')),
        timeoutMs,
      );
      const fail = (error: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      socket.once('connect', () =>
        socket.write(
          encodeFrame({
            type: 'client.hello',
            protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
            extensionInstanceId: wanted ?? endpoint?.extensionInstanceId,
            hostInstanceId: endpoint?.hostInstanceId,
          }),
        ),
      );
      const drain = (): void => {
        while (inbound.length > 0 && !socket.destroyed) {
          const message = inbound.shift();
          if (!isObject(message)) {
            fail(disconnectedError('Invalid Chrome Host message'));
            break;
          }
          if (!validated) {
            if (
              message.type === 'error' &&
              message.code === 'EXTENSION_VERSION_MISMATCH'
            ) {
              fail(versionMismatch());
              break;
            }
            if (
              message.type !== 'hello' ||
              message.extensionId !== CHROME_EXTENSION_ID ||
              message.protocolVersion !== CHROME_BRIDGE_PROTOCOL_VERSION ||
              typeof message.extensionInstanceId !== 'string' ||
              !message.extensionInstanceId ||
              typeof message.hostInstanceId !== 'string' ||
              !message.hostInstanceId ||
              typeof message.browserSessionId !== 'string' ||
              !message.browserSessionId ||
              (wanted !== undefined &&
                wanted !== message.extensionInstanceId) ||
              (endpoint !== undefined &&
                (message.extensionInstanceId !== endpoint.extensionInstanceId ||
                  message.hostInstanceId !== endpoint.hostInstanceId))
            ) {
              fail(
                disconnectedError(
                  'Chrome Host profile or protocol did not match',
                ),
              );
              break;
            }
            validated = true;
            clearTimeout(timer);
            this.selectedExtensionInstanceId ??= message.extensionInstanceId;
            this.socket = socket;
            this.hello = message as unknown as BridgeHello;
            this.notifyConnectionChange(true);
            resolve();
            continue;
          }
          if (this.socket !== socket) break;
          if (message.browserSessionId !== this.hello?.browserSessionId)
            continue;
          const settles =
            message.type === 'response' &&
            typeof message.id === 'string' &&
            this.pending.has(message.id);
          this.handleMessage(message);
          // Playwright installs page listeners in promise continuations. Let
          // those run before delivering an event in the same socket chunk.
          if (settles && inbound.length > 0) {
            setImmediate(drain);
            return;
          }
        }
        draining = false;
      };
      socket.on('data', (chunk) => {
        try {
          inbound.push(...decoder.push(chunk));
        } catch {
          fail(disconnectedError('Invalid Chrome Host frame'));
          return;
        }
        if (!draining) {
          draining = true;
          drain();
        }
      });
      socket.on('error', (error) => {
        if (!validated) fail(error);
      });
      socket.on('close', () => {
        inbound.length = 0;
        clearTimeout(timer);
        if (!validated) reject(disconnectedError());
        if (this.socket === socket) this.disconnect(disconnectedError());
      });
    });
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
        typeof message.method !== 'string' ||
        ('sessionId' in message &&
          (typeof message.sessionId !== 'string' || message.sessionId === ''))
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
      if (event.method === 'Page.javascriptDialogOpening') {
        // Chrome defers input acknowledgements until the modal is handled.
        // Release only inputs already sent to this target, after notifying
        // Playwright about the dialog; locator auto-waits must keep waiting.
        for (const [id, pending] of this.pending) {
          if (
            pending.inputTarget?.tabId === event.tabId &&
            pending.inputTarget.sessionId === event.sessionId
          ) {
            this.pending.delete(id);
            clearTimeout(pending.timer);
            pending.resolve({});
          }
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
    if (this.isConnected())
      await this.sendRequest('session.close', {}, 2_000).catch(() => undefined);
    this.disconnect(disconnectedError('Chrome bridge stopped'));
    this.selectedExtensionInstanceId = undefined;
    this.requestedExtensionInstanceId = undefined;
  }
}

const POLL_INTERVAL_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCompatible(profile: ChromeProfileEndpoint): boolean {
  return (
    profile.protocolVersion === CHROME_BRIDGE_PROTOCOL_VERSION &&
    profile.extensionProtocolVersion === CHROME_BRIDGE_PROTOCOL_VERSION
  );
}

function versionMismatch(): BrowserRuntimeError {
  return new BrowserRuntimeError(
    'EXTENSION_VERSION_MISMATCH',
    'Browser Use CLI, Native Host and Chrome extension versions must match. Update Qwen Code, run native-host-setup.js install, and reload the extension at chrome://extensions.',
  );
}

function bridgeRuntimeErrorCode(code: string | undefined): RuntimeErrorCode {
  switch (code) {
    case 'NOT_GRANTED':
      return 'TAB_NOT_GRANTED';
    case 'STALE_TAB':
      return 'STALE_TAB';
    case 'UNSUPPORTED_TAB':
      return 'UNSUPPORTED_TAB';
    case 'PERMISSION_REQUIRED':
      return 'PERMISSION_REQUIRED';
    case 'TAB_OWNERSHIP_CONFLICT':
      return 'TAB_OWNERSHIP_CONFLICT';
    case 'TAB_DEBUGGER_CONFLICT':
      return 'TAB_DEBUGGER_CONFLICT';
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

function errorMessage(error: unknown): string {
  return isObject(error) &&
    typeof error.message === 'string' &&
    error.message !== ''
    ? error.message
    : String(error);
}
