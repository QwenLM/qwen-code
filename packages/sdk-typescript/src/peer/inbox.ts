/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The listening side: one UNIX domain socket that reads NDJSON frames.
 *
 * Access control is the filesystem plus a token. The directory is 0700 and
 * the socket 0600, so only this user can connect; the first line of every
 * connection must present the token published in this endpoint's record,
 * or the connection is dropped unread. A token proves the connection is
 * allowed, not who opened it, so every field of a frame stays a claim.
 *
 * This inbox accepts exactly one token. It does not keep the review
 * machinery a Qwen Code session keeps for itself — rate limits, holds,
 * trusted controllers — because a program that joins the directory decides
 * for itself what to do with a message it receives.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { isLocalIpcPath, probePeerSocket } from './client.js';
import { describeError, PeerEndpointError } from './errors.js';
import {
  MAX_FRAME_CHARS,
  parsePeerAuthLine,
  parsePeerFrame,
  type PeerFrame,
} from './frames.js';

/**
 * Longest usable socket path: `sun_path` holds 108 bytes on Linux and 104
 * on macOS, NUL included, and bind fails rather than truncating.
 */
export const MAX_SOCKET_PATH_BYTES = 103;

/** The directory (or, in a shared temp directory, the prefix) of a socket. */
export const SOCKET_DIR_NAME = 'qwen-socks';

/**
 * Most connections open at once. A sender connects, writes and hangs up,
 * so anything past a handful is a bug or a flood, and without a ceiling one
 * process could hold this one's descriptors.
 */
export const MAX_PEER_CONNECTIONS = 64;

/**
 * How long a connection may go without completing a line that counts.
 *
 * Only the auth line and a frame that parses re-arm it. A timer any byte
 * resets could be held open by a peer dribbling one byte at a time, and one
 * a junk line resets by a peer writing a junk line per period.
 */
export const LINE_DEADLINE_MS = 30_000;

const SOCKET_DIR_MODE = 0o700;
const SOCKET_MODE = 0o600;

const NONCE_DIRNAME = new RegExp(`^${SOCKET_DIR_NAME}-[0-9a-f]{16}$`);

export interface PeerInboxOptions {
  /** Bind exactly here instead of walking the candidate paths. */
  socketPath?: string;
  /** The token a connection's first line must present. */
  requiredToken: string;
  /** Called for each frame that parses. Should not throw. */
  onFrame: (frame: PeerFrame) => void;
  /** Keep the process running while the inbox is open. Default true. */
  keepAlive?: boolean;
  /** Override {@link LINE_DEADLINE_MS}, for tests. */
  lineDeadlineMs?: number;
}

export interface PeerInbox {
  readonly socketPath: string;
  /** Drop live connections, stop listening and remove the socket file. */
  close(): Promise<void>;
  /** The same, for an exit handler where nothing can await. */
  closeSync(): void;
}

/**
 * Where this process may bind, best first.
 *
 * `$XDG_RUNTIME_DIR` is a per-user directory that disappears at logout,
 * the right lifetime for a socket. Anywhere else the temp directory may be
 * shared with other users, where a predictable directory name is a target
 * someone else can create first — so the name carries a nonce, and peers
 * learn the address from the record, never by deriving it.
 */
export function resolveInboxCandidates(pid: number = process.pid): string[] {
  if (process.platform === 'win32') return [];
  const candidates: string[] = [];
  const runtimeDir = process.env['XDG_RUNTIME_DIR'];
  if (runtimeDir) {
    candidates.push(path.join(runtimeDir, SOCKET_DIR_NAME, `${pid}.sock`));
  }
  const nonce = randomBytes(8).toString('hex');
  candidates.push(
    path.join(os.tmpdir(), `${SOCKET_DIR_NAME}-${nonce}`, `${pid}.sock`),
    path.join('/tmp', `${SOCKET_DIR_NAME}-${nonce}`, `${pid}.sock`),
  );
  return candidates.filter(
    (candidate, index) =>
      Buffer.byteLength(candidate) <= MAX_SOCKET_PATH_BYTES &&
      candidates.indexOf(candidate) === index,
  );
}

/**
 * A name beside `socketPath` keyed by the same PID, for when the PID-keyed
 * one is held: two PID namespaces sharing a runtime directory can both
 * resolve it. Null when the sibling would not fit `sun_path`.
 */
function siblingSocketPath(socketPath: string): string | null {
  const base = path.basename(socketPath, '.sock').split('-')[0]!;
  const sibling = path.join(
    path.dirname(socketPath),
    `${base}-${randomBytes(4).toString('hex')}.sock`,
  );
  return Buffer.byteLength(sibling) <= MAX_SOCKET_PATH_BYTES ? sibling : null;
}

function tokenMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Split a connection's bytes into lines. The cap is measured on what is
 * left after complete lines are taken, so it bounds one line rather than
 * how the bytes happened to arrive.
 */
function createLineReader(
  onLine: (line: string) => void,
  onOverflow: () => void,
): (chunk: string) => void {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim().length > 0) onLine(line);
      newline = buffer.indexOf('\n');
    }
    if (buffer.length > MAX_FRAME_CHARS) {
      buffer = '';
      onOverflow();
    }
  };
}

function listen(server: net.Server, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(target, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function bindAt(
  requested: string,
  options: PeerInboxOptions,
): Promise<PeerInbox> {
  if (!isLocalIpcPath(requested)) {
    throw new Error(`not an absolute local path: ${requested}`);
  }
  if (Buffer.byteLength(requested) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`longer than ${MAX_SOCKET_PATH_BYTES} bytes: ${requested}`);
  }
  const dir = path.dirname(requested);
  const ownsDir = NONCE_DIRNAME.test(path.basename(dir));
  const dropDirIfOurs = () =>
    ownsDir ? fs.rmdir(dir).catch(() => {}) : Promise.resolve();

  await fs.mkdir(dir, { recursive: true, mode: SOCKET_DIR_MODE });
  try {
    // mkdir and chmod both follow a symlink, and a shared temp directory is
    // somewhere another user can create this name first. Insist on a real
    // directory this user owns before trusting its permissions.
    const stats = await fs.lstat(dir);
    if (!stats.isDirectory()) throw new Error(`${dir} is not a directory`);
    const uid = process.getuid?.();
    if (uid !== undefined && stats.uid !== uid) {
      throw new Error(`${dir} belongs to uid ${stats.uid}, not ${uid}`);
    }
    await fs.chmod(dir, SOCKET_DIR_MODE);
  } catch (error) {
    await dropDirIfOurs();
    throw error;
  }

  // A socket file left by a crash blocks bind forever, so it has to go —
  // but only when nothing answers on it. Anything short of a definitive
  // `dead` takes a sibling name instead: unlinking a live socket would make
  // its owner silently unreachable.
  let target = requested;
  if ((await probePeerSocket(target)) !== 'dead') {
    const sibling = siblingSocketPath(target);
    if (sibling === null) {
      await dropDirIfOurs();
      throw new Error(`${target} is in use and no sibling name fits`);
    }
    target = sibling;
  }
  await fs.unlink(target).catch(() => {});

  const keepAlive = options.keepAlive ?? true;
  const lineDeadlineMs = options.lineDeadlineMs ?? LINE_DEADLINE_MS;
  const connections = new Set<net.Socket>();

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    connections.add(socket);
    socket.setEncoding('utf8');
    if (!keepAlive) socket.unref();

    let deadline: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(deadline);
      deadline = setTimeout(() => socket.destroy(), lineDeadlineMs);
      deadline.unref();
    };
    arm();

    let authed = false;
    // Terminal: lines already buffered from the same chunk must not revive
    // a connection that failed to authenticate.
    let refused = false;
    const read = createLineReader(
      (line) => {
        if (refused) return;
        if (!authed) {
          const presented = parsePeerAuthLine(line);
          if (
            presented !== null &&
            tokenMatches(options.requiredToken, presented)
          ) {
            authed = true;
            arm();
            return;
          }
          refused = true;
          socket.destroy();
          return;
        }
        const frame = parsePeerFrame(line);
        if (frame === null) return;
        arm();
        try {
          options.onFrame(frame);
        } catch {
          // A throwing callback must not take the connection down with it.
        }
      },
      () => {
        refused = true;
        socket.destroy();
      },
    );
    socket.on('data', read);
    // The server is half-open so a sender can end its side right after
    // writing; close this side too, or the connection lingers.
    socket.on('end', () => socket.end());
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(deadline);
      connections.delete(socket);
    });
  });
  server.maxConnections = MAX_PEER_CONNECTIONS;

  try {
    await listen(server, target);
  } catch (error) {
    // The path was taken between the probe and the listen. One sibling
    // settles that; a second failure is a real one.
    const sibling =
      (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? siblingSocketPath(target)
        : null;
    if (sibling === null) {
      await dropDirIfOurs();
      throw error;
    }
    try {
      await listen(server, sibling);
      target = sibling;
    } catch (retryError) {
      await dropDirIfOurs();
      throw retryError;
    }
  }
  server.on('error', () => {});

  try {
    await fs.chmod(target, SOCKET_MODE);
  } catch (error) {
    // The permission bits are the whole of the access control here; a
    // socket that cannot be locked down is worse than none.
    server.close();
    await fs.unlink(target).catch(() => {});
    await dropDirIfOurs();
    throw error;
  }
  if (!keepAlive) server.unref();

  let closed = false;
  const destroyConnections = () => {
    for (const socket of connections) socket.destroy();
    connections.clear();
  };
  return {
    socketPath: target,
    async close() {
      if (closed) return;
      closed = true;
      destroyConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.unlink(target).catch(() => {});
      await dropDirIfOurs();
    },
    closeSync() {
      if (closed) return;
      closed = true;
      destroyConnections();
      server.close();
      try {
        fsSync.unlinkSync(target);
        if (ownsDir) fsSync.rmdirSync(dir);
      } catch {
        // Best effort on the way out.
      }
    },
  };
}

/**
 * Bind an inbox at `options.socketPath`, or at the first candidate path
 * that works.
 *
 * Throws {@link PeerEndpointError} `unsupported-platform` where there is no
 * candidate at all, and `bind-failed` when every candidate failed — naming
 * the first, which is the one configuration or the environment chose.
 */
export async function startPeerInbox(
  options: PeerInboxOptions,
): Promise<PeerInbox> {
  const candidates =
    options.socketPath !== undefined
      ? [options.socketPath]
      : resolveInboxCandidates();
  if (candidates.length === 0) {
    throw new PeerEndpointError(
      'unsupported-platform',
      'peer inboxes need UNIX domain sockets, which this platform does not offer here',
    );
  }
  let firstFailure: string | undefined;
  for (const candidate of candidates) {
    try {
      return await bindAt(candidate, options);
    } catch (error) {
      firstFailure ??= `${candidate}: ${describeError(error)}`;
    }
  }
  throw new PeerEndpointError(
    'bind-failed',
    `could not bind a peer inbox (tried ${candidates.length} path${
      candidates.length === 1 ? '' : 's'
    }; first: ${firstFailure})`,
  );
}
