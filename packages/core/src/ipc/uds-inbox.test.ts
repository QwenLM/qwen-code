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
  buildUserFrame,
  encodePeerFrame,
  type PeerFrame,
} from './peer-frames.js';
import { probePeerSocket, sendPeerFrame, PeerSendError } from './uds-client.js';
import {
  _sweepOrphanSocketsForTesting as sweepOrphanSockets,
  startPeerInbox,
  type PeerInbox,
} from './uds-inbox.js';

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

  // The socket directory sits at a predictable path under a world-writable
  // `/tmp` whenever `XDG_RUNTIME_DIR` is unset, so a different-uid neighbour
  // can get there first. `mkdir(recursive)` is happy with a pre-existing
  // symlink-to-directory and `chmod` follows it, which would hand our 0700
  // to a directory of their choosing.
  it('refuses a socket directory that is a symlink', async () => {
    const target = path.join(tmpDir, 'victim');
    await fs.mkdir(target, { mode: 0o755 });
    await fs.chmod(target, 0o755);
    await fs.symlink(target, path.join(tmpDir, 'socks'));

    const started = await startPeerInbox({
      socketPath: path.join(tmpDir, 'socks', 'a.sock'),
      onFrame: () => {},
    });

    expect(started).toBeNull();
    // The decisive assertion: the planted target keeps its own mode.
    const targetStat = await fs.stat(target);
    expect(targetStat.mode & 0o777).toBe(0o755);
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

    // Each connection sends a half-frame, then the other half, interleaved.
    await Promise.all([
      writeRaw(started.socketPath, [a.slice(0, 20), a.slice(20)]),
      writeRaw(started.socketPath, [b.slice(0, 20), b.slice(20)]),
    ]);
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
    await writeRaw(started.socketPath, ['x'.repeat(MAX_FRAME_BYTES + 1)]);
    await settle();
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
    expect(await probePeerSocket(started.socketPath)).toBe(true);
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
});

describe.skipIf(isWindows)('probePeerSocket', () => {
  it('is true for a listening inbox', async () => {
    const started = await listen();
    expect(await probePeerSocket(started.socketPath)).toBe(true);
  });

  it('is false once the inbox closes', async () => {
    const started = await listen();
    await started.close();
    inbox = null;
    expect(await probePeerSocket(started.socketPath)).toBe(false);
  });

  it('is false for a leftover socket file with nobody listening', async () => {
    const stale = path.join(tmpDir, 'stale.sock');
    await fs.writeFile(stale, '');
    expect(await probePeerSocket(stale)).toBe(false);
  });

  it('is false for a non-local path', async () => {
    expect(await probePeerSocket('relative.sock')).toBe(false);
  });
});

describe.skipIf(isWindows)('orphan socket sweeping', () => {
  /** A PID that is essentially certain not to be running. */
  const DEAD_PID = 0x7ffffffe;

  it('removes a socket file whose process is gone', async () => {
    const dir = path.join(tmpDir, 'socks');
    await fs.mkdir(dir, { recursive: true });
    const orphan = path.join(dir, `${DEAD_PID}.sock`);
    await fs.writeFile(orphan, '');

    expect(await sweepOrphanSockets(dir, '/tmp/self.sock')).toBe(1);
    await expect(fs.stat(orphan)).rejects.toThrow();
  });

  it("leaves a live process's socket alone", async () => {
    const dir = path.join(tmpDir, 'socks');
    await fs.mkdir(dir, { recursive: true });
    const live = path.join(dir, `${process.pid}.sock`);
    await fs.writeFile(live, '');

    expect(await sweepOrphanSockets(dir, '/tmp/self.sock')).toBe(0);
    await expect(fs.stat(live)).resolves.toBeDefined();
  });

  it('never removes our own socket', async () => {
    const dir = path.join(tmpDir, 'socks');
    await fs.mkdir(dir, { recursive: true });
    // Same name as a dead pid, but it is the path we are listening on.
    const self = path.join(dir, `${DEAD_PID}.sock`);
    await fs.writeFile(self, '');

    expect(await sweepOrphanSockets(dir, self)).toBe(0);
    await expect(fs.stat(self)).resolves.toBeDefined();
  });

  it('ignores files that are not <pid>.sock', async () => {
    const dir = path.join(tmpDir, 'socks');
    await fs.mkdir(dir, { recursive: true });
    const keep = [
      '2026-notes.sock',
      'notes.txt',
      'socket',
      `${DEAD_PID}.sock.bak`,
    ];
    for (const name of keep) await fs.writeFile(path.join(dir, name), '');

    expect(await sweepOrphanSockets(dir, '/tmp/self.sock')).toBe(0);
    expect((await fs.readdir(dir)).sort()).toEqual([...keep].sort());
  });

  it('returns zero for a directory that does not exist', async () => {
    expect(
      await sweepOrphanSockets(path.join(tmpDir, 'nope'), '/tmp/self.sock'),
    ).toBe(0);
  });

  it('runs at bind time, so starting a session cleans up after dead ones', async () => {
    const dir = path.join(tmpDir, 'socks');
    await fs.mkdir(dir, { recursive: true });
    const orphan = path.join(dir, `${DEAD_PID}.sock`);
    await fs.writeFile(orphan, '');

    const started = await listen();
    await expect(fs.stat(orphan)).rejects.toThrow();
    // Our own socket survived the sweep it triggered.
    await expect(fs.stat(started.socketPath)).resolves.toBeDefined();
  });
});
