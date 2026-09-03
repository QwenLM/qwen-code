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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { MAX_SOCKET_PATH_BYTES } from './socket-path.js';
import {
  getLastPeerInboxFailure,
  describePeerInboxFailure,
  startPeerInbox,
  SWEEP_BATCH_SIZE,
  sweepOrphanSocketDirs,
  sweepOrphanSockets,
  type PeerConnectionAuth,
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
  // packages/core's vitest config does not set `unstubEnvs`, so a test
  // that throws before its own cleanup would otherwise leak TMPDIR or
  // XDG_RUNTIME_DIR into the next test's mkdtemp.
  vi.unstubAllEnvs();
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
    expect(getLastPeerInboxFailure()).toMatchObject({
      cause: 'non_local',
      socketPath: 'relative.sock',
      attempts: 1,
    });
  });

  it('names the cause when the socket directory is not a directory', async () => {
    await fs.writeFile(path.join(tmpDir, 'socks'), 'a file');
    const started = await startPeerInbox({
      socketPath: path.join(tmpDir, 'socks', 'a.sock'),
      onFrame: () => {},
    });
    expect(started).toBeNull();
    const failure = getLastPeerInboxFailure();
    expect(failure?.cause).toBe('not_directory');
    expect(describePeerInboxFailure(failure!)).toContain(
      'not a plain directory',
    );
    expect(describePeerInboxFailure(failure!)).toContain('XDG_RUNTIME_DIR');
  });

  it('includes the errno when a parent is not a directory', async () => {
    const broken = path.join(tmpDir, 'broken');
    await fs.writeFile(broken, 'a file');
    await startPeerInbox({
      socketPath: path.join(broken, 'socks', 'a.sock'),
      onFrame: () => {},
    });
    const failure = getLastPeerInboxFailure();
    expect(failure?.cause).toBe('not_directory');
    expect(describePeerInboxFailure(failure!)).toContain('ENOTDIR');
  });

  it('surfaces remediation and multi-candidate diagnostics', () => {
    const failure = {
      cause: 'unknown' as const,
      socketPath: '/tmp/qwen-socks/a.sock',
      detail: 'ENOSPC: no space left on device',
      hint: 'Free disk space, then restart.',
      attempts: 3,
    };
    expect(describePeerInboxFailure(failure)).toContain(failure.hint);
    expect(describePeerInboxFailure(failure)).toContain(
      'Tried 3 candidate paths',
    );
    expect(
      describePeerInboxFailure({ ...failure, cause: 'chmod_failed' }),
    ).toContain(failure.hint);
    expect(
      describePeerInboxFailure({ ...failure, cause: 'non_local' }),
    ).toContain(failure.hint);
  });

  it('names the cause when a planted symlink sits where the directory should be', async () => {
    const elsewhere = path.join(tmpDir, 'elsewhere');
    await fs.mkdir(elsewhere);
    await fs.symlink(elsewhere, path.join(tmpDir, 'socks'));
    await startPeerInbox({
      socketPath: path.join(tmpDir, 'socks', 'a.sock'),
      onFrame: () => {},
    });
    expect(getLastPeerInboxFailure()?.cause).toBe('not_directory');
  });

  it('names the cause when the path is too long to bind', async () => {
    const long = path.join(tmpDir, 'x'.repeat(120), 'a.sock');
    const started = await startPeerInbox({
      socketPath: long,
      onFrame: () => {},
    });
    expect(started).toBeNull();
    expect(getLastPeerInboxFailure()?.cause).toBe('path_too_long');
    expect(describePeerInboxFailure(getLastPeerInboxFailure()!)).toContain(
      'shorter directory',
    );
  });

  it.skipIf(process.getuid?.() === 0)(
    'names the cause when a parent directory is not writable',
    async () => {
      const locked = path.join(tmpDir, 'locked');
      await fs.mkdir(locked, { mode: 0o500 });
      await fs.chmod(locked, 0o500);
      const started = await startPeerInbox({
        socketPath: path.join(locked, 'socks', 'a.sock'),
        onFrame: () => {},
      });
      expect(started).toBeNull();
      expect(getLastPeerInboxFailure()?.cause).toBe('permission');
      await fs.chmod(locked, 0o700);
    },
  );

  it('clears the recorded failure once a bind succeeds', async () => {
    await startPeerInbox({ socketPath: 'relative.sock', onFrame: () => {} });
    expect(getLastPeerInboxFailure()).not.toBeNull();
    await listen();
    expect(getLastPeerInboxFailure()).toBeNull();
  });

  it('falls back to the next candidate when the runtime directory is unusable', async () => {
    // XDG_RUNTIME_DIR pointing at a file is what a broken container mount
    // looks like from inside; the session must still get an inbox.
    const runtime = path.join(tmpDir, 'runtime');
    await fs.writeFile(runtime, 'not a directory');
    const tmp = await fs.mkdtemp('/tmp/qwen-inbox-fallback-');
    vi.stubEnv('XDG_RUNTIME_DIR', runtime);
    vi.stubEnv('TMPDIR', tmp);
    try {
      const started = await startPeerInbox({ onFrame: () => {} });
      expect(started).not.toBeNull();
      inbox = started;
      expect(started!.socketPath.startsWith(tmp + path.sep)).toBe(true);
      expect(getLastPeerInboxFailure()).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('reports automatic Windows paths as an unsupported platform', async () => {
    const platform = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('win32');
    try {
      const started = await startPeerInbox({ onFrame: () => {} });
      expect(started).toBeNull();
      expect(getLastPeerInboxFailure()?.cause).toBe('unsupported_platform');
      expect(describePeerInboxFailure(getLastPeerInboxFailure()!)).toContain(
        'not available on this platform',
      );
      // A machine-level refusal is not a path that might have gone
      // better. Counting candidates here would send a user for whom no
      // path can ever work looking for a better one, with a number that
      // moves when XDG_RUNTIME_DIR is set.
      expect(getLastPeerInboxFailure()?.attempts).toBe(1);
      expect(
        describePeerInboxFailure(getLastPeerInboxFailure()!),
      ).not.toContain('Tried');
    } finally {
      platform.mockRestore();
    }
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

  it('drops a connection that sends no complete line by the deadline, even if bytes trickle in', async () => {
    const started = await startPeerInbox({
      socketPath: path.join(tmpDir, 'socks', 'a.sock'),
      onFrame: (frame) => received.push(frame),
      lineDeadlineMs: 120,
    });
    if (!started) throw new Error('inbox failed to start');
    inbox = started;
    const socket = await connectRaw(started.socketPath);
    const closed = new Promise<void>((resolve) =>
      socket.on('close', () => resolve()),
    );
    // One byte every 40 ms would reset an idle timer forever.
    const dribble = setInterval(() => socket.write('x'), 40);
    const start = Date.now();
    await closed;
    clearInterval(dribble);
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(received).toHaveLength(0);
  });

  it('drops a connection held open by junk lines shorter than the deadline', async () => {
    const started = await startPeerInbox({
      socketPath: path.join(tmpDir, 'socks', 'a.sock'),
      onFrame: (frame) => received.push(frame),
      lineDeadlineMs: 120,
    });
    if (!started) throw new Error('inbox failed to start');
    inbox = started;
    const socket = await connectRaw(started.socketPath);
    const closed = new Promise<void>((resolve) =>
      socket.on('close', () => resolve()),
    );
    // Complete lines, so the byte-dribble guard above does not apply, but
    // none of them parses. Two bytes every 40 ms would hold a connection
    // -- and one of the 64 maxConnections slots -- for the whole session
    // if an unparseable line re-armed the deadline.
    const junk = setInterval(() => socket.write('x\n'), 40);
    const start = Date.now();
    await closed;
    clearInterval(junk);
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(received).toHaveLength(0);
  });

  it('re-arms the deadline from each complete line, not from each byte', async () => {
    const started = await startPeerInbox({
      socketPath: path.join(tmpDir, 'socks', 'a.sock'),
      onFrame: (frame) => received.push(frame),
      lineDeadlineMs: 150,
    });
    if (!started) throw new Error('inbox failed to start');
    inbox = started;
    const socket = await connectRaw(started.socketPath);
    let open = true;
    socket.on('close', () => {
      open = false;
    });
    // Two whole frames 100 ms apart both land; the connection is still
    // open after the second because each line re-armed the deadline.
    socket.write(encodePeerFrame(buildUserFrame({ content: 'one' })));
    await new Promise((resolve) => setTimeout(resolve, 100));
    socket.write(encodePeerFrame(buildUserFrame({ content: 'two' })));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(received).toHaveLength(2);
    expect(open).toBe(true);
    socket.end();
    await settle();
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

  it('re-arms the deadline from the auth line, so a slow sender still lands', async () => {
    // Only progress re-arms the deadline, and presenting credentials is
    // progress: the sender has authenticated and still has its frame to
    // write. Without this re-arm the deadline runs from connect, and a
    // sender that pauses between the two lines is hung up on before its
    // frame arrives -- a legitimate peer dropped for being slow.
    const started = await startPeerInbox({
      socketPath: path.join(tmpDir, 'socks', 'auth.sock'),
      requiredToken: TOKEN,
      onFrame: (frame) => received.push(frame),
      lineDeadlineMs: 150,
    });
    if (!started) throw new Error('inbox failed to start');
    inbox = started;
    const socket = await connectRaw(started.socketPath);
    await new Promise((resolve) => setTimeout(resolve, 100));
    socket.write(buildAuthLine(TOKEN));
    // 200 ms after connect: past the deadline armed at connect, inside
    // the one the auth line armed.
    await new Promise((resolve) => setTimeout(resolve, 100));
    socket.write(encodePeerFrame(buildUserFrame({ content: 'slow' })));
    await settle();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ message: { content: 'slow' } });
    socket.end();
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

  it('drops a wrong-LENGTH token cleanly instead of throwing', async () => {
    // timingSafeEqual throws on differing lengths, so the byte-length
    // short-circuit in tokenMatches is the only thing keeping a truncated
    // QWEN_CODE_MESSAGING_TOKEN a clean fail-closed refusal rather than an
    // exception inside the line reader.
    const started = await listenWithToken();
    await writeRaw(started.socketPath, [
      buildAuthLine('a'.repeat(32)) +
        encodePeerFrame(buildUserFrame({ content: 'short token' })),
    ]).catch(() => {});
    await settle();
    expect(received).toHaveLength(0);
    // The inbox is still serving: the refusal was per-connection.
    await sendPeerFrame(started.socketPath, buildUserFrame({ content: 'ok' }), {
      authToken: TOKEN,
    });
    await settle();
    expect(received).toHaveLength(1);
  });

  it('does not let one connection refusal brick the inbox', async () => {
    // Were `refused` hoisted out of the per-connection closure, a single
    // unauthenticated connection — a pre-token build's send, which is only
    // meant to be dropped — would silently kill the inbox for the rest of
    // the session.
    const started = await listenWithToken();
    await writeRaw(started.socketPath, [
      encodePeerFrame(buildUserFrame({ content: 'unauthenticated' })),
    ]).catch(() => {});
    await settle();
    expect(received).toHaveLength(0);

    await sendPeerFrame(
      started.socketPath,
      buildUserFrame({ content: 'after the refusal' }),
      { authToken: TOKEN },
    );
    await settle();
    expect(received).toMatchObject([
      { message: { content: 'after the refusal' } },
    ]);
  });

  it('does not let one connection admission admit the next', async () => {
    // The other leak direction: a hoisted `authed` would make the first
    // legitimate sender open the inbox to every later connection, token or
    // not.
    const started = await listenWithToken();
    await sendPeerFrame(
      started.socketPath,
      buildUserFrame({ content: 'authenticated' }),
      { authToken: TOKEN },
    );
    await settle();
    expect(received).toHaveLength(1);

    await writeRaw(started.socketPath, [
      encodePeerFrame(buildUserFrame({ content: 'riding on the last auth' })),
    ]).catch(() => {});
    await settle();
    expect(received).toHaveLength(1);
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

describe.skipIf(isWindows)('child token', () => {
  const PEER = 'a'.repeat(64);
  const CHILD = 'c'.repeat(64);
  let admitted: Array<PeerConnectionAuth | undefined>;

  beforeEach(() => {
    admitted = [];
  });

  async function listenWithBoth(
    tokens: { requiredToken?: string; childToken?: string } = {
      requiredToken: PEER,
      childToken: CHILD,
    },
  ): Promise<PeerInbox> {
    const started = await startPeerInbox({
      socketPath: path.join(tmpDir, 'socks', 'child.sock'),
      ...tokens,
      onFrame: (frame, auth) => {
        received.push(frame);
        admitted.push(auth);
      },
    });
    if (!started) throw new Error('inbox failed to start');
    inbox = started;
    return started;
  }

  it('admits either token and reports which one it was', async () => {
    const started = await listenWithBoth();
    await sendPeerFrame(started.socketPath, buildUserFrame({ content: 'p' }), {
      authToken: PEER,
    });
    await sendPeerFrame(started.socketPath, buildUserFrame({ content: 'c' }), {
      authToken: CHILD,
    });
    await settle();
    expect(
      received.map(
        (f) => (f as { message: { content: string } }).message.content,
      ),
    ).toEqual(['p', 'c']);
    expect(admitted).toEqual(['peer', 'child']);
  });

  it('holds the verdict for every frame on the connection', async () => {
    // The kind is decided once per connection, at the auth line, and
    // cannot be re-negotiated by a later line.
    const started = await listenWithBoth();
    await writeRaw(started.socketPath, [
      buildAuthLine(CHILD) +
        encodePeerFrame(buildUserFrame({ content: 'one' })) +
        buildAuthLine(PEER) +
        encodePeerFrame(buildUserFrame({ content: 'two' })),
    ]);
    await settle();
    // The second auth line is an unparseable frame, skipped like any other.
    expect(received).toHaveLength(2);
    expect(admitted).toEqual(['child', 'child']);
  });

  it('still refuses a token that is neither', async () => {
    const started = await listenWithBoth();
    await writeRaw(started.socketPath, [
      buildAuthLine('b'.repeat(64)) +
        encodePeerFrame(buildUserFrame({ content: 'neither' })),
    ]).catch(() => {});
    await settle();
    expect(received).toHaveLength(0);
  });

  it('means nothing without a required token', async () => {
    // A child token on an open inbox would be a third state — "admitted,
    // but not by a token we asked for" — with no consumer. It is inert.
    const started = await listenWithBoth({ childToken: CHILD });
    await sendPeerFrame(started.socketPath, buildUserFrame({ content: 'x' }), {
      authToken: CHILD,
    });
    await sendPeerFrame(started.socketPath, buildUserFrame({ content: 'y' }));
    await settle();
    expect(received).toHaveLength(2);
    expect(admitted).toEqual([undefined, undefined]);
  });
});

describe.skipIf(isWindows)('orphan socket sweeps', () => {
  it('removes sockets whose process is provably dead and keeps the rest', async () => {
    const dir = path.join(tmpDir, 'qwen-socks');
    await fs.mkdir(dir);
    // 2^22-1 is above the default pid_max on Linux, so nothing owns it.
    const dead = path.join(dir, '4194303.sock');
    const live = path.join(dir, `${process.pid}.sock`);
    const self = path.join(dir, '4194302.sock');
    const foreign = path.join(dir, 'notes.sock');
    for (const file of [dead, live, self, foreign])
      await fs.writeFile(file, '');

    expect(await sweepOrphanSockets(dir, self)).toBe(1);
    expect(await fs.readdir(dir)).toEqual(
      expect.arrayContaining([
        'notes.sock',
        `${process.pid}.sock`,
        '4194302.sock',
      ]),
    );
    await expect(fs.stat(dead)).rejects.toThrow();
  });

  it('sweeps every batch when more than one batch of dead sockets accumulates', async () => {
    const dir = path.join(tmpDir, 'qwen-socks');
    await fs.mkdir(dir);
    // Sized from the constant so the fixture spans two batches however
    // the fd-pressure knob is tuned.
    const sockets = Array.from({ length: SWEEP_BATCH_SIZE + 4 }, (_, index) =>
      path.join(dir, `${2_147_483_600 + index}.sock`),
    );
    await Promise.all(sockets.map((socket) => fs.writeFile(socket, '')));

    expect(
      await sweepOrphanSockets(dir, path.join(dir, '2147483647.sock')),
    ).toBe(sockets.length);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('sweeps every batch when more than one batch of fallback directories accumulates', async () => {
    // One nonce directory per crashed session: 17+ of them span two
    // batches, and only a loop that visits every batch clears them all.
    const parent = path.join(tmpDir, 'tmp');
    const ownDir = path.join(parent, `qwen-socks-${'f'.repeat(16)}`);
    await fs.mkdir(ownDir, { recursive: true });
    const dirs = Array.from({ length: SWEEP_BATCH_SIZE + 4 }, (_, index) =>
      path.join(parent, `qwen-socks-${index.toString(16).padStart(16, '0')}`),
    );
    await Promise.all(
      dirs.map(async (dir, index) => {
        await fs.mkdir(dir);
        await fs.writeFile(path.join(dir, `${2_147_483_600 + index}.sock`), '');
      }),
    );

    expect(await sweepOrphanSocketDirs(parent, ownDir)).toBe(dirs.length);
    const left = await fs.readdir(parent);
    expect(
      left.filter((name) => /^qwen-socks-[0-9a-f]{16}$/.test(name)),
    ).toEqual([path.basename(ownDir)]);
  });

  it('keeps a listening socket even when its filename PID is absent', async () => {
    const dir = path.join(tmpDir, 'qwen-socks');
    const live = path.join(dir, '4194303.sock');
    await fs.mkdir(dir);
    const server = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(live, resolve));
    try {
      expect(
        await sweepOrphanSockets(dir, path.join(dir, '4194302.sock')),
      ).toBe(0);
      await expect(fs.stat(live)).resolves.toBeDefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // Mode 000 makes connect() fail EACCES, which is a real inconclusive
  // probe: the listener below is up and answers anyone permitted to dial
  // it. The existing "keeps a listening socket even when its filename PID
  // is absent" pins only the case where the probe reaches a definitive
  // answer, and stays green whether or not `unknown` is honoured.
  it.skipIf(process.getuid?.() === 0)(
    'keeps a socket whose probe could not reach a verdict',
    async () => {
      const dir = path.join(tmpDir, 'qwen-socks');
      await fs.mkdir(dir);
      // Above the default pid_max, so `isPidAlive` reports dead -- which is
      // also what it reports for a live PID from another namespace. The
      // probe is the only thing left between this file and the unlink.
      const live = path.join(dir, '4194303.sock');
      const server = net.createServer((socket) => socket.end());
      await new Promise<void>((resolve) => server.listen(live, resolve));
      await fs.chmod(live, 0o000);
      try {
        expect(
          await sweepOrphanSockets(dir, path.join(dir, '4194302.sock')),
        ).toBe(0);
        await expect(fs.stat(live)).resolves.toBeDefined();
      } finally {
        await fs.chmod(live, 0o600);
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'keeps a fallback directory whose probe could not reach a verdict',
    async () => {
      const parent = path.join(tmpDir, 'tmp');
      const dir = path.join(parent, `qwen-socks-${'a'.repeat(16)}`);
      await fs.mkdir(dir, { recursive: true });
      const live = path.join(dir, '4194303.sock');
      const server = net.createServer((socket) => socket.end());
      await new Promise<void>((resolve) => server.listen(live, resolve));
      await fs.chmod(live, 0o000);
      try {
        expect(
          await sweepOrphanSocketDirs(
            parent,
            path.join(parent, `qwen-socks-${'b'.repeat(16)}`),
          ),
        ).toBe(0);
        await expect(fs.stat(live)).resolves.toBeDefined();
      } finally {
        await fs.chmod(live, 0o600);
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it('removes dead-socket and old empty fallback directories, but keeps fresh empty directories', async () => {
    const parent = path.join(tmpDir, 'tmp');
    const nonce = (n: string) =>
      path.join(parent, `qwen-socks-${n.repeat(16)}`);
    const dead = nonce('a');
    const mixed = nonce('b');
    const freshEmpty = nonce('c');
    const own = nonce('d');
    const oldEmpty = nonce('e');
    for (const d of [dead, mixed, freshEmpty, own, oldEmpty])
      await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(dead, '4194303.sock'), '');
    await fs.writeFile(path.join(mixed, '4194303.sock'), '');
    await fs.writeFile(path.join(mixed, 'keep.txt'), '');
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(oldEmpty, old, old);
    await fs.mkdir(path.join(parent, 'qwen-socks-notanonce'));

    expect(await sweepOrphanSocketDirs(parent, own)).toBe(2);
    const left = await fs.readdir(parent);
    expect(left).toEqual(
      expect.arrayContaining([
        path.basename(mixed),
        path.basename(freshEmpty),
        path.basename(own),
        'qwen-socks-notanonce',
      ]),
    );
    expect(left).not.toContain(path.basename(dead));
    expect(left).not.toContain(path.basename(oldEmpty));
  });

  it('keeps a fallback directory with a listening absent-PID socket', async () => {
    const parent = await fs.mkdtemp('/tmp/qwen-inbox-sweep-');
    const liveDir = path.join(parent, `qwen-socks-${'a'.repeat(16)}`);
    const ownDir = path.join(parent, `qwen-socks-${'b'.repeat(16)}`);
    const live = path.join(liveDir, '4194303.sock');
    await fs.mkdir(liveDir, { recursive: true });
    await fs.mkdir(ownDir);
    const server = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(live, resolve));
    try {
      expect(await sweepOrphanSocketDirs(parent, ownDir)).toBe(0);
      await expect(fs.stat(live)).resolves.toBeDefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it('sweeps the shared runtime directory on bind', async () => {
    const runtime = path.join(tmpDir, 'runtime');
    const dir = path.join(runtime, 'qwen-socks');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '4194303.sock'), '');
    vi.stubEnv('XDG_RUNTIME_DIR', runtime);
    try {
      const started = await startPeerInbox({ onFrame: () => {} });
      if (!started) throw new Error('inbox failed to start');
      inbox = started;
      expect(path.dirname(started.socketPath)).toBe(dir);
      await settle();
      await expect(fs.stat(path.join(dir, '4194303.sock'))).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('sweeps fallback directories when binding through a fallback', async () => {
    const runtime = path.join(tmpDir, 'runtime');
    await fs.writeFile(runtime, 'not a directory');
    const temp = await fs.mkdtemp('/tmp/qwen-inbox-bind-');
    const stale = path.join(temp, `qwen-socks-${'a'.repeat(16)}`);
    await fs.mkdir(stale, { recursive: true });
    await fs.writeFile(path.join(stale, '4194303.sock'), '');
    vi.stubEnv('XDG_RUNTIME_DIR', runtime);
    vi.stubEnv('TMPDIR', temp);
    try {
      const started = await startPeerInbox({ onFrame: () => {} });
      if (!started) throw new Error('inbox failed to start');
      inbox = started;
      expect(path.dirname(path.dirname(started.socketPath))).toBe(temp);
      await settle();
      await expect(fs.stat(stale)).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(temp, { recursive: true, force: true });
    }
  });
});

describe.skipIf(isWindows)('PID-keyed path collisions', () => {
  /**
   * Stand in for a session in another PID namespace that resolved the
   * same path: a plain listener holding the address this process's PID
   * would pick.
   */
  async function occupy(socketPath: string): Promise<net.Server> {
    await fs.mkdir(path.dirname(socketPath), { recursive: true });
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    server.unref();
    return server;
  }

  it('binds a sibling name rather than unlinking a live listener', async () => {
    const taken = path.join(tmpDir, 'socks', '4242.sock');
    const squatter = await occupy(taken);
    try {
      const started = await startPeerInbox({
        socketPath: taken,
        onFrame: (frame) => received.push(frame),
      });
      if (!started) throw new Error('inbox failed to start');
      inbox = started;

      // Ours moved aside...
      expect(started.socketPath).not.toBe(taken);
      expect(path.basename(started.socketPath)).toMatch(
        /^4242-[0-9a-f]{8}\.sock$/,
      );
      expect(path.dirname(started.socketPath)).toBe(path.dirname(taken));

      // ...and the other session is still listening where it was. This is
      // the whole point: unlinking would have made it unreachable while
      // leaving it convinced it was fine.
      const stat = await fs.lstat(taken);
      expect(stat.isSocket()).toBe(true);
      await expect(connectRaw(taken)).resolves.toBeInstanceOf(net.Socket);

      // And the sibling is a working inbox.
      await sendPeerFrame(
        started.socketPath,
        buildUserFrame({ content: 'hello' }),
      );
      await settle();
      expect(received).toHaveLength(1);

      // Shut down inside the test rather than leaving it to afterEach:
      // close() unlinks whichever path it was handed, and handing it the
      // *requested* path would delete the live peer's socket while our
      // own sibling stayed on disk. Nothing observes that unless the
      // shutdown happens where it can be asserted.
      await started.close();
      inbox = null;
      await expect(fs.stat(started.socketPath)).rejects.toThrow();
      const afterClose = await fs.lstat(taken);
      expect(afterClose.isSocket()).toBe(true);
      await expect(connectRaw(taken)).resolves.toBeInstanceOf(net.Socket);
    } finally {
      squatter.close();
    }
  });

  it('retries at a sibling when the path is taken between the probe and the listen', async () => {
    // The raced-EADDRINUSE branch, which the probe branch above never
    // reaches. A directory standing where the socket belongs reproduces
    // that interleaving exactly and deterministically: connect() to it
    // gives ECONNREFUSED so the probe says dead, unlink() fails EISDIR
    // and is swallowed, and bind() then reports EADDRINUSE -- the same
    // sequence as a peer that grabbed the name inside the window.
    const taken = path.join(tmpDir, 'socks', '4242.sock');
    await fs.mkdir(taken, { recursive: true });

    const started = await startPeerInbox({
      socketPath: taken,
      onFrame: (frame) => received.push(frame),
    });

    expect(started).not.toBeNull();
    inbox = started;
    expect(getLastPeerInboxFailure()).toBeNull();
    // A sibling of the requested name, not the name itself.
    expect(started!.socketPath).not.toBe(taken);
    expect(path.basename(started!.socketPath)).toMatch(
      /^4242-[0-9a-f]{8}\.sock$/,
    );
    // And it is a working inbox, not merely a bound path.
    await sendPeerFrame(started!.socketPath, buildUserFrame({ content: 'hi' }));
    await settle();
    expect(received).toHaveLength(1);
  });

  it('falls through to the next candidate when the sibling would not fit', async (ctx) => {
    // Both path_too_long tests pass an explicit socketPath, so the
    // candidate list has exactly one entry and the fall-through is never
    // walked. Nothing today distinguishes "this candidate is impossible,
    // try the next" from "give up" -- inserting an early break on this
    // cause leaves the suite green while the session starts unreachable,
    // blaming a path length the user never set.
    const runtimeRoot = await fs.mkdtemp('/tmp/qs-rt-');
    const shortTmp = await fs.mkdtemp('/tmp/qs-tm-');
    // Pad the runtime dir so `<pid>.sock` lands inside sun_path but the
    // 9-byte sibling suffix would push it over.
    const suffix = path.join('qwen-socks', `${process.pid}.sock`);
    const target = 99;
    const padLength =
      target - Buffer.byteLength(path.join(runtimeRoot, 'x', suffix)) + 1;
    if (padLength < 1) {
      ctx.skip();
      return;
    }
    const runtime = path.join(runtimeRoot, 'p'.repeat(padLength));
    const taken = path.join(runtime, suffix);
    expect(Buffer.byteLength(taken)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
    expect(Buffer.byteLength(taken) + 9).toBeGreaterThan(MAX_SOCKET_PATH_BYTES);

    // A live peer holding the PID-keyed path, so the probe says alive and
    // a sibling is required -- but no sibling fits.
    const squatter = await occupy(taken);
    vi.stubEnv('XDG_RUNTIME_DIR', runtime);
    vi.stubEnv('TMPDIR', shortTmp);
    try {
      const started = await startPeerInbox({
        onFrame: (frame) => received.push(frame),
      });
      expect(started).not.toBeNull();
      inbox = started;
      // Candidate 1 was impossible; the session is reachable anyway.
      expect(started!.socketPath.startsWith(runtime)).toBe(false);
      expect(getLastPeerInboxFailure()).toBeNull();
      // And the live peer at candidate 1 was left alone.
      expect((await fs.lstat(taken)).isSocket()).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      squatter.close();
      await fs.rm(runtimeRoot, { recursive: true, force: true });
      await fs.rm(shortTmp, { recursive: true, force: true });
    }
  });

  it('reports a failure when a sibling name would not fit sun_path', async (ctx) => {
    // A directory long enough that `<pid>.sock` fits but the 9 extra
    // bytes of a sibling do not.
    //
    // The base is built under a literal `/tmp` rather than `tmpDir`: from
    // `os.tmpdir()` the padding goes negative once TMPDIR passes ~69
    // bytes, and the precondition below would then take the whole test
    // out on that machine. A short fixed root keeps the budget positive
    // everywhere.
    const root = await fs.mkdtemp('/tmp/qs-');
    const base = path.join(root, 'socks');
    const padding = 'p'.repeat(
      Math.max(
        0,
        MAX_SOCKET_PATH_BYTES - Buffer.byteLength(path.join(base, '4242.sock')),
      ),
    );
    const dir = base + padding;
    const taken = path.join(dir, '4242.sock');
    // A visible skip, not a silent `return`: the reporter cannot tell a
    // bare return from a pass, so a machine where this branch stopped
    // being exercised would look identical to one where it still is.
    if (Buffer.byteLength(taken) > MAX_SOCKET_PATH_BYTES) {
      ctx.skip();
      return;
    }
    const squatter = await occupy(taken);
    try {
      const started = await startPeerInbox({
        socketPath: taken,
        onFrame: () => {},
      });
      expect(started).toBeNull();
      expect(getLastPeerInboxFailure()?.cause).toBe('path_too_long');
      // The live listener is untouched either way.
      await expect(connectRaw(taken)).resolves.toBeInstanceOf(net.Socket);
    } finally {
      squatter.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('still clears a dead socket file rather than moving aside', async () => {
    const stale = path.join(tmpDir, 'socks', '4242.sock');
    await fs.mkdir(path.dirname(stale), { recursive: true });
    // A socket file with nothing behind it, which is what a kill -9
    // leaves: bind must reclaim the name, not multiply it.
    await fs.writeFile(stale, '');
    const started = await startPeerInbox({
      socketPath: stale,
      onFrame: () => {},
    });
    if (!started) throw new Error('inbox failed to start');
    inbox = started;
    expect(started.socketPath).toBe(stale);
  });

  it('sweeps a sibling-named socket whose process is dead', async () => {
    const dir = path.join(tmpDir, 'qwen-socks');
    await fs.mkdir(dir);
    // 2^22-1 is above the default pid_max on Linux, so nothing owns it.
    const deadSibling = path.join(dir, '4194303-0123abcd.sock');
    const liveSibling = path.join(dir, `${process.pid}-0123abcd.sock`);
    const malformed = path.join(dir, '4194303-XYZ.sock');
    for (const file of [deadSibling, liveSibling, malformed]) {
      await fs.writeFile(file, '');
    }

    await sweepOrphanSockets(dir, path.join(dir, `${process.pid}.sock`));

    await expect(fs.stat(deadSibling)).rejects.toThrow();
    await expect(fs.stat(liveSibling)).resolves.toBeDefined();
    await expect(fs.stat(malformed)).resolves.toBeDefined();
  });
});
