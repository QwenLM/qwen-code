/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { encodeFrame, FrameDecoder } from '../transport/framing.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-host-'));
const hostPath = path.join(root, 'host.cjs');
const children: ChildProcessWithoutNullStreams[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];
beforeAll(async () => {
  await build({
    entryPoints: [fileURLToPath(new URL('./index.ts', import.meta.url))],
    outfile: hostPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
  }
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function startHost(socketPath: string) {
  const child = spawn(process.execPath, [hostPath], {
    env: { ...process.env, QWEN_BROWSER_USE_SOCKET_PATH: socketPath },
    stdio: 'pipe',
  });
  children.push(child);
  return child;
}

async function backend(directory: string) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const socketPath = path.join(directory, 'bridge.sock');
  const received: unknown[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    const decoder = new FrameDecoder();
    socket.on('data', (data) => received.push(...decoder.push(data)));
  });
  servers.push(server);
  server.listen(socketPath);
  await once(server, 'listening');
  return { socketPath, received };
}

test.skipIf(process.platform === 'win32')(
  'exits when no backend exists instead of retrying forever',
  async () => {
    const child = startHost(path.join(root, 'absent.sock'));
    child.stdin.write(encodeFrame({ type: 'hello' }));
    await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 10_000 });
  },
  15_000,
);

test.skipIf(process.platform === 'win32')(
  'refuses a server in a shared writable directory before forwarding hello',
  async () => {
    const directory = path.join(root, 'shared');
    const server = await backend(directory);
    fs.chmodSync(directory, 0o777);
    const child = startHost(server.socketPath);
    child.stdin.write(encodeFrame({ type: 'hello' }));
    await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 10_000 });
    expect(server.received).toEqual([]);
  },
  15_000,
);

test.skipIf(process.platform === 'win32')(
  'refuses a symlink socket before forwarding hello',
  async () => {
    const server = await backend(path.join(root, 'target'));
    const link = path.join(root, 'link.sock');
    fs.symlinkSync(server.socketPath, link);
    const child = startHost(link);
    child.stdin.write(encodeFrame({ type: 'hello' }));
    await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 10_000 });
    expect(server.received).toEqual([]);
  },
  15_000,
);

test.skipIf(process.platform === 'win32')(
  'rejects a private socket reached through a replaceable ancestor',
  async () => {
    const server = await backend(path.join(root, 'safe', 'private'));
    const shared = path.join(root, 'replaceable');
    fs.mkdirSync(shared, { mode: 0o777 });
    fs.chmodSync(shared, 0o777);
    fs.symlinkSync(path.join(root, 'safe'), path.join(shared, 'link'));
    const child = startHost(
      path.join(shared, 'link', 'private', 'bridge.sock'),
    );
    child.stdin.write(encodeFrame({ type: 'hello' }));
    await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 10_000 });
    expect(server.received).toEqual([]);
  },
  15_000,
);

test.skipIf(process.platform === 'win32')(
  'relays both ways after more than 60 seconds idle and exits on backend loss',
  async () => {
    const server = await backend(path.join(root, 'private'));
    const child = startHost(server.socketPath);
    const hello = { type: 'hello', protocolVersion: 1, extensionId: 'fixture' };
    const output: unknown[] = [];
    const decoder = new FrameDecoder();
    child.stdout.on('data', (data: Buffer) =>
      output.push(...decoder.push(data)),
    );
    child.stdin.write(encodeFrame(hello));
    await vi.waitFor(() => expect(server.received).toEqual([hello]), {
      timeout: 10_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 61_000));
    expect(child.exitCode).toBeNull();
    sockets[0]!.write(
      encodeFrame({ type: 'request', id: 'idle-ping', method: 'ping' }),
    );
    await vi.waitFor(() =>
      expect(output).toContainEqual({
        type: 'request',
        id: 'idle-ping',
        method: 'ping',
      }),
    );
    child.stdin.write(
      encodeFrame({ type: 'response', id: 'idle-ping', ok: true }),
    );
    await vi.waitFor(() => expect(server.received).toHaveLength(2));
    sockets[0]!.destroy();
    await vi.waitFor(() => expect(child.exitCode).toBe(0));
  },
  80_000,
);

test.skipIf(process.platform === 'win32').each(['eof', 'malformed'])(
  'closes its socket when Chrome input ends with %s',
  async (input) => {
    const server = await backend(path.join(root, input));
    const child = startHost(server.socketPath);
    child.stdin.write(encodeFrame({ type: 'hello' }));
    await vi.waitFor(() => expect(server.received).toHaveLength(1), {
      timeout: 10_000,
    });
    const closed = once(sockets[0]!, 'close');
    if (input === 'eof') child.stdin.end();
    else child.stdin.write(Buffer.from([1, 0, 0, 0, 0]));
    await vi.waitFor(
      () => expect(child.exitCode).toBe(input === 'eof' ? 0 : 1),
      { timeout: 10_000 },
    );
    await closed;
  },
  15_000,
);
