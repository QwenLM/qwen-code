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
import { isLocalIpcPath, resolvePeerSocketPath } from './socket-path.js';

const debugLogger = createDebugLogger('PEER_IPC');

const SOCKET_DIR_MODE = 0o700;
const SOCKET_MODE = 0o600;

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
 *
 * Every step here is O(chunk), never O(buffer). The pacing of a sender's
 * writes is entirely its own choice, so anything proportional to the
 * accumulated buffer is quadratic work an unauthenticated same-uid peer
 * can bill to this session's event loop for free: dripping bytes with no
 * newline until the cap is reached costs it one syscall per event and
 * costs us a full re-scan per event. The cap bounds memory, not CPU.
 */
function createLineReader(
  onLine: (line: string) => void,
  onOverflow: () => void,
): (chunk: string) => void {
  // Held as unjoined chunks with a running byte count. Joining, scanning
  // or re-measuring is deferred until a newline proves a frame is actually
  // complete, and by then the bytes being paid for are bytes being retired.
  let pending: string[] = [];
  let pendingBytes = 0;
  const reset = () => {
    pending = [];
    pendingBytes = 0;
  };
  return (chunk: string) => {
    if (chunk.length === 0) return;
    // Everything left in `pending` is an incomplete line, so a chunk with
    // no newline in it cannot complete one — there is nothing to extract
    // and nothing to scan. Cap it anyway, or a peer that never writes a
    // newline grows the buffer until the process dies.
    if (!chunk.includes('\n')) {
      pending.push(chunk);
      pendingBytes += Buffer.byteLength(chunk, 'utf8');
      if (pendingBytes > MAX_FRAME_BYTES) {
        reset();
        onOverflow();
      }
      return;
    }
    pending.push(chunk);
    const buffer = pending.join('');
    reset();
    // Complete lines are extracted before the cap is applied. Capping the
    // whole accumulated buffer first would discard legal, under-cap frames
    // whenever a pipelining sender happened to put several of them in one
    // chunk, and would reject a line of exactly MAX_FRAME_BYTES because its
    // own terminating newline pushed the buffer one over.
    //
    // Walked with an index rather than by re-slicing the head off `buffer`:
    // a chunk of N newlines would otherwise copy the remainder N times.
    let start = 0;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(start, newline);
      start = newline + 1;
      if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
        onOverflow();
        return;
      }
      if (line.trim().length > 0) onLine(line);
      newline = buffer.indexOf('\n', start);
    }
    // The tail follows the last newline in this chunk, so it is bounded by
    // the chunk and measuring it is O(chunk) too.
    const tail = buffer.slice(start);
    if (tail.length === 0) return;
    const tailBytes = Buffer.byteLength(tail, 'utf8');
    if (tailBytes > MAX_FRAME_BYTES) {
      onOverflow();
      return;
    }
    pending.push(tail);
    pendingBytes = tailBytes;
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
          'peer sent a line over 1 MiB; dropping the connection',
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
