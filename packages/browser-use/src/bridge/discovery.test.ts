/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  chromeDiscoveryDirectory,
  discoverChromeProfiles,
  DISCOVERY_DIRECTORY_NAME,
  profileSocketPath,
  type ChromeProfileEndpoint,
} from './discovery.js';
import {
  defaultChromeBridgeSocketDirectory,
  defaultChromeBridgeSocketPath,
} from './protocol.js';

vi.setConfig({ testTimeout: 20_000, hookTimeout: 10_000 });
const lstatMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: lstatMock };
});
const roots: string[] = [];
const servers: Server[] = [];
beforeEach(() =>
  lstatMock.mockImplementation((file: string) => fs.promises.lstat(file)),
);
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture() {
  const directory = fs.mkdtempSync('/tmp/qbu-discovery-');
  roots.push(directory);
  const hostInstanceId = randomUUID();
  const socketPath = path.join(directory, hostInstanceId + '.sock');
  const endpoint: ChromeProfileEndpoint = {
    extensionInstanceId: 'profile-a',
    hostInstanceId,
    socketPath,
    protocolVersion: 3,
    extensionProtocolVersion: 3,
    pid: process.pid,
  };
  const server = createServer((socket) => socket.end());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const recordPath = path.join(directory, hostInstanceId + '.json');
  fs.writeFileSync(recordPath, JSON.stringify(endpoint), { mode: 0o600 });
  return { directory, endpoint, server, recordPath };
}

test.skipIf(process.platform === 'win32')(
  'accepts a private live record and leaves discovery state unchanged',
  async () => {
    const f = await fixture();
    const before = fs.statSync(f.recordPath);
    expect(await discoverChromeProfiles(f.directory)).toEqual([f.endpoint]);
    expect(fs.statSync(f.recordPath)).toMatchObject({
      ino: before.ino,
      mtimeMs: before.mtimeMs,
    });
  },
);

test
  .skipIf(process.platform === 'win32')
  .each([
    'invalid-json',
    'wrong-host-id',
    'external-socket',
    'missing-profile',
    'invalid-version',
    'public-record',
    'foreign-record',
    'symlink-record',
    'regular-socket',
    'missing-socket',
    'stale-socket',
  ] as const)(
  'ignores %s without replacing or deleting its files',
  async (scenario) => {
    const f = await fixture();
    const endpoint = { ...f.endpoint } as Record<string, unknown>;
    if (scenario === 'wrong-host-id') endpoint['hostInstanceId'] = randomUUID();
    const externalConnected = vi.fn();
    if (scenario === 'external-socket') {
      const externalPath = path.join(f.directory, 'another-host.sock');
      const external = createServer((socket) => {
        externalConnected();
        socket.end();
      });
      servers.push(external);
      await new Promise<void>((resolve) =>
        external.listen(externalPath, resolve),
      );
      endpoint['socketPath'] = externalPath;
    }
    if (scenario === 'missing-profile') delete endpoint['extensionInstanceId'];
    if (scenario === 'invalid-version') endpoint['protocolVersion'] = '3';
    fs.writeFileSync(
      f.recordPath,
      scenario === 'invalid-json' ? '{' : JSON.stringify(endpoint),
    );
    if (scenario === 'public-record') fs.chmodSync(f.recordPath, 0o644);
    if (scenario === 'foreign-record') {
      lstatMock.mockImplementation(async (file: string) => {
        const info = await fs.promises.lstat(file);
        return file === f.recordPath
          ? Object.assign(info, { uid: process.getuid!() + 1 })
          : info;
      });
    }
    if (scenario === 'symlink-record') {
      const target = path.join(f.directory, 'target');
      fs.renameSync(f.recordPath, target);
      fs.symlinkSync(target, f.recordPath);
    }
    if (
      scenario === 'regular-socket' ||
      scenario === 'missing-socket' ||
      scenario === 'stale-socket'
    ) {
      await new Promise<void>((resolve) => f.server.close(() => resolve()));
      if (scenario === 'regular-socket')
        fs.writeFileSync(f.endpoint.socketPath, 'keep');
      if (scenario === 'stale-socket') {
        const dead = spawnSync(
          process.execPath,
          [
            '-e',
            "require('node:net').createServer().listen(process.argv[1], () => process.exit(0))",
            f.endpoint.socketPath,
          ],
          { timeout: 10_000 },
        );
        expect(dead.error).toBeUndefined();
        expect(dead.status).toBe(0);
        expect(fs.statSync(f.endpoint.socketPath).isSocket()).toBe(true);
      }
    }
    const before = fs.lstatSync(f.recordPath);
    const contents = fs.readFileSync(f.recordPath, 'utf8');
    expect(await discoverChromeProfiles(f.directory)).toEqual([]);
    expect(externalConnected).not.toHaveBeenCalled();
    expect(fs.lstatSync(f.recordPath)).toMatchObject({
      ino: before.ino,
      mode: before.mode,
    });
    expect(fs.readFileSync(f.recordPath, 'utf8')).toBe(contents);
    if (scenario === 'regular-socket')
      expect(fs.readFileSync(f.endpoint.socketPath, 'utf8')).toBe('keep');
  },
);

test.skipIf(process.platform === 'win32')(
  'rejects a public discovery directory instead of repairing its permissions',
  async () => {
    const f = await fixture();
    fs.chmodSync(f.directory, 0o755);
    await expect(discoverChromeProfiles(f.directory)).rejects.toThrow(
      'private user-owned directory',
    );
    expect(fs.statSync(f.directory).mode & 0o777).toBe(0o755);
  },
);

test.skipIf(process.platform === 'win32')(
  'removes the files of a Host whose process has exited',
  async () => {
    const f = await fixture();
    await new Promise<void>((resolve) => f.server.close(() => resolve()));
    const dead = spawnSync(
      process.execPath,
      [
        '-e',
        "require('node:net').createServer().listen(process.argv[1], () => { console.log(process.pid); process.exit(0); })",
        f.endpoint.socketPath,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(dead.status).toBe(0);
    fs.writeFileSync(
      f.recordPath,
      JSON.stringify({ ...f.endpoint, pid: Number(dead.stdout.trim()) }),
      { mode: 0o600 },
    );

    expect(await discoverChromeProfiles(f.directory)).toEqual([]);
    expect(fs.existsSync(f.recordPath)).toBe(false);
    expect(fs.existsSync(f.endpoint.socketPath)).toBe(false);
  },
);

test('publishes into a dedicated directory rather than the socket base', async () => {
  vi.stubEnv('QWEN_BROWSER_USE_DISCOVERY_DIR', '');
  vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');
  // toEqual, not toBe: Object.is ignores asymmetric matchers.
  expect(chromeDiscoveryDirectory()).toEqual(
    process.platform === 'win32'
      ? expect.any(String)
      : path.join(
          path.dirname(defaultChromeBridgeSocketPath()),
          DISCOVERY_DIRECTORY_NAME,
        ),
  );
});

test.skipIf(process.platform === 'win32')(
  'the default macOS socket path fits sun_path for the largest uid',
  async () => {
    const base = defaultChromeBridgeSocketDirectory(
      4_294_967_295,
      'darwin',
      () => undefined,
    );
    expect(
      profileSocketPath(path.join(base, DISCOVERY_DIRECTORY_NAME), randomUUID())
        .length,
    ).toBeLessThanOrEqual(103);
  },
);

test.skipIf(process.platform === 'win32')(
  'creates a missing private socket base before its discovery directory',
  async () => {
    const base = fs.mkdtempSync('/tmp/qbu-discovery-base-');
    roots.push(base);
    const directory = path.join(base, 'user-base', 'qwen-hosts');
    expect(await discoverChromeProfiles(directory)).toEqual([]);
    for (const created of [path.dirname(directory), directory])
      expect(fs.statSync(created).mode & 0o777).toBe(0o700);
  },
);
