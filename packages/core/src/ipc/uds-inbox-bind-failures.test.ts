/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The bind-time failures no real filesystem can be made to produce: a
 * socket `chmod` that fails after `listen()` already succeeded, a
 * directory that disappears between its own `mkdir` and `chmod`, and a
 * `listen()` that fails twice over.
 *
 * Every other failure in `bindAt` has a fixture that produces it -- a
 * file where a directory belongs, a path over `sun_path`, a live
 * squatter. These do not. The socket is created by `listen()` a
 * microsecond before the chmod, inside a directory this process just
 * chmod'd to 0700 and owns; the window in which a sweeper or a tmpfs
 * cleaner can remove that directory is two syscalls wide; and a sibling
 * name is eight random bytes, so nothing can be planted in its way.
 * Stubbing is the only way in.
 *
 * They live in their own file because the stubs have to be module-level,
 * and routing the real-socket suite in `uds-inbox.test.ts` through a
 * patched `node:fs/promises` and `node:net` would put mocks under sixty
 * tests that have no need of them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

/** A `chmod` to fail: which path suffix, and with which errno. */
let chmodFailure: { suffix: string; code: string } | null = null;

/** Set to an errno every `listen()` should fail with; null binds for real. */
let failListenWith: string | null = null;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const chmod: typeof actual.chmod = async (target, mode) => {
    if (chmodFailure !== null && String(target).endsWith(chmodFailure.suffix)) {
      throw Object.assign(
        new Error(`${chmodFailure.code}: chmod '${String(target)}'`),
        { code: chmodFailure.code },
      );
    }
    return actual.chmod(target, mode);
  };
  return { ...actual, chmod, default: { ...actual, chmod } };
});

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  // `createServer` is overloaded, so the wrapper is typed through the
  // namespace member rather than by restating either signature.
  type CreateServer = typeof actual.createServer;
  const createServer = ((...args: unknown[]) => {
    const server = (actual.createServer as (...a: unknown[]) => net.Server)(
      ...args,
    );
    const listen = server.listen.bind(server);
    server.listen = ((...listenArgs: never[]) => {
      if (failListenWith === null) return listen(...listenArgs);
      // Asynchronously, the way a real bind failure arrives: `listenAt`
      // subscribes and then returns to the event loop.
      setImmediate(() =>
        server.emit(
          'error',
          Object.assign(new Error(`${failListenWith}: address in use`), {
            code: failListenWith,
          }),
        ),
      );
      return server;
    }) as typeof server.listen;
    return server;
  }) as CreateServer;
  return { ...actual, createServer, default: { ...actual, createServer } };
});

const fs = await import('node:fs/promises');
const { describePeerInboxFailure, getLastPeerInboxFailure, startPeerInbox } =
  await import('./uds-inbox.js');

const isWindows = process.platform === 'win32';

let tmpDir: string;

beforeEach(async () => {
  chmodFailure = null;
  failListenWith = null;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-bindfail-'));
});

afterEach(async () => {
  chmodFailure = null;
  failListenWith = null;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** A live listener holding `socketPath`, as a peer session would. */
async function occupy(socketPath: string): Promise<net.Server> {
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  server.unref();
  return server;
}

describe.skipIf(isWindows)('a socket that cannot be locked down', () => {
  it('reports chmod_failed and leaves nothing behind', async () => {
    // A socket this process cannot restrict to 0600 is worse than no
    // socket at all -- the permission bits are the whole access-control
    // story -- so the bind is abandoned rather than completed. Drop the
    // `chmod_failed` override and `classify` returns `permission` for
    // EPERM, whose sentence blames the *directory* and sends the user to
    // fix permissions that are already correct; drop the cleanup and the
    // bound socket and its directory are orphaned where no sweep derives
    // a parent from.
    const socketPath = path.join(tmpDir, 'socks', '4242.sock');
    chmodFailure = { suffix: '.sock', code: 'EPERM' };

    const started = await startPeerInbox({ socketPath, onFrame: () => {} });

    expect(started).toBeNull();
    const failure = getLastPeerInboxFailure();
    expect(failure?.cause).toBe('chmod_failed');
    expect(failure?.socketPath).toBe(socketPath);
    await expect(fs.stat(socketPath)).rejects.toThrow();
    await expect(fs.stat(path.dirname(socketPath))).rejects.toThrow();
  });

  it('blames the configured path, not the sibling it moved aside to', async () => {
    // A failure after a sibling advance must still name what the user
    // configured. The sibling is a name this process minted seconds ago:
    // putting it in the startup banner and in `/peers` sends the user to
    // inspect a file that appears nowhere in their settings, while the
    // path they can actually act on goes unmentioned. Node's errno
    // message keeps naming the sibling in `detail`, which is where a log
    // reader wants it.
    const requested = path.join(tmpDir, 'socks', '4242.sock');
    const squatter = await occupy(requested);
    chmodFailure = { suffix: '.sock', code: 'EPERM' };
    try {
      const started = await startPeerInbox({
        socketPath: requested,
        onFrame: () => {},
      });

      expect(started).toBeNull();
      const failure = getLastPeerInboxFailure();
      expect(failure?.cause).toBe('chmod_failed');
      // The advance happened -- otherwise this test proves nothing about
      // it -- and the report still names the requested path.
      expect(failure?.detail).toMatch(/4242-[0-9a-f]{8}\.sock/);
      expect(failure?.socketPath).toBe(requested);
      // And the live session next door is untouched.
      expect((await fs.lstat(requested)).isSocket()).toBe(true);
    } finally {
      squatter.close();
    }
  });
});

describe.skipIf(isWindows)('a listen that fails at both names', () => {
  it('blames the configured path, not the sibling it retried at', async () => {
    // The raced-EADDRINUSE retry: the path was taken between the probe
    // and the listen, the retry at a sibling fails too, and what is left
    // to report is a real bind failure. It must be reported against the
    // path the user configured. Naming the sibling instead puts a
    // filename this process minted eight random bytes ago into the
    // startup banner and into `/peers`, and sends the user to inspect a
    // file that exists in no configuration of theirs. Node's message
    // keeps naming the attempted path in `detail`.
    const requested = path.join(tmpDir, 'socks', '4242.sock');
    failListenWith = 'EADDRINUSE';

    const started = await startPeerInbox({
      socketPath: requested,
      onFrame: () => {},
    });

    expect(started).toBeNull();
    const failure = getLastPeerInboxFailure();
    expect(failure?.cause).toBe('bind_failed');
    expect(failure?.socketPath).toBe(requested);
    expect(failure?.socketPath).not.toMatch(/-[0-9a-f]{8}\.sock$/);
    // The directory the failed candidate created is not left behind.
    await expect(fs.stat(path.dirname(requested))).rejects.toThrow();
  });
});

describe.skipIf(isWindows)('a socket directory that vanishes mid-setup', () => {
  it('names the missing ancestor rather than an unknown error', async () => {
    // `mkdir` is recursive, so it creates the ancestors it needs and
    // ENOENT never comes from there -- which left `missing_ancestor` with
    // no producer at all. It is still reachable: `mkdir`, `lstat` and
    // `chmod` are three syscalls, and a sweeper or a tmpfs cleaner
    // removing the directory in between makes the next one fail ENOENT.
    // Stubbing the directory chmod reproduces that window exactly.
    //
    // Drop the ENOENT case from `classify` and this renders as `unknown`,
    // which hands the user a raw errno string instead of naming the
    // parent that is gone.
    const socketPath = path.join(tmpDir, 'socks', '4242.sock');
    chmodFailure = { suffix: `${path.sep}socks`, code: 'ENOENT' };

    const started = await startPeerInbox({ socketPath, onFrame: () => {} });

    expect(started).toBeNull();
    const failure = getLastPeerInboxFailure();
    expect(failure?.cause).toBe('missing_ancestor');
    expect(failure?.socketPath).toBe(socketPath);
    expect(describePeerInboxFailure(failure!)).toContain('does not exist');
  });
});
