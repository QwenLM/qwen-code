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
 * on entirely. A second token, `childToken`, goes only to processes this
 * session spawns, and is the one fact about a sender the inbox can vouch
 * for: a connection that presents it was opened by something this session
 * itself started. Beyond that, a token authenticates the connection, not
 * the sender: Node cannot read `SO_PEERCRED` without a native addon, so a
 * frame's claimed `from` is still unauthenticated and kept only for reply
 * routing — any process holding a token can write any `from` it likes.
 * Everything downstream is built on that assumption: the inbound gate
 * decides whether a message may act, and the envelope tells the model the
 * content is not from its user.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { createDebugLogger } from '../utils/debugLogger.js';
import { isPidAlive } from '../utils/process-liveness.js';
import {
  MAX_FRAME_BYTES,
  parsePeerAuthLine,
  parsePeerFrame,
  type PeerFrame,
} from './peer-frames.js';
import {
  isLocalIpcPath,
  MAX_SOCKET_PATH_BYTES,
  resolvePeerSocketCandidates,
  SOCKET_DIR_NAME,
} from './socket-path.js';
import { probePeerSocketVerdict } from './uds-client.js';

const debugLogger = createDebugLogger('PEER_IPC');

const SOCKET_DIR_MODE = 0o700;
const SOCKET_MODE = 0o600;

// An empty fallback directory may be between mkdir and listen in another
// session. A normal bind takes milliseconds; a minute keeps that window safe
// while still letting later sessions collect directories left by a crash.
const EMPTY_FALLBACK_DIR_GRACE_MS = 60_000;

/**
 * How many sweep probes run at once. Each one holds a file descriptor
 * until it connects or times out, so this is an fd-pressure knob, not a
 * correctness bound: every batch runs, however many there are. Exported
 * so tests can size their fixtures to span more than one batch whatever
 * this is tuned to.
 */
export const SWEEP_BATCH_SIZE = 16;

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
 * Measured from connect to the auth line, and from there to each
 * successfully parsed frame — never reset by a lone byte, and never by a
 * line that failed to parse. An idle timer that any byte resets can be
 * held open forever by a peer dribbling one byte at a time under the
 * 1 MiB cap; so can a line deadline, by a peer writing one junk line per
 * deadline. Only progress re-arms this one. A sender writes its frame
 * and hangs up, so a legitimate connection never comes near it.
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
  /**
   * The path whose failure is reported: the first candidate tried, which
   * is the one the user configured. Later candidates are process-minted
   * fallback directories, so naming those would point the user at a
   * directory that exists nowhere in their configuration.
   */
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
 * Only `<digits>.sock`, or the `<digits>-<8 hex>.sock` sibling a PID
 * collision forces, is a socket this code created.
 *
 * Same strictness as the session registry's filename guard, for the same
 * reason: a lenient match would let the sweep delete a file it never
 * wrote. The optional suffix is matched exactly so the sweep reaps a
 * sibling left by a crash the same way it reaps a plain one.
 */
const SOCKET_FILENAME = /^\d+(-[0-9a-f]{8})?\.sock$/;

/** The PID a socket filename is keyed by, or null if it is not ours. */
function pidOfSocketFilename(name: string): number | null {
  if (!SOCKET_FILENAME.test(name)) return null;
  const pid = Number.parseInt(name.split(/[-.]/)[0]!, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * A sibling path for `socketPath`, keyed by the same PID but distinct.
 *
 * Used when the PID-keyed path is already held by a *live* listener,
 * which happens when two PID namespaces share a runtime directory (a
 * container bind-mounting the host's, most often) and both sessions get
 * the same PID. Returns null when the sibling would not fit in
 * `sun_path`, so the caller falls through to the next candidate rather
 * than binding something that cannot work.
 */
function siblingSocketPath(socketPath: string): string | null {
  const dir = path.dirname(socketPath);
  const base = path.basename(socketPath, '.sock').split('-')[0]!;
  const sibling = path.join(
    dir,
    `${base}-${randomBytes(4).toString('hex')}.sock`,
  );
  return Buffer.byteLength(sibling) <= MAX_SOCKET_PATH_BYTES ? sibling : null;
}

/** The fallback directories `resolvePeerSocketCandidates` mints. */
const NONCE_DIRNAME = new RegExp(`^${SOCKET_DIR_NAME}-[0-9a-f]{16}$`);

export interface PeerInboxOptions {
  /**
   * Bind exactly here instead of trying this process's candidate paths
   * in order. Tests use it; production leaves it unset so an unusable
   * runtime directory falls back instead of turning messaging off.
   */
  socketPath?: string;
  /**
   * When set, a connection's first line must be an auth line presenting
   * exactly this token; anything else drops the connection unread. Unset
   * admits every connection, which only tests use.
   */
  requiredToken?: string;
  /**
   * A second token the auth line may present instead of `requiredToken`.
   * Never published: it reaches only the processes this session spawns,
   * so a connection that authenticates with it is known to come from one
   * of them, and `onFrame` is told so. Ignored unless `requiredToken` is
   * set — without an admission requirement there is nothing to tell apart.
   */
  childToken?: string;
  /**
   * Called for each well-formed frame. Must not throw. `auth` says which
   * token admitted the connection, and is absent when the inbox requires
   * none.
   */
  onFrame: (frame: PeerFrame, auth?: PeerConnectionAuth) => void;
  /** Override for tests; production uses {@link LINE_DEADLINE_MS}. */
  lineDeadlineMs?: number;
}

/**
 * Which token a connection presented: the published one any peer holds,
 * or the child token only this session's own processes were given.
 */
export type PeerConnectionAuth = 'peer' | 'child';

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
 *
 * "Provably" is meant literally, because `isPidAlive` proves nothing about
 * a PID from another namespace: the probe must come back `dead`, not merely
 * "not alive", and liveness is re-read on the turn of the unlink so the
 * verdict and the deletion cannot straddle a probe's round trip.
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
        const pid = pidOfSocketFilename(name);
        if (pid === null) return;
        const fullPath = path.join(dir, name);
        if (fullPath === selfSocketPath) return;
        if (isPidAlive(pid)) return;
        // Only a definitive `dead` licenses the unlink. A timed-out or
        // unpermitted probe establishes nothing, and this path deletes a
        // file another namespace's live session may be listening on --
        // where `isPidAlive` is meaningless, the probe is the only guard.
        if ((await probePeerSocketVerdict(fullPath)) !== 'dead') return;
        // The probe yielded a full round trip, so re-read liveness on the
        // same turn as the delete: the verdict above is about the state
        // before that await, not the state now.
        if (isPidAlive(pid)) return;
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
            const pid = pidOfSocketFilename(file);
            if (pid === null || isPidAlive(pid)) return;
            // Same rule as the file sweep: anything short of a definitive
            // `dead` leaves the whole directory alone.
            if ((await probePeerSocketVerdict(path.join(dir, file))) !== 'dead')
              return;
          }
          // Re-read every PID on the turn of the delete, after the probes
          // above have yielded; one revived socket vetoes the directory.
          for (const file of files) {
            const pid = pidOfSocketFilename(file);
            if (pid === null || isPidAlive(pid)) return;
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
    const attempt = { ...result.failure, attempts: index + 1 };
    debugLogger.warn(
      `peer inbox could not bind at ${candidate} (${attempt.cause}): ${attempt.detail}`,
    );
    // A machine-level refusal is decided before any filesystem call and
    // holds for every candidate alike. Counting the rest would tell a
    // user for whom no path can ever work to go looking for a better
    // one, and would make the count vary with an unrelated environment
    // variable.
    if (attempt.cause === 'unsupported_platform') {
      failure = { ...attempt, attempts: 1 };
      break;
    }
    // Report the FIRST candidate's diagnosis, not the last. The first is
    // the path the user configured; every later candidate is a nonce
    // directory this process minted, which appears nowhere in their
    // configuration and which they cannot act on. `attempts` keeps
    // counting all of them, so the "Tried N candidate paths." sentence
    // stays true.
    if (failure === null) {
      failure = attempt;
    } else {
      failure.attempts = index + 1;
    }
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
  requestedPath: string,
  options: PeerInboxOptions,
  automaticPath: boolean,
): Promise<{ inbox: PeerInbox } | { failure: PeerInboxStartFailure }> {
  // Moves to a sibling name when a live listener already holds the
  // PID-keyed path; everything below binds and reports the bound path.
  let socketPath = requestedPath;
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

  const socketDir = path.dirname(socketPath);
  // A candidate that fails after its directory was created leaves that
  // directory behind, and no sweep can reach it: `sweepAround` runs only
  // on the success path and derives its parent from the winning
  // candidate. Empty-only, so a directory holding someone's live socket
  // is never touched, and best-effort because losing the race to another
  // session's sweep is not an error worth reporting.
  const dropDirIfEmpty = async () => {
    await fs.rmdir(socketDir).catch(() => {});
  };
  try {
    const dir = socketDir;
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
    await dropDirIfEmpty();
    return { failure: classify(error, socketPath) };
  }

  // A socket file left behind by a crashed session would make bind() fail
  // with EADDRINUSE forever, so the path has to be cleared first — but
  // only when nothing is listening on it. The path is keyed by PID, and a
  // PID is unique only within its namespace: where two namespaces share a
  // runtime directory (a container bind-mounting the host's is the usual
  // way), two live sessions can resolve the same path. Unlinking there
  // would leave the other session listening on an inode no peer can reach
  // — silently unreachable, which is the failure this whole path exists
  // to prevent. So a live socket is left alone and we take a sibling name
  // instead; only a dead one is removed.
  // Not `=== 'alive'`: an inconclusive probe must take the sibling name
  // too. Unlinking on "could not tell" is the same mistake the sweep
  // guards against, and the sibling costs only a filename.
  if ((await probePeerSocketVerdict(socketPath)) !== 'dead') {
    const sibling = siblingSocketPath(socketPath);
    if (sibling === null) {
      await dropDirIfEmpty();
      return {
        failure: classify(
          new InboxSetupError(
            'path_too_long',
            `${socketPath} is held by a live session and a sibling name would exceed sun_path`,
            'Set XDG_RUNTIME_DIR or TMPDIR to a shorter directory, then restart.',
          ),
          socketPath,
        ),
      };
    }
    debugLogger.debug(
      `${socketPath} is held by a live session (a PID collision across namespaces); binding at ${sibling}`,
    );
    socketPath = sibling;
  }
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

    let authed = options.requiredToken === undefined;
    let auth: PeerConnectionAuth | undefined;
    // destroy() does not stop lines already buffered from this chunk, and
    // a failed line followed by a *valid* auth line must not resurrect
    // the connection — the refusal is terminal.
    let refused = false;
    const read = createLineReader(
      (line) => {
        if (refused) return;
        if (!authed) {
          // The auth line re-arms: presenting credentials is progress,
          // and the sender still has its frame to write. Nothing else
          // re-arms before a frame parses — see below.
          arm();
          const presented = parsePeerAuthLine(line);
          if (presented !== null) {
            auth = authKindOf(options, presented);
          }
          if (auth !== undefined) {
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
          // Deliberately no arm(): a peer that keeps writing junk lines
          // would otherwise hold this connection, and one of the 64
          // maxConnections slots, for the whole session at two bytes per
          // deadline. Only progress re-arms, and an unparseable line is
          // not progress.
          return;
        }
        arm();
        try {
          options.onFrame(frame, auth);
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

  const listenAt = (target: string) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(target, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

  try {
    await listenAt(socketPath);
  } catch (error) {
    // EADDRINUSE here means the path was taken between the probe above
    // and this listen — the same cross-namespace PID collision, just
    // raced. One retry at a sibling name settles it; a second failure is
    // a real bind failure and is reported as one.
    const sibling =
      (error as NodeJS.ErrnoException)?.code === 'EADDRINUSE'
        ? siblingSocketPath(socketPath)
        : null;
    let raced = error;
    // The path last handed to listen(), which is what a failure must
    // name. `socketPath` is only advanced on success, so reporting it
    // after a failed retry would put the original path in the sentence
    // while Node's message in `detail` named the sibling -- one banner,
    // two paths, and the user sent after the wrong one.
    let attempted = socketPath;
    if (sibling !== null) {
      try {
        attempted = sibling;
        await listenAt(sibling);
        socketPath = sibling;
        raced = null;
      } catch (retryError) {
        raced = retryError;
      }
    }
    if (raced !== null) {
      await dropDirIfEmpty();
      const classified = classify(raced, attempted);
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
    await dropDirIfEmpty();
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

/**
 * Which of the inbox's tokens a presented one is, or undefined for none.
 *
 * Both comparisons always run so a wrong token costs the same whichever
 * one it was aiming at.
 */
function authKindOf(
  options: Pick<PeerInboxOptions, 'requiredToken' | 'childToken'>,
  presented: string,
): PeerConnectionAuth | undefined {
  const peer =
    options.requiredToken !== undefined &&
    tokenMatches(options.requiredToken, presented);
  const child =
    options.childToken !== undefined &&
    tokenMatches(options.childToken, presented);
  if (peer) return 'peer';
  if (child) return 'child';
  return undefined;
}

function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
