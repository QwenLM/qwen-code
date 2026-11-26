/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Inbound side of the peer transport.
 *
 * Binds a Unix Domain Socket inside a 0700 directory, reads newline-delimited
 * JSON frames, and hands accepted user frames to the prompt queue. Filesystem
 * permissions are the entire isolation story here — there is no verified sender
 * identity. See docs/designs/2026-08-08-cross-session-peer-messaging.md §6.8.
 */

import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import {
  BRAND_TEMP_PATH_SLUG,
  ENV_MESSAGING_SELF_TOKEN,
  ENV_MESSAGING_SOCKET,
} from '../config/brand.js';
import type { QueuedCommand, QueuePriority } from '../input/types.js';
import { enqueuePendingNotification } from '../services/messageQueueManager.js';
import { runLogger } from '../utils/runLogger.js';
import {
  boundMessagingSocket,
  setBoundMessagingSocket,
} from './bound-socket.js';
import {
  buildCrossSessionEnvelope,
  parseCrossSessionEnvelope,
} from './cross-session-envelope.js';
import {
  applyInboundPolicy,
  decideInboundPolicy,
  currentModeClass,
  setPeerReceiptSink,
  HOLD_SETTLEMENT_BUDGET_MS,
  type PeerMessageStatus,
} from './inbound-policy.js';
import {
  UDS_ADDRESS_PREFIX,
  hopChainContains,
  hopIdForAddress,
  isLocalIpcPath,
  isValidPeerAddress,
  parsePeerAddress,
  toUdsAddress,
} from './peer-address.js';
import { peerDropReporter, type PeerDropReason } from './peer-guard.js';
import { injectPeerFilePrefix, materializePeerFiles } from './peer-files.js';
import { sanitizeForDisplay } from './peer-message-preview.js';
import { isKnownPeerAddress, probeSocket } from './session-registry.js';
import {
  admitReceiptForOutstandingSend,
  ownSelfToken,
  sendControlFrame,
} from './uds-client.js';

/**
 * Conservative `sun_path` bound. Linux allows 108 bytes and macOS 104; using the
 * smaller keeps one code path.
 */
const MAX_SUN_PATH_BYTES = 104;

/** Largest single NDJSON frame this server will assemble. */
const MAX_FRAME_BYTES = 1024 * 1024;

const NEWLINE_BYTE = 0x0a;

const SOCKET_DIR_NAME = `${BRAND_TEMP_PATH_SLUG}-socks`;

/**
 * Shortest base a socket can live under, and the fallback for every other one.
 *
 * `/tmp` rather than `os.tmpdir()`: on macOS the latter is a per-user
 * `/var/folders/<hash>/T` around 50 bytes long, which eats half the `sun_path`
 * budget and renders as an unreadable wall wherever an address is displayed.
 */
const DEFAULT_SOCKET_BASE = '/tmp';

/** This process's uid, or 0 where the platform has no concept of one. */
function currentUid(): number {
  return process.getuid?.() ?? 0;
}

/**
 * Whether this user can bind inside the given socket directory.
 *
 * A directory that does not exist yet is usable — we create it. An existing one
 * is usable only when this uid owns it, because the `0700` mode it is bound
 * under makes it unusable to everyone else. `/tmp` is shared, so the name may
 * well already belong to another user on a multi-user host.
 */
function isUsableSocketDir(directory: string): boolean {
  try {
    return lstatSync(directory).uid === currentUid();
  } catch {
    // Does not exist, or sits somewhere we cannot stat. Either way the bind
    // path's own verification is the one that decides.
    return true;
  }
}

/**
 * Default socket path for this process.
 *
 * Prefers `XDG_RUNTIME_DIR`, which is per-user, `0700` and typically tmpfs
 * where it exists at all, and otherwise uses `/tmp`. The shared directory name
 * gives way to a uid-scoped one when another user got there first: it is
 * `0700`, so without this a second user on the same host could never bind.
 */
export function getDefaultUdsSocketPath(): string {
  const base = process.env['XDG_RUNTIME_DIR'] || DEFAULT_SOCKET_BASE;
  const shared = path.join(base, SOCKET_DIR_NAME);
  const directory = isUsableSocketDir(shared)
    ? shared
    : path.join(base, `${SOCKET_DIR_NAME}-${currentUid()}`);

  const preferred = path.join(directory, `${process.pid}.sock`);
  if (Buffer.byteLength(preferred) <= MAX_SUN_PATH_BYTES) return preferred;

  // Only reachable from a long XDG_RUNTIME_DIR now that the default base is
  // `/tmp`, and shorter than what it replaces because no base is shorter.
  return path.join(
    DEFAULT_SOCKET_BASE,
    `${SOCKET_DIR_NAME}-${currentUid()}`,
    `${process.pid}.sock`,
  );
}

/**
 * Mints the descendant token unless one was inherited.
 *
 * Provenance only: a peer presenting our token is our own descendant. It is not
 * an authenticator and must never gate anything but a default policy choice.
 */
export function ensureSelfToken(): string {
  const existing = ownSelfToken();
  if (existing) return existing;
  const token = randomUUID();
  process.env[ENV_MESSAGING_SELF_TOKEN] = token;
  return token;
}

// Re-exported so this stays the import site it has always been; the state moved
// to its own module because the send path needs it too and cannot import back.
export { boundMessagingSocket };

export interface UdsMessagingHandle {
  socketPath: string;
  close(): Promise<void>;
}

export interface StartUdsMessagingOptions {
  /** True when the path came from `--messaging-socket-path`. */
  isExplicit?: boolean;
  /** Resolves the current session id at delivery time. */
  getSessionId: () => string;
}

interface InboundFrame {
  type?: unknown;
  msg_id?: unknown;
  uuid?: unknown;
  priority?: unknown;
  from?: unknown;
  self_token?: unknown;
  message?: { role?: unknown; content?: unknown };
  file_attachments?: unknown;
  action?: unknown;
  status?: unknown;
  orig_msg_id?: unknown;
}

const RECEIPT_STATUSES: readonly string[] = [
  'held',
  'denied',
  'expired',
  'delivered',
];

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Drops a frame the gate will never see, inside the drop reporter's suppression
 * window: a looping or hostile peer produces these as fast as it can write, so
 * the report is rate-limited rather than logged per frame.
 */
function dropInbound(from: string, reason: PeerDropReason): void {
  peerDropReporter.report({ from, reason });
}

function asPriority(value: unknown): QueuePriority {
  return value === 'now' || value === 'later' ? value : 'next';
}

/**
 * Notifies the local model when one of its sends was parked, rejected, or
 * finally delivered after being parked.
 *
 * `delivered` is otherwise silent: the common case should not add a turn. The
 * exception is a message this session was told to wait on — leaving that
 * instruction unresolved is what made the wait indefinite.
 *
 * The delivered wording deliberately does not claim approval. A policy or
 * permission-mode change releasing the queue produces the same `delivered`
 * status as a human answering the prompt, and nothing on the wire tells them
 * apart, so asserting either would sometimes be false.
 */
function notifySenderOfReceipt(
  status: PeerMessageStatus,
  peer: string,
  wasHeld: boolean,
  customContext?: Readonly<Record<string, string>>,
  sessionId?: string,
): void {
  if (status === 'delivered' && !wasHeld) return;
  const detail =
    status === 'delivered'
      ? 'is no longer held and has been delivered'
      : status === 'held'
        ? 'is awaiting that user\'s approval before it is delivered'
        : status === 'denied'
          ? 'was declined by that session'
          : 'expired before that session reviewed it';
  // A delivered message is now in that session's queue, so the advice is to
  // expect an answer rather than to stop waiting for one.
  const advice =
    status === 'delivered'
      ? 'That session will act on it in its own time; do not resend it.'
      : 'Do not resend it; continue with other work.';
  enqueuePendingNotification({
    prompt: `Your cross-session message to ${peer} ${detail}. ${advice}`,
    commandMode: 'task-notification',
    priority: 'later',
    isMeta: true,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(customContext !== undefined ? { customContext } : {}),
  });
}

function handleControlFrame(frame: InboundFrame): void {
  if (frame.action !== 'peer_message_status') return;
  const status = asString(frame.status);
  const origMsgId = asString(frame.orig_msg_id);
  if (!status || !RECEIPT_STATUSES.includes(status) || !origMsgId) return;

  const admitted = admitReceiptForOutstandingSend(
    origMsgId,
    status as PeerMessageStatus,
  );
  if (!admitted) {
    runLogger.debug(`[uds-messaging] Unmatched receipt for ${origMsgId}`);
    return;
  }
  notifySenderOfReceipt(
    status as PeerMessageStatus,
    admitted.to,
    admitted.wasHeld,
    admitted.customContext,
    admitted.sessionId,
  );
}

/** Per-server context, so identity comes from the bind rather than a global. */
export interface InboundContext {
  getSessionId: () => string;
  /** This server's own reply address. */
  ownAddress: string;
}

async function handleUserFrame(
  frame: InboundFrame,
  context: InboundContext,
): Promise<void> {
  const { getSessionId, ownAddress: myAddress } = context;
  const raw = asString(frame.message?.content);
  if (!raw) return;

  const envelope = parseCrossSessionEnvelope(raw);
  if (!envelope) {
    dropInbound(asString(frame.from) ?? 'unknown', 'invalid-envelope');
    return;
  }

  const from = envelope.from ?? asString(frame.from) ?? 'unknown';

  if (from === myAddress) {
    dropInbound(from, 'self-echo');
    return;
  }
  // Against a chain built by something that relays. This process never builds
  // one — every send is a single hop — so a chain arriving with our own hop in
  // it came back to us the long way round.
  if (hopChainContains(envelope.hopChain, hopIdForAddress(myAddress))) {
    dropInbound(from, 'loop-detected');
    return;
  }

  // Resolved here rather than inside the receipt sink. The sink has to stay
  // synchronous: `hold` puts `held` on the wire before offering the message to a
  // review surface, so that a surface answering synchronously cannot land
  // `delivered` ahead of the `held` that explains it. Awaiting a registry read
  // inside the sink would turn that ordering into a race. The gate, the approval
  // dialog and the delivered message's marker want the same answer, so one read
  // serves all of them — and it comes first because the gate is one of them.
  const knownPeer = await isKnownPeerAddress(from);

  const selfToken = ownSelfToken();
  const hints = {
    selfSent: selfToken !== undefined && frame.self_token === selfToken,
    ...(envelope.fromMode !== undefined && { fromMode: envelope.fromMode }),
    knownPeer,
  };
  const decision = decideInboundPolicy(hints);

  const msgId = asString(frame.msg_id);
  const baseMessage = {
    from,
    ...(envelope.fromName !== undefined && { fromName: envelope.fromName }),
    ...(msgId !== undefined && { msgId }),
    knownPeer,
    hints,
  };

  // `attachmentCount` is passed rather than closed over: the refuse path builds
  // its command before anything is materialized, and reading a variable that is
  // assigned later would report whatever the last message happened to bring.
  const buildCommand = (
    body: string,
    attachmentCount: number,
  ): QueuedCommand => ({
    prompt: buildCrossSessionEnvelope({ ...envelope, body }),
    commandMode: 'prompt',
    priority: asPriority(frame.priority),
    isMeta: true,
    // A peer's leading slash is text, never a command in this session.
    skipSlashCommands: true,
    // Minted here, never taken from the frame. This is the public dedup and
    // cancellation identity: it picks the representative of a coalesced batch
    // and keys the lifecycle events handed to an SDK client, so a peer choosing
    // it could cancel or displace work this session is already running. The
    // sender mints a fresh one per message anyway, so the value carries nothing
    // across the wire that is worth preserving.
    uuid: randomUUID(),
    sessionId: getSessionId(),
    // Peer-authored text bound for a terminal: collapsing whitespace takes out
    // newlines and tabs but leaves ESC and bidi overrides exactly where they are.
    displaySummary: sanitizeForDisplay(envelope.body)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80),
    origin: {
      kind: 'peer' as const,
      transport: 'uds' as const,
      from,
      ...(envelope.fromName !== undefined && { name: envelope.fromName }),
      body: envelope.body,
      ...(msgId !== undefined && { msgId }),
      ...(envelope.fromMode !== undefined && { fromMode: envelope.fromMode }),
      ...(envelope.hopChain !== undefined && { hopChain: envelope.hopChain }),
      ...(hints.selfSent && { selfSent: true }),
      knownPeer,
      ...(attachmentCount > 0 && { attachmentCount }),
    },
  });

  // Refuse must settle before any attachment byte reaches disk, otherwise a
  // session that opted out is still coerced into writing a peer's files.
  if (decision.policy === 'refuse') {
    applyInboundPolicy(
      { ...baseMessage, command: buildCommand(envelope.body, 0) },
      decision,
    );
    peerDropReporter.report({ from, reason: 'refused' });
    return;
  }

  // Attachments are written before the hold gate rather than after it. Copying
  // captures the bytes as they were described; deferring until an approval
  // minutes later would re-read paths the sender is free to have changed. The
  // hold queue therefore owns them, and discards them if the message is never
  // accepted.
  let body = envelope.body;
  let attachmentPaths: string[] = [];
  if (Array.isArray(frame.file_attachments) && frame.file_attachments.length) {
    const materialized = await materializePeerFiles(
      frame.file_attachments,
      getSessionId(),
    );
    attachmentPaths = materialized.paths;
    body = injectPeerFilePrefix(body, materialized);
  }

  applyInboundPolicy(
    {
      ...baseMessage,
      command: buildCommand(body, attachmentPaths.length),
      ...(attachmentPaths.length > 0 && { attachmentPaths }),
      sessionId: getSessionId(),
    },
    decision,
  );
}

/** Serializes ordinary frames so two messages cannot interleave. */
let inboundChain: Promise<void> = Promise.resolve();

function routeInbound(frame: InboundFrame, context: InboundContext): void {
  if (frame.type === 'control') {
    handleControlFrame(frame);
    return;
  }
  if (frame.type !== 'user') return;

  // A `now` frame without attachments is cheap and latency-sensitive, so it
  // skips the queue. Ordering is therefore not guaranteed across priorities.
  if (frame.priority === 'now' && frame.file_attachments === undefined) {
    void handleUserFrame(frame, context).catch((error) =>
      runLogger.debug(`[uds-messaging] Inbound handling failed: ${error}`),
    );
    return;
  }

  inboundChain = inboundChain
    .then(() => handleUserFrame(frame, context))
    .catch((error) =>
      runLogger.debug(`[uds-messaging] Inbound handling failed: ${error}`),
    );
}

/**
 * Splits a connection's byte stream into NDJSON frames.
 *
 * @internal Exported for the framing tests. What they assert is which bytes
 * arrive together — a batch in one write, a frame split across chunks, a newline
 * landing exactly on a chunk boundary — and no real socket lets a test say.
 */
export function attachLineReader(
  connection: net.Socket,
  context: InboundContext,
): void {
  // Deliberately no setEncoding. The cap here is a byte count, and a decoded
  // string can only be measured in bytes by re-encoding it — worse, a
  // StringDecoder turns each malformed byte into a 3-byte U+FFFD, so the count
  // drifts on exactly the input this cap exists for. Bytes in; decode once, per
  // frame, at the parse.
  let pendingChunks: Buffer[] = [];
  let pendingBytes = 0;

  const reset = () => {
    pendingChunks = [];
    pendingBytes = 0;
  };

  const dropConnection = () => {
    runLogger.warn(
      `[uds-messaging] Frame exceeded ${MAX_FRAME_BYTES} bytes; dropping connection`,
    );
    dropInbound('unknown', 'oversized');
    reset();
    connection.destroy();
  };

  /** Joins everything buffered so far with this frame's tail. */
  const takeFrame = (tail: Buffer): Buffer => {
    if (pendingChunks.length === 0) return tail;
    pendingChunks.push(tail);
    const frame = Buffer.concat(pendingChunks);
    reset();
    return frame;
  };

  const dispatch = (frame: Buffer) => {
    const line = frame.toString('utf8');
    if (!line.trim()) return;
    try {
      routeInbound(JSON.parse(line) as InboundFrame, context);
    } catch {
      dropInbound('unknown', 'invalid-frame');
    }
  };

  connection.on('data', (chunk: Buffer) => {
    // Only the new chunk is scanned; everything already buffered is known to
    // hold no newline. That is what keeps a peer writing one byte at a time from
    // turning this into a repeated scan of a megabyte-long tail.
    let start = 0;
    let newline = chunk.indexOf(NEWLINE_BYTE, start);
    while (newline !== -1) {
      // Complete frames are consumed before the cap is applied. The cap bounds
      // one frame; applying it to the whole unconsumed buffer used to destroy a
      // peer that batched several perfectly valid frames into a single write.
      const frame = takeFrame(chunk.subarray(start, newline));
      // Still enforced per frame: a complete oversized line arriving in one
      // chunk tripped the old check, and must not now reach JSON.parse instead.
      if (frame.length > MAX_FRAME_BYTES) {
        dropConnection();
        return;
      }
      dispatch(frame);
      start = newline + 1;
      newline = chunk.indexOf(NEWLINE_BYTE, start);
    }

    const rest = chunk.subarray(start);
    if (rest.length > 0) {
      pendingChunks.push(rest);
      pendingBytes += rest.length;
    }
    if (pendingBytes > MAX_FRAME_BYTES) dropConnection();
  });
  connection.on('end', () => {
    if (pendingBytes > 0) dispatch(Buffer.concat(pendingChunks));
    reset();
    // allowHalfOpen keeps our side open after the peer's FIN. Nothing is ever
    // written back on this connection, so close it — otherwise server.close()
    // waits forever on connections that will never end themselves.
    connection.end();
  });
  connection.on('error', () => connection.destroy());
}

/**
 * Builds the receipt sink.
 *
 * A reply only goes to a `.sock` path that either names a session in the local
 * registry or sits in this session's own socket directory. That is a guard
 * against misrouting — a typo, a stale address, a bug of ours — and not a
 * security boundary: both halves are writable by any process of this user, which
 * is the same population that can forge a `from` in the first place. What it buys
 * is that a control frame cannot be aimed at an unrelated local socket by
 * accident.
 *
 * Synchronous on purpose. See the note where `knownPeer` is resolved.
 */
function makeReceiptSink(socketPath: string) {
  const ownDir = path.dirname(socketPath);
  return (
    message: { from: string; msgId?: string; knownPeer?: boolean },
    status: PeerMessageStatus,
  ): Promise<void> | undefined => {
    const { from, msgId, knownPeer } = message;
    if (!from.startsWith(UDS_ADDRESS_PREFIX) || !isValidPeerAddress(from)) {
      return undefined;
    }
    const target = parsePeerAddress(from).target;
    if (!isLocalIpcPath(target) || !target.endsWith('.sock')) return undefined;
    // Registry membership *or* our own directory. Comparing directories alone
    // silently cut off every peer that bound an explicit path or whose
    // XDG_RUNTIME_DIR differs from ours: its model had been told the message was
    // awaiting approval and not to resend, and the answer never came.
    if (!knownPeer && path.dirname(target) !== ownDir) {
      runLogger.debug(
        `[uds-messaging] Receipt skipped: ${from} is not a known peer`,
      );
      return undefined;
    }
    // Returned rather than floated so shutdown settlement can await the batch.
    // `expired` is only ever emitted while tearing down, so it carries the
    // shorter timeout that keeps a dead peer from outliving the exit budget.
    return sendControlFrame(
      target,
      {
        type: 'control',
        action: 'peer_message_status',
        status,
        from: toUdsAddress(socketPath),
        ...(msgId !== undefined && { orig_msg_id: msgId }),
      },
      status === 'expired' ? HOLD_SETTLEMENT_BUDGET_MS : undefined,
    );
  };
}

/**
 * Verifies a socket directory is a real directory this user owns, tightening
 * its mode when it is ours to tighten.
 *
 * The default base is world-writable, so the directory may have been created by
 * someone else moments before us. `lstat` rather than `stat`: a symlink planted
 * at this path reports as a link and is rejected here, instead of being
 * followed so that the bind — and the `unlink` that precedes it — land wherever
 * it points.
 *
 * Verifying rather than tightening is the point. Older code assumed a directory
 * it had not created could be brought into line with a `chmod`; against an
 * unexpected owner or an unexpected type the honest answer is to refuse.
 *
 * Throws rather than returning a flag: the caller already treats a failed
 * directory preparation as "no messaging this session", which is the right
 * outcome here too.
 */
async function ensureOwnPrivateDirectory(directory: string): Promise<void> {
  const stats = await fs.lstat(directory);
  if (!stats.isDirectory()) {
    throw new Error('not a directory');
  }

  const uid = currentUid();
  if (stats.uid !== uid) {
    throw new Error(`owned by uid ${stats.uid}, not ${uid}`);
  }

  if ((stats.mode & 0o777) === 0o700) return;

  // Ours, but looser than it should be — recursive mkdir leaves an existing
  // directory's mode alone, so this is the ordinary upgrade path.
  await fs.chmod(directory, 0o700);
  const tightened = await fs.lstat(directory);
  if ((tightened.mode & 0o777) !== 0o700) {
    throw new Error('mode is still not 0700 after chmod');
  }
}

/**
 * Binds the peer socket.
 *
 * Returns undefined when the socket cannot be bound; callers treat that as
 * "this session has no cross-session capability" and continue.
 */
export async function startUdsMessaging(
  socketPath: string,
  options: StartUdsMessagingOptions,
): Promise<UdsMessagingHandle | undefined> {
  if (!isLocalIpcPath(socketPath)) {
    runLogger.error(`[uds-messaging] Refusing non-local socket path: ${socketPath}`);
    return undefined;
  }

  const directory = path.dirname(socketPath);
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await ensureOwnPrivateDirectory(directory);
  } catch (error) {
    runLogger.error(
      `[uds-messaging] Cannot prepare socket directory ${directory}: ${error}`,
    );
    return undefined;
  }

  const inboundContext: InboundContext = {
    getSessionId: options.getSessionId,
    ownAddress: toUdsAddress(socketPath),
  };
  const openConnections = new Set<net.Socket>();
  const onConnection = (connection: net.Socket) => {
    openConnections.add(connection);
    connection.on('close', () => openConnections.delete(connection));
    attachLineReader(connection, inboundContext);
  };

  // A fresh server per attempt: a `net.Server` whose listen failed is not
  // documented to be reusable, and the retry below needs one either way.
  const bindOnce = async (): Promise<net.Server> => {
    const candidate = net.createServer({ allowHalfOpen: true }, onConnection);
    await new Promise<void>((resolve, reject) => {
      candidate.once('error', reject);
      candidate.listen(socketPath, () => {
        candidate.removeListener('error', reject);
        resolve();
      });
    });
    return candidate;
  };

  const reportBindFailure = (error: unknown): undefined => {
    const code = (error as NodeJS.ErrnoException)?.code;
    const hint =
      code === 'ENAMETOOLONG'
        ? ' — the socket path exceeds the platform limit; set XDG_RUNTIME_DIR to a shorter directory'
        : '';
    runLogger.error(`[uds-messaging] Bind failed for ${socketPath}: ${error}${hint}`);
    return undefined;
  };

  let server: net.Server;
  try {
    server = await bindOnce();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') {
      return reportBindFailure(error);
    }

    // Binding used to start by unlinking the path unconditionally, which let an
    // explicit --messaging-socket-path delete a live session's socket: that
    // session stayed listening on an inode no peer could reach, and every
    // message for it arrived here instead. Same reasoning as
    // ensureOwnPrivateDirectory above — against something that is not ours to
    // remove, refuse rather than force.
    if (await probeSocket(socketPath)) {
      runLogger.error(
        options.isExplicit
          ? `[uds-messaging] --messaging-socket-path is already served by a live session: ${socketPath}`
          : `[uds-messaging] ${socketPath} is served by a live session; not binding`,
      );
      return undefined;
    }

    // An explicit path may name something that is not a socket at all. A default
    // path lives in the directory verified above, where nothing but our own
    // sockets belongs, so only this case needs asking.
    if (options.isExplicit) {
      const stats = await fs.lstat(socketPath).catch(() => undefined);
      if (stats && !stats.isSocket()) {
        runLogger.error(
          `[uds-messaging] --messaging-socket-path exists and is not a socket; refusing to remove it: ${socketPath}`,
        );
        return undefined;
      }
    }

    // Nobody is listening: a leftover from a crashed session, and reclaiming it
    // is the whole point.
    await fs.unlink(socketPath).catch(() => {});
    try {
      server = await bindOnce();
    } catch (retryError) {
      // One retry only. A second EADDRINUSE means someone won the race between
      // our probe and our bind, and taking the path from them is exactly what
      // this is here to stop.
      return reportBindFailure(retryError);
    }
  }

  // Never hold the process open for the listener alone.
  server.unref();
  server.on('error', (error) =>
    runLogger.debug(`[uds-messaging] Server error: ${error}`),
  );

  try {
    await fs.chmod(socketPath, 0o600);
  } catch (error) {
    runLogger.error(
      `[uds-messaging] Cannot restrict socket permissions, refusing to listen: ${error}`,
    );
    server.close();
    await fs.unlink(socketPath).catch(() => {});
    return undefined;
  }

  // Published for our descendants, which inherit it: it tells a child where the
  // session that spawned it listens. Deliberately not read back as this
  // process's own address — a child that never bound inherits this value and no
  // bind-failure path clears it, so `boundMessagingSocket()` is the only honest
  // answer to "where do I listen?". See bound-socket.ts.
  process.env[ENV_MESSAGING_SOCKET] = socketPath;
  setBoundMessagingSocket(socketPath);
  ensureSelfToken();
  setPeerReceiptSink(makeReceiptSink(socketPath));
  runLogger.debug(`[uds-messaging] Listening on ${socketPath}`);

  let closed = false;
  return {
    socketPath,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      setPeerReceiptSink(undefined);
      delete process.env[ENV_MESSAGING_SOCKET];
      setBoundMessagingSocket(undefined);
      // A peer mid-write would otherwise keep server.close() pending.
      for (const connection of openConnections) connection.destroy();
      openConnections.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.unlink(socketPath).catch(() => {});
    },
  };
}

/** Exposed for the send path, which stamps its own mode class on the envelope. */
export { currentModeClass };
