/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isLocalIpcPath,
  PeerSendError,
  probePeerSocketVerdict,
  sendPeerFrame,
} from '../../../src/peer/client.js';
import {
  buildAuthLine,
  buildUserFrame,
  MAX_FRAME_CHARS,
} from '../../../src/peer/frames.js';
import { MAX_CONCURRENT_SENDS } from '../../../src/peer/client.js';
import { makeTempRoot, noUnixSockets } from './helpers.js';

describe('isLocalIpcPath', () => {
  it.runIf(process.platform !== 'win32')(
    'accepts only absolute local paths',
    () => {
      expect(isLocalIpcPath('/run/user/1000/qwen-socks/1.sock')).toBe(true);
      expect(isLocalIpcPath('relative.sock')).toBe(false);
      expect(isLocalIpcPath('//server/share/1.sock')).toBe(false);
      expect(isLocalIpcPath('/tmp/a\0b')).toBe(false);
      expect(isLocalIpcPath('')).toBe(false);
    },
  );
});

describe.skipIf(noUnixSockets)('sendPeerFrame and probePeerSocket', () => {
  let root: string;
  const servers: net.Server[] = [];

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function listen(
    name: string,
    onConnection: (socket: net.Socket) => void,
  ): Promise<string> {
    const socketPath = path.join(root, name);
    const server = net.createServer({ allowHalfOpen: true }, onConnection);
    servers.push(server);
    return new Promise((resolve) =>
      server.listen(socketPath, () => resolve(socketPath)),
    );
  }

  it('writes the auth line and the frame together, and resolves when the peer closes', async () => {
    const chunks: string[] = [];
    const socketPath = await listen('peer.sock', (socket) => {
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => chunks.push(chunk));
      socket.on('end', () => socket.end());
    });
    const frame = buildUserFrame({ content: 'hello' });

    await sendPeerFrame(socketPath, frame, { authToken: 'secret' });

    expect(chunks[0]).toBe(
      `${buildAuthLine('secret')}${JSON.stringify(frame)}\n`,
    );
  });

  it('leaves the auth line off when there is no token to present', async () => {
    let received = '';
    const socketPath = await listen('open.sock', (socket) => {
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        received += chunk;
      });
      socket.on('end', () => socket.end());
    });
    const frame = buildUserFrame({ content: 'hello' });
    await sendPeerFrame(socketPath, frame);
    expect(received).toBe(`${JSON.stringify(frame)}\n`);
  });

  it('times out on a peer that accepts and never closes', async () => {
    const socketPath = await listen('stuck.sock', () => {});
    await expect(
      sendPeerFrame(socketPath, buildUserFrame({ content: 'x' }), {
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ name: 'PeerSendError', code: 'ETIMEDOUT' });
  });

  it('reports a missing address, and refuses an oversized frame without dialing', async () => {
    const missing = path.join(root, 'missing.sock');
    await expect(
      sendPeerFrame(missing, buildUserFrame({ content: 'x' })),
    ).rejects.toMatchObject({ code: 'ENOENT', local: false });
    await expect(
      sendPeerFrame(
        missing,
        buildUserFrame({ content: 'x'.repeat(MAX_FRAME_CHARS) }),
      ),
    ).rejects.toMatchObject({ code: 'EMSGSIZE' });
    const relative = sendPeerFrame(
      'relative.sock',
      buildUserFrame({ content: 'x' }),
    );
    await expect(relative).rejects.toBeInstanceOf(PeerSendError);
    await expect(relative).rejects.toMatchObject({ code: undefined });
  });

  it('tells a listener from nothing, and establishes nothing about a path it will not dial', async () => {
    const socketPath = await listen('alive.sock', (socket) => socket.end());
    expect(await probePeerSocketVerdict(socketPath)).toBe('alive');
    expect(await probePeerSocketVerdict(path.join(root, 'missing.sock'))).toBe(
      'dead',
    );
    expect(await probePeerSocketVerdict('relative.sock')).toBe('unknown');
  });

  it.runIf(process.platform === 'linux')(
    'reads a file nothing listens on as dead',
    async () => {
      const stale = path.join(root, 'stale.sock');
      fs.writeFileSync(stale, '');
      expect(await probePeerSocketVerdict(stale)).toBe('dead');
    },
  );
});

describe.skipIf(noUnixSockets)('the concurrent send ceiling', () => {
  it('refuses the send past it locally, before dialing anything', async () => {
    const root = makeTempRoot();
    const socketPath = path.join(root, 'blackhole.sock');
    const held: net.Socket[] = [];
    const blackhole = net.createServer({ allowHalfOpen: true }, (socket) => {
      held.push(socket);
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => blackhole.listen(socketPath, resolve));
    try {
      const inFlight = Array.from({ length: MAX_CONCURRENT_SENDS }, () =>
        sendPeerFrame(socketPath, buildUserFrame({ content: 'x' }), {
          timeoutMs: 20_000,
        }).catch((error: unknown) => error),
      );
      await vi.waitFor(() => expect(held).toHaveLength(MAX_CONCURRENT_SENDS));

      // A path nothing listens on: past the ceiling it is never dialed, so
      // the answer is the local refusal and not ENOENT.
      const started = Date.now();
      const refused = await sendPeerFrame(
        path.join(root, 'never-dialed.sock'),
        buildUserFrame({ content: 'y' }),
      ).catch((error: unknown) => error);
      expect(refused).toMatchObject({
        name: 'PeerSendError',
        code: 'EBUSY',
        local: true,
      });
      expect(Date.now() - started).toBeLessThan(1_000);

      for (const socket of held) socket.destroy();
      await Promise.all(inFlight);
    } finally {
      blackhole.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
