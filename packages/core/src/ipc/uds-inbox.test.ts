/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Exercises the inbox against a real socket rather than a mock: the parts
 * most likely to break — framing across chunk boundaries, permission
 * bits, cleanup on close — only exist at the socket boundary.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MAX_FRAME_BYTES,
  buildAuthLine,
  buildUserFrame,
  encodePeerFrame,
  type PeerFrame,
} from './peer-frames.js';
import {
  MAX_CONCURRENT_SENDS,
  sendPeerFrame,
  PeerSendError,
} from './uds-client.js';
import { startPeerInbox, type PeerInbox } from './uds-inbox.js';

let tmpDir: string;
let inbox: PeerInbox | null = null;
let received: PeerFrame[];

const isWindows = process.platform === 'win32';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-inbox-'));
  received = [];
});

afterEach(async () => {
  await inbox?.close();
  inbox = null;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function listen(name = 'a.sock'): Promise<PeerInbox> {
  const started = await startPeerInbox({
    socketPath: path.join(tmpDir, 'socks', name),
    onFrame: (frame) => received.push(frame),
  });
  if (!started) throw new Error('inbox failed to start');
  inbox = started;
  return started;
}

/** Write raw bytes, bypassing the client, to drive the framing directly. */
function writeRaw(socketPath: string, chunks: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: socketPath });
    socket.on('error', reject);
    socket.on('connect', () => {
      for (const chunk of chunks) socket.write(chunk);
      socket.end();
    });
    socket.on('close', () => resolve());
  });
}

/** Open a raw connection the test drives one write at a time. */
function connectRaw(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: socketPath });
    socket.on('error', reject);
    socket.once('connect', () => resolve(socket));
  });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe.skipIf(isWindows)('startPeerInbox', () => {
  it('receives a frame written by the client', async () => {
    const started = await listen();
    await sendPeerFrame(started.socketPath, buildUserFrame({ content: 'hi' }));
    await settle();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'hi' },
    });
  });

  it('creates the socket directory as 0700 and the socket as 0600', async () => {
    const started = await listen();
    const dirStat = await fs.stat(path.dirname(started.socketPath));
    const sockStat = await fs.stat(started.socketPath);
    expect(dirStat.mode & 0o777).toBe(0o700);
    expect(sockStat.mode & 0o777).toBe(0o600);
  });

  it('tightens a pre-existing loose socket directory', async () => {
    const dir = path.join(tmpDir, 'socks');
    await fs.mkdir(dir, { recursive: true, mode: 0o755 });
    await fs.chmod(dir, 0o755);

    const started = await listen();
    const dirStat = await fs.stat(path.dirname(started.socketPath));
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it('reclaims a socket file left behind by a crashed session', async () => {
    const dir = path.join(tmpDir, 'socks');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'a.sock'), 'stale');

    const started = await listen();
    await sendPeerFrame(started.socketPath, buildUserFrame({ content: 'hi' }));
    await settle();
    expect(received).toHaveLength(1);
  });

  it('refuses a socket directory another user could have planted', async () => {
    // /tmp is world-writable, so the fallback directory can be created by
    // someone else first. A symlink there would send our chmod — and the
    // socket — somewhere we never chose.
    const elsewhere = path.join(tmpDir, 'elsewhere');
    await fs.mkdir(elsewhere, { mode: 0o755 });
    await fs.chmod(elsewhere, 0o755);
    await fs.symlink(elsewhere, path.join(tmpDir, 'socks'));

    const started = await startPeerInbox({
      socketPath: path.join(tmpDir, 'socks', 'a.sock'),
      onFrame: () => {},
    });
    expect(started).toBeNull();
    // The planted directory is left exactly as it was.
    expect((await fs.stat(elsewhere)).mode & 0o777).toBe(0o755);
  });

  it('refuses a non-local path', async () => {
    const started = await startPeerInbox({
      socketPath: 'relative.sock',
      onFrame: () => {},
    });
    expect(started).toBeNull();
  });

  it('unlinks the socket on close', async () => {
    const started = await listen();
    await started.close();
    inbox = null;
    await expect(fs.stat(started.socketPath)).rejects.toThrow();
  });

  it('is safe to close twice', async () => {
    const started = await listen();
    await started.close();
    await expect(started.close()).resolves.toBeUndefined();
    inbox = null;
  });
});

describe.skipIf(isWindows)('framing', () => {
  it('reassembles a frame split across writes', async () => {
    const started = await listen();
    const encoded = encodePeerFrame(buildUserFrame({ content: 'split me' }));
    const mid = Math.floor(encoded.length / 2);
    await writeRaw(started.socketPath, [
      encoded.slice(0, mid),
      encoded.slice(mid),
    ]);
    await settle();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ message: { content: 'split me' } });
  });

  it('splits several frames arriving in one write', async () => {
    const started = await listen();
    const payload =
      encodePeerFrame(buildUserFrame({ content: 'one' })) +
      encodePeerFrame(buildUserFrame({ content: 'two' }));
    await writeRaw(started.socketPath, [payload]);
    await settle();

    expect(
      received.map(
        (f) => (f as { message: { content: string } }).message.content,
      ),
    ).toEqual(['one', 'two']);
  });

  it('keeps two concurrent senders from splicing into each other', async () => {
    const started = await listen();
    const a = encodePeerFrame(buildUserFrame({ content: 'aaa' }));
    const b = encodePeerFrame(buildUserFrame({ content: 'bbb' }));

    // Settle between the writes so the server really is holding both
    // half-frames at once. Writing each connection's halves back to back
    // passes even with one buffer shared by every connection.
    const [sa, sb] = await Promise.all([
      connectRaw(started.socketPath),
      connectRaw(started.socketPath),
    ]);
    sa.write(a.slice(0, 20));
    await settle();
    sb.write(b.slice(0, 20));
    await settle();
    sa.end(a.slice(20));
    await settle();
    sb.end(b.slice(20));
    await settle();

    const contents = received
      .map((f) => (f as { message: { content: string } }).message.content)
      .sort();
    expect(contents).toEqual(['aaa', 'bbb']);
  });

  it('ignores blank lines', async () => {
    const started = await listen();
    await writeRaw(started.socketPath, [
      '\n\n   \n' + encodePeerFrame(buildUserFrame({ content: 'hi' })),
    ]);
    await settle();
    expect(received).toHaveLength(1);
  });

  it('drops an unparseable line without killing the connection', async () => {
    const started = await listen();
    await writeRaw(started.socketPath, [
      'not json\n' + encodePeerFrame(buildUserFrame({ content: 'after' })),
    ]);
    await settle();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ message: { content: 'after' } });
  });

  it('drops a connection that never sends a newline', async () => {
    const started = await listen();
    const socket = await connectRaw(started.socketPath);
    // Nothing on this side calls end(): the hang-up has to come from the
    // server, which is the only observable difference between capping the
    // line and buffering it forever.
    const hungUp = new Promise<void>((resolve) =>
      socket.once('close', () => resolve()),
    );
    socket.write('x'.repeat(MAX_FRAME_BYTES + 1));
    await hungUp;
    expect(received).toHaveLength(0);

    // The inbox is still usable afterwards.
    await sendPeerFrame(started.socketPath, buildUserFrame({ content: 'ok' }));
    await settle();
    expect(received).toHaveLength(1);
  });

  it('does not let a throwing handler take down the server', async () => {
    const started = await startPeerInbox({
      socketPath: path.join(tmpDir, 'socks', 'b.sock'),
      onFrame: () => {
        throw new Error('handler exploded');
      },
    });
    if (!started) throw new Error('inbox failed to start');
    inbox = started;

    await expect(
      sendPeerFrame(started.socketPath, buildUserFrame({ content: 'boom' })),
    ).resolves.toBeUndefined();
    await settle();
    // The server survived: a second frame is still accepted.
    await expect(
      sendPeerFrame(started.socketPath, buildUserFrame({ content: 'again' })),
    ).resolves.toBeUndefined();
  });
});

describe.skipIf(isWindows)('inbox auth', () => {
  const TOKEN = 'a'.repeat(64);

  async function listenWithToken(): Promise<PeerInbox> {
    const started = await startPeerInbox({
      socketPath: path.join(tmpDir, 'socks', 'auth.sock'),
      requiredToken: TOKEN,
      onFrame: (frame) => received.push(frame),
    });
    if (!started) throw new Error('inbox failed to start');
    inbox = started;
    return started;
  }

  it('delivers a frame preceded by the right token', async () => {
    const started = await listenWithToken();
    await sendPeerFrame(started.socketPath, buildUserFrame({ content: 'hi' }), {
      authToken: TOKEN,
    });
    await settle();
    expect(received).toHaveLength(1);
  });

  it('drops the connection on a wrong token, frames unread', async () => {
    const started = await listenWithToken();
    await writeRaw(started.socketPath, [
      buildAuthLine('b'.repeat(64)) +
        encodePeerFrame(buildUserFrame({ content: 'stolen' })),
    ]).catch(() => {
      // The server may reset the connection mid-write.
    });
    await settle();
    expect(received).toHaveLength(0);
  });

  it('drops a connection whose first line is a frame, not an auth line', async () => {
    const started = await listenWithToken();
    await writeRaw(started.socketPath, [
      encodePeerFrame(buildUserFrame({ content: 'unauthenticated' })) +
        buildAuthLine(TOKEN) +
        encodePeerFrame(buildUserFrame({ content: 'late auth' })),
    ]).catch(() => {});
    await settle();
    // Neither the pre-auth frame nor anything after the destroy arrives.
    expect(received).toHaveLength(0);
  });

  it('reads several frames after one auth line on the same connection', async () => {
    const started = await listenWithToken();
    await writeRaw(started.socketPath, [
      buildAuthLine(TOKEN) +
        encodePeerFrame(buildUserFrame({ content: 'one' })) +
        encodePeerFrame(buildUserFrame({ content: 'two' })),
    ]);
    await settle();
    expect(
      received.map(
        (f) => (f as { message: { content: string } }).message.content,
      ),
    ).toEqual(['one', 'two']);
  });

  it('an inbox without a required token skips a leading auth line', async () => {
    // The old-receiver case: a sender always leads with the auth line
    // when it has a token, and a pre-token inbox must read past it.
    const started = await listen();
    await sendPeerFrame(started.socketPath, buildUserFrame({ content: 'hi' }), {
      authToken: TOKEN,
    });
    await settle();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ message: { content: 'hi' } });
  });
});

describe.skipIf(isWindows)('client errors', () => {
  it('reports ENOENT for a socket that does not exist', async () => {
    const missing = path.join(tmpDir, 'nope.sock');
    await expect(
      sendPeerFrame(missing, buildUserFrame({ content: 'hi' })),
    ).rejects.toMatchObject({ name: 'PeerSendError', code: 'ENOENT' });
  });

  it('reports ECONNREFUSED for a stale socket file', async () => {
    const started = await listen();
    const socketPath = started.socketPath;
    // Close the server but leave the inode: a crashed session's leftovers.
    await started.close();
    inbox = null;
    await fs.writeFile(socketPath, '');

    await expect(
      sendPeerFrame(socketPath, buildUserFrame({ content: 'hi' })),
    ).rejects.toBeInstanceOf(PeerSendError);
  });

  it('refuses a non-local path before dialing', async () => {
    await expect(
      sendPeerFrame('relative.sock', buildUserFrame({ content: 'hi' })),
    ).rejects.toMatchObject({ name: 'PeerSendError' });
  });

  it('refuses a frame the receiver would drop for being too long', async () => {
    const started = await listen();
    await expect(
      sendPeerFrame(
        started.socketPath,
        buildUserFrame({ content: 'x'.repeat(MAX_FRAME_BYTES) }),
      ),
    ).rejects.toMatchObject({ name: 'PeerSendError', code: 'EMSGSIZE' });
    await settle();
    expect(received).toHaveLength(0);
  });

  it('gives up on a peer that dribbles bytes back instead of closing', async () => {
    // Accepts, drains the frame, then writes one byte at a time and
    // never closes (half-open, so the client's FIN does not end it).
    // socket.setTimeout would treat every byte as activity and never
    // fire; the deadline must not.
    const dribblePath = path.join(tmpDir, 'socks', 'dribble.sock');
    await fs.mkdir(path.dirname(dribblePath), { recursive: true });
    const conns: net.Socket[] = [];
    const server = net.createServer({ allowHalfOpen: true }, (conn) => {
      conns.push(conn);
      conn.resume();
      const drip = setInterval(() => conn.write('b'), 100);
      conn.on('close', () => clearInterval(drip));
    });
    await new Promise<void>((resolve) => server.listen(dribblePath, resolve));
    try {
      const startedAt = Date.now();
      await expect(
        sendPeerFrame(dribblePath, buildUserFrame({ content: 'hi' }), {
          timeoutMs: 500,
        }),
      ).rejects.toMatchObject({ name: 'PeerSendError', code: 'ETIMEDOUT' });
      expect(Date.now() - startedAt).toBeLessThan(3000);
    } finally {
      for (const conn of conns) conn.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('drops sends beyond the concurrent cap instead of opening unbounded connections', async () => {
    // Accepts but never services anything: each dial holds its send slot
    // until the deadline, the way a peer that accepts and stalls holds a
    // receipt connection open.
    const stallPath = path.join(tmpDir, 'socks', 'stall.sock');
    await fs.mkdir(path.dirname(stallPath), { recursive: true });
    const conns: net.Socket[] = [];
    const server = net.createServer((conn) => {
      conns.push(conn);
      conn.pause();
    });
    await new Promise<void>((resolve) => server.listen(stallPath, resolve));
    try {
      const pending: Array<Promise<void>> = [];
      for (let i = 0; i < MAX_CONCURRENT_SENDS; i += 1) {
        pending.push(
          sendPeerFrame(stallPath, buildUserFrame({ content: 'hi' }), {
            timeoutMs: 1000,
          }).catch(() => {}),
        );
      }
      await expect(
        sendPeerFrame(stallPath, buildUserFrame({ content: 'hi' }), {
          timeoutMs: 1000,
        }),
      ).rejects.toMatchObject({ name: 'PeerSendError', code: 'EBUSY' });
      await Promise.all(pending);
    } finally {
      for (const conn of conns) conn.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
