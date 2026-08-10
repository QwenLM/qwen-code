/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Server side of same-machine peer messaging: one UNIX domain socket per
 * session, accepting NDJSON frames.
 *
 * Access control is filesystem permissions and nothing else. The socket
 * directory is 0700 and the socket itself is 0600, so only this uid can
 * connect. Node cannot read `SO_PEERCRED` without a native addon, so a
 * frame's claimed origin is *not* authenticated beyond that: any process
 * running as this user can write any `from` it likes. Everything
 * downstream is built on that assumption — the inbound gate decides
 * whether a message may act, and the envelope tells the model the content
 * is not from its user.
 */

import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  MAX_FRAME_BYTES,
  parsePeerFrame,
  type PeerFrame,
} from './peer-frames.js';
import { isPidAlive } from '../utils/process-liveness.js';
import { isLocalIpcPath, resolvePeerSocketPath } from './socket-path.js';

const debugLogger = createDebugLogger('PEER_IPC');

const SOCKET_DIR_MODE = 0o700;
const SOCKET_MODE = 0o600;

/**
 * Only `<digits>.sock` is a socket this code created.
 *
 * Same strictness as the session registry's filename guard, for the same
 * reason: a lenient match would let the sweep delete a file it never
 * wrote.
 */
const SOCKET_FILENAME = /^\d+\.sock$/;

export interface PeerInboxOptions {
  /** Defaults to this process's resolved socket path. */
  socketPath?: string;
  /** Called for each well-formed frame. Must not throw. */
  onFrame: (frame: PeerFrame) => void;
}

export interface PeerInbox {
  readonly socketPath: string;
  /** Close the listener, drop live connections, and unlink the socket. */
  close(): Promise<void>;
}

/**
 * Split an incoming byte stream into frames.
 *
 * Returned as a closure per connection because framing state (the partial
 * line) is per-connection: two peers writing concurrently must not splice
 * their halves together.
 */
function createLineReader(
  onLine: (line: string) => void,
  onOverflow: () => void,
): (chunk: string) => void {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
        buffer = '';
        onOverflow();
        return;
      }
      if (line.trim().length > 0) onLine(line);
      newline = buffer.indexOf('\n');
    }
    // The cap binds the unterminated tail only; complete frames were already
    // extracted above, so a pipelining sender does not lose a valid frame
    // because its neighbor pushed the combined span over the bound. A tail
    // of exactly MAX_FRAME_BYTES can still grow into a legal terminated
    // line, so it is accepted until it exceeds the cap. Measured in bytes,
    // like the wire: a multibyte line can be shorter than it is large.
    if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
      buffer = '';
      onOverflow();
    }
  };
}

/**
 * Delete socket files in `dir` left behind by sessions that are gone.
 *
 * A session that exits cleanly unlinks its own socket; one that is killed
 * cannot. Nothing else removes them, so without this the directory grows
 * by one dead file per crash. Under `$XDG_RUNTIME_DIR` that is bounded by
 * the login session, but the `/tmp/qwen-socks-<uid>/` fallback persists
 * across reboots on some systems.
 *
 * Sweeping happens at bind time rather than on a timer: the directory
 * only accumulates when a session dies, and a new session starting is
 * both the natural moment to notice and the only moment anyone cares.
 * Each socket directory is swept by the sessions that use it, so a
 * process whose path fell back to `/tmp` cleans `/tmp`, not the runtime
 * dir it could not use.
 *
 * Conservative by construction: a file is removed only when its PID is
 * *provably* dead. A live PID is left alone even though it may have been
 * recycled onto some unrelated process — a leftover file costs a few
 * bytes, and deleting a live session's socket would make it silently
 * unreachable.
 */
async function sweepOrphanSockets(
  dir: string,
  selfSocketPath: string,
): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0;
  }

  let swept = 0;
  await Promise.all(
    entries.map(async (name) => {
      if (!SOCKET_FILENAME.test(name)) return;
      const fullPath = path.join(dir, name);
      if (fullPath === selfSocketPath) return;

      const pid = Number.parseInt(name.slice(0, -'.sock'.length), 10);
      if (!Number.isInteger(pid) || pid <= 0) return;
      if (isPidAlive(pid)) return;

      try {
        await fs.unlink(fullPath);
        swept += 1;
      } catch {
        // Raced with another session's sweep, or not ours to remove.
      }
    }),
  );

  if (swept > 0) {
    debugLogger.debug(`swept ${swept} orphaned peer socket(s) from ${dir}`);
  }
  return swept;
}

/** Exposed for tests; production callers go through {@link startPeerInbox}. */
export const _sweepOrphanSocketsForTesting = sweepOrphanSockets;

/**
 * True when `dir` is a real directory belonging to this uid.
 *
 * `lstat`, not `stat`: the question is what the path itself is, and a
 * symlink that happens to point at one of our own directories is still an
 * attacker-controlled indirection, not a directory we created.
 *
 * The uid comparison is skipped where the platform has no uids (Windows),
 * where the directory check is the whole of what can be asserted.
 */
async function isOwnDirectory(dir: string): Promise<boolean> {
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory()) return false;
  const euid = process.geteuid?.();
  return euid === undefined || stat.uid === euid;
}

/**
 * Bind this session's inbox.
 *
 * Returns null instead of throwing when the socket cannot be bound: a
 * session that cannot be messaged is a degraded session, not a broken
 * one, and the caller has nothing useful to do with the failure beyond
 * carrying on.
 */
export async function startPeerInbox(
  options: PeerInboxOptions,
): Promise<PeerInbox | null> {
  const socketPath = options.socketPath ?? resolvePeerSocketPath();

  if (!isLocalIpcPath(socketPath)) {
    debugLogger.error(`refusing to bind a non-local IPC path: ${socketPath}`);
    return null;
  }

  try {
    const dir = path.dirname(socketPath);
    await fs.mkdir(dir, { recursive: true, mode: SOCKET_DIR_MODE });
    // `mkdir` accepts a pre-existing symlink-to-directory and `chmod`
    // follows it, so without this check a different-uid neighbour who
    // pre-plants the (predictable, `/tmp`-rooted when `XDG_RUNTIME_DIR` is
    // unset) directory path as a symlink gets our chmod applied to a
    // directory of their choosing. lstat first, and refuse anything that is
    // not a real directory this uid owns.
    if (!(await isOwnDirectory(dir))) {
      debugLogger.error(
        `peer inbox directory is not a directory owned by this user, refusing to listen: ${dir}`,
      );
      return null;
    }
    // mkdir's mode is masked by the umask and ignored outright when the
    // directory already exists, so chmod is what actually enforces 0700.
    await fs.chmod(dir, SOCKET_DIR_MODE);
  } catch (error) {
    debugLogger.error(`peer inbox directory unusable: ${describe(error)}`);
    return null;
  }

  // A socket file left behind by a crashed session would make bind() fail
  // with EADDRINUSE forever. Unlinking is safe because the path is keyed
  // by our own PID: if a live process were listening there, it would be
  // this one.
  try {
    await fs.unlink(socketPath);
  } catch {
    // Nothing to clean up.
  }

  const connections = new Set<net.Socket>();

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    connections.add(socket);
    socket.setEncoding('utf8');

    const read = createLineReader(
      (line) => {
        const frame = parsePeerFrame(line);
        if (frame === null) {
          debugLogger.debug(
            `dropping unparseable frame: ${line.slice(0, 200)}`,
          );
          return;
        }
        try {
          options.onFrame(frame);
        } catch (error) {
          debugLogger.error(`onFrame threw: ${describe(error)}`);
        }
      },
      () => {
        debugLogger.error(
          'peer sent a frame over the 1 MiB line limit; dropping the connection',
        );
        socket.destroy();
      },
    );

    socket.on('data', read);
    socket.on('end', () => {
      // allowHalfOpen keeps our side open after the peer's FIN, which is
      // what lets a sender `end()` immediately after writing. Close our
      // half explicitly or the connection lingers until process exit.
      socket.end();
    });
    socket.on('error', (error) => {
      debugLogger.debug(`peer connection error: ${error.message}`);
    });
    socket.on('close', () => {
      connections.delete(socket);
    });
  });

  server.on('error', (error) => {
    debugLogger.error(`peer inbox server error: ${describe(error)}`);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENAMETOOLONG') {
      debugLogger.error(
        `peer inbox socket path is too long to bind (${Buffer.byteLength(
          socketPath,
        )} bytes): ${socketPath}. Set XDG_RUNTIME_DIR or TMPDIR to a shorter directory.`,
      );
    } else {
      debugLogger.error(`peer inbox failed to bind: ${describe(error)}`);
    }
    return null;
  }

  try {
    await fs.chmod(socketPath, SOCKET_MODE);
  } catch (error) {
    // A socket we cannot lock down is worse than no socket at all: the
    // permission bits are the entire access-control story here.
    debugLogger.error(
      `peer inbox socket could not be restricted to 0600, refusing to listen: ${describe(error)}`,
    );
    // A connection can race into the listen→chmod window; settle it the
    // same way close() would before the server goes away.
    for (const socket of connections) socket.destroy();
    connections.clear();
    server.unref();
    server.close();
    try {
      fsSync.unlinkSync(socketPath);
    } catch {
      // Best effort.
    }
    return null;
  }

  // Never hold the event loop open on the inbox alone — a session waiting
  // only for a peer message should still be able to exit.
  server.unref();

  // After listening, not before: becoming reachable is what the caller is
  // waiting on, and housekeeping should not sit in front of it.
  await sweepOrphanSockets(path.dirname(socketPath), socketPath);

  debugLogger.debug(`peer inbox listening: ${socketPath}`);

  let closed = false;
  return {
    socketPath,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of connections) socket.destroy();
      connections.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        await fs.unlink(socketPath);
      } catch {
        // Already gone.
      }
      debugLogger.debug(`peer inbox closed: ${socketPath}`);
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
