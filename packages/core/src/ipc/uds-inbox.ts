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
import { isPidAlive } from '../utils/process-liveness.js';
import {
  MAX_FRAME_BYTES,
  parsePeerFrame,
  type PeerFrame,
} from './peer-frames.js';
import {
  isLocalIpcPath,
  MAX_SOCKET_PATH_BYTES,
  resolvePeerSocketCandidates,
  SOCKET_DIR_NAME,
} from './socket-path.js';
import { probePeerSocket } from './uds-client.js';

const debugLogger = createDebugLogger('PEER_IPC');

const SOCKET_DIR_MODE = 0o700;
const SOCKET_MODE = 0o600;

// An empty fallback directory may be between mkdir and listen in another
// session. A normal bind takes milliseconds; a minute keeps that window safe
// while still letting later sessions collect directories left by a crash.
const EMPTY_FALLBACK_DIR_GRACE_MS = 60_000;

// Each probe holds a file descriptor until it connects or times out.
const SWEEP_BATCH_SIZE = 16;

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
 * How long a connection may go without completing a line before it is
 * dropped.
 *
 * Measured from connect to the first complete line, and then from each
 * complete line to the next — never reset by a lone byte. An idle timer
 * that any byte resets can be held open forever by a peer dribbling one
 * byte at a time under the 1 MiB cap; a deadline that only a whole
 * frame satisfies cannot. A sender writes its frame and hangs up, so a
 * legitimate connection never comes near this.
 */
export const LINE_DEADLINE_MS = 30_000;

/**
 * Why the inbox could not bind, in terms a user can act on.
 *
 * - `non_local`: the configured path is not an absolute local path.
 * - `unsupported_platform`: automatic inbox paths are unavailable here.
 * - `not_directory`: something that is not a directory (a file, a
 *   symlink) sits where the socket directory should be.
 * - `foreign_owner`: the socket directory belongs to another uid.
 * - `permission`: this user cannot create, enter or lock down the socket
 *   directory.
 * - `missing_ancestor`: a parent of the socket directory does not exist.
 * - `path_too_long`: the path exceeds what `sun_path` can hold.
 * - `bind_failed`: `listen()` failed for another reason (the errno is in
 *   `detail`).
 * - `chmod_failed`: the socket could not be restricted to 0600.
 * - `unknown`: anything else; `detail` carries the error.
 */
export type PeerInboxFailureCause =
  | 'non_local'
  | 'unsupported_platform'
  | 'not_directory'
  | 'foreign_owner'
  | 'permission'
  | 'missing_ancestor'
  | 'path_too_long'
  | 'bind_failed'
  | 'chmod_failed'
  | 'unknown';

export interface PeerInboxStartFailure {
  cause: PeerInboxFailureCause;
  /** The last path tried. */
  socketPath: string;
  /** The underlying error, for logs. */
  detail: string;
  /** What the user can do about it. */
  hint: string;
  /** How many candidate paths were tried before giving up. */
  attempts: number;
}

/**
 * The failure that turned messaging off for this session, if any.
 *
 * A session that cannot bind its inbox is not broken — it carries on —
 * but it is unreachable, and the only symptom of that is peers reporting
 * it absent. So the failure is kept where the UI can show it at startup
 * and where `/peers` can repeat it, instead of living only in a debug
 * log nobody has on. Cleared by a successful bind.
 */
let lastStartFailure: PeerInboxStartFailure | null = null;

export function getLastPeerInboxFailure(): PeerInboxStartFailure | null {
  return lastStartFailure;
}

/** One line for a human: what failed, where, and what to do. */
export function describePeerInboxFailure(
  failure: PeerInboxStartFailure,
): string {
  const where = path.dirname(failure.socketPath);
  const attempts =
    failure.attempts > 1 ? ` Tried ${failure.attempts} candidate paths.` : '';
  switch (failure.cause) {
    case 'non_local':
      return `the socket path "${failure.socketPath}" is not an absolute local path. ${failure.hint}${attempts}`;
    case 'unsupported_platform':
      return `cross-session messaging is not available on this platform. ${failure.hint}${attempts}`;
    case 'not_directory':
      return `"${where}" could not be created or is not a plain directory (${failure.detail}). ${failure.hint}${attempts}`;
    case 'foreign_owner':
      return `"${where}" belongs to another user. ${failure.hint}${attempts}`;
    case 'permission':
      return `this user cannot create or lock down "${where}" (${failure.detail}). ${failure.hint}${attempts}`;
    case 'missing_ancestor':
      return `a parent of "${where}" does not exist. ${failure.hint}${attempts}`;
    case 'path_too_long':
      return `"${failure.socketPath}" is longer than the ${MAX_SOCKET_PATH_BYTES}-byte socket path limit. ${failure.hint}${attempts}`;
    case 'bind_failed':
      return `the socket could not be bound at "${failure.socketPath}" (${failure.detail}). ${failure.hint}${attempts}`;
    case 'chmod_failed':
      return `the socket at "${failure.socketPath}" could not be restricted to this user (${failure.detail}). ${failure.hint}${attempts}`;
    default:
      return `${failure.detail} (at "${failure.socketPath}"). ${failure.hint}${attempts}`;
  }
}

const HINT_RUNTIME_DIR =
  'Set XDG_RUNTIME_DIR (or TMPDIR) to a directory you own, then restart.';

class InboxSetupError extends Error {
  constructor(
    readonly failureCause: PeerInboxFailureCause,
    message: string,
    readonly hint: string = HINT_RUNTIME_DIR,
  ) {
    super(message);
    this.name = 'InboxSetupError';
  }
}

/** Map an errno from mkdir/lstat/chmod/listen onto a cause and a hint. */
function classify(error: unknown, socketPath: string): PeerInboxStartFailure {
  if (error instanceof InboxSetupError) {
    return {
      cause: error.failureCause,
      socketPath,
      detail: error.message,
      hint: error.hint,
      attempts: 1,
    };
  }
  const code = (error as NodeJS.ErrnoException)?.code;
  const detail = describe(error);
  const base = { socketPath, detail, attempts: 1 };
  switch (code) {
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return { ...base, cause: 'permission', hint: HINT_RUNTIME_DIR };
    case 'ENOENT':
      return { ...base, cause: 'missing_ancestor', hint: HINT_RUNTIME_DIR };
    // mkdir(recursive) reports a file in the way as EEXIST, not ENOTDIR.
    case 'EEXIST':
    case 'ENOTDIR':
    case 'ELOOP':
      return {
        ...base,
        cause: 'not_directory',
        hint: 'Remove it, or set XDG_RUNTIME_DIR to a directory you own, then restart.',
      };
    case 'ENAMETOOLONG':
      return {
        ...base,
        cause: 'path_too_long',
        hint: 'Set XDG_RUNTIME_DIR or TMPDIR to a shorter directory, then restart.',
      };
    default:
      return { ...base, cause: 'unknown', hint: HINT_RUNTIME_DIR };
  }
}

/**
 * Only `<digits>.sock` is a socket this code created.
 *
 * Same strictness as the session registry's filename guard, for the same
 * reason: a lenient match would let the sweep delete a file it never
 * wrote.
 */
const SOCKET_FILENAME = /^\d+\.sock$/;

/** The fallback directories `resolvePeerSocketCandidates` mints. */
const NONCE_DIRNAME = new RegExp(`^${SOCKET_DIR_NAME}-[0-9a-f]{16}$`);

export interface PeerInboxOptions {
  /**
   * Bind exactly here instead of trying this process's candidate paths
   * in order. Tests use it; production leaves it unset so an unusable
   * runtime directory falls back instead of turning messaging off.
   */
  socketPath?: string;
  /** Called for each well-formed frame. Must not throw. */
  onFrame: (frame: PeerFrame) => void;
  /** Override for tests; production uses {@link LINE_DEADLINE_MS}. */
  lineDeadlineMs?: number;
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
 * Delete `<pid>.sock` files in `dir` left behind by sessions that are gone.
 *
 * A session that exits cleanly unlinks its own socket; one that is killed
 * cannot, and nothing else removes them, so without this the shared
 * runtime directory grows by one dead file per crash. Sweeping happens at
 * bind time rather than on a timer: the directory only accumulates when a
 * session dies, and a new session starting is the natural moment to
 * notice.
 *
 * Conservative by construction: a file goes only when its PID is
 * *provably* dead. A live PID is left alone even though it may have been
 * recycled onto some unrelated process — a leftover file costs a few
 * bytes, and deleting a live session's socket would make it silently
 * unreachable.
 */
export async function sweepOrphanSockets(
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
  for (let offset = 0; offset < entries.length; offset += SWEEP_BATCH_SIZE) {
    await Promise.all(
      entries.slice(offset, offset + SWEEP_BATCH_SIZE).map(async (name) => {
        if (!SOCKET_FILENAME.test(name)) return;
        const fullPath = path.join(dir, name);
        if (fullPath === selfSocketPath) return;
        const pid = Number.parseInt(name.slice(0, -'.sock'.length), 10);
        if (!Number.isInteger(pid) || pid <= 0 || isPidAlive(pid)) return;
        if (await probePeerSocket(fullPath)) return;
        try {
          await fs.unlink(fullPath);
          swept += 1;
        } catch {
          // Raced with another session's sweep, or not ours to remove.
        }
      }),
    );
  }
  if (swept > 0) {
    debugLogger.debug(`swept ${swept} orphaned peer socket(s) from ${dir}`);
  }
  return swept;
}

/**
 * Remove whole fallback directories (`qwen-socks-<nonce>/`) in `parent`
 * whose every socket belongs to a dead process.
 *
 * Each session that falls back to a shared temp directory mints its own
 * nonce-named directory, so a killed session leaves a directory behind,
 * not just a file. Only directories this uid owns, matching the exact
 * name shape, and holding nothing but provably dead sockets are removed;
 * anything else is not ours to reason about.
 */
export async function sweepOrphanSocketDirs(
  parent: string,
  selfDir: string,
): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(parent);
  } catch {
    return 0;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  let swept = 0;
  for (let offset = 0; offset < entries.length; offset += SWEEP_BATCH_SIZE) {
    await Promise.all(
      entries.slice(offset, offset + SWEEP_BATCH_SIZE).map(async (name) => {
        if (!NONCE_DIRNAME.test(name)) return;
        const dir = path.join(parent, name);
        if (dir === selfDir) return;
        try {
          const stat = await fs.lstat(dir);
          if (!stat.isDirectory()) return;
          if (uid !== null && stat.uid !== uid) return;
          const files = await fs.readdir(dir);
          if (
            files.length === 0 &&
            Date.now() - stat.mtimeMs < EMPTY_FALLBACK_DIR_GRACE_MS
          ) {
            return;
          }
          for (const file of files) {
            if (!SOCKET_FILENAME.test(file)) return;
            const pid = Number.parseInt(file.slice(0, -'.sock'.length), 10);
            if (!Number.isInteger(pid) || pid <= 0 || isPidAlive(pid)) return;
            if (await probePeerSocket(path.join(dir, file))) return;
          }
          for (const file of files) await fs.unlink(path.join(dir, file));
          await fs.rmdir(dir);
          swept += 1;
        } catch {
          // Raced, or not ours.
        }
      }),
    );
  }
  if (swept > 0) {
    debugLogger.debug(
      `swept ${swept} orphaned peer socket director${swept === 1 ? 'y' : 'ies'} from ${parent}`,
    );
  }
  return swept;
}

function sweepAround(socketPath: string): Promise<number> {
  const dir = path.dirname(socketPath);
  const base = path.basename(dir);
  if (base === SOCKET_DIR_NAME) return sweepOrphanSockets(dir, socketPath);
  if (NONCE_DIRNAME.test(base)) {
    return sweepOrphanSocketDirs(path.dirname(dir), dir);
  }
  return Promise.resolve(0);
}

/**
 * Bind this session's inbox.
 *
 * Tries each candidate path in order (see `resolvePeerSocketCandidates`)
 * and returns null only when every one failed. The failure is then kept
 * for {@link getLastPeerInboxFailure}: a session that cannot be messaged
 * is a degraded session, not a broken one, but its user has to be told
 * why or they will never know it is unreachable.
 */
export async function startPeerInbox(
  options: PeerInboxOptions,
): Promise<PeerInbox | null> {
  const candidates =
    options.socketPath !== undefined
      ? [options.socketPath]
      : resolvePeerSocketCandidates();

  let failure: PeerInboxStartFailure | null = null;
  for (const [index, candidate] of candidates.entries()) {
    const result = await bindAt(
      candidate,
      options,
      options.socketPath === undefined,
    );
    if ('inbox' in result) {
      lastStartFailure = null;
      if (index > 0) {
        debugLogger.warn(
          `peer inbox bound at fallback path ${candidate} after ${index} unusable candidate(s)`,
        );
      }
      // Fire-and-forget: a sweep is housekeeping, and nothing about this
      // session's own inbox depends on it.
      void sweepAround(candidate).catch(() => {});
      return result.inbox;
    }
    failure = { ...result.failure, attempts: index + 1 };
    debugLogger.warn(
      `peer inbox could not bind at ${candidate} (${failure.cause}): ${failure.detail}`,
    );
    // A non-local or over-long path is a property of that candidate, not
    // of the machine; the next candidate is worth trying. A bind that
    // failed for another reason usually is too. Only an explicit path
    // has no next.
  }

  if (failure) {
    lastStartFailure = failure;
    debugLogger.error(
      `cross-session messaging is OFF for this session: ${describePeerInboxFailure(failure)}`,
    );
  }
  return null;
}

async function bindAt(
  socketPath: string,
  options: PeerInboxOptions,
  automaticPath: boolean,
): Promise<{ inbox: PeerInbox } | { failure: PeerInboxStartFailure }> {
  if (!isLocalIpcPath(socketPath)) {
    const unsupportedPlatform = automaticPath && process.platform === 'win32';
    return {
      failure: classify(
        new InboxSetupError(
          unsupportedPlatform ? 'unsupported_platform' : 'non_local',
          unsupportedPlatform
            ? 'automatic peer inbox paths are not supported on Windows'
            : `refusing to bind a non-local IPC path: ${socketPath}`,
          unsupportedPlatform
            ? 'Disable cross-session messaging for this session.'
            : 'Use an absolute local path.',
        ),
        socketPath,
      ),
    };
  }
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    return {
      failure: classify(
        Object.assign(new Error(`${socketPath} exceeds sun_path`), {
          code: 'ENAMETOOLONG',
        }),
        socketPath,
      ),
    };
  }

  try {
    const dir = path.dirname(socketPath);
    await fs.mkdir(dir, { recursive: true, mode: SOCKET_DIR_MODE });
    // Both mkdir(recursive) and chmod succeed straight through a symlink,
    // and a shared temp directory is a place where another user can
    // create our directory first. If they point it at a directory of
    // ours, the chmod below silently retargets that directory and the
    // socket lands inside it. Insist on a real directory we own; anything
    // else means someone got there first.
    const dirStat = await fs.lstat(dir);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!dirStat.isDirectory()) {
      throw new InboxSetupError(
        'not_directory',
        `${dir} is not a directory`,
        'Remove it, or set XDG_RUNTIME_DIR to a directory you own, then restart.',
      );
    }
    if (uid !== null && dirStat.uid !== uid) {
      throw new InboxSetupError(
        'foreign_owner',
        `${dir} belongs to uid ${dirStat.uid}, not ${uid}`,
      );
    }
    // mkdir's mode is masked by the umask and ignored outright when the
    // directory already exists, so chmod is what actually enforces 0700.
    await fs.chmod(dir, SOCKET_DIR_MODE);
  } catch (error) {
    return { failure: classify(error, socketPath) };
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
  const lineDeadlineMs = options.lineDeadlineMs ?? LINE_DEADLINE_MS;

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    connections.add(socket);
    socket.setEncoding('utf8');
    // An accepted connection is ref'd even when its server is not, so
    // without this one idle peer would pin the process open — exactly what
    // the server.unref() below is meant to prevent.
    socket.unref();

    // A deadline, not an idle timer: it is satisfied only by a complete
    // line, and re-armed from that line, so a peer that keeps the
    // connection alive with lone bytes still loses it on time.
    let deadline: NodeJS.Timeout | null = null;
    const arm = () => {
      if (deadline) clearTimeout(deadline);
      deadline = setTimeout(() => {
        deadline = null;
        debugLogger.debug(
          `closing a peer connection that sent no complete line within ${lineDeadlineMs} ms`,
        );
        socket.destroy();
      }, lineDeadlineMs);
      deadline.unref();
    };
    arm();

    const read = createLineReader(
      (line) => {
        arm();
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
      if (deadline) clearTimeout(deadline);
      deadline = null;
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
    const classified = classify(error, socketPath);
    return {
      failure:
        classified.cause === 'unknown'
          ? {
              ...classified,
              cause: 'bind_failed',
              hint: 'If another process holds the path, restart after it exits; otherwise set XDG_RUNTIME_DIR to a directory you own.',
            }
          : classified,
    };
  }

  try {
    await fs.chmod(socketPath, SOCKET_MODE);
  } catch (error) {
    // A socket we cannot lock down is worse than no socket at all: the
    // permission bits are the entire access-control story here.
    server.close();
    try {
      fsSync.unlinkSync(socketPath);
    } catch {
      // Best effort.
    }
    return {
      failure: {
        ...classify(error, socketPath),
        cause: 'chmod_failed',
      },
    };
  }

  // Never hold the event loop open on the inbox alone — a session waiting
  // only for a peer message should still be able to exit. Accepted
  // connections are unref'd in the connection handler for the same reason;
  // unref'ing the server by itself would not be enough.
  server.unref();

  debugLogger.debug(`peer inbox listening: ${socketPath}`);

  let closed = false;
  return {
    inbox: {
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
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
