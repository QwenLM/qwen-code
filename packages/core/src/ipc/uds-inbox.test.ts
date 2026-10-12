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
  probePeerSocketVerdict,
  sendPeerFrame,
  PeerSendError,
  type SendPeerFrameOptions,
} from './uds-client.js';
import {
  MAX_SOCKET_PATH_BYTES,
  SOCKET_DIR_NAME,
  resolvePeerSocketCandidates,
} from './socket-path.js';
import {
  getLastPeerInboxFailure,
  describePeerInboxFailure,
  startPeerInbox,
  SWEEP_BATCH_SIZE,
  sweepOrphanSocketDirs,
  sweepOrphanSockets,
  type PeerConnectionAuth,
  type PeerInbox,
  type PeerInboxOptions,
} from './uds-inbox.js';
import type { PeerControllerIdentity } from './peer-controllers.js';
import { expectWithinLatencyBudget } from '../test-utils/latency-budget.js';
import { leaveStaleSocket } from '../test-utils/stale-socket.js';

/**
 * A PID no process can ever hold.
 *
 * `pid_max` is at most 2^22 on 64-bit Linux, so 4194303 -- used here
 * before -- is `pid_max - 1`: allocatable, and on a busy machine
 * eventually allocated, which would quietly turn "provably dead" fixtures
 * into live ones. 2^31-1 is above every `pid_max` the kernel accepts.
 */
const UNALLOCATABLE_PID = 2_147_483_647;

let tmpDir: string;
let inbox: PeerInbox | null = null;
let received: PeerFrame[];
let shortTmpDirs: string[] = [];

const isWindows = process.platform === 'win32';
const PEER = 'a'.repeat(64);
const CHILD = 'c'.repeat(64);

beforeEach(async () => {
  shortTmpDirs = [];
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
  await Promise.all(
    shortTmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

const sockAt = (name = 'a.sock') => path.join(tmpDir, 'socks', name);

/** Starts an inbox that must bind, handing it to afterEach to close. */
async function mustStart(options: PeerInboxOptions): Promise<PeerInbox> {
  const started = await startPeerInbox(options);
  if (!started) throw new Error('inbox failed to start');
  inbox = started;
  return started;
}

/** An inbox at socks/<name> that records every frame in `received`. */
function listen(
  name = 'a.sock',
  extra: Partial<PeerInboxOptions> = {},
): Promise<PeerInbox> {
  return mustStart({
    socketPath: sockAt(name),
    onFrame: (frame) => received.push(frame),
    ...extra,
  });
}

/** A bind attempt nothing reads frames from (usually expected to fail). */
const tryStart = (socketPath?: string) =>
  startPeerInbox({ socketPath, onFrame: () => {} });

const encoded = (content: string) =>
  encodePeerFrame(buildUserFrame({ content }));

const send = (
  socketPath: string,
  content: string,
  options?: SendPeerFrameOptions,
) => sendPeerFrame(socketPath, buildUserFrame({ content }), options);

const contents = () =>
  received.map((f) => (f as { message: { content: string } }).message.content);

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

/** Writes one raw payload the server may reset mid-write, then settles. */
async function writeTolerant(socketPath: string, payload: string) {
  await writeRaw(socketPath, [payload]).catch(() => {});
  await settle();
}

/** Open a raw connection the test drives one write at a time. */
function connectRaw(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: socketPath });
    socket.on('error', reject);
    socket.once('connect', () => resolve(socket));
  });
}

const whenClosed = (socket: net.Socket) =>
  new Promise<void>((resolve) => socket.once('close', () => resolve()));

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

async function waitForRemoval(target: string): Promise<void> {
  await vi.waitFor(
    async () => {
      await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    },
    { timeout: 2_000, interval: 10 },
  );
}

async function makeShortTmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(`/tmp/${prefix}`);
  shortTmpDirs.push(dir);
  return dir;
}

function stubDirs(runtime: string, tmp?: string): void {
  vi.stubEnv('XDG_RUNTIME_DIR', runtime);
  if (tmp !== undefined) vi.stubEnv('TMPDIR', tmp);
}

/**
 * Makes this process report a uid one above its real one. It moves the
 * comparison value rather than a directory's owner, so an ownership guard
 * fires whether or not the runner is root. `process.getuid` is optional in
 * the Node types (it does not exist on Windows), so it has to be narrowed
 * before `vi.spyOn` can type the mock. It mutates process-global state, so
 * callers restore it in `finally`.
 */
function spoofOtherUid() {
  const withUid = process as NodeJS.Process & { getuid: () => number };
  const uid = vi.spyOn(withUid, 'getuid');
  uid.mockReturnValue((process.getuid?.() ?? 0) + 1);
  return uid;
}

/** Asserts the recorded failure's cause and that its text names `texts`. */
function expectFailure(cause: string, ...texts: string[]) {
  const failure = getLastPeerInboxFailure();
  expect(failure?.cause).toBe(cause);
  for (const text of texts) {
    expect(describePeerInboxFailure(failure!)).toContain(text);
  }
  return failure;
}

async function serve(
  socketPath: string,
  server = net.createServer((socket) => socket.end()),
): Promise<net.Server> {
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
}

const closeServer = (server: net.Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

const absentPid = (dir: string) => path.join(dir, `${UNALLOCATABLE_PID}.sock`);
const nonce = (parent: string, ch: string) =>
  path.join(parent, `qwen-socks-${ch.repeat(16)}`);

describe.skipIf(isWindows)('startPeerInbox', () => {
  it('receives a frame written by the client', async () => {
    const started = await listen();
    await send(started.socketPath, 'hi');
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
    await leaveStaleSocket(path.join(dir, 'a.sock'));

    const started = await listen();
    await send(started.socketPath, 'hi');
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

    expect(await tryStart(sockAt())).toBeNull();
    // The planted directory is left exactly as it was.
    expect((await fs.stat(elsewhere)).mode & 0o777).toBe(0o755);
  });

  it('refuses a non-local path', async () => {
    expect(await tryStart('relative.sock')).toBeNull();
    expect(getLastPeerInboxFailure()).toMatchObject({
      cause: 'non_local',
      socketPath: 'relative.sock',
      attempts: 1,
    });
  });

  it('names the cause when the socket directory is not a directory', async () => {
    await fs.writeFile(path.join(tmpDir, 'socks'), 'a file');
    expect(await tryStart(sockAt())).toBeNull();
    expectFailure('not_directory', 'not a plain directory', 'XDG_RUNTIME_DIR');
  });

  it('includes the errno when a parent is not a directory', async () => {
    const broken = path.join(tmpDir, 'broken');
    await fs.writeFile(broken, 'a file');
    await tryStart(path.join(broken, 'socks', 'a.sock'));
    expectFailure('not_directory', 'ENOTDIR');
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
    for (const cause of ['chmod_failed', 'non_local'] as const) {
      expect(describePeerInboxFailure({ ...failure, cause })).toContain(
        failure.hint,
      );
    }
  });

  it('names the cause when a planted symlink sits where the directory should be', async () => {
    const elsewhere = path.join(tmpDir, 'elsewhere');
    await fs.mkdir(elsewhere);
    await fs.symlink(elsewhere, path.join(tmpDir, 'socks'));
    await tryStart(sockAt());
    expect(getLastPeerInboxFailure()?.cause).toBe('not_directory');
  });

  it('names the cause when the path is too long to bind', async () => {
    const long = path.join(tmpDir, 'x'.repeat(120), 'a.sock');
    expect(await tryStart(long)).toBeNull();
    expectFailure('path_too_long', 'shorter directory');
  });

  it.skipIf(process.getuid?.() === 0)(
    'names the cause when a parent directory is not writable',
    async () => {
      const locked = path.join(tmpDir, 'locked');
      await fs.mkdir(locked, { mode: 0o500 });
      await fs.chmod(locked, 0o500);
      expect(await tryStart(path.join(locked, 'socks', 'a.sock'))).toBeNull();
      expect(getLastPeerInboxFailure()?.cause).toBe('permission');
      await fs.chmod(locked, 0o700);
    },
  );

  it('clears the recorded failure once a bind succeeds', async () => {
    await tryStart('relative.sock');
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
    stubDirs(runtime, tmp);
    try {
      const started = await tryStart();
      expect(started).not.toBeNull();
      inbox = started;
      expect(started!.socketPath.startsWith(tmp + path.sep)).toBe(true);
      expect(getLastPeerInboxFailure()).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('blames the first candidate when every candidate fails', async () => {
    // The recorded failure keeps candidate 1's diagnosis -- the preferred
    // environment-derived path -- while `attempts` counts the rest. Report
    // the last one instead and the banner names a nonce directory this
    // process minted, which appears in no configuration and which the user
    // cannot act on, while the "Tried N candidate paths." sentence
    // disappears with it. Every other failure test hands in an explicit
    // socketPath, so the candidate list has one entry and this path through
    // `startPeerInbox` is never walked.
    const base = await makeShortTmpDir('qwen-inbox-blame-');
    const runtime = path.join(base, 'runtime-file');
    const tmp = path.join(base, 'tmp-file');
    await fs.writeFile(runtime, 'not a directory');
    await fs.writeFile(tmp, 'not a directory');
    stubDirs(runtime, tmp);
    // Candidates 1 and 2 fail at mkdir. Candidate 3 lives under a literal
    // `/tmp`, which exists and is writable, so the uid guard is what has
    // to turn it away.
    const uid = spoofOtherUid();
    try {
      const expected = resolvePeerSocketCandidates();
      expect(expected).toHaveLength(3);

      expect(await tryStart()).toBeNull();
      const failure = expectFailure('not_directory', 'Tried 3 candidate paths');
      expect(failure?.socketPath).toBe(expected[0]);
      expect(failure?.attempts).toBe(3);
    } finally {
      uid.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('refuses a socket directory another uid owns', async () => {
    // The uid guard is what stops the chmod below it from retargeting a
    // directory someone else planted in a shared temp dir, and it is
    // also what keeps "belongs to another user" distinguishable from
    // "this user cannot create or lock down" -- a broken rootless-
    // container mount versus a permission problem.
    const uid = spoofOtherUid();
    try {
      expect(await tryStart(sockAt())).toBeNull();
      expectFailure('foreign_owner', 'belongs to another user');
    } finally {
      uid.mockRestore();
    }
  });

  it('reports automatic Windows paths as an unsupported platform', async () => {
    const platform = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('win32');
    try {
      expect(await tryStart()).toBeNull();
      const failure = expectFailure(
        'unsupported_platform',
        'not available on this platform',
      );
      // A machine-level refusal is not a path that might have gone
      // better. Counting candidates here would send a user for whom no
      // path can ever work looking for a better one, with a number that
      // moves when XDG_RUNTIME_DIR is set.
      expect(failure?.attempts).toBe(1);
      expect(describePeerInboxFailure(failure!)).not.toContain('Tried');
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
    const line = encoded('split me');
    const mid = Math.floor(line.length / 2);
    await writeRaw(started.socketPath, [line.slice(0, mid), line.slice(mid)]);
    await settle();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ message: { content: 'split me' } });
  });

  it('splits several frames arriving in one write', async () => {
    const started = await listen();
    await writeRaw(started.socketPath, [encoded('one') + encoded('two')]);
    await settle();

    expect(contents()).toEqual(['one', 'two']);
  });

  it('keeps two concurrent senders from splicing into each other', async () => {
    const started = await listen();
    const a = encoded('aaa');
    const b = encoded('bbb');

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

    expect(contents().sort()).toEqual(['aaa', 'bbb']);
  });

  it('ignores blank lines', async () => {
    const started = await listen();
    await writeRaw(started.socketPath, ['\n\n   \n' + encoded('hi')]);
    await settle();
    expect(received).toHaveLength(1);
  });

  it('drops an unparseable line without killing the connection', async () => {
    const started = await listen();
    await writeRaw(started.socketPath, ['not json\n' + encoded('after')]);
    await settle();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ message: { content: 'after' } });
  });

  /** Writes `chunk` every 40 ms against a 120 ms line deadline. */
  async function expectHungUpWhileWriting(chunk: string) {
    const started = await listen('a.sock', { lineDeadlineMs: 120 });
    const socket = await connectRaw(started.socketPath);
    const closed = whenClosed(socket);
    const writer = setInterval(() => socket.write(chunk), 40);
    const start = Date.now();
    await closed;
    clearInterval(writer);
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(received).toHaveLength(0);
  }

  it('drops a connection that sends no complete line by the deadline, even if bytes trickle in', async () => {
    // One byte every 40 ms would reset an idle timer forever.
    await expectHungUpWhileWriting('x');
  });

  it('drops a connection held open by junk lines shorter than the deadline', async () => {
    // Complete lines, so the byte-dribble guard above does not apply, but
    // none of them parses. Two bytes every 40 ms would hold a connection
    // -- and one of the 64 maxConnections slots -- for the whole session
    // if an unparseable line re-armed the deadline.
    await expectHungUpWhileWriting('x\n');
  });

  it('re-arms the deadline from each complete line, not from each byte', async () => {
    const started = await listen('a.sock', { lineDeadlineMs: 400 });
    const socket = await connectRaw(started.socketPath);
    let open = true;
    socket.on('close', () => {
      open = false;
    });
    // Two whole frames 250 ms apart both land. At 450 ms after the first,
    // the connection is past its first deadline but still inside the one
    // the second frame armed.
    socket.write(encoded('one'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    socket.write(encoded('two'));
    await new Promise((resolve) => setTimeout(resolve, 200));
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
    const hungUp = whenClosed(socket);
    socket.write('x'.repeat(MAX_FRAME_BYTES + 1));
    await hungUp;
    expect(received).toHaveLength(0);

    // The inbox is still usable afterwards.
    await send(started.socketPath, 'ok');
    await settle();
    expect(received).toHaveLength(1);
  });

  it('does not let a throwing handler take down the server', async () => {
    const started = await listen('b.sock', {
      onFrame: () => {
        throw new Error('handler exploded');
      },
    });

    await expect(send(started.socketPath, 'boom')).resolves.toBeUndefined();
    await settle();
    // The server survived: a second frame is still accepted.
    await expect(send(started.socketPath, 'again')).resolves.toBeUndefined();
  });
});

describe.skipIf(isWindows)('inbox auth', () => {
  const TOKEN = 'a'.repeat(64);
  const auth = { authToken: TOKEN };
  const listenWithToken = (extra: Partial<PeerInboxOptions> = {}) =>
    listen('auth.sock', { requiredToken: TOKEN, ...extra });

  it('delivers a frame preceded by the right token', async () => {
    const started = await listenWithToken();
    await send(started.socketPath, 'hi', auth);
    await settle();
    expect(received).toHaveLength(1);
  });

  it('re-arms the deadline from the auth line, so a slow sender still lands', async () => {
    // Only progress re-arms the deadline, and presenting credentials is
    // progress: the sender has authenticated and still has its frame to
    // write. Without this re-arm the deadline runs from connect, and a
    // sender that pauses between the two lines is hung up on before its
    // frame arrives -- a legitimate peer dropped for being slow.
    const started = await listenWithToken({ lineDeadlineMs: 400 });
    const socket = await connectRaw(started.socketPath);
    await new Promise((resolve) => setTimeout(resolve, 250));
    socket.write(buildAuthLine(TOKEN));
    // 500 ms after connect: past the deadline armed at connect, inside
    // the one the auth line armed.
    await new Promise((resolve) => setTimeout(resolve, 250));
    socket.write(encoded('slow'));
    await settle();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ message: { content: 'slow' } });
    socket.end();
  });

  it('drops the connection on a wrong token, frames unread', async () => {
    const started = await listenWithToken();
    // The server may reset the connection mid-write.
    await writeTolerant(
      started.socketPath,
      buildAuthLine('b'.repeat(64)) + encoded('stolen'),
    );
    expect(received).toHaveLength(0);
  });

  it('drops a connection whose first line is a frame, not an auth line', async () => {
    const started = await listenWithToken();
    await writeTolerant(
      started.socketPath,
      encoded('unauthenticated') + buildAuthLine(TOKEN) + encoded('late auth'),
    );
    // Neither the pre-auth frame nor anything after the destroy arrives.
    expect(received).toHaveLength(0);
  });

  it('reads several frames after one auth line on the same connection', async () => {
    const started = await listenWithToken();
    await writeRaw(started.socketPath, [
      buildAuthLine(TOKEN) + encoded('one') + encoded('two'),
    ]);
    await settle();
    expect(contents()).toEqual(['one', 'two']);
  });

  it('drops a wrong-LENGTH token cleanly instead of throwing', async () => {
    // timingSafeEqual throws on differing lengths, so the byte-length
    // short-circuit in tokenMatches is the only thing keeping a truncated
    // QWEN_CODE_MESSAGING_TOKEN a clean fail-closed refusal rather than an
    // exception inside the line reader.
    const started = await listenWithToken();
    await writeTolerant(
      started.socketPath,
      buildAuthLine('a'.repeat(32)) + encoded('short token'),
    );
    expect(received).toHaveLength(0);
    // The inbox is still serving: the refusal was per-connection.
    await send(started.socketPath, 'ok', auth);
    await settle();
    expect(received).toHaveLength(1);
  });

  it('does not let one connection refusal brick the inbox', async () => {
    // Were `refused` hoisted out of the per-connection closure, a single
    // unauthenticated connection — a pre-token build's send, which is only
    // meant to be dropped — would silently kill the inbox for the rest of
    // the session.
    const started = await listenWithToken();
    await writeTolerant(started.socketPath, encoded('unauthenticated'));
    expect(received).toHaveLength(0);

    await send(started.socketPath, 'after the refusal', auth);
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
    await send(started.socketPath, 'authenticated', auth);
    await settle();
    expect(received).toHaveLength(1);

    await writeTolerant(started.socketPath, encoded('riding on the last auth'));
    expect(received).toHaveLength(1);
  });

  it('an inbox without a required token skips a leading auth line', async () => {
    // The old-receiver case: a sender always leads with the auth line
    // when it has a token, and a pre-token inbox must read past it.
    const started = await listen();
    await send(started.socketPath, 'hi', auth);
    await settle();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ message: { content: 'hi' } });
  });
});

describe.skipIf(isWindows)('client errors', () => {
  /** A hand-rolled peer at socks/<name>; `stop` drops its connections. */
  async function rawPeer(
    name: string,
    onConnection: (conn: net.Socket) => void,
    options: net.ServerOpts = {},
  ) {
    const socketPath = sockAt(name);
    await fs.mkdir(path.dirname(socketPath), { recursive: true });
    const conns: net.Socket[] = [];
    const server = await serve(
      socketPath,
      net.createServer(options, (conn) => {
        conns.push(conn);
        onConnection(conn);
      }),
    );
    const stop = async () => {
      for (const conn of conns) conn.destroy();
      await closeServer(server);
    };
    return { socketPath, stop };
  }

  it('reports ENOENT for a socket that does not exist', async () => {
    await expect(
      send(path.join(tmpDir, 'nope.sock'), 'hi'),
    ).rejects.toMatchObject({ name: 'PeerSendError', code: 'ENOENT' });
  });

  it('reports ECONNREFUSED for a stale socket file', async () => {
    const started = await listen();
    const socketPath = started.socketPath;
    // Recreate the closed server as a crashed session's stale socket inode.
    await started.close();
    inbox = null;
    await leaveStaleSocket(socketPath);

    await expect(send(socketPath, 'hi')).rejects.toBeInstanceOf(PeerSendError);
  });

  it('refuses a non-local path before dialing', async () => {
    await expect(send('relative.sock', 'hi')).rejects.toMatchObject({
      name: 'PeerSendError',
    });
  });

  it('refuses a frame the receiver would drop for being too long', async () => {
    const started = await listen();
    await expect(
      send(started.socketPath, 'x'.repeat(MAX_FRAME_BYTES)),
    ).rejects.toMatchObject({ name: 'PeerSendError', code: 'EMSGSIZE' });
    await settle();
    expect(received).toHaveLength(0);
  });

  it('gives up on a peer that dribbles bytes back instead of closing', async () => {
    // Accepts, drains the frame, then writes one byte at a time and
    // never closes (half-open, so the client's FIN does not end it).
    // socket.setTimeout would treat every byte as activity and never
    // fire; the deadline must not.
    const peer = await rawPeer(
      'dribble.sock',
      (conn) => {
        conn.resume();
        const drip = setInterval(() => conn.write('b'), 100);
        conn.on('close', () => clearInterval(drip));
      },
      { allowHalfOpen: true },
    );
    try {
      const startedAt = Date.now();
      await expect(
        send(peer.socketPath, 'hi', { timeoutMs: 500 }),
      ).rejects.toMatchObject({ name: 'PeerSendError', code: 'ETIMEDOUT' });
      expectWithinLatencyBudget(Date.now() - startedAt, 3000);
    } finally {
      await peer.stop();
    }
  });

  it('drops sends beyond the concurrent cap instead of opening unbounded connections', async () => {
    // Accepts but never services anything: each dial holds its send slot
    // until the deadline, the way a peer that accepts and stalls holds a
    // receipt connection open.
    const peer = await rawPeer('stall.sock', (conn) => conn.pause());
    try {
      const pending: Array<Promise<void>> = [];
      for (let i = 0; i < MAX_CONCURRENT_SENDS; i += 1) {
        pending.push(
          send(peer.socketPath, 'hi', { timeoutMs: 1000 }).catch(() => {}),
        );
      }
      await expect(
        send(peer.socketPath, 'hi', { timeoutMs: 1000 }),
      ).rejects.toMatchObject({ name: 'PeerSendError', code: 'EBUSY' });
      await Promise.all(pending);
    } finally {
      await peer.stop();
    }
  });
});

describe.skipIf(isWindows)('child token', () => {
  let admitted: Array<PeerConnectionAuth | undefined>;

  beforeEach(() => {
    admitted = [];
  });

  function listenWithBoth(
    tokens: { requiredToken?: string; childToken?: string } = {
      requiredToken: PEER,
      childToken: CHILD,
    },
  ): Promise<PeerInbox> {
    return listen('child.sock', {
      ...tokens,
      onFrame: (frame, auth) => {
        received.push(frame);
        admitted.push(auth);
      },
    });
  }

  it('admits either token and reports which one it was', async () => {
    const started = await listenWithBoth();
    await send(started.socketPath, 'p', { authToken: PEER });
    await send(started.socketPath, 'c', { authToken: CHILD });
    await settle();
    expect(contents()).toEqual(['p', 'c']);
    expect(admitted).toEqual(['peer', 'child']);
  });

  it('holds the verdict for every frame on the connection', async () => {
    // The kind is decided once per connection, at the auth line, and
    // cannot be re-negotiated by a later line.
    const started = await listenWithBoth();
    await writeRaw(started.socketPath, [
      buildAuthLine(CHILD) +
        encoded('one') +
        buildAuthLine(PEER) +
        encoded('two'),
    ]);
    await settle();
    // The second auth line is an unparseable frame, skipped like any other.
    expect(received).toHaveLength(2);
    expect(admitted).toEqual(['child', 'child']);
  });

  it('still refuses a token that is neither', async () => {
    const started = await listenWithBoth();
    await writeTolerant(
      started.socketPath,
      buildAuthLine('b'.repeat(64)) + encoded('neither'),
    );
    expect(received).toHaveLength(0);
  });

  it('means nothing without a required token', async () => {
    // A child token on an open inbox would be a third state — "admitted,
    // but not by a token we asked for" — with no consumer. It is inert.
    const started = await listenWithBoth({ childToken: CHILD });
    await send(started.socketPath, 'x', { authToken: CHILD });
    await send(started.socketPath, 'y');
    await settle();
    expect(received).toHaveLength(2);
    expect(admitted).toEqual([undefined, undefined]);
  });
});

describe.skipIf(isWindows)('controller grants', () => {
  const GRANT = 'qpc_' + 'd'.repeat(64);
  const IDENTITY = { id: 'c_0123abcd', label: 'voice bridge' };
  const grantOnly = (presented: string) =>
    presented === GRANT ? IDENTITY : undefined;
  let admitted: Array<PeerConnectionAuth | undefined>;
  let controllers: Array<PeerControllerIdentity | undefined>;

  beforeEach(() => {
    admitted = [];
    controllers = [];
  });

  const record: PeerInboxOptions['onFrame'] = (frame, auth, controller) => {
    received.push(frame);
    admitted.push(auth);
    controllers.push(controller);
  };

  const listenWithController = (
    resolveController?: PeerInboxOptions['resolveController'],
    lineDeadlineMs?: number,
  ) =>
    listen('controller.sock', {
      requiredToken: PEER,
      childToken: CHILD,
      resolveController,
      lineDeadlineMs,
      onFrame: record,
    });

  it('admits a granted token and names the grant', async () => {
    const started = await listenWithController(grantOnly);
    await send(started.socketPath, 'g', { authToken: GRANT });
    await settle();
    expect(received).toHaveLength(1);
    expect(admitted).toEqual(['controller']);
    expect(controllers).toEqual([IDENTITY]);
  });

  it("names no grant for this session's own tokens", async () => {
    const started = await listenWithController(() => IDENTITY);
    await send(started.socketPath, 'p', { authToken: PEER });
    await send(started.socketPath, 'c', { authToken: CHILD });
    await settle();
    // A resolver that says yes to everything must not re-label a
    // connection this session can already account for precisely.
    expect(admitted).toEqual(['peer', 'child']);
    expect(controllers).toEqual([undefined, undefined]);
  });

  it('holds the grant for every frame on the connection', async () => {
    const resolver = vi.fn(grantOnly);
    const started = await listenWithController(resolver);
    await writeRaw(started.socketPath, [
      buildAuthLine(GRANT) + encoded('one') + encoded('two'),
    ]);
    await settle();
    expect(received).toHaveLength(2);
    expect(admitted).toEqual(['controller', 'controller']);
    expect(controllers).toEqual([IDENTITY, IDENTITY]);
    expect(resolver).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledWith(GRANT);
  });

  it('drops an open controller connection after its grant is revoked', async () => {
    let granted = true;
    const resolver = vi.fn((presented: string) =>
      presented === GRANT && granted ? IDENTITY : undefined,
    );
    const started = await listenWithController(resolver, 120);
    const socket = await connectRaw(started.socketPath);
    const closed = whenClosed(socket);

    socket.write(buildAuthLine(GRANT) + encoded('before'));
    await settle();
    granted = false;
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.write(encoded('within-window'));
    await settle();
    await closed;

    expect(contents()).toEqual(['before', 'within-window']);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(resolver).toHaveBeenLastCalledWith(GRANT);
  });

  it('drops a connection whose token no grant resolves', async () => {
    const started = await listenWithController(() => undefined);
    await writeTolerant(
      started.socketPath,
      buildAuthLine(GRANT) + encoded('no grant'),
    );
    expect(received).toHaveLength(0);
  });

  it('treats a throwing resolver as "not a controller"', async () => {
    // The resolver reads a file the user can edit at any moment, so it
    // can fail for reasons unrelated to the token. A failure must not
    // admit the connection, and must not take the inbox down with it.
    const started = await listenWithController(() => {
      throw new Error('registry on fire');
    });
    await writeRaw(started.socketPath, [
      buildAuthLine(GRANT) + encoded('x'),
    ]).catch(() => {});
    await send(started.socketPath, 'p', { authToken: PEER });
    await settle();
    expect(contents()).toEqual(['p']);
    expect(admitted).toEqual(['peer']);
  });

  it('means nothing without a required token', async () => {
    const started = await listen('open.sock', {
      resolveController: () => IDENTITY,
      onFrame: record,
    });
    await send(started.socketPath, 'x', { authToken: GRANT });
    await settle();
    expect(received).toHaveLength(1);
    expect(admitted).toEqual([undefined]);
    expect(controllers).toEqual([undefined]);
  });
});

describe.skipIf(isWindows)('orphan socket sweeps', () => {
  async function socksDir(): Promise<string> {
    const dir = path.join(tmpDir, 'qwen-socks');
    await fs.mkdir(dir);
    return dir;
  }

  /** The path a sweep treats as this session's own socket. */
  const ownSock = (dir: string) =>
    path.join(dir, `${UNALLOCATABLE_PID - 1}.sock`);

  /** `locked` makes the listener undialable, so the probe gets no verdict. */
  async function expectListenerKept(
    live: string,
    sweep: () => Promise<number>,
    locked = false,
  ) {
    const server = await serve(live);
    if (locked) await fs.chmod(live, 0o000);
    try {
      expect(await sweep()).toBe(0);
      await expect(fs.stat(live)).resolves.toBeDefined();
    } finally {
      if (locked) await fs.chmod(live, 0o600);
      await closeServer(server);
    }
  }

  it('removes sockets whose process is provably dead and keeps the rest', async () => {
    const dir = await socksDir();
    const dead = absentPid(dir);
    const live = path.join(dir, `${process.pid}.sock`);
    const self = ownSock(dir);
    const foreign = path.join(dir, 'notes.sock');
    await leaveStaleSocket(dead);
    for (const file of [live, self, foreign]) await fs.writeFile(file, '');

    expect(await sweepOrphanSockets(dir, self)).toBe(1);
    expect(await fs.readdir(dir)).toEqual(
      expect.arrayContaining([
        'notes.sock',
        `${process.pid}.sock`,
        path.basename(self),
      ]),
    );
    await expect(fs.stat(dead)).rejects.toThrow();
  });

  it('sweeps every batch when more than one batch of dead sockets accumulates', async () => {
    const dir = await socksDir();
    // Sized from the constant so the fixture spans two batches however
    // the fd-pressure knob is tuned.
    const firstPid = 2_147_483_000;
    const sockets = Array.from({ length: SWEEP_BATCH_SIZE + 4 }, (_, index) =>
      path.join(dir, `${firstPid + index}.sock`),
    );
    await Promise.all(sockets.map((socket) => leaveStaleSocket(socket)));

    // Below the fixture range, not inside it: a self path that lands on
    // one of the fixtures is skipped as this session's own socket, and
    // the count then comes up one short for a reason that has nothing to
    // do with batching. That happens once SWEEP_BATCH_SIZE is tuned past
    // the gap the fixture leaves.
    const selfPath = path.join(dir, `${firstPid - 1}.sock`);
    expect(sockets).not.toContain(selfPath);

    expect(await sweepOrphanSockets(dir, selfPath)).toBe(sockets.length);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('leaves a fallback directory another uid owns', async () => {
    // The guard that stops this sweep from reaching into a directory
    // someone else minted in a shared temp dir. Nothing exercised it:
    // removing it left the whole suite green while the sweep deleted
    // another user's sockets and their directory.
    const parent = path.join(tmpDir, 'tmp');
    const theirs = nonce(parent, 'a');
    await fs.mkdir(theirs, { recursive: true });
    await fs.writeFile(absentPid(theirs), '');
    const uid = spoofOtherUid();
    try {
      expect(
        await sweepOrphanSocketDirs(parent, path.join(parent, 'self')),
      ).toBe(0);
      await expect(fs.stat(theirs)).resolves.toBeDefined();
    } finally {
      uid.mockRestore();
    }
  });

  it('sweeps every batch when more than one batch of fallback directories accumulates', async () => {
    // One nonce directory per crashed session: 17+ of them span two
    // batches, and only a loop that visits every batch clears them all.
    const parent = await makeShortTmpDir('qwen-inbox-batches-');
    const ownDir = nonce(parent, 'f');
    await fs.mkdir(ownDir);
    const dirs = Array.from({ length: SWEEP_BATCH_SIZE + 4 }, (_, index) =>
      path.join(parent, `qwen-socks-${index.toString(16).padStart(16, '0')}`),
    );
    await Promise.all(
      dirs.map(async (dir, index) => {
        await fs.mkdir(dir);
        await leaveStaleSocket(path.join(dir, `${2_147_483_000 + index}.sock`));
      }),
    );

    expect(await sweepOrphanSocketDirs(parent, ownDir)).toBe(dirs.length);
    const left = await fs.readdir(parent);
    expect(
      left.filter((name) => /^qwen-socks-[0-9a-f]{16}$/.test(name)),
    ).toEqual([path.basename(ownDir)]);
  });

  it('keeps a listening socket even when its filename PID is absent', async () => {
    const dir = await socksDir();
    await expectListenerKept(absentPid(dir), () =>
      sweepOrphanSockets(dir, ownSock(dir)),
    );
  });

  // Mode 000 makes connect() fail EACCES, which is a real inconclusive
  // probe: the listener below is up and answers anyone permitted to dial
  // it. The existing "keeps a listening socket even when its filename PID
  // is absent" pins only the case where the probe reaches a definitive
  // answer, and stays green whether or not `unknown` is honoured.
  it.skipIf(process.getuid?.() === 0)(
    'keeps a socket whose probe could not reach a verdict',
    async () => {
      const dir = await socksDir();
      // `isPidAlive` reports dead for it -- which is also what it reports
      // for a live PID from another namespace. The probe is the only
      // thing left between this file and the unlink.
      await expectListenerKept(
        absentPid(dir),
        () => sweepOrphanSockets(dir, ownSock(dir)),
        true,
      );
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'keeps a fallback directory whose probe could not reach a verdict',
    async () => {
      const parent = await makeShortTmpDir('qwen-inbox-unknown-');
      const dir = nonce(parent, 'a');
      await fs.mkdir(dir, { recursive: true });
      await expectListenerKept(
        absentPid(dir),
        () => sweepOrphanSocketDirs(parent, nonce(parent, 'b')),
        true,
      );
    },
  );

  it('removes dead-socket and old empty fallback directories, but keeps fresh empty directories', async () => {
    const parent = await makeShortTmpDir('qwen-inbox-dirs-');
    const dead = nonce(parent, 'a');
    const mixed = nonce(parent, 'b');
    const freshEmpty = nonce(parent, 'c');
    const own = nonce(parent, 'd');
    const oldEmpty = nonce(parent, 'e');
    for (const d of [dead, mixed, freshEmpty, own, oldEmpty])
      await fs.mkdir(d, { recursive: true });
    await leaveStaleSocket(absentPid(dead));
    await fs.writeFile(absentPid(mixed), '');
    await fs.writeFile(path.join(mixed, 'keep.txt'), '');
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(oldEmpty, old, old);

    // Each of the three survivors below must survive for exactly one
    // reason, or a deleted guard is invisible. Freshly-created empty
    // directories are kept by the 60-second grace whatever else is
    // removed, so every one of them is aged past it first.

    // (a) Kept only by the name-shape filter. Without it, the sweep
    // considers every entry of `parent` -- which in production is
    // os.tmpdir() or literally /tmp -- and any aged empty directory the
    // user owns falls through to rmdir.
    const notANonce = path.join(parent, 'qwen-socks-notanonce');
    await fs.mkdir(notANonce);
    await fs.utimes(notANonce, old, old);

    // (b) Kept only by the self-exclusion: aged, correctly named, and
    // holding nothing but a provably dead socket, so every other guard
    // would let it go.
    await fs.writeFile(absentPid(own), '');
    await fs.utimes(own, old, old);

    // (c) Kept only by the PID liveness check: a socket file named for
    // this live process, with nothing listening on it -- so the probe
    // says dead and only `isPidAlive` stands in the way.
    const liveNamed = nonce(parent, 'f');
    await fs.mkdir(liveNamed, { recursive: true });
    await fs.writeFile(path.join(liveNamed, `${process.pid}.sock`), '');
    await fs.utimes(liveNamed, old, old);

    expect(await sweepOrphanSocketDirs(parent, own)).toBe(2);
    const left = await fs.readdir(parent);
    expect(left).toEqual(
      expect.arrayContaining([
        path.basename(mixed),
        path.basename(freshEmpty),
        path.basename(own),
        path.basename(liveNamed),
        'qwen-socks-notanonce',
      ]),
    );
    expect(left).not.toContain(path.basename(dead));
    expect(left).not.toContain(path.basename(oldEmpty));
  });

  it('keeps a fallback directory with a listening absent-PID socket', async () => {
    const parent = await makeShortTmpDir('qwen-inbox-sweep-');
    const liveDir = nonce(parent, 'a');
    const ownDir = nonce(parent, 'b');
    await fs.mkdir(liveDir, { recursive: true });
    await fs.mkdir(ownDir);
    await expectListenerKept(absentPid(liveDir), () =>
      sweepOrphanSocketDirs(parent, ownDir),
    );
  });

  it('sweeps the shared runtime directory on bind', async () => {
    const runtime = path.join(tmpDir, 'runtime');
    const dir = path.join(runtime, 'qwen-socks');
    await fs.mkdir(dir, { recursive: true });
    await leaveStaleSocket(absentPid(dir));
    stubDirs(runtime);
    try {
      const started = await tryStart();
      if (!started) throw new Error('inbox failed to start');
      inbox = started;
      expect(path.dirname(started.socketPath)).toBe(dir);
      await waitForRemoval(absentPid(dir));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('sweeps fallback directories even when the runtime candidate wins', async () => {
    const runtime = path.join(tmpDir, 'runtime');
    const temp = await makeShortTmpDir('qwen-inbox-losing-candidate-');
    const stale = nonce(temp, 'a');
    await fs.mkdir(stale, { recursive: true });
    await leaveStaleSocket(absentPid(stale));
    stubDirs(runtime, temp);
    try {
      const started = await tryStart();
      if (!started) throw new Error('inbox failed to start');
      inbox = started;
      expect(path.dirname(started.socketPath)).toBe(
        path.join(runtime, SOCKET_DIR_NAME),
      );
      await waitForRemoval(stale);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('sweeps only the directory shapes this code mints', async () => {
    // The sweep is scoped by directory name -- `qwen-socks/` and the
    // nonce directories -- and nothing pinned that. An explicit
    // socketPath can point anywhere, and a stale `<pid>.sock` sitting
    // beside it belongs to whoever put it there; without the guard a
    // bind deletes files out of a directory this code never created.
    //
    // The control binds into a directory the guard does admit, with the
    // same fixture and the same wait, so a wait too short to observe any
    // sweep at all cannot pass this test by doing nothing.
    const foreign = path.join(tmpDir, 'my-sockets');
    const mine = path.join(tmpDir, 'qwen-socks');
    await fs.mkdir(foreign);
    await fs.mkdir(mine);
    const untouched = absentPid(foreign);
    const swept = absentPid(mine);
    await leaveStaleSocket(untouched);
    await leaveStaleSocket(swept);

    const outside = await tryStart(path.join(foreign, 'a.sock'));
    const insideDir = await tryStart(path.join(mine, 'b.sock'));
    if (!outside || !insideDir) throw new Error('inbox failed to start');
    inbox = insideDir;
    try {
      await waitForRemoval(swept);
      await expect(fs.stat(untouched)).resolves.toBeDefined();
    } finally {
      await outside.close();
    }
  });

  it('sweeps fallback directories when binding through a fallback', async () => {
    const runtime = path.join(tmpDir, 'runtime');
    await fs.writeFile(runtime, 'not a directory');
    const temp = await fs.mkdtemp('/tmp/qwen-inbox-bind-');
    const stale = nonce(temp, 'a');
    await fs.mkdir(stale, { recursive: true });
    await leaveStaleSocket(absentPid(stale));
    stubDirs(runtime, temp);
    try {
      const started = await tryStart();
      if (!started) throw new Error('inbox failed to start');
      inbox = started;
      expect(path.dirname(path.dirname(started.socketPath))).toBe(temp);
      await waitForRemoval(stale);
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

  /**
   * `4242.sock` in a directory padded so the name fits sun_path but the 9
   * extra bytes of a sibling do not. The root is a literal `/tmp` rather
   * than `tmpDir`: from `os.tmpdir()` the padding goes negative once TMPDIR
   * passes ~69 bytes, and the fits-precondition would then take the test
   * out on that machine. A short fixed root keeps the budget positive.
   */
  async function paddedTaken() {
    const root = await fs.mkdtemp('/tmp/qs-');
    const base = path.join(root, 'socks');
    const padding = 'p'.repeat(
      Math.max(
        0,
        MAX_SOCKET_PATH_BYTES - Buffer.byteLength(path.join(base, '4242.sock')),
      ),
    );
    return { root, taken: path.join(base + padding, '4242.sock') };
  }

  function expectSibling(socketPath: string, taken: string) {
    expect(socketPath).not.toBe(taken);
    expect(path.basename(socketPath)).toMatch(/^4242-[0-9a-f]{8}\.sock$/);
  }

  async function expectStillListening(taken: string) {
    expect((await fs.lstat(taken)).isSocket()).toBe(true);
    await expect(connectRaw(taken)).resolves.toBeInstanceOf(net.Socket);
  }

  it('binds a sibling name rather than unlinking a live listener', async () => {
    const taken = sockAt('4242.sock');
    const squatter = await occupy(taken);
    try {
      const started = await listen('4242.sock');

      // Ours moved aside...
      expectSibling(started.socketPath, taken);
      expect(path.dirname(started.socketPath)).toBe(path.dirname(taken));

      // ...and the other session is still listening where it was. This is
      // the whole point: unlinking would have made it unreachable while
      // leaving it convinced it was fine.
      await expectStillListening(taken);

      // And the sibling is a working inbox.
      await send(started.socketPath, 'hello');
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
      await expectStillListening(taken);
    } finally {
      squatter.close();
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    'binds a sibling when the requested path cannot be verified free',
    async () => {
      const taken = sockAt('4242.sock');
      const squatter = await occupy(taken);
      await fs.chmod(taken, 0o000);
      try {
        expect(await probePeerSocketVerdict(taken)).toBe('unknown');
        const started = await listen('4242.sock', { onFrame: () => {} });
        expectSibling(started.socketPath, taken);
        await expect(fs.stat(taken)).resolves.toBeDefined();
      } finally {
        await fs.chmod(taken, 0o600);
        squatter.close();
      }
    },
  );

  it('retries at a sibling when the path is taken between the probe and the listen', async () => {
    // The raced-EADDRINUSE branch, which the probe branch above never
    // reaches. A directory standing where the socket belongs reproduces
    // that interleaving exactly and deterministically: connect() to it
    // gives ECONNREFUSED so the probe says dead, unlink() fails EISDIR
    // and is swallowed, and bind() then reports EADDRINUSE -- the same
    // sequence as a peer that grabbed the name inside the window.
    const taken = sockAt('4242.sock');
    await fs.mkdir(taken, { recursive: true });

    const started = await startPeerInbox({
      socketPath: taken,
      onFrame: (frame) => received.push(frame),
    });

    expect(started).not.toBeNull();
    inbox = started;
    expect(getLastPeerInboxFailure()).toBeNull();
    // A sibling of the requested name, not the name itself.
    expectSibling(started!.socketPath, taken);
    // And it is a working inbox, not merely a bound path.
    await send(started!.socketPath, 'hi');
    await settle();
    expect(received).toHaveLength(1);
  });

  it('reports a sibling overflow when the race lands on an unpadded name', async (ctx) => {
    // The raced ordering AND a sibling that will not fit: the one
    // combination neither existing test reaches. Both sibling-overflow
    // tests use a live squatter, which takes the pre-bind probe branch,
    // and the raced test above uses a geometry where the sibling fits.
    // Without the early return this falls through `classify` -- which has
    // no EADDRINUSE case -- to `bind_failed`, telling the user to restart
    // after a process that will never exit, when the blocker is a name
    // length.
    //
    // Same directory-in-the-socket's-place trick as the test above, in
    // the padded geometry.
    const { root, taken } = await paddedTaken();
    // A visible skip rather than a bare return, for the same reason as
    // the sibling-overflow test below: a machine where the geometry
    // stopped holding must not look like a pass.
    ctx.skip(Buffer.byteLength(taken) > MAX_SOCKET_PATH_BYTES);
    expect(Buffer.byteLength(taken) + 9).toBeGreaterThan(MAX_SOCKET_PATH_BYTES);
    await fs.mkdir(taken, { recursive: true });
    try {
      expect(await tryStart(taken)).toBeNull();
      const failure = expectFailure(
        'sibling_too_long',
        'in use or could not be verified free',
      );
      expect(failure?.socketPath).toBe(taken);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
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
    const suffix = path.join(SOCKET_DIR_NAME, `${process.pid}.sock`);
    const target = 99;
    const padLength =
      target - Buffer.byteLength(path.join(runtimeRoot, 'x', suffix)) + 1;
    ctx.skip(padLength < 1);
    const runtime = path.join(runtimeRoot, 'p'.repeat(padLength));
    const taken = path.join(runtime, suffix);
    expect(Buffer.byteLength(taken)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
    expect(Buffer.byteLength(taken) + 9).toBeGreaterThan(MAX_SOCKET_PATH_BYTES);

    // A live peer holding the PID-keyed path, so the probe says alive and
    // a sibling is required -- but no sibling fits.
    const squatter = await occupy(taken);
    stubDirs(runtime, shortTmp);
    try {
      // Everything below is only a test of the fall-through while the
      // padded path really is candidate 1. Let the directory name grow by
      // five bytes and the pre-bind length filter drops it before any
      // bind is attempted -- the inbox then binds the TMPDIR candidate
      // first, every assertion here still passes, and the only guard
      // against an early `break` on `sibling_too_long` is silently gone.
      // `resolvePeerSocketCandidates` reads the environment when called,
      // so this has to run after the stubs above.
      expect(resolvePeerSocketCandidates()[0]).toBe(taken);

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
    const { root, taken } = await paddedTaken();
    // A visible skip, not a silent `return`: the reporter cannot tell a
    // bare return from a pass, so a machine where this branch stopped
    // being exercised would look identical to one where it still is.
    ctx.skip(Buffer.byteLength(taken) > MAX_SOCKET_PATH_BYTES);
    const squatter = await occupy(taken);
    try {
      expect(await tryStart(taken)).toBeNull();
      // Not the path_too_long sentence: this path fits, and claiming
      // otherwise is something the user can measure and disprove.
      const failure = expectFailure(
        'sibling_too_long',
        'in use or could not be verified free',
      );
      expect(describePeerInboxFailure(failure!)).not.toMatch(
        /^"[^"]+" is longer than/,
      );
      // The live listener is untouched either way.
      await expect(connectRaw(taken)).resolves.toBeInstanceOf(net.Socket);
    } finally {
      squatter.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    'reports sibling overflow when the requested path cannot be verified free',
    async (ctx) => {
      const { root, taken } = await paddedTaken();
      ctx.skip(Buffer.byteLength(taken) > MAX_SOCKET_PATH_BYTES);
      expect(Buffer.byteLength(taken) + 9).toBeGreaterThan(
        MAX_SOCKET_PATH_BYTES,
      );
      const squatter = await occupy(taken);
      await fs.chmod(taken, 0o000);
      try {
        expect(await probePeerSocketVerdict(taken)).toBe('unknown');
        expect(await tryStart(taken)).toBeNull();
        expectFailure(
          'sibling_too_long',
          'in use or could not be verified free',
        );
      } finally {
        await fs.chmod(taken, 0o600);
        squatter.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it('still clears a dead socket file rather than moving aside', async () => {
    const stale = sockAt('4242.sock');
    await fs.mkdir(path.dirname(stale), { recursive: true });
    // A socket file with nothing behind it, which is what a kill -9
    // leaves: bind must reclaim the name, not multiply it.
    await leaveStaleSocket(stale);
    const started = await listen('4242.sock', { onFrame: () => {} });
    expect(started.socketPath).toBe(stale);
  });

  it('sweeps a sibling-named socket whose process is dead', async () => {
    const dir = path.join(tmpDir, 'qwen-socks');
    await fs.mkdir(dir);
    const deadSibling = path.join(dir, `${UNALLOCATABLE_PID}-0123abcd.sock`);
    const liveSibling = path.join(dir, `${process.pid}-0123abcd.sock`);
    const malformed = path.join(dir, `${UNALLOCATABLE_PID}-XYZ.sock`);
    await leaveStaleSocket(deadSibling);
    for (const file of [liveSibling, malformed]) await fs.writeFile(file, '');

    await sweepOrphanSockets(dir, path.join(dir, `${process.pid}.sock`));

    await expect(fs.stat(deadSibling)).rejects.toThrow();
    await expect(fs.stat(liveSibling)).resolves.toBeDefined();
    await expect(fs.stat(malformed)).resolves.toBeDefined();
  });
});
