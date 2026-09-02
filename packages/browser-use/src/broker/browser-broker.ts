/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { chmod, lstat, readlink, symlink, unlink } from 'node:fs/promises';
import { connect, createServer, type Server, type Socket } from 'node:net';

import {
  CHROME_BRIDGE_PROTOCOL_VERSION,
  CHROME_EXTENSION_ID,
  defaultChromeBridgeSocketPath,
  type BridgeEvent,
  type BridgeHello,
  type BridgeRequest,
  type BridgeResponse,
} from '../bridge/protocol.js';
import { encodeFrame, FrameDecoder } from '../bridge/transport/framing.js';
import type {
  ClientHello,
  ClientWelcome,
  ConnectionState,
} from './protocol.js';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

export interface BrowserBrokerOptions {
  socketPath?: string;
  handshakeTimeoutMs?: number;
  onClientCountChanged?(clientCount: number): void;
}

interface ClientPeer {
  readonly socket: Socket;
  readonly id: string;
  readonly requestIds: Set<string>;
  readonly leases: Set<TabLease>;
  sessionName?: string;
  connected: boolean;
}

interface TabLease {
  readonly tabId: number;
  readonly client: ClientPeer;
  state: 'acquiring' | 'owned' | 'releasing';
}

interface PendingRequest {
  readonly method: string;
  readonly client?: ClientPeer;
  readonly clientRequestId?: string;
  readonly lease?: TabLease;
  readonly tabId?: number;
  readonly action?: 'acquire' | 'create' | 'detach' | 'close' | 'cleanup';
}

interface SocketIdentity {
  dev: number;
  ino: number;
}

interface RecoveryLock {
  path: string;
  contents: string;
}

export class BrowserBroker {
  readonly socketPath: string;

  private readonly handshakeTimeoutMs: number;
  private readonly onClientCountChanged?: (clientCount: number) => void;
  private server: Server | undefined;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private socketIdentity: SocketIdentity | undefined;
  private extension: Socket | undefined;
  private stopping = false;
  private readonly acceptedSockets = new Set<Socket>();
  private readonly clientsBySocket = new Map<Socket, ClientPeer>();
  private readonly clientsById = new Map<string, ClientPeer>();
  private readonly leases = new Map<number, TabLease>();
  private readonly pending = new Map<string, PendingRequest>();

  constructor(options: BrowserBrokerOptions = {}) {
    this.socketPath = options.socketPath ?? defaultChromeBridgeSocketPath();
    this.handshakeTimeoutMs =
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.onClientCountChanged = options.onClientCountChanged;
  }

  get clientCount(): number {
    return this.clientsById.size;
  }

  isExtensionConnected(): boolean {
    return this.extension !== undefined && !this.extension.destroyed;
  }

  async start(): Promise<void> {
    if (this.stopPromise !== undefined) await this.stopPromise;
    if (this.server?.listening === true) return;
    const attempt = (this.startPromise ??= this.startInternal());
    try {
      await attempt;
    } finally {
      if (this.startPromise === attempt) this.startPromise = undefined;
    }
  }

  async stop(): Promise<void> {
    const attempt = (this.stopPromise ??= this.stopInternal(this.startPromise));
    try {
      await attempt;
    } finally {
      if (this.stopPromise === attempt) this.stopPromise = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    this.stopping = false;
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    try {
      try {
        await listen(server, this.socketPath);
      } catch (error) {
        if (
          !isNodeError(error, 'EADDRINUSE') ||
          !(await recoverStaleSocketAndListen(server, this.socketPath))
        )
          throw error;
      }
      if (process.platform !== 'win32') {
        this.socketIdentity = await currentSocketIdentity(this.socketPath);
        if (this.socketIdentity === undefined)
          throw new Error('Browser broker did not create a Unix socket');
        await chmod(this.socketPath, 0o600);
      }
    } catch (error) {
      if (this.server === server) this.server = undefined;
      await closeServer(server);
      await unlinkOwnedSocket(this.socketPath, this.socketIdentity);
      this.socketIdentity = undefined;
      throw error;
    }
  }

  private accept(socket: Socket): void {
    this.acceptedSockets.add(socket);
    const decoder = new FrameDecoder();
    let validated = false;
    const timer = setTimeout(() => {
      if (!validated)
        socket.destroy(new Error('Browser broker hello timed out'));
    }, this.handshakeTimeoutMs);
    timer.unref();

    socket.on('data', (chunk: Buffer) => {
      try {
        for (const message of decoder.push(chunk)) {
          if (!validated) {
            validated = this.handleHandshake(socket, message);
            if (validated) clearTimeout(timer);
            if (!validated) return;
            continue;
          }
          const client = this.clientsBySocket.get(socket);
          if (client !== undefined) this.handleClientMessage(client, message);
          else if (this.extension === socket)
            this.handleExtensionMessage(message);
        }
      } catch {
        socket.destroy(new Error('Invalid browser broker frame'));
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(timer);
      this.acceptedSockets.delete(socket);
      const client = this.clientsBySocket.get(socket);
      if (client !== undefined) this.disconnectClient(client);
      if (this.extension === socket) this.disconnectExtension(socket);
    });
  }

  private handleHandshake(socket: Socket, message: unknown): boolean {
    if (isBridgeHello(message)) {
      if (
        message.protocolVersion !== CHROME_BRIDGE_PROTOCOL_VERSION ||
        message.extensionId !== CHROME_EXTENSION_ID
      ) {
        socket.destroy(
          new Error(
            'Chrome extension identity or protocol version did not match',
          ),
        );
        return false;
      }
      this.promoteExtension(socket);
      return true;
    }
    if (isClientHello(message)) {
      if (
        message.protocolVersion !== CHROME_BRIDGE_PROTOCOL_VERSION ||
        message.clientId.trim() === '' ||
        message.clientId.length > 200 ||
        this.clientsById.has(message.clientId)
      ) {
        socket.destroy(new Error('Browser client hello was invalid'));
        return false;
      }
      this.promoteClient(socket, message);
      return true;
    }
    socket.destroy(new Error('Browser broker expected a hello message'));
    return false;
  }

  private promoteClient(socket: Socket, hello: ClientHello): void {
    const client: ClientPeer = {
      socket,
      id: hello.clientId,
      requestIds: new Set(),
      leases: new Set(),
      connected: true,
    };
    this.clientsBySocket.set(socket, client);
    this.clientsById.set(client.id, client);
    const welcome: ClientWelcome = {
      type: 'client.welcome',
      protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
      extensionConnected: this.isExtensionConnected(),
    };
    this.write(socket, welcome);
    this.notifyClientCountChanged();
  }

  private promoteExtension(socket: Socket): void {
    const previous = this.extension;
    if (previous !== undefined) {
      this.disconnectExtension(previous);
      previous.destroy();
    }
    this.extension = socket;
    this.broadcastConnection(true);
  }

  private handleClientMessage(client: ClientPeer, message: unknown): void {
    if (!isBridgeRequest(message)) return;
    if (client.requestIds.has(message.id)) {
      this.respondError(
        client,
        message.id,
        'INVALID_REQUEST_ID',
        `Browser request id is already pending: ${message.id}`,
      );
      return;
    }
    if (!this.isExtensionConnected()) {
      this.respondError(
        client,
        message.id,
        'BROWSER_DISCONNECTED',
        'Chrome extension is not connected',
      );
      return;
    }

    const tabId = validTabId(message.params.tabId);
    let lease: TabLease | undefined;
    let action: PendingRequest['action'];
    if (message.method === 'tabs.attach' && tabId !== undefined) {
      const existing = this.leases.get(tabId);
      if (existing !== undefined && existing.client !== client) {
        this.respondError(
          client,
          message.id,
          'TAB_ALREADY_CLAIMED',
          `Chrome tab ${tabId} is already claimed by another browser session`,
        );
        return;
      }
      if (existing?.state === 'releasing') {
        this.respondError(
          client,
          message.id,
          'TAB_ALREADY_CLAIMED',
          `Chrome tab ${tabId} is being released`,
        );
        return;
      }
      if (existing === undefined) {
        lease = { tabId, client, state: 'acquiring' };
        this.leases.set(tabId, lease);
        client.leases.add(lease);
        action = 'acquire';
      } else if (existing.state === 'acquiring') {
        this.respondError(
          client,
          message.id,
          'TAB_ALREADY_CLAIMED',
          `Chrome tab ${tabId} is already being claimed`,
        );
        return;
      } else {
        lease = existing;
        action = 'acquire';
      }
    } else if (message.method === 'tabs.create') {
      action = 'create';
    } else if (tabId !== undefined && message.method === 'tabs.get') {
      const existing = this.leases.get(tabId);
      if (existing?.client === client) lease = existing;
    } else if (tabId !== undefined) {
      lease = this.leases.get(tabId);
      if (
        lease === undefined ||
        lease.client !== client ||
        lease.state !== 'owned'
      ) {
        this.respondError(
          client,
          message.id,
          'TAB_NOT_OWNED',
          `Chrome tab ${tabId} is not owned by this browser session`,
        );
        return;
      }
      if (message.method === 'tabs.detach') {
        lease.state = 'releasing';
        action = 'detach';
      } else if (message.method === 'tabs.close') {
        action = 'close';
      }
    }

    if (
      message.method === 'session.name' &&
      typeof message.params.name === 'string' &&
      message.params.name.trim() !== ''
    ) {
      client.sessionName = message.params.name.slice(0, 200);
    }
    this.forwardClientRequest(client, message, lease, action);
  }

  private forwardClientRequest(
    client: ClientPeer,
    request: BridgeRequest,
    lease: TabLease | undefined,
    action: PendingRequest['action'],
  ): void {
    const brokerId = randomUUID();
    const pending: PendingRequest = {
      method: request.method,
      client,
      clientRequestId: request.id,
      ...(lease === undefined ? {} : { lease }),
      ...(validTabId(request.params.tabId) === undefined
        ? {}
        : { tabId: request.params.tabId as number }),
      ...(action === undefined ? {} : { action }),
    };
    this.pending.set(brokerId, pending);
    client.requestIds.add(request.id);
    this.write(this.extension!, {
      type: 'request',
      id: brokerId,
      method: request.method,
      params: this.sessionParams(client, request.params),
    } satisfies BridgeRequest);
  }

  private handleExtensionMessage(message: unknown): void {
    if (isBridgeResponse(message)) {
      this.handleExtensionResponse(message);
      return;
    }
    if (!isBridgeEvent(message)) return;
    const event: BridgeEvent = {
      type: 'event',
      tabId: message.tabId,
      method: message.method,
      params: message.params,
      ...(typeof message.sessionId === 'string' && message.sessionId !== ''
        ? { sessionId: message.sessionId }
        : {}),
    };
    const isDerived = event.method === 'qwenBrowser.derivedTabTracked';
    const lease = isDerived
      ? this.inheritDerivedOwner(event)
      : this.leases.get(event.tabId);
    if (isDerived && lease === undefined) return;
    if (lease?.client.connected === true)
      this.write(lease.client.socket, event);
    if (event.method === 'qwenBrowser.tabRemoved') this.releaseLease(lease);
  }

  private handleExtensionResponse(response: BridgeResponse): void {
    const pending = this.pending.get(response.id);
    if (pending === undefined) return;
    this.pending.delete(response.id);
    const client = pending.client;
    if (client !== undefined && pending.clientRequestId !== undefined) {
      client.requestIds.delete(pending.clientRequestId);
    }

    switch (pending.action) {
      case 'acquire':
        this.finishAcquire(pending, response);
        break;
      case 'create':
        this.finishCreate(pending, response);
        break;
      case 'detach':
        this.finishDetach(pending, response);
        break;
      case 'close':
        if (response.ok) this.releaseLease(pending.lease);
        break;
      case 'cleanup':
        this.releaseLease(pending.lease);
        return;
      default:
        break;
    }
    if (
      pending.method === 'tabs.get' &&
      !response.ok &&
      terminalTabError(response.error?.code)
    ) {
      this.releaseLease(pending.lease);
    }

    if (
      client !== undefined &&
      !client.connected &&
      pending.tabId !== undefined
    ) {
      const lease = this.leases.get(pending.tabId);
      if (lease?.client === client && lease.state === 'owned')
        this.maybeBeginCleanup(lease);
    }

    let outgoing = response;
    if (
      response.ok &&
      pending.method === 'tabs.queryDerived' &&
      client !== undefined
    ) {
      outgoing = {
        ...response,
        result: this.filterDerivedTabs(client, response.result),
      };
    }
    if (client?.connected === true && pending.clientRequestId !== undefined) {
      this.write(client.socket, {
        ...outgoing,
        id: pending.clientRequestId,
      });
    }
  }

  private finishAcquire(
    pending: PendingRequest,
    response: BridgeResponse,
  ): void {
    const lease = pending.lease;
    if (lease === undefined || this.leases.get(lease.tabId) !== lease) return;
    if (!response.ok) {
      this.releaseLease(lease);
      return;
    }
    lease.state = 'owned';
    if (!lease.client.connected) this.maybeBeginCleanup(lease);
  }

  private finishCreate(
    pending: PendingRequest,
    response: BridgeResponse,
  ): void {
    if (!response.ok || pending.client === undefined) return;
    const tabId = providerTabId(response.result);
    if (tabId === undefined || this.leases.has(tabId)) return;
    const lease: TabLease = {
      tabId,
      client: pending.client,
      state: 'owned',
    };
    this.leases.set(tabId, lease);
    pending.client.leases.add(lease);
    if (!pending.client.connected) this.maybeBeginCleanup(lease);
  }

  private finishDetach(
    pending: PendingRequest,
    response: BridgeResponse,
  ): void {
    const lease = pending.lease;
    if (lease === undefined || this.leases.get(lease.tabId) !== lease) return;
    if (response.ok || !lease.client.connected) this.releaseLease(lease);
    else lease.state = 'owned';
  }

  private inheritDerivedOwner(event: BridgeEvent): TabLease | undefined {
    if (event.method !== 'qwenBrowser.derivedTabTracked') return undefined;
    if (!isObject(event.params)) return undefined;
    const openerTabId = validTabId(event.params.openerTabId);
    if (openerTabId === undefined) return undefined;
    const opener = this.leases.get(openerTabId);
    if (
      opener === undefined ||
      opener.state !== 'owned' ||
      !opener.client.connected
    )
      return undefined;
    const existing = this.leases.get(event.tabId);
    if (existing !== undefined)
      return existing.client === opener.client ? existing : undefined;
    const lease: TabLease = {
      tabId: event.tabId,
      client: opener.client,
      state: 'owned',
    };
    this.leases.set(event.tabId, lease);
    opener.client.leases.add(lease);
    return lease;
  }

  private disconnectClient(client: ClientPeer): void {
    if (!client.connected) return;
    client.connected = false;
    this.clientsBySocket.delete(client.socket);
    if (this.clientsById.get(client.id) === client)
      this.clientsById.delete(client.id);
    this.notifyClientCountChanged();
    for (const lease of [...client.leases]) {
      if (this.stopping || !this.isExtensionConnected()) {
        this.releaseLease(lease);
      } else if (lease.state === 'owned') {
        this.maybeBeginCleanup(lease);
      }
    }
  }

  private maybeBeginCleanup(lease: TabLease): void {
    for (const pending of this.pending.values()) {
      if (pending.client === lease.client && pending.tabId === lease.tabId)
        return;
    }
    this.beginCleanup(lease);
  }

  private beginCleanup(lease: TabLease): void {
    if (this.leases.get(lease.tabId) !== lease || lease.state === 'releasing')
      return;
    if (!this.isExtensionConnected()) {
      this.releaseLease(lease);
      return;
    }
    lease.state = 'releasing';
    const brokerId = randomUUID();
    this.pending.set(brokerId, {
      method: 'tabs.detach',
      lease,
      action: 'cleanup',
    });
    this.write(this.extension!, {
      type: 'request',
      id: brokerId,
      method: 'tabs.detach',
      params: this.sessionParams(lease.client, { tabId: lease.tabId }),
    } satisfies BridgeRequest);
  }

  private disconnectExtension(socket: Socket): void {
    if (this.extension !== socket) return;
    this.extension = undefined;
    for (const pending of this.pending.values()) {
      const client = pending.client;
      if (client !== undefined && pending.clientRequestId !== undefined) {
        client.requestIds.delete(pending.clientRequestId);
        if (client.connected) {
          this.respondError(
            client,
            pending.clientRequestId,
            'BROWSER_DISCONNECTED',
            'Chrome extension disconnected before the request completed',
          );
        }
      }
    }
    this.pending.clear();
    for (const lease of [...this.leases.values()]) {
      if (!lease.client.connected || lease.state !== 'owned')
        this.releaseLease(lease);
    }
    if (!this.stopping) this.broadcastConnection(false);
  }

  private filterDerivedTabs(client: ClientPeer, value: unknown): unknown {
    if (!Array.isArray(value)) return value;
    return value.filter((entry) => {
      if (!isObject(entry)) return false;
      const tabId = validTabId(entry.providerTabId);
      const openerTabId = validTabId(entry.derivedFromProviderTabId);
      const directLease =
        tabId === undefined ? undefined : this.leases.get(tabId);
      if (directLease !== undefined) return ownedBy(directLease, client);
      if (
        tabId === undefined ||
        openerTabId === undefined ||
        !client.connected ||
        !ownedBy(this.leases.get(openerTabId), client)
      ) {
        return false;
      }
      const lease: TabLease = { tabId, client, state: 'owned' };
      this.leases.set(tabId, lease);
      client.leases.add(lease);
      return true;
    });
  }

  private releaseLease(lease: TabLease | undefined): void {
    if (lease === undefined || this.leases.get(lease.tabId) !== lease) return;
    this.leases.delete(lease.tabId);
    lease.client.leases.delete(lease);
  }

  private sessionParams(
    client: ClientPeer,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const annotated: Record<string, unknown> = {
      ...params,
      qwenSessionId: client.id,
    };
    delete annotated.qwenSessionName;
    if (client.sessionName !== undefined)
      annotated.qwenSessionName = client.sessionName;
    return annotated;
  }

  private respondError(
    client: ClientPeer,
    id: string,
    code: string,
    message: string,
  ): void {
    this.write(client.socket, {
      type: 'response',
      id,
      ok: false,
      error: { code, message },
    } satisfies BridgeResponse);
  }

  private broadcastConnection(connected: boolean): void {
    const state: ConnectionState = { type: 'connection', connected };
    for (const client of this.clientsById.values()) {
      this.write(client.socket, state);
    }
  }

  private notifyClientCountChanged(): void {
    try {
      this.onClientCountChanged?.(this.clientCount);
    } catch {
      // Lifecycle observers cannot be allowed to break broker cleanup.
    }
  }

  private write(socket: Socket, message: unknown): void {
    if (!socket.destroyed) socket.write(encodeFrame(message));
  }

  private async stopInternal(
    starting: Promise<void> | undefined,
  ): Promise<void> {
    await starting?.catch(() => undefined);
    this.stopping = true;
    const extension = this.extension;
    this.extension = undefined;
    extension?.destroy();
    this.pending.clear();
    for (const lease of [...this.leases.values()]) this.releaseLease(lease);
    for (const socket of this.acceptedSockets) socket.destroy();
    this.acceptedSockets.clear();
    if (this.clientsById.size > 0) {
      for (const client of this.clientsById.values()) client.connected = false;
      this.clientsById.clear();
      this.clientsBySocket.clear();
      this.notifyClientCountChanged();
    }
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) await closeServer(server);
    await unlinkOwnedSocket(this.socketPath, this.socketIdentity);
    this.socketIdentity = undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBridgeHello(value: unknown): value is BridgeHello {
  return isObject(value) && value.type === 'hello';
}

function isClientHello(value: unknown): value is ClientHello {
  return (
    isObject(value) &&
    value.type === 'client.hello' &&
    typeof value.protocolVersion === 'number' &&
    typeof value.clientId === 'string'
  );
}

function isBridgeRequest(value: unknown): value is BridgeRequest {
  return (
    isObject(value) &&
    value.type === 'request' &&
    typeof value.id === 'string' &&
    value.id !== '' &&
    typeof value.method === 'string' &&
    value.method !== '' &&
    isObject(value.params)
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

function isBridgeEvent(value: unknown): value is BridgeEvent {
  return (
    isObject(value) &&
    value.type === 'event' &&
    validTabId(value.tabId) !== undefined &&
    typeof value.method === 'string'
  );
}

function validTabId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function providerTabId(value: unknown): number | undefined {
  return isObject(value) ? validTabId(value.providerTabId) : undefined;
}

function terminalTabError(code: string | undefined): boolean {
  return (
    code === 'STALE_TAB' ||
    code === 'UNSUPPORTED_TAB' ||
    code === 'NOT_GRANTED' ||
    code === 'TAB_NOT_GRANTED'
  );
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

async function removeStaleSocket(socketPath: string): Promise<boolean> {
  if (process.platform === 'win32') return false;
  const info = await lstat(socketPath).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (info === undefined) return true;
  if (!info.isSocket()) return false;
  if (typeof process.getuid === 'function' && info.uid !== process.getuid())
    return false;
  if (await socketAcceptsConnections(socketPath)) return false;
  const current = await lstat(socketPath).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return undefined;
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
    if (!isNodeError(error, 'ENOENT')) throw error;
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
      await symlink(contents, path);
      return { path, contents };
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
      const owner = await readRecoveryLockOwner(path);
      if (owner === undefined || processIsAlive(owner)) return undefined;
      await unlink(path).catch((unlinkError: unknown) => {
        if (!isNodeError(unlinkError, 'ENOENT')) throw unlinkError;
      });
    }
  }
  return undefined;
}

async function readRecoveryLockOwner(
  path: string,
): Promise<number | undefined> {
  const contents = await readlink(path).catch(() => '');
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
    return !isNodeError(error, 'ESRCH');
  }
}

async function releaseRecoveryLock(lock: RecoveryLock): Promise<void> {
  const contents = await readlink(lock.path).catch(() => undefined);
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

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
    if (!isNodeError(error, 'ENOENT')) throw error;
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

function ownedBy(lease: TabLease | undefined, client: ClientPeer): boolean {
  return lease?.client === client && lease.state === 'owned';
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
