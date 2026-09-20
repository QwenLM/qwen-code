#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { chmod, lstat, rename, unlink, writeFile } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import {
  CHROME_BRIDGE_PROTOCOL_VERSION,
  CHROME_EXTENSION_IDS,
  defaultChromeBridgeSocketPath,
  type BridgeHello,
} from '../protocol.js';
import {
  chromeDiscoveryDirectory,
  profileSocketPath,
  prepareDiscoveryDirectory,
} from '../discovery.js';
import {
  prepareSocketDirectory,
  verifySocketPeerPath,
} from '../socket-path.js';
import { encodeFrame, FrameDecoder } from '../transport/framing.js';
import { encodeNativeMessagingOutput } from './native-messaging-output.js';
import {
  currentSocketIdentity,
  isAddressInUse,
  listen,
  recoverStaleSocketAndListen,
  unlinkOwnedSocket,
  type SocketIdentity,
} from './listener.js';

interface Client {
  socket: Socket;
  id: string;
  state: 'opening' | 'active' | 'closing' | 'closed';
  reason?: 'graceful' | 'disconnected';
}
interface Pending {
  client: Client;
  originalId?: string;
  method: string;
  timer: NodeJS.Timeout;
}

const hostInstanceId = randomUUID();
const directory = chromeDiscoveryDirectory();
const overridden = Boolean(process.env['QWEN_BROWSER_USE_SOCKET_PATH']?.trim());
const socketPath = overridden
  ? defaultChromeBridgeSocketPath()
  : profileSocketPath(directory, hostInstanceId);
const discoveryPath = overridden
  ? undefined
  : join(directory, `${hostInstanceId}.json`);
const decoder = new FrameDecoder();
const clients = new Map<string, Client>();
const sockets = new Set<Socket>();
const pending = new Map<string, Pending>();
const server = createServer(accept);
let hello: BridgeHello | undefined;
let identity: SocketIdentity | undefined;
let outputSequence = 0;
let closing = false;
let starting: Promise<void> | undefined;
const startupTimer = setTimeout(() => void shutdown(1), 10_000);
// Protocol 2 CLIs listen on `bridge.sock` in the socket base (the parent of
// the discovery directory) and wait for their own Native Host, which this
// extension no longer launches. Greet each new such listener once with this
// protocol's hello so it reports that Qwen Code must be updated instead of a
// generic connection timeout.
const legacySocketPath = overridden
  ? undefined
  : join(dirname(directory), 'bridge.sock');
let legacyTimer: NodeJS.Timeout | undefined;
let greetedLegacySocket: string | undefined;

function sendNative(message: unknown): void {
  if (closing) return;
  for (const frame of encodeNativeMessagingOutput(
    message,
    String(++outputSequence),
  ))
    process.stdout.write(frame);
}

function request(
  client: Client,
  method: string,
  params: Record<string, unknown>,
  originalId?: string,
): void {
  const id = randomUUID();
  const timer = setTimeout(() => {
    pending.delete(id);
    if (method === 'session.open') {
      // Native Messaging delivers open first; the extension registers it synchronously.
      client.reason ??= 'disconnected';
      client.state = 'closing';
      request(client, 'session.close', { reason: client.reason });
      client.socket.destroy();
      return;
    }
    if (method === 'session.close') {
      client.state = 'closed';
      clients.delete(client.id);
      client.socket.destroy();
    }
    if (originalId !== undefined)
      respond(client, originalId, false, undefined, {
        code: 'OPERATION_TIMEOUT',
        message: `Browser Host request timed out: ${method}`,
      });
  }, 135_000);
  timer.unref();
  pending.set(id, { client, method, originalId, timer });
  sendNative({
    type: 'request',
    id,
    browserSessionId: client.id,
    method,
    params,
  });
}

function respond(
  client: Client,
  id: string,
  ok: boolean,
  result?: unknown,
  error?: unknown,
): void {
  if (!client.socket.destroyed)
    client.socket.write(
      encodeFrame({
        type: 'response',
        browserSessionId: client.id,
        id,
        ok,
        result,
        error,
      }),
    );
}

function closeClient(
  client: Client,
  reason: 'graceful' | 'disconnected',
  originalId?: string,
): void {
  client.reason ??= reason;
  if (
    client.state === 'opening' ||
    client.state === 'closing' ||
    client.state === 'closed'
  )
    return;
  client.state = 'closing';
  request(client, 'session.close', { reason: client.reason }, originalId);
}

function accept(socket: Socket): void {
  if (closing) {
    socket.destroy();
    return;
  }
  sockets.add(socket);
  const frames = new FrameDecoder();
  let client: Client | undefined;
  const timer = setTimeout(() => socket.destroy(), 10_000);
  timer.unref();
  socket.on('error', () => undefined);
  socket.on('close', () => {
    clearTimeout(timer);
    sockets.delete(socket);
    if (client !== undefined && !closing) closeClient(client, 'disconnected');
  });
  socket.on('data', (chunk) => {
    try {
      for (const message of frames.push(chunk)) {
        if (!isObject(message)) {
          socket.destroy();
          return;
        }
        if (client === undefined) {
          if (message.type !== 'client.hello' || hello === undefined) {
            socket.destroy();
            return;
          }
          clearTimeout(timer);
          if (
            message.protocolVersion !== CHROME_BRIDGE_PROTOCOL_VERSION ||
            hello.protocolVersion !== CHROME_BRIDGE_PROTOCOL_VERSION
          ) {
            socket.end(
              encodeFrame({
                type: 'error',
                code: 'EXTENSION_VERSION_MISMATCH',
                message:
                  'Browser Use CLI, Native Host and Chrome extension versions must match. Update Qwen Code, run native-host-setup.js install, and reload the extension at chrome://extensions.',
              }),
            );
            return;
          }
          if (
            (message.extensionInstanceId !== undefined &&
              message.extensionInstanceId !== hello.extensionInstanceId) ||
            (message.hostInstanceId !== undefined &&
              message.hostInstanceId !== hostInstanceId)
          ) {
            socket.destroy();
            return;
          }
          client = { socket, id: randomUUID(), state: 'opening' };
          clients.set(client.id, client);
          request(client, 'session.open', {});
          continue;
        }
        if (
          client.state !== 'active' ||
          message.type !== 'request' ||
          typeof message.id !== 'string' ||
          typeof message.method !== 'string' ||
          !isObject(message.params) ||
          message.browserSessionId !== client.id ||
          message.method === 'session.open'
        ) {
          socket.destroy();
          return;
        }
        if (message.method === 'session.close')
          closeClient(client, 'graceful', message.id);
        else request(client, message.method, message.params, message.id);
      }
    } catch {
      socket.destroy();
    }
  });
}

async function start(extensionHello: BridgeHello): Promise<void> {
  hello = extensionHello;
  if (!overridden) await prepareDiscoveryDirectory(directory);
  await prepareSocketDirectory(socketPath);
  try {
    await listen(server, socketPath);
  } catch (error) {
    if (
      !isAddressInUse(error) ||
      !(await recoverStaleSocketAndListen(server, socketPath))
    )
      throw error;
  }
  identity = await currentSocketIdentity(socketPath);
  if (process.platform !== 'win32') await chmod(socketPath, 0o600);
  if (discoveryPath !== undefined) {
    const temporary = `${discoveryPath}.tmp`;
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          extensionInstanceId: hello.extensionInstanceId,
          hostInstanceId,
          protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
          extensionProtocolVersion: hello.protocolVersion,
          socketPath,
          pid: process.pid,
        }),
        { mode: 0o600 },
      );
      await rename(temporary, discoveryPath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  clearTimeout(startupTimer);
  if (
    legacySocketPath !== undefined &&
    hello.protocolVersion === CHROME_BRIDGE_PROTOCOL_VERSION
  ) {
    legacyTimer = setInterval(() => void greetLegacyClient(), 1_000);
    legacyTimer.unref();
    void greetLegacyClient();
  }
}

async function greetLegacyClient(): Promise<void> {
  if (legacySocketPath === undefined || hello === undefined || closing) return;
  const info = await lstat(legacySocketPath).catch(() => undefined);
  if (!info?.isSocket() || info.uid !== process.getuid?.()) return;
  // Filesystems reuse a freed inode for the next socket at the same path, so
  // the creation time is what tells a restarted CLI's listener apart.
  const key = `${info.dev}:${info.ino}:${info.birthtimeMs || info.ctimeMs}`;
  if (key === greetedLegacySocket) return;
  greetedLegacySocket = key;
  try {
    await verifySocketPeerPath(legacySocketPath);
  } catch {
    return;
  }
  const legacy = connect(legacySocketPath);
  legacy.on('error', () => undefined);
  legacy.setTimeout(5_000, () => legacy.destroy());
  legacy.once('connect', () =>
    legacy.end(
      encodeFrame({
        type: 'hello',
        protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
        extensionId: hello!.extensionId,
        extensionInstanceId: hello!.extensionInstanceId,
      }),
    ),
  );
}

async function shutdown(code = 0): Promise<void> {
  if (closing) return;
  closing = true;
  clearTimeout(startupTimer);
  clearInterval(legacyTimer);
  for (const item of pending.values()) clearTimeout(item.timer);
  pending.clear();
  for (const socket of sockets) socket.destroy();
  process.stdin.destroy();
  const deadline = setTimeout(() => process.exit(code), 2_000);
  deadline.unref();
  await starting?.catch(() => undefined);
  // server.close() unlinks a Unix pathname even if another listener replaced it.
  // This dedicated process can close its descriptors by exiting after guarded cleanup.
  await unlinkOwnedSocket(socketPath, identity);
  if (discoveryPath !== undefined)
    await unlink(discoveryPath).catch(() => undefined);
  process.exit(code);
}

process.stdin.on('data', (chunk: Buffer) => {
  try {
    for (const message of decoder.push(chunk)) {
      if (!isObject(message)) continue;
      if (hello === undefined && starting === undefined) {
        if (
          message.type !== 'hello' ||
          !CHROME_EXTENSION_IDS.includes(message.extensionId as string) ||
          typeof message.protocolVersion !== 'number' ||
          typeof message.extensionInstanceId !== 'string' ||
          message.extensionInstanceId.length === 0 ||
          message.extensionInstanceId.length > 128
        ) {
          void shutdown(1);
          return;
        }
        starting = start(message as unknown as BridgeHello);
        void starting.catch(() => shutdown(1));
        continue;
      }
      if (
        message.type === 'event' &&
        typeof message.browserSessionId === 'string'
      ) {
        const client = clients.get(message.browserSessionId);
        if (client?.state === 'active' && !client.socket.destroyed)
          client.socket.write(encodeFrame(message));
        continue;
      }
      if (message.type !== 'response' || typeof message.id !== 'string')
        continue;
      const item = pending.get(message.id);
      if (item === undefined || item.client.id !== message.browserSessionId)
        continue;
      pending.delete(message.id);
      clearTimeout(item.timer);
      const client = item.client;
      if (item.method === 'session.open') {
        if (!message.ok) {
          clients.delete(client.id);
          client.state = 'closed';
          client.socket.destroy();
          continue;
        }
        client.state = 'active';
        if (client.reason !== undefined || client.socket.destroyed)
          closeClient(client, client.reason ?? 'disconnected');
        else
          client.socket.write(
            encodeFrame({
              ...hello,
              hostInstanceId,
              browserSessionId: client.id,
            }),
          );
      } else {
        if (item.originalId !== undefined)
          respond(
            client,
            item.originalId,
            message.ok === true,
            message.result,
            message.error,
          );
        if (item.method === 'session.close') {
          client.state = 'closed';
          clients.delete(client.id);
          client.socket.end();
        }
      }
    }
  } catch {
    void shutdown(1);
  }
});
process.stdin.on('end', () => void shutdown());
process.stdin.on('error', () => void shutdown(1));
process.stdout.on('error', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
