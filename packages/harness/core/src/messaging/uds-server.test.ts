/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Socket path resolution, socket directory verification, and frame splitting.
 *
 * The first two concern where a session is willing to bind, which the default
 * base being world-writable makes a question worth testing directly. The third
 * is tested here rather than end-to-end because it is about which bytes arrive
 * together, and a real socket chunks however the kernel feels like. Message
 * delivery over a bound socket lives in `uds-messaging.integration.test.ts`.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import type * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENV_MESSAGING_SELF_TOKEN, ENV_PRODUCT_HOME } from '../config/brand.js';
import { buildCrossSessionEnvelope } from './cross-session-envelope.js';
import {
  _resetInboundPolicyForTest,
  listHeldMessages,
  setCrossSessionInboundResolver,
  setPermissionModeGetter,
} from './inbound-policy.js';
import { toUdsAddress } from './peer-address.js';
import { peerDropReporter } from './peer-guard.js';
import {
  _resetSessionRegistryStateForTest,
  PEER_PROTOCOL_VERSION,
  writeSessionRegistryEntry,
} from './session-registry.js';
import {
  attachLineReader,
  boundMessagingSocket,
  getDefaultUdsSocketPath,
  startUdsMessaging,
  type UdsMessagingHandle,
} from './uds-server.js';

const enqueueMock = vi.hoisted(() => vi.fn());
const tempPathSlug = process.env['BRAND_TEMP_PATH_SLUG'] || 'qwen-code';
const socketDirName = `${tempPathSlug}-socks`;
vi.mock('../services/messageQueueManager.js', () => ({
  enqueue: enqueueMock,
  enqueuePendingNotification: vi.fn(),
}));
vi.mock('../utils/events.js', () => ({
  coreEvents: { emitFeedback: vi.fn() },
}));

/** Mirrors the platform bound the implementation enforces. */
const MAX_SUN_PATH_BYTES = 104;

let workDir: string;
let previousXdg: string | undefined;
let previousHome: string | undefined;
let actualGetuid: typeof process.getuid;
const opened: UdsMessagingHandle[] = [];

/** Mirrors the frame cap the reader enforces. */
const MAX_FRAME_BYTES = 1024 * 1024;

const PEER_SOCKET = '/tmp/peer-under-test.sock';
const PEER_ADDRESS = toUdsAddress(PEER_SOCKET);

let frameCounter = 0;

/** One well-formed inbound frame, newline included. */
function userFrame(
  body: string,
  options: { from?: string | null; selfToken?: string } = {},
): Buffer {
  frameCounter += 1;
  // `null` sends an envelope with no address at all, as an unbound sender does.
  const from = options.from === undefined ? PEER_ADDRESS : options.from;
  return Buffer.from(
    `${JSON.stringify({
      type: 'user',
      msg_id: `frame-${frameCounter}`,
      message: {
        role: 'user',
        content: buildCrossSessionEnvelope({
          ...(from !== null && { from }),
          body,
        }),
      },
      ...(options.selfToken !== undefined && {
        self_token: options.selfToken,
      }),
    })}\n`,
    'utf8',
  );
}

/** Publishes the peer under test, so the inbound gate knows its address. */
async function registerPeer(): Promise<void> {
  await writeSessionRegistryEntry({
    pid: process.pid,
    procStart: Date.now() - 1000,
    startedAt: Date.now(),
    cwd: '/tmp/project',
    sessionId: 'peer-session',
    kind: 'interactive',
    status: 'idle',
    messagingSocketPath: PEER_SOCKET,
    peerProtocol: PEER_PROTOCOL_VERSION,
  });
}

/**
 * A connection whose chunk boundaries the test decides.
 *
 * The reader's contract is entirely about where bytes are cut — a batch in one
 * write, a frame spread over many, a newline landing last in a chunk — and a
 * real socket delivers them however the kernel chose to.
 */
function attachFakeConnection() {
  const socket = new EventEmitter() as unknown as net.Socket;
  const destroy = vi.fn();
  Object.assign(socket, {
    destroy,
    end: vi.fn(),
    setEncoding: vi.fn(),
  });
  attachLineReader(socket, {
    getSessionId: () => 'session-under-test',
    ownAddress: toUdsAddress('/tmp/receiver-under-test.sock'),
  });
  return {
    /** Delivers one `data` event with exactly these bytes. */
    feed: (chunk: Buffer) => socket.emit('data', chunk),
    /** Delivers the bytes one at a time, the worst case for any buffering. */
    drip: (chunk: Buffer) => {
      for (const byte of chunk) socket.emit('data', Buffer.from([byte]));
    },
    end: () => socket.emit('end'),
    destroyed: () => destroy.mock.calls.length > 0,
  };
}

/** Binds under `directory`, remembering the handle for teardown. */
async function bindIn(directory: string): Promise<UdsMessagingHandle | undefined> {
  const handle = await startUdsMessaging(path.join(directory, 'test.sock'), {
    getSessionId: () => 'session-under-test',
  });
  if (handle) opened.push(handle);
  return handle;
}

/**
 * Makes this process appear to be a different user.
 *
 * Ownership cannot be handed to another uid without privileges, so the test
 * moves the observer instead of the observed: a directory this user really owns
 * looks foreign once `getuid` reports somebody else. This is the seam, and its
 * limit is that it exercises the comparison rather than the kernel's answer.
 *
 * Assigned rather than spied because `process.getuid` is optional in the Node
 * types; `afterEach` puts the original back.
 */
function pretendToBeAnotherUser(): void {
  const actual = process.getuid?.() ?? 0;
  process.getuid = () => actual + 1;
}

describe('uds server', () => {
  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-uds-server-'));
    previousXdg = process.env['XDG_RUNTIME_DIR'];
    previousHome = process.env[ENV_PRODUCT_HOME];
    actualGetuid = process.getuid;
    delete process.env['XDG_RUNTIME_DIR'];
    // Keeps the registry read on the inbound path inside the sandbox.
    process.env[ENV_PRODUCT_HOME] = path.join(workDir, 'home');
    enqueueMock.mockClear();
    _resetInboundPolicyForTest();
    _resetSessionRegistryStateForTest();
    // The reporter is a process singleton with a 60s window, so without this a
    // suppressed drop from an earlier test would make this one's assertion pass
    // or fail on test order.
    peerDropReporter.reset();
    setPermissionModeGetter(() => 'default');
  });

  afterEach(async () => {
    for (const handle of opened.splice(0)) await handle.close();
    process.getuid = actualGetuid;
    _resetInboundPolicyForTest();
    _resetSessionRegistryStateForTest();
    if (previousXdg === undefined) delete process.env['XDG_RUNTIME_DIR'];
    else process.env['XDG_RUNTIME_DIR'] = previousXdg;
    if (previousHome === undefined) delete process.env[ENV_PRODUCT_HOME];
    else process.env[ENV_PRODUCT_HOME] = previousHome;
    await fs.rm(workDir, { recursive: true, force: true });
  });

  describe('getDefaultUdsSocketPath', () => {
    it('[AC1] falls back to /tmp when XDG_RUNTIME_DIR is unset', () => {
      expect(getDefaultUdsSocketPath()).toBe(
        `/tmp/${socketDirName}/${process.pid}.sock`,
      );
    });

    it('[AC2] prefers XDG_RUNTIME_DIR when it is set', () => {
      process.env['XDG_RUNTIME_DIR'] = workDir;

      expect(getDefaultUdsSocketPath()).toBe(
        path.join(workDir, socketDirName, `${process.pid}.sock`),
      );
    });

    it('keeps the shared directory when this user already owns it', async () => {
      process.env['XDG_RUNTIME_DIR'] = workDir;
      await fs.mkdir(path.join(workDir, socketDirName), { mode: 0o700 });

      expect(getDefaultUdsSocketPath()).toBe(
        path.join(workDir, socketDirName, `${process.pid}.sock`),
      );
    });

    // The shared directory is 0700, so without this a second user on the host
    // could never bind: their mkdir no-ops and their chmod is refused.
    it('[AC3] scopes by uid when the shared directory belongs to someone else', async () => {
      process.env['XDG_RUNTIME_DIR'] = workDir;
      await fs.mkdir(path.join(workDir, socketDirName), { mode: 0o700 });
      pretendToBeAnotherUser();
      const foreignUid = process.getuid!();

      expect(getDefaultUdsSocketPath()).toBe(
        path.join(workDir, `${socketDirName}-${foreignUid}`, `${process.pid}.sock`),
      );
    });

    it('[AC5] falls back to a shorter path when the preferred one overflows sun_path', () => {
      process.env['XDG_RUNTIME_DIR'] = `/${'x'.repeat(MAX_SUN_PATH_BYTES)}`;
      const preferredLength = Buffer.byteLength(
        path.join(
          process.env['XDG_RUNTIME_DIR'],
          socketDirName,
          `${process.pid}.sock`,
        ),
      );

      const resolved = getDefaultUdsSocketPath();

      expect(resolved).toBe(
        `/tmp/${socketDirName}-${process.getuid?.() ?? 0}/${process.pid}.sock`,
      );
      expect(Buffer.byteLength(resolved)).toBeLessThanOrEqual(
        MAX_SUN_PATH_BYTES,
      );
      // The property the previous implementation got wrong: its fallback
      // rebuilt from the same long base and so was longer still.
      expect(Buffer.byteLength(resolved)).toBeLessThan(preferredLength);
    });
  });

  describe('socket directory verification', () => {
    it('binds inside a directory it creates itself', async () => {
      const directory = path.join(workDir, 'socks');

      const handle = await bindIn(directory);

      expect(handle).toBeDefined();
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(handle!.socketPath)).mode & 0o777).toBe(0o600);
    });

    // The ordinary upgrade path: ours, but created before we cared about the
    // mode. Refusing here would turn a working feature off.
    it('[AC4] tightens a loose directory this user owns and binds anyway', async () => {
      const directory = path.join(workDir, 'socks');
      await fs.mkdir(directory, { mode: 0o755 });

      const handle = await bindIn(directory);

      expect(handle).toBeDefined();
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    });

    // Without the lstat this follows the link, and both the pre-bind unlink and
    // the socket itself land wherever the link points.
    it('[AC4] refuses a socket directory that is a symlink', async () => {
      const real = path.join(workDir, 'elsewhere');
      const link = path.join(workDir, 'socks');
      await fs.mkdir(real, { mode: 0o700 });
      await fs.symlink(real, link);

      expect(await bindIn(link)).toBeUndefined();
      expect(boundMessagingSocket()).toBeUndefined();
    });

    it('[AC4] refuses a socket directory that is a plain file', async () => {
      const file = path.join(workDir, 'socks');
      await fs.writeFile(file, 'not a directory');

      expect(await bindIn(file)).toBeUndefined();
      expect(boundMessagingSocket()).toBeUndefined();
    });

    it('[AC4] refuses a socket directory owned by another user', async () => {
      const directory = path.join(workDir, 'socks');
      await fs.mkdir(directory, { mode: 0o700 });
      pretendToBeAnotherUser();

      expect(await bindIn(directory)).toBeUndefined();
      expect(boundMessagingSocket()).toBeUndefined();
    });
  });

  /**
   * What happens when the path is already taken.
   *
   * Binding used to start by unlinking it, which cannot tell a crashed session's
   * leftover from a running session's socket.
   */
  describe('an occupied socket path', () => {
    // [RA11] The displaced session stays listening on an unreachable inode, so
    // it looks alive to itself while every message for it arrives elsewhere.
    it('[RA11] refuses to take a socket a live session is serving', async () => {
      const directory = path.join(workDir, 'socks');
      const incumbent = await bindIn(directory);
      expect(incumbent).toBeDefined();

      const intruder = await startUdsMessaging(incumbent!.socketPath, {
        isExplicit: true,
        getSessionId: () => 'intruder',
      });

      expect(intruder).toBeUndefined();
      // The incumbent's socket is still the one on disk, still a socket, and
      // still the address this process reports.
      expect((await fs.lstat(incumbent!.socketPath)).isSocket()).toBe(true);
      expect(boundMessagingSocket()).toBe(incumbent!.socketPath);
    });

    // [RA12] The case the unconditional unlink existed for, which still has to
    // work. Any file at the path fails bind with EADDRINUSE and answers no
    // probe, which is exactly what a crashed session's leftover socket does.
    it('[RA12] reclaims a path left behind with nobody listening', async () => {
      const directory = path.join(workDir, 'socks');
      await fs.mkdir(directory, { mode: 0o700 });
      const socketPath = path.join(directory, 'test.sock');
      await fs.writeFile(socketPath, 'leftover');

      const handle = await bindIn(directory);

      expect(handle).toBeDefined();
      expect(handle!.socketPath).toBe(socketPath);
      expect((await fs.lstat(socketPath)).isSocket()).toBe(true);
    });

    // [RA12] An explicit path is user-supplied and may name anything. Removing a
    // regular file to put a socket in its place is not ours to do.
    it('[RA12] refuses to remove a non-socket at an explicit path', async () => {
      const directory = path.join(workDir, 'socks');
      await fs.mkdir(directory, { mode: 0o700 });
      const file = path.join(directory, 'test.sock');
      await fs.writeFile(file, 'precious');

      const handle = await startUdsMessaging(file, {
        isExplicit: true,
        getSessionId: () => 'intruder',
      });

      expect(handle).toBeUndefined();
      await expect(fs.readFile(file, 'utf8')).resolves.toBe('precious');
    });
  });

  /**
   * Where one frame ends and the next begins.
   *
   * The cap is a bound on a single frame. It used to be applied to the whole
   * unconsumed buffer, and counted in UTF-16 code units rather than bytes, so a
   * batch of valid frames was destroyed for being a batch while a CJK frame
   * three times over the limit sailed through.
   */
  describe('frame reader', () => {
    // These are about which bytes arrive together, so the sender is one the
    // gate would deliver without a question.
    beforeEach(registerPeer);

    it('[RA15] delivers every frame of a batch that together exceed the cap', async () => {
      const connection = attachFakeConnection();
      const batch = Buffer.concat([
        userFrame(`one ${'x'.repeat(400 * 1024)}`),
        userFrame(`two ${'x'.repeat(400 * 1024)}`),
        userFrame(`three ${'x'.repeat(400 * 1024)}`),
      ]);
      expect(batch.length).toBeGreaterThan(MAX_FRAME_BYTES);

      connection.feed(batch);

      await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(3));
      expect(connection.destroyed()).toBe(false);
    });

    it('[RA16] drops a single frame over the cap', async () => {
      const connection = attachFakeConnection();

      connection.feed(userFrame('over ' + 'x'.repeat(2 * MAX_FRAME_BYTES)));

      await vi.waitFor(() => expect(connection.destroyed()).toBe(true));
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    // The cap is in bytes. Counting the decoded string's length instead let a
    // CJK body three times over the limit through, because each of its
    // characters is one UTF-16 code unit and three bytes.
    it('[RA16] measures a CJK frame in bytes, not code units', async () => {
      const connection = attachFakeConnection();
      const body = '测'.repeat(400_000);
      expect(body.length).toBeLessThan(MAX_FRAME_BYTES);
      expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(MAX_FRAME_BYTES);

      connection.feed(userFrame(body));

      await vi.waitFor(() => expect(connection.destroyed()).toBe(true));
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    // Bytes are only decoded at the parse, so malformed UTF-8 is an ordinary bad
    // frame rather than something that can disturb the accounting.
    it('[RA16] treats malformed UTF-8 as one bad frame and reads on', async () => {
      const connection = attachFakeConnection();

      connection.feed(Buffer.concat([Buffer.from([0xff, 0xfe, 0xff]), Buffer.from('\n')]));
      connection.feed(userFrame('after the garbage'));

      await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
      expect(connection.destroyed()).toBe(false);
    });

    it('[RA15] reassembles a frame delivered one byte at a time', async () => {
      const connection = attachFakeConnection();

      connection.drip(userFrame('dripped'));

      await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
      expect(connection.destroyed()).toBe(false);
    });

    it('[RA15] splits frames whose newline lands on a chunk boundary', async () => {
      const connection = attachFakeConnection();
      const first = userFrame('first');
      const second = userFrame('second');

      // The newline is the last byte of one chunk and the next frame starts the
      // following one — the case an off-by-one in the cursor gets wrong.
      connection.feed(first);
      connection.feed(second.subarray(0, second.length - 1));
      connection.feed(second.subarray(second.length - 1));

      await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(2));
      expect(connection.destroyed()).toBe(false);
    });

    it('[RA15] delivers a trailing frame that arrives without a newline', async () => {
      const connection = attachFakeConnection();
      const frame = userFrame('unterminated');

      connection.feed(frame.subarray(0, frame.length - 1));
      connection.end();

      await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    });
  });
  /**
   * Registry membership feeds the gate. The address is a claim, so this only
   * separates a session this machine has a record of from an arbitrary string —
   * the report that prompted it sent from a path that never existed.
   */
  describe('unregistered senders', () => {
    let previousSelfToken: string | undefined;

    beforeEach(() => {
      previousSelfToken = process.env[ENV_MESSAGING_SELF_TOKEN];
    });

    afterEach(() => {
      if (previousSelfToken === undefined) {
        delete process.env[ENV_MESSAGING_SELF_TOKEN];
      } else {
        process.env[ENV_MESSAGING_SELF_TOKEN] = previousSelfToken;
      }
    });

    it('holds a message whose address names no registered session', async () => {
      const connection = attachFakeConnection();
      connection.feed(
        userFrame('ghost', { from: toUdsAddress('/tmp/test-socks/ghost.sock') }),
      );

      await vi.waitFor(() => expect(listHeldMessages()).toHaveLength(1));
      expect(listHeldMessages()[0]).toMatchObject({
        cause: 'unregistered-sender',
        knownPeer: false,
      });
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('holds a message that carries no address at all', async () => {
      const connection = attachFakeConnection();
      connection.feed(userFrame('anonymous', { from: null }));

      await vi.waitFor(() => expect(listHeldMessages()).toHaveLength(1));
      expect(listHeldMessages()[0]).toMatchObject({
        from: 'unknown',
        cause: 'unregistered-sender',
      });
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('delivers a registered peer and records that on the origin', async () => {
      await registerPeer();
      const connection = attachFakeConnection();
      connection.feed(userFrame('hello'));

      await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
      expect(enqueueMock.mock.calls[0]?.[0].origin).toMatchObject({
        kind: 'peer',
        knownPeer: true,
      });
    });

    it('honours an explicit accept, and marks the delivered origin', async () => {
      setCrossSessionInboundResolver(() => ({
        policy: 'accept',
        source: 'user',
      }));
      const connection = attachFakeConnection();
      connection.feed(
        userFrame('ghost', { from: toUdsAddress('/tmp/test-socks/ghost.sock') }),
      );

      await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
      expect(enqueueMock.mock.calls[0]?.[0].origin).toMatchObject({
        knownPeer: false,
      });
    });

    // A descendant without a socket of its own sends with no address; the token
    // is the stronger provenance signal, and holding it broke a working flow.
    it('accepts our own descendant whether or not its address is registered', async () => {
      process.env[ENV_MESSAGING_SELF_TOKEN] = 'token-under-test';
      const connection = attachFakeConnection();
      connection.feed(
        userFrame('from a child', { from: null, selfToken: 'token-under-test' }),
      );

      await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
      expect(listHeldMessages()).toHaveLength(0);
    });
  });
});
