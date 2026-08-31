/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { QwenCodeAdaptor } from './adaptor/qwen-code-adaptor.js';
import type { LiveConfig } from './config.js';
import { LiveDaemon } from './daemon.js';
import {
  getLiveDiscoveryPath,
  type LiveDiscoveryRecord,
} from './host/discovery.js';
import { LIVE_HOST_PROTOCOL_VERSION } from './host/types.js';
import { LiveLogger } from './logger.js';

const temporaryDirectories: string[] = [];
const daemons: LiveDaemon[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-live-daemon-'));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeAdaptor(): QwenCodeAdaptor {
  return { preflight: async () => undefined } as unknown as QwenCodeAdaptor;
}

async function testConfig(): Promise<LiveConfig> {
  const base = await temporaryDirectory();
  return {
    realtime: {
      endpoint: 'https://dashscope.example.invalid',
      apiKey: 'test-api-key',
      model: 'test-model',
    },
    serve: { baseUrl: 'http://127.0.0.1:1' },
    dataDir: join(base, 'data'),
    discoveryDir: join(base, 'discovery'),
    port: 0,
  };
}

function startedDaemon(config: LiveConfig): LiveDaemon {
  const daemon = new LiveDaemon(config, {
    adaptor: fakeAdaptor(),
    // 'error' level keeps expected warnings (discovery cleanup) off stderr.
    logger: new LiveLogger('error'),
  });
  daemons.push(daemon);
  return daemon;
}

async function readDiscoveryRecord(
  discoveryDir: string,
): Promise<LiveDiscoveryRecord> {
  const raw = await readFile(getLiveDiscoveryPath(discoveryDir), 'utf8');
  return JSON.parse(raw) as LiveDiscoveryRecord;
}

async function plantDiscoveryRecord(
  discoveryDir: string,
  record: LiveDiscoveryRecord,
): Promise<void> {
  const discoveryPath = getLiveDiscoveryPath(discoveryDir);
  await mkdir(dirname(discoveryPath), { recursive: true, mode: 0o700 });
  await writeFile(discoveryPath, `${JSON.stringify(record)}\n`, {
    mode: 0o600,
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds).unref();
  });
}

function connectHost(url: string, headers: Record<string, string>): WebSocket {
  const target = url.replace(/^http/, 'ws');
  return new WebSocket(`${target}/live/host`, { headers });
}

function hostHeaders(record: LiveDiscoveryRecord): Record<string, string> {
  return {
    authorization: `Bearer ${record.token}`,
    'x-qwen-live-nonce': record.instanceNonce,
  };
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

/** Resolves with the HTTP status of a refused upgrade, rejects on success. */
function waitForRefusal(socket: WebSocket): Promise<number | 'destroyed'> {
  return new Promise((resolve, reject) => {
    socket.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 'destroyed');
      socket.terminate();
    });
    socket.once('error', () => {
      resolve('destroyed');
    });
    socket.once('open', () => {
      reject(new Error('the upgrade was accepted'));
    });
  });
}

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('LiveDaemon', () => {
  it('stop() without start() resolves quickly', async () => {
    const daemon = startedDaemon(await testConfig());
    const outcome = await Promise.race([
      daemon.stop().then(() => 'stopped' as const),
      delay(2_000).then(() => 'timeout' as const),
    ]);
    expect(outcome).toBe('stopped');
  });

  it('publishes a discovery record and accepts a Host presenting it', async () => {
    const config = await testConfig();
    const daemon = startedDaemon(config);
    const { url, port } = await daemon.start();
    expect(url).toBe(`http://127.0.0.1:${port}`);

    const record = await readDiscoveryRecord(config.discoveryDir);
    expect(record.pid).toBe(process.pid);
    expect(record.url).toBe(url);
    expect(record.protocolVersion).toBe(LIVE_HOST_PROTOCOL_VERSION);

    const socket = connectHost(url, hostHeaders(record));
    await waitForOpen(socket);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.terminate();
  });

  it('refuses an upgrade that carries an Origin header (CSRF wall)', async () => {
    const config = await testConfig();
    const daemon = startedDaemon(config);
    const { url } = await daemon.start();
    const record = await readDiscoveryRecord(config.discoveryDir);

    // Even a correct token is refused when Origin marks a browser context.
    const socket = connectHost(url, {
      ...hostHeaders(record),
      origin: 'https://evil.example.com',
    });
    await expect(waitForRefusal(socket)).resolves.toBe(401);
  });

  it('refuses a wrong bearer token with 401', async () => {
    const config = await testConfig();
    const daemon = startedDaemon(config);
    const { url } = await daemon.start();
    const record = await readDiscoveryRecord(config.discoveryDir);

    const socket = connectHost(url, {
      ...hostHeaders(record),
      authorization: 'Bearer not-the-token',
    });
    await expect(waitForRefusal(socket)).resolves.toBe(401);
  });

  it('stop() resolves within a deadline while a Host keeps reconnecting', async () => {
    const config = await testConfig();
    const daemon = startedDaemon(config);
    const { port } = await daemon.start();
    const record = await readDiscoveryRecord(config.discoveryDir);

    // A raw upgraded socket that never answers the server's close frame —
    // the worst-case peer graceful close would wait on. Resolves with the
    // socket once the 101 handshake completed, or undefined when refused.
    const rawHostSocket = (): Promise<Socket | undefined> =>
      new Promise((resolve) => {
        const req = request({
          host: '127.0.0.1',
          port,
          path: '/live/host',
          headers: {
            ...hostHeaders(record),
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
          },
        });
        req.on('upgrade', (_res, socket) => {
          socket.on('error', () => {});
          resolve(socket);
        });
        req.on('response', () => {
          resolve(undefined);
        });
        req.on('error', () => {
          resolve(undefined);
        });
        req.end();
      });

    const sockets: Socket[] = [];
    let redialing = true;
    const redial = (socket: Socket) => {
      socket.on('close', () => {
        if (!redialing) return;
        setTimeout(() => {
          if (!redialing) return;
          void rawHostSocket().then((next) => {
            if (!next) return;
            sockets.push(next);
            redial(next);
          });
        }, 5).unref();
      });
    };

    const first = await rawHostSocket();
    expect(first).toBeDefined();
    sockets.push(first!);
    redial(first!);

    try {
      const outcome = await Promise.race([
        daemon.stop().then(() => 'stopped' as const),
        delay(3_000).then(() => 'timeout' as const),
      ]);
      expect(outcome).toBe('stopped');
    } finally {
      redialing = false;
      for (const socket of sockets) socket.destroy();
    }
  });

  it('reclaims a stale dead-owner discovery record and republishes', async () => {
    const config = await testConfig();
    await plantDiscoveryRecord(config.discoveryDir, {
      url: 'http://127.0.0.1:3210',
      token: 'stale-token',
      protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
      pid: 999_999,
      instanceNonce: 'daemon_instance_nonce_stale_01',
    });

    const daemon = startedDaemon(config);
    const { url } = await daemon.start();

    const record = await readDiscoveryRecord(config.discoveryDir);
    expect(record.pid).toBe(process.pid);
    expect(record.url).toBe(url);
    expect(record.instanceNonce).not.toBe('daemon_instance_nonce_stale_01');
    expect(record.token).not.toBe('stale-token');
  });

  it('fails fast on a live discovery owner instead of stealing the file', async () => {
    const config = await testConfig();
    const planted: LiveDiscoveryRecord = {
      url: 'http://127.0.0.1:3210',
      token: 'live-owner-token',
      protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
      // This test process is alive, so the record reads as a live owner.
      pid: process.pid,
      instanceNonce: 'daemon_instance_nonce_live_01',
    };
    await plantDiscoveryRecord(config.discoveryDir, planted);

    const daemon = startedDaemon(config);
    await expect(daemon.start()).rejects.toThrow(
      /Another Live daemon \(pid \d+\) already owns/,
    );
    // The live owner's record is untouched.
    await expect(readDiscoveryRecord(config.discoveryDir)).resolves.toEqual(
      planted,
    );
  });
});
