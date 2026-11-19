/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, test, vi } from 'vitest';
import * as listener from './listener.js';

vi.setConfig({ testTimeout: 20_000, hookTimeout: 10_000 });
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync('/tmp/qbu-lock-');
  roots.push(root);
  const socketPath = path.join(root, 'bridge.sock');
  const owner = spawnSync(
    process.execPath,
    [
      '-e',
      "require('node:net').createServer().listen(process.argv[1], () => process.exit(0))",
      socketPath,
    ],
    { timeout: 10_000 },
  );
  expect(owner.error).toBeUndefined();
  expect(owner.status).toBe(0);
  const server = createServer((socket) => socket.end());
  servers.push(server);
  return {
    socketPath,
    server,
  };
}

async function assertConnects(socketPath: string) {
  const socket = connect(socketPath);
  try {
    await once(socket, 'connect');
  } finally {
    socket.destroy();
  }
}

test('recognizes address-in-use errors from another VM realm', () => {
  const error = runInNewContext(
    "Object.assign(new Error('busy'), { code: 'EADDRINUSE' })",
  );
  expect(error instanceof Error).toBe(false);
  expect(listener.isAddressInUse(error)).toBe(true);
});

test.skipIf(process.platform === 'win32')(
  'a recovery attempt preserves a live listener',
  async () => {
    const f = fixture();
    fs.unlinkSync(f.socketPath);
    const owner = createServer((socket) => socket.end());
    servers.push(owner);
    await listener.listen(owner, f.socketPath);
    const before = fs.statSync(f.socketPath);
    expect(
      await listener.recoverStaleSocketAndListen(f.server, f.socketPath),
    ).toBe(false);
    expect(fs.statSync(f.socketPath)).toMatchObject({
      dev: before.dev,
      ino: before.ino,
    });
    await assertConnects(f.socketPath);
  },
);
