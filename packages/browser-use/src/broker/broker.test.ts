/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CHROME_BRIDGE_PROTOCOL_VERSION,
  CHROME_EXTENSION_ID,
  type BridgeRequest,
  type BridgeResponse,
} from '../bridge/protocol.js';
import { encodeFrame, FrameDecoder } from '../bridge/transport/framing.js';
import { BrowserBroker, type BrowserBrokerOptions } from './browser-broker.js';
import type {
  ClientHello,
  ClientWelcome,
  ConnectionState,
} from './protocol.js';

const roots: string[] = [];
const brokers: BrowserBroker[] = [];
const peers: Peer[] = [];

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.close();
  for (const broker of brokers.splice(0)) await broker.stop();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('BrowserBroker', () => {
  it('validates both handshakes and broadcasts extension state', async () => {
    const counts: number[] = [];
    const broker = await startBroker({
      onClientCountChanged: (count) => counts.push(count),
    });
    const clientA = await connectClient(broker, 'client-a');
    expect(await clientA.read<ClientWelcome>()).toEqual({
      type: 'client.welcome',
      protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
      extensionConnected: false,
    });
    const duplicate = await connectClient(broker, 'client-a');
    await duplicate.waitForClose();
    expect(broker.clientCount).toBe(1);

    const invalidExtension = await connectPeer(broker.socketPath);
    invalidExtension.write({
      type: 'hello',
      protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION + 1,
      extensionId: CHROME_EXTENSION_ID,
    });
    await invalidExtension.waitForClose();
    expect(broker.isExtensionConnected()).toBe(false);

    const extension = await connectExtension(broker);
    expect(await clientA.read<ConnectionState>()).toEqual({
      type: 'connection',
      connected: true,
    });
    const clientB = await connectClient(broker, 'client-b');
    expect(await clientB.read<ClientWelcome>()).toEqual({
      type: 'client.welcome',
      protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
      extensionConnected: true,
    });
    expect(broker.clientCount).toBe(2);

    extension.close();
    expect(await clientA.read<ConnectionState>()).toEqual({
      type: 'connection',
      connected: false,
    });
    expect(await clientB.read<ConnectionState>()).toEqual({
      type: 'connection',
      connected: false,
    });
    clientB.close();
    await waitFor(() => broker.clientCount === 1);
    expect(counts).toEqual([1, 2, 1]);
  });

  it('multiplexes colliding client request ids and adds session metadata', async () => {
    const broker = await startBroker();
    const extension = await connectExtension(broker);
    const clientA = await readyClient(broker, 'client-a');
    const clientB = await readyClient(broker, 'client-b');

    clientA.write(request('same-id', 'session.name', { name: 'Research' }));
    clientB.write(request('same-id', 'ping'));
    const forwarded = await Promise.all([
      extension.read<BridgeRequest>(),
      extension.read<BridgeRequest>(),
    ]);
    const named = forwarded.find(
      (message) => message.method === 'session.name',
    );
    const ping = forwarded.find((message) => message.method === 'ping');
    expect(named).toMatchObject({
      type: 'request',
      params: {
        name: 'Research',
        qwenSessionId: 'client-a',
        qwenSessionName: 'Research',
      },
    });
    expect(ping).toMatchObject({
      type: 'request',
      params: { qwenSessionId: 'client-b' },
    });
    expect(named?.id).not.toBe(ping?.id);
    expect(named?.id).not.toBe('same-id');

    extension.write(response(ping!.id, true, 'pong-b'));
    extension.write(response(named!.id, true, null));
    await expect(clientB.read<BridgeResponse>()).resolves.toEqual(
      response('same-id', true, 'pong-b'),
    );
    await expect(clientA.read<BridgeResponse>()).resolves.toEqual(
      response('same-id', true, null),
    );

    clientA.write(request('next', 'ping'));
    expect(await extension.read<BridgeRequest>()).toMatchObject({
      method: 'ping',
      params: {
        qwenSessionId: 'client-a',
        qwenSessionName: 'Research',
      },
    });
  });

  it('atomically leases tabs and releases them only after detach completes', async () => {
    const broker = await startBroker();
    const extension = await connectExtension(broker);
    const owner = await readyClient(broker, 'owner');
    const contender = await readyClient(broker, 'contender');

    owner.write(request('attach-owner', 'tabs.attach', { tabId: 0 }));
    const ownerAttach = await extension.read<BridgeRequest>();
    expect(ownerAttach).toMatchObject({
      method: 'tabs.attach',
      params: { tabId: 0, qwenSessionId: 'owner' },
    });

    contender.write(request('attach-contender', 'tabs.attach', { tabId: 0 }));
    expect(await contender.read<BridgeResponse>()).toEqual(
      responseError(
        'attach-contender',
        'TAB_ALREADY_CLAIMED',
        'Chrome tab 0 is already claimed by another browser session',
      ),
    );
    extension.write(response(ownerAttach.id, true, null));
    expect(await owner.read<BridgeResponse>()).toEqual(
      response('attach-owner', true, null),
    );

    contender.write(
      request('foreign-write', 'cdp.send', {
        tabId: 0,
        method: 'Page.reload',
        params: {},
      }),
    );
    expect(await contender.read<BridgeResponse>()).toEqual(
      responseError(
        'foreign-write',
        'TAB_NOT_OWNED',
        'Chrome tab 0 is not owned by this browser session',
      ),
    );

    owner.write(request('detach-owner', 'tabs.detach', { tabId: 0 }));
    const detach = await extension.read<BridgeRequest>();
    contender.write(request('too-early', 'tabs.attach', { tabId: 0 }));
    expect(await contender.read<BridgeResponse>()).toMatchObject({
      id: 'too-early',
      ok: false,
      error: { code: 'TAB_ALREADY_CLAIMED' },
    });

    extension.write(response(detach.id, true, null));
    expect(await owner.read<BridgeResponse>()).toEqual(
      response('detach-owner', true, null),
    );
    contender.write(request('takeover', 'tabs.attach', { tabId: 0 }));
    expect(await extension.read<BridgeRequest>()).toMatchObject({
      method: 'tabs.attach',
      params: { tabId: 0, qwenSessionId: 'contender' },
    });
  });

  it('leases created and derived tabs and routes events only to their owner', async () => {
    const broker = await startBroker();
    const extension = await connectExtension(broker);
    const owner = await readyClient(broker, 'owner');
    const observer = await readyClient(broker, 'observer');

    owner.write(request('create', 'tabs.create'));
    const create = await extension.read<BridgeRequest>();
    extension.write(
      response(create.id, true, {
        providerTabId: 11,
        url: 'about:blank',
        title: '',
      }),
    );
    await owner.read<BridgeResponse>();

    extension.write({
      type: 'event',
      tabId: 12,
      method: 'qwenBrowser.derivedTabTracked',
      params: { openerTabId: 11 },
    });
    expect(await owner.read()).toEqual({
      type: 'event',
      tabId: 12,
      method: 'qwenBrowser.derivedTabTracked',
      params: { openerTabId: 11 },
    });
    await expect(observer.expectNoMessage()).resolves.toBeUndefined();

    extension.write({
      type: 'event',
      tabId: 12,
      method: 'Runtime.consoleAPICalled',
      params: { type: 'log' },
    });
    expect(await owner.read()).toMatchObject({
      type: 'event',
      tabId: 12,
      method: 'Runtime.consoleAPICalled',
    });
    await expect(observer.expectNoMessage()).resolves.toBeUndefined();

    observer.write(
      request('derived-write', 'cdp.send', {
        tabId: 12,
        method: 'Page.reload',
        params: {},
      }),
    );
    expect(await observer.read<BridgeResponse>()).toMatchObject({
      id: 'derived-write',
      ok: false,
      error: { code: 'TAB_NOT_OWNED' },
    });

    observer.write(request('observer-create', 'tabs.create'));
    const observerCreate = await extension.read<BridgeRequest>();
    extension.write(
      response(observerCreate.id, true, {
        providerTabId: 21,
        url: 'about:blank',
        title: '',
      }),
    );
    await observer.read<BridgeResponse>();
    extension.write({
      type: 'event',
      tabId: 22,
      method: 'qwenBrowser.derivedTabTracked',
      params: { openerTabId: 21 },
    });
    await observer.read();

    owner.write(request('derived-list', 'tabs.queryDerived'));
    const query = await extension.read<BridgeRequest>();
    extension.write(
      response(query.id, true, [
        { providerTabId: 12, derivedFromProviderTabId: 11 },
        { providerTabId: 13, derivedFromProviderTabId: 11 },
        { providerTabId: 22, derivedFromProviderTabId: 21 },
      ]),
    );
    expect(await owner.read<BridgeResponse>()).toEqual(
      response('derived-list', true, [
        { providerTabId: 12, derivedFromProviderTabId: 11 },
        { providerTabId: 13, derivedFromProviderTabId: 11 },
      ]),
    );

    owner.write(
      request('recovered-derived-write', 'cdp.send', {
        tabId: 13,
        method: 'Page.reload',
        params: {},
      }),
    );
    const recoveredWrite = await extension.read<BridgeRequest>();
    expect(recoveredWrite).toMatchObject({
      method: 'cdp.send',
      params: { tabId: 13, qwenSessionId: 'owner' },
    });
    extension.write(response(recoveredWrite.id, true, null));
    await owner.read<BridgeResponse>();

    owner.write(request('release-derived', 'tabs.detach', { tabId: 12 }));
    const release = await extension.read<BridgeRequest>();
    extension.write(response(release.id, true, null));
    await owner.read();
    observer.write(request('claim-derived', 'tabs.attach', { tabId: 12 }));
    const claim = await extension.read<BridgeRequest>();
    extension.write(response(claim.id, true, null));
    await observer.read();

    owner.write(request('derived-after-transfer', 'tabs.queryDerived'));
    const transferredQuery = await extension.read<BridgeRequest>();
    extension.write(
      response(transferredQuery.id, true, [
        { providerTabId: 12, derivedFromProviderTabId: 11 },
      ]),
    );
    expect(await owner.read<BridgeResponse>()).toEqual(
      response('derived-after-transfer', true, []),
    );
  });

  it('waits for disconnect cleanup before allowing a new owner', async () => {
    const broker = await startBroker();
    const extension = await connectExtension(broker);
    const owner = await readyClient(broker, 'owner');
    const contender = await readyClient(broker, 'contender');

    owner.write(request('attach', 'tabs.attach', { tabId: 21 }));
    const attach = await extension.read<BridgeRequest>();
    extension.write(response(attach.id, true, null));
    await owner.read();
    owner.close();

    const cleanup = await extension.read<BridgeRequest>();
    expect(cleanup).toMatchObject({
      method: 'tabs.detach',
      params: { tabId: 21, qwenSessionId: 'owner' },
    });
    contender.write(request('early', 'tabs.attach', { tabId: 21 }));
    expect(await contender.read<BridgeResponse>()).toMatchObject({
      id: 'early',
      ok: false,
      error: { code: 'TAB_ALREADY_CLAIMED' },
    });

    extension.write(response(cleanup.id, true, null));
    contender.write(request('after-cleanup', 'tabs.attach', { tabId: 21 }));
    expect(await extension.read<BridgeRequest>()).toMatchObject({
      method: 'tabs.attach',
      params: { tabId: 21, qwenSessionId: 'contender' },
    });
  });

  it('does not restore derived leases for a disconnected client', async () => {
    const broker = await startBroker();
    const extension = await connectExtension(broker);
    const owner = await readyClient(broker, 'owner');
    const contender = await readyClient(broker, 'contender');

    owner.write(request('attach', 'tabs.attach', { tabId: 41 }));
    const attach = await extension.read<BridgeRequest>();
    extension.write(response(attach.id, true, null));
    await owner.read<BridgeResponse>();

    owner.write(
      request('pending', 'cdp.send', {
        tabId: 41,
        method: 'Page.reload',
        params: {},
      }),
    );
    await extension.read<BridgeRequest>();
    owner.write(request('derived', 'tabs.queryDerived'));
    const derived = await extension.read<BridgeRequest>();
    owner.close();
    await waitFor(() => broker.clientCount === 1);
    extension.write(
      response(derived.id, true, [
        { providerTabId: 42, derivedFromProviderTabId: 41 },
      ]),
    );

    contender.write(request('claim-derived', 'tabs.attach', { tabId: 42 }));
    expect(await extension.read<BridgeRequest>()).toMatchObject({
      method: 'tabs.attach',
      params: { tabId: 42, qwenSessionId: 'contender' },
    });
  });

  it('drains an owner request before disconnect cleanup and takeover', async () => {
    const broker = await startBroker();
    const extension = await connectExtension(broker);
    const owner = await readyClient(broker, 'owner');
    const contender = await readyClient(broker, 'contender');

    owner.write(request('attach', 'tabs.attach', { tabId: 25 }));
    const attach = await extension.read<BridgeRequest>();
    extension.write(response(attach.id, true, null));
    await owner.read();
    owner.write(
      request('in-flight', 'cdp.send', {
        tabId: 25,
        method: 'Page.reload',
        params: {},
      }),
    );
    const inFlight = await extension.read<BridgeRequest>();
    owner.close();
    await expect(extension.expectNoMessage()).resolves.toBeUndefined();

    contender.write(request('early', 'tabs.attach', { tabId: 25 }));
    expect(await contender.read<BridgeResponse>()).toMatchObject({
      id: 'early',
      error: { code: 'TAB_ALREADY_CLAIMED' },
    });
    extension.write(response(inFlight.id, true, null));
    const cleanup = await extension.read<BridgeRequest>();
    expect(cleanup).toMatchObject({
      method: 'tabs.detach',
      params: { tabId: 25, qwenSessionId: 'owner' },
    });
    extension.write(response(cleanup.id, true, null));

    contender.write(request('takeover', 'tabs.attach', { tabId: 25 }));
    expect(await extension.read<BridgeRequest>()).toMatchObject({
      method: 'tabs.attach',
      params: { tabId: 25, qwenSessionId: 'contender' },
    });
  });

  it('fails requests closed but preserves live-client leases on extension loss', async () => {
    const broker = await startBroker();
    const extension = await connectExtension(broker);
    const owner = await readyClient(broker, 'owner');
    const contender = await readyClient(broker, 'contender');

    owner.write(request('attach', 'tabs.attach', { tabId: 31 }));
    const attach = await extension.read<BridgeRequest>();
    extension.write(response(attach.id, true, null));
    await owner.read<BridgeResponse>();
    owner.write(
      request('pending', 'cdp.send', {
        tabId: 31,
        method: 'Page.reload',
        params: {},
      }),
    );
    await extension.read<BridgeRequest>();
    extension.close();
    expect(await owner.read<BridgeResponse>()).toMatchObject({
      id: 'pending',
      ok: false,
      error: { code: 'BROWSER_DISCONNECTED' },
    });
    expect(await owner.read<ConnectionState>()).toEqual({
      type: 'connection',
      connected: false,
    });
    expect(await contender.read<ConnectionState>()).toEqual({
      type: 'connection',
      connected: false,
    });

    const replacement = await connectExtension(broker);
    expect(await owner.read<ConnectionState>()).toEqual({
      type: 'connection',
      connected: true,
    });
    expect(await contender.read<ConnectionState>()).toEqual({
      type: 'connection',
      connected: true,
    });
    contender.write(request('takeover', 'tabs.attach', { tabId: 31 }));
    expect(await contender.read<BridgeResponse>()).toMatchObject({
      id: 'takeover',
      ok: false,
      error: { code: 'TAB_ALREADY_CLAIMED' },
    });

    owner.write(request('resync', 'tabs.attach', { tabId: 31 }));
    expect(await replacement.read<BridgeRequest>()).toMatchObject({
      method: 'tabs.attach',
      params: { tabId: 31, qwenSessionId: 'owner' },
    });
  });

  it('releases an unconfirmed lease when the extension disconnects', async () => {
    const broker = await startBroker();
    const extension = await connectExtension(broker);
    const owner = await readyClient(broker, 'owner');
    const contender = await readyClient(broker, 'contender');

    owner.write(request('attach', 'tabs.attach', { tabId: 32 }));
    await extension.read<BridgeRequest>();
    extension.close();
    expect(await owner.read<BridgeResponse>()).toMatchObject({
      id: 'attach',
      ok: false,
      error: { code: 'BROWSER_DISCONNECTED' },
    });
    await owner.read<ConnectionState>();
    await contender.read<ConnectionState>();

    const replacement = await connectExtension(broker);
    await owner.read<ConnectionState>();
    await contender.read<ConnectionState>();
    contender.write(request('takeover', 'tabs.attach', { tabId: 32 }));
    expect(await replacement.read<BridgeRequest>()).toMatchObject({
      method: 'tabs.attach',
      params: { tabId: 32, qwenSessionId: 'contender' },
    });
  });

  it('releases an owner lease when tabs.get proves the tab is stale', async () => {
    const broker = await startBroker();
    const extension = await connectExtension(broker);
    const owner = await readyClient(broker, 'owner');
    const contender = await readyClient(broker, 'contender');

    owner.write(request('attach', 'tabs.attach', { tabId: 35 }));
    const attach = await extension.read<BridgeRequest>();
    extension.write(response(attach.id, true, null));
    await owner.read();
    owner.write(request('get-stale', 'tabs.get', { tabId: 35 }));
    const get = await extension.read<BridgeRequest>();
    extension.write({
      type: 'response',
      id: get.id,
      ok: false,
      error: { code: 'STALE_TAB', message: 'Tab is gone' },
    });
    await owner.read();

    contender.write(request('takeover', 'tabs.attach', { tabId: 35 }));
    expect(await extension.read<BridgeRequest>()).toMatchObject({
      method: 'tabs.attach',
      params: { tabId: 35, qwenSessionId: 'contender' },
    });
  });

  it('does not replace or unlink a live broker socket', async () => {
    const root = temporaryRoot();
    const socketPath = path.join(root, 'broker.sock');
    const owner = new BrowserBroker({ socketPath });
    const contender = new BrowserBroker({ socketPath });
    brokers.push(contender, owner);
    await owner.start();
    await expect(contender.start()).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
    await contender.stop();
    expect(fs.statSync(socketPath).isSocket()).toBe(true);

    const client = await connectClient(owner, 'still-live');
    expect(await client.read<ClientWelcome>()).toMatchObject({
      type: 'client.welcome',
    });
  });

  it('preserves a non-socket path after failed start and stop', async () => {
    if (process.platform === 'win32') return;
    const root = temporaryRoot();
    const socketPath = path.join(root, 'broker.sock');
    fs.writeFileSync(socketPath, 'keep-me');
    const broker = new BrowserBroker({ socketPath });
    brokers.push(broker);
    await expect(broker.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await broker.stop();
    expect(fs.readFileSync(socketPath, 'utf8')).toBe('keep-me');
  });

  it('recovers a stale same-user Unix socket', async () => {
    if (process.platform === 'win32') return;
    const root = temporaryRoot();
    const socketPath = path.join(root, 'broker.sock');
    await createStaleSocket(socketPath);
    expect(fs.statSync(socketPath).isSocket()).toBe(true);

    const broker = new BrowserBroker({ socketPath });
    brokers.push(broker);
    await broker.start();
    const client = await connectClient(broker, 'after-stale');
    expect(await client.read<ClientWelcome>()).toMatchObject({
      type: 'client.welcome',
    });
  });

  it('recovers a stale socket recovery lock left by a dead process', async () => {
    if (process.platform === 'win32') return;
    const root = temporaryRoot();
    const socketPath = path.join(root, 'broker.sock');
    await createStaleSocket(socketPath);
    fs.symlinkSync(
      JSON.stringify({ pid: -1, token: 'stale' }),
      `${socketPath}.recovery-lock`,
    );

    const broker = new BrowserBroker({ socketPath });
    brokers.push(broker);
    await broker.start();
    expect(fs.statSync(socketPath).isSocket()).toBe(true);
  });

  it('allows an overlapping stop and restart without hanging', async () => {
    const broker = await startBroker();
    const stopping = broker.stop();
    const restarting = broker.start();
    await expect(Promise.all([stopping, restarting])).resolves.toBeDefined();
    expect(fs.statSync(broker.socketPath).isSocket()).toBe(true);
  });

  it('stops with a silent unauthenticated peer', async () => {
    const broker = await startBroker();
    await connectPeer(broker.socketPath);
    await expect(broker.stop()).resolves.toBeUndefined();
  });
});

function request(
  id: string,
  method: string,
  params: Record<string, unknown> = {},
): BridgeRequest {
  return { type: 'request', id, method, params };
}

function response(id: string, ok: true, result: unknown): BridgeResponse {
  return { type: 'response', id, ok, result };
}

function responseError(
  id: string,
  code: string,
  message: string,
): BridgeResponse {
  return { type: 'response', id, ok: false, error: { code, message } };
}

async function startBroker(
  options: Omit<BrowserBrokerOptions, 'socketPath'> = {},
): Promise<BrowserBroker> {
  const root = temporaryRoot();
  const broker = new BrowserBroker({
    ...options,
    socketPath: path.join(root, 'broker.sock'),
  });
  brokers.push(broker);
  await broker.start();
  return broker;
}

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-broker-'));
  roots.push(root);
  return root;
}

async function createStaleSocket(socketPath: string): Promise<void> {
  const fixturePath = `${socketPath}.fixture`;
  const fixture = createServer();
  await new Promise<void>((resolve, reject) => {
    fixture.once('error', reject);
    fixture.listen(fixturePath, resolve);
  });
  fs.renameSync(fixturePath, socketPath);
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
}

async function connectExtension(broker: BrowserBroker): Promise<Peer> {
  const peer = await connectPeer(broker.socketPath);
  peer.write({
    type: 'hello',
    protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
    extensionId: CHROME_EXTENSION_ID,
  });
  await waitFor(() => broker.isExtensionConnected());
  return peer;
}

async function connectClient(
  broker: BrowserBroker,
  clientId: string,
): Promise<Peer> {
  const peer = await connectPeer(broker.socketPath);
  const hello: ClientHello = {
    type: 'client.hello',
    protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
    clientId,
  };
  peer.write(hello);
  return peer;
}

async function readyClient(
  broker: BrowserBroker,
  clientId: string,
): Promise<Peer> {
  const peer = await connectClient(broker, clientId);
  await peer.read<ClientWelcome>();
  return peer;
}

async function connectPeer(socketPath: string): Promise<Peer> {
  const socket = connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const peer = new Peer(socket);
  peers.push(peer);
  return peer;
}

class Peer {
  private readonly decoder = new FrameDecoder();
  private readonly messages: unknown[] = [];
  private readonly waiters: Array<{
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      for (const message of this.decoder.push(chunk)) {
        const waiter = this.waiters.shift();
        if (waiter === undefined) this.messages.push(message);
        else {
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      }
    });
  }

  write(message: unknown): void {
    this.socket.write(encodeFrame(message));
  }

  async read<T = unknown>(timeoutMs = 1_000): Promise<T> {
    const queued = this.messages.shift();
    if (queued !== undefined) return queued as T;
    return await new Promise<T>((resolve, reject) => {
      const waiter = {
        resolve: (value: unknown) => resolve(value as T),
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(new Error('Timed out waiting for broker message'));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async expectNoMessage(timeoutMs = 30): Promise<void> {
    if (this.messages.length !== 0)
      throw new Error(
        `Unexpected broker message: ${JSON.stringify(this.messages[0])}`,
      );
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: (value: unknown) =>
          reject(
            new Error(`Unexpected broker message: ${JSON.stringify(value)}`),
          ),
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          resolve();
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async waitForClose(): Promise<void> {
    if (this.socket.destroyed) return;
    await new Promise<void>((resolve) => this.socket.once('close', resolve));
  }

  close(): void {
    this.socket.destroy();
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Peer closed'));
    }
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
