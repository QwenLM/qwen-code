/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Server side of same-machine peer messaging: one UNIX domain socket per
 * session, accepting NDJSON frames.
 *
 * Access control is filesystem permissions plus a connection token. The
 * socket directory is 0700 and the socket itself is 0600, so only this
 * uid can connect; when `requiredToken` is set, a connection must also
 * present it on its first line before any frame is read, which narrows
 * "can reach the socket path" to "can read this session's 0600 registry
 * record" and is what a permissionless transport (a named pipe) will rely
 * on entirely. The token authenticates the connection, not the sender:
 * Node cannot read `SO_PEERCRED` without a native addon, so a frame's
 * claimed `from` is still unauthenticated and kept only for reply
 * routing — any process holding the token can write any `from` it likes.
 * Everything downstream is built on that assumption: the inbound gate
 * decides whether a message may act, and the envelope tells the model the
 * content is not from its user.
 */

import { timingSafeEqual } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  MAX_FRAME_BYTES,
  parsePeerAuthLine,
  parsePeerFrame,
  type PeerFrame,
} from './peer-frames.js';
import { isLocalIpcPath, resolvePeerSocketPath } from './socket-path.js';

const debugLogger = createDebugLogger('PEER_IPC');

const SOCKET_DIR_MODE = 0o700;
const SOCKET_MODE = 0o600;

/**
 * Most peers connected at once.
 *
 * A sender opens one connection per message and hangs up, so anything past
 * a handful is a bug or a flood. Without a ceiling, a same-uid process can
 * hold open as many connections as it likes and take this session's file
 * descriptors with it.
 */
export const MAX_PEER_CONNECTIONS = 64;

/**
 * How long a connection may sit without traffic before it is dropped.
 *
 * The 1 MiB cap only fires on a peer that keeps *writing* without a
 * newline. A peer that connects, writes nothing, and never hangs up costs
 * nothing to create and would otherwise hold a descriptor for the life of
 * the session.
 */
export const CONNECTION_IDLE_TIMEOUT_MS = 30_000;

export interface PeerInboxOptions {
  /** Defaults to this process's resolved socket path. */
  socketPath?: string;
  /**
   * When set, a connection's first line must be an auth line presenting
   * exactly this token; anything else drops the connection unread. Unset
   * admits every connection, which only tests use.
   */
  requiredToken?: string;
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
      if (line.trim().length > 0) onLine(line);
      newline = buffer.indexOf('\n');
    }
    // Check what is left *after* draining, so the cap bounds one line and
    // not the arrival pattern: a peer that lands a megabyte of perfectly
    // good frames in a single chunk has not done anything wrong.
    if (buffer.length > MAX_FRAME_BYTES) {
      buffer = '';
      onOverflow();
    }
  };
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
    // Both mkdir(recursive) and chmod succeed straight through a symlink,
    // and the `/tmp` fallback directory sits in a world-writable place
    // where another user can create it first. If they point it at a
    // directory of ours, the chmod below silently retargets that
    // directory and the socket lands inside it. Insist on a real
    // directory we own; anything else means someone got there first.
    const dirStat = await fs.lstat(dir);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!dirStat.isDirectory()) {
      throw new Error(`${dir} is not a directory`);
    }
    if (uid !== null && dirStat.uid !== uid) {
      throw new Error(`${dir} belongs to uid ${dirStat.uid}, not ${uid}`);
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
    // An accepted connection is ref'd even when its server is not, so
    // without this one idle peer would pin the process open — exactly what
    // the server.unref() below is meant to prevent.
    socket.unref();
    socket.setTimeout(CONNECTION_IDLE_TIMEOUT_MS, () => {
      debugLogger.debug('dropping an idle peer connection');
      socket.destroy();
    });

    let authed = options.requiredToken === undefined;
    // destroy() does not stop lines already buffered from this chunk, and
    // a failed line followed by a *valid* auth line must not resurrect
    // the connection — the refusal is terminal.
    let refused = false;
    const read = createLineReader(
      (line) => {
        if (refused) return;
        if (!authed) {
          const presented = parsePeerAuthLine(line);
          if (
            presented !== null &&
            tokenMatches(options.requiredToken!, presented)
          ) {
            authed = true;
            return;
          }
          debugLogger.debug(
            'dropping a connection whose first line did not authenticate: no valid auth line, or token mismatch',
          );
          refused = true;
          socket.destroy();
          return;
        }
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
          'peer sent more than 1 MiB without a newline; dropping the connection',
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

  server.maxConnections = MAX_PEER_CONNECTIONS;

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
    server.close();
    try {
      fsSync.unlinkSync(socketPath);
    } catch {
      // Best effort.
    }
    return null;
  }

  // Never hold the event loop open on the inbox alone — a session waiting
  // only for a peer message should still be able to exit. Accepted
  // connections are unref'd in the connection handler for the same reason;
  // unref'ing the server by itself would not be enough.
  server.unref();

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

/**
 * Constant-time comparison. A same-uid peer has better channels than a
 * byte-by-byte timing oracle, but a permissionless transport (the named
 * pipe this token exists for) may not share that property.
 */
function tokenMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
