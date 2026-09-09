/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sending a message to another session on this machine.
 *
 * Kept apart from the tool so the routing decision — is this name a peer
 * at all? — can be made and tested without a tool invocation.
 */

import type { ApprovalMode } from '../config/approval-mode.js';
import { readOwnSessionRecord } from '../services/session-registry.js';
import { modeClass } from './inbound-gate.js';
import {
  hasToken,
  hashBody,
  isBodyWithinWindow,
  PEER_ADMISSION_LIMITS,
  PEER_BURST_WINDOW_MS,
  refillBucket,
} from './peer-admission.js';
import {
  buildUserFrame,
  canonicalizeMsgId,
  type PeerDeliveryStatus,
} from './peer-frames.js';
import {
  advertisablePeerAddress,
  listMessageablePeers,
  resolvePeerTarget,
  suggestPeerNames,
  toPeerSessionInfo,
  type PeerSessionInfo,
} from './peer-directory.js';
import { PeerSendError, sendPeerFrame } from './uds-client.js';

/**
 * This session's own reply address and display name.
 *
 * `ipcPath` is only present once the inbox is bound, which is also the
 * flag for "cross-session messaging is enabled here". Sending without it
 * would produce a message no one can answer, so the absence doubles as
 * the send-side gate.
 */
export interface OwnPeerIdentity {
  ipcPath: string;
  name: string;
  sessionId: string;
  /** The same short handle peers see next to this session's name. */
  ref: string;
}

export async function getOwnPeerIdentity(): Promise<OwnPeerIdentity | null> {
  const record = await readOwnSessionRecord();
  // The same projection peers see, so the name this session reports for
  // itself is the flattened one they would type.
  const self = record === null ? null : toPeerSessionInfo(record);
  if (!self) return null;
  return {
    ipcPath: self.ipcPath,
    name: self.name,
    sessionId: self.sessionId,
    ref: self.ref,
  };
}

/**
 * The approval-mode class this session asserts to a receiver.
 *
 * The receiver's parity rule asks whether the two sessions are in the
 * same review class, so this is the same classification the receiving
 * gate applies to itself. Two sessions in the same mode therefore always
 * agree on which class they are in.
 */
export function senderModeClass(mode: ApprovalMode): 'bypass' | 'prompting' {
  return modeClass(mode);
}

/** What this session remembers about a message it sent. */
export interface SentPeerMessage {
  /** The address the model used, as list_agents printed it. */
  address: string;
  /** Exact socket path the send-side mirror reserved against. */
  ipcPath: string;
  /** When the frame was written, on the pacer's clock. */
  sentAt: number;
  /** Last receipt applied, or 'pending' before any. */
  state: PeerDeliveryStatus | 'pending';
}

/** A receipt that moved a sent message to a new state. */
export interface SettledPeerReceipt {
  address: string;
  ipcPath: string;
  previous: PeerDeliveryStatus | 'pending';
  /**
   * How long ago this session wrote the message the receipt answers.
   *
   * A receiver drops a message the moment it arrives, so this is also
   * the age of the drop — which the receipt itself cannot carry, since a
   * deferred one is written long after the drop it reports. A throttle
   * computed from a wall the receiver has already refilled past is worse
   * than none: it would make the mirror stricter than the session it
   * models, which is the one thing it must never be.
   */
  ageMs: number;
}

/**
 * Bound on remembered sends.
 *
 * A receipt only makes sense while its message could still be pending;
 * the oldest entries are forgotten first, so an unanswered send stops
 * being tracked after this many later ones.
 */
export const MAX_TRACKED_SENDS = 200;

const sentMessages = new Map<string, SentPeerMessage>();

const NEVER_WRITTEN_SEND_CODES = new Set<string | undefined>([
  undefined,
  'ENOENT',
  'ECONNREFUSED',
  'EMSGSIZE',
  'EAGAIN',
  'EBUSY',
]);

function trackSent(msgId: string, info: SentPeerMessage): void {
  const key = canonicalizeMsgId(msgId);
  sentMessages.delete(key);
  sentMessages.set(key, info);
  while (sentMessages.size > MAX_TRACKED_SENDS) {
    const oldest = sentMessages.keys().next().value;
    if (oldest === undefined) break;
    sentMessages.delete(oldest);
  }
}

/**
 * The receipt transitions a sent message can make. A receiver's gate
 * re-sends `held` on a retry and on a failed release, and corrects
 * `delivered` to `expired` when the session exits with the message still
 * queued, and to `misaddressed` when a session swap outruns a queued
 * envelope; everything else is a repeat, and a repeat must not become
 * another line in the user's transcript.
 */
const RECEIPT_TRANSITIONS: Record<
  PeerDeliveryStatus | 'pending',
  ReadonlySet<PeerDeliveryStatus>
> = {
  pending: new Set([
    'held',
    'delivered',
    'denied',
    'refused',
    'expired',
    'misaddressed',
    'dropped',
  ]),
  // A refusal is decided at admission, so it cannot follow a hold: a
  // message already parked was not turned away. Switching the setting to
  // `refuse` while it sits there settles it as `denied` — someone chose.
  //
  // A drop is decided even earlier, before the message is anything to the
  // receiver at all, so it can only ever follow `pending`. A `dropped`
  // receipt naming a message this session already saw held or delivered
  // is answering a *later* frame that reused the id, and applying it
  // would tell the user a message that did arrive never did.
  held: new Set(['delivered', 'denied', 'expired', 'misaddressed']),
  delivered: new Set(['expired', 'misaddressed']),
  denied: new Set(),
  refused: new Set(),
  expired: new Set(),
  misaddressed: new Set(),
  dropped: new Set(),
};

/**
 * Apply a receipt to the send it answers.
 *
 * A receipt names a message id, and any process that can reach this
 * session's socket can write one for any id, any number of times. Only
 * ids this session actually sent are answered for, and only a receipt
 * that moves the message to a new state is reported — so a stranger's
 * receipts, and a peer repeating one, are noise the inbox drops rather
 * than notices the user reads. Returns undefined for both.
 */
export function settleSentPeerMessage(
  msgId: string,
  status: PeerDeliveryStatus,
): SettledPeerReceipt | undefined {
  const entry = sentMessages.get(canonicalizeMsgId(msgId));
  if (!entry || !RECEIPT_TRANSITIONS[entry.state].has(status)) {
    return undefined;
  }
  const previous = entry.state;
  entry.state = status;
  return {
    address: entry.address,
    ipcPath: entry.ipcPath,
    previous,
    ageMs: Math.max(0, pacerWallNow() - entry.sentAt),
  };
}

/**
 * Test-only: the send a receipt refers to, if this session made it.
 *
 * A receipt names a message id, and any process that can reach this
 * session's socket can write a receipt for any id. Only ids this session
 * actually sent are answered for, so a stranger's receipts are noise the
 * inbox drops rather than notices the user reads — production reads that
 * through `settleSentPeerMessage`, which is the only caller that needs to
 * both find the entry and advance it. This is the read-only seam the
 * ledger's own tests observe the private map through; naming it plainly
 * kept reading as an unwired production entry point.
 */
export function lookupSentPeerMessageForTest(
  msgId: string,
): SentPeerMessage | undefined {
  return sentMessages.get(canonicalizeMsgId(msgId));
}

/**
 * Test-only: remember a send the way `sendToPeer` does.
 *
 * The ledger is process-private, and the only production writer is a real
 * delivery over a real socket to a peer in the registry. A test that needs
 * a *settleable* id — one `settleSentPeerMessage` will answer for — would
 * otherwise have to stage a whole peer session to get one. This calls the
 * same `trackSent` the send path calls, so what lands in the map is what a
 * send leaves there; only the trigger is the test.
 */
export function trackSentPeerMessageForTest(
  msgId: string,
  address: string,
  ipcPath = address,
): void {
  trackSent(msgId, {
    address,
    ipcPath,
    sentAt: pacerWallNow(),
    state: 'pending',
  });
}

/** Test-only: forget every tracked send. */
export function resetSentPeerMessagesForTest(): void {
  sentMessages.clear();
}

/**
 * Most targets the pacer meters at once. Same shape and reasoning as the
 * receiver's own sender table.
 */
export const MAX_PACED_TARGETS = 256;

/**
 * This session's model of what each target will accept.
 *
 * The receiver drops what arrives too fast and says so, but that answer
 * comes back over a socket, one round trip later, by which time a model
 * in a loop has sent five more. Mirroring the receiver's bucket here
 * turns that into an answer the sender gets *before* it writes: the send
 * fails, the tool result says to batch, and the receiver never spends a
 * connection on a message it was going to drop.
 *
 * Keyed by socket path rather than by name, with the session id retained
 * in the value. The path is what an inbox is and what the receiver meters
 * by (`from` is the mirror image of this key), while the id detects a new
 * session that reused the same path and therefore owns a fresh bucket.
 *
 * A mirror can only ever be approximate: this session is not the only one
 * sending, and the receiver's bucket is shared. It is deliberately no
 * stricter than the real limit, so it never refuses a send the receiver
 * would have taken; when it turns out to have been optimistic, a
 * `rate-limited` receipt empties it (`drainSendPacer`).
 */
interface PacedBody {
  messageId: string;
  hash: string;
  at: number;
  atWall: number;
  generation: number;
  tokenSpent: boolean;
}

interface PacedTarget {
  sessionId: string;
  tokens: number;
  lastRefill: number;
  /** Sends in the current burst, for the message the refusal carries. */
  sentInBurst: number;
  burstStartedAt: number;
  /**
   * The previous body sent to this target, as the digest the receiver's
   * meter keeps. The receiver drops a repeat of it inside the dedup
   * window without charging the sender's bucket, so the mirror skips the
   * charge for one too; charging would drift the mirror below the real
   * bucket until it refuses sends the receiver would have taken.
   */
  bodies: PacedBody[];
  /**
   * Bumped whenever the mirror's level is set by something other than
   * this session's own arithmetic — a drain, or a fresh entry. A refund
   * carrying an older stamp is answering a question that has since been
   * settled by the receiver, and must not hand a token back.
   */
  generation: number;
}

const pacedTargets = new Map<string, PacedTarget>();

function pacedTargetFor(
  ipcPath: string,
  sessionId: string,
  now: number,
): PacedTarget {
  const existing = pacedTargets.get(ipcPath);
  if (existing?.sessionId === sessionId) {
    pacedTargets.delete(ipcPath);
    pacedTargets.set(ipcPath, existing);
    return existing;
  }
  const generation = (existing?.generation ?? -1) + 1;
  pacedTargets.delete(ipcPath);
  while (pacedTargets.size >= MAX_PACED_TARGETS) {
    let victim: string | undefined;
    for (const [candidate, target] of pacedTargets) {
      const level = refillBucket(
        target.tokens,
        target.lastRefill,
        now,
        PEER_ADMISSION_LIMITS.bucketCapacity,
        PEER_ADMISSION_LIMITS.refillPerSecond,
      );
      if (level >= PEER_ADMISSION_LIMITS.bucketCapacity) {
        victim = candidate;
        break;
      }
    }
    victim ??= pacedTargets.keys().next().value;
    if (victim === undefined) break;
    pacedTargets.delete(victim);
  }
  const fresh: PacedTarget = {
    sessionId,
    tokens: PEER_ADMISSION_LIMITS.bucketCapacity,
    lastRefill: now,
    sentInBurst: 0,
    burstStartedAt: now,
    bodies: [],
    generation,
  };
  pacedTargets.set(ipcPath, fresh);
  return fresh;
}

let pacerNow: () => number = () => performance.now();
let pacerWallNow: () => number = () => Date.now();

/**
 * Test-only: drive the pacer's clock. Pass nothing to restore the
 * monotonic clock production runs on.
 */
export function setSendPacerClockForTest(
  now?: () => number,
  wallNow?: () => number,
): void {
  pacerNow = now ?? (() => performance.now());
  pacerWallNow = wallNow ?? (() => Date.now());
}

/**
 * Take one token for a send of `body` to `ipcPath`, or report that there
 * is none.
 *
 * The refund exists because a token stands for a message the receiver
 * will have to meter, and a frame that was never written is not one. It
 * is idempotent: a caller that refunds twice must not hand itself an
 * extra send.
 */
function reservePacerToken(
  ipcPath: string,
  sessionId: string,
  body: string,
  messageId: string,
):
  | { ok: true; refund: () => void }
  | { ok: false; repeat: true }
  | { ok: false; repeat?: false; sentInBurst: number } {
  const now = pacerNow();
  const wallNow = pacerWallNow();
  const target = pacedTargetFor(ipcPath, sessionId, now);
  target.tokens = refillBucket(
    target.tokens,
    target.lastRefill,
    now,
    PEER_ADMISSION_LIMITS.bucketCapacity,
    PEER_ADMISSION_LIMITS.refillPerSecond,
  );
  target.lastRefill = now;

  target.bodies = target.bodies.filter((record) =>
    isBodyWithinWindow(
      record.at,
      record.atWall,
      now,
      wallNow,
      PEER_ADMISSION_LIMITS.dedupWindowMs,
    ),
  );
  const bodyHash = hashBody(body);
  const lastBody = target.bodies.at(-1);
  if (lastBody?.hash === bodyHash) {
    // The receiver remembers this exact body and will turn it away before
    // policy, so writing it buys a connection there, a line in its drop
    // report and a receipt back — and the caller would be told "sent" for
    // a message that is never read. Nothing sendToPeer writes can reach
    // the receiver's own exemptions (a peer connection is neither a child
    // process nor a controller grant), so refusing here matches its rule
    // rather than exceeding it.
    return { ok: false, repeat: true };
  }

  if (!hasToken(target.tokens)) {
    // Refused before the burst window rolls over, so the count this
    // quotes is the window that emptied the bucket, not a fresh one.
    return { ok: false, sentInBurst: target.sentInBurst };
  }

  // The burst is over once the bucket is whole again, or once enough time
  // has passed that it would have been had nothing been sent. Without
  // this the count in the refusal would grow for the life of the session
  // and stop describing anything a user could act on.
  if (
    target.tokens >= PEER_ADMISSION_LIMITS.bucketCapacity ||
    now - target.burstStartedAt > PEER_BURST_WINDOW_MS
  ) {
    target.sentInBurst = 0;
    target.burstStartedAt = now;
  }

  // Keep each reservation until delivery succeeds or the receiver confirms
  // that exact message never reached its model. Refunds can then remove one
  // failed write without erasing a later send or the body before it.
  const generation = target.generation;

  target.tokens -= 1;
  const record: PacedBody = {
    messageId: canonicalizeMsgId(messageId),
    hash: bodyHash,
    at: now,
    atWall: wallNow,
    generation,
    tokenSpent: true,
  };
  target.bodies.push(record);
  target.sentInBurst += 1;

  let refunded = false;
  return {
    ok: true,
    refund: () => {
      if (refunded) return;
      refunded = true;
      // A drain since the reservation means the receiver has told this
      // session what its level really is. Handing a token back now would
      // silently undo that and write the very message the drain exists to
      // hold back.
      refundPacedRecord(target, record, true);
      forgetPacedBodies(target, [messageId]);
    },
  };
}

/**
 * Empty the mirror for `ipcPath`.
 *
 * Called when a `rate-limited` receipt arrives: the receiver has just
 * proved the mirror was reading high — other senders share that bucket,
 * or the session was already over its limit when this one started. Only
 * the receiver knows the true level, so the honest thing is to assume
 * nothing is left and let it refill at the rate the receiver refills at.
 */
export function drainSendPacer(ipcPath: string): void {
  // Only a target this session has actually paced. A receipt naming
  // anything else would otherwise mint an empty bucket for an address
  // nothing was ever sent to, and the next send there would be refused
  // quoting a burst of zero.
  const target = pacedTargets.get(ipcPath);
  if (target === undefined) return;
  target.tokens = 0;
  target.lastRefill = pacerNow();
  target.generation += 1;
  // The burst count is this session's own — the receiver's level says
  // nothing about how much this session sent — so it is left alone. Nor
  // is `burstStartedAt` re-anchored: a drain is a correction to the
  // level, not the start of a new burst, and re-anchoring it on every
  // receipt would stop the window ever rolling, so the count a refusal
  // quotes as "in the last minute" would grow for the life of the
  // session.
}

/** Remove sends the receiver confirmed never reached its model. */
export function forgetSendPacerMessages(
  ipcPath: string,
  messageIds: readonly string[],
): void {
  const target = pacedTargets.get(ipcPath);
  if (target === undefined) return;
  forgetPacedBodies(target, messageIds);
}

/** Refund a send the receiver proved was addressed to another session. */
export function refundSendPacerMessage(
  ipcPath: string,
  messageId: string,
): void {
  const target = pacedTargets.get(ipcPath);
  if (target === undefined) return;
  const canonicalId = canonicalizeMsgId(messageId);
  const record = target.bodies.find((body) => body.messageId === canonicalId);
  if (record === undefined) return;
  refundPacedRecord(target, record);
  forgetPacedBodies(target, [messageId]);
}

/** Refund a duplicate's token while retaining its body baseline. */
export function refundSendPacerToken(ipcPath: string, messageId: string): void {
  const target = pacedTargets.get(ipcPath);
  if (target === undefined) return;
  const canonicalId = canonicalizeMsgId(messageId);
  const record = target.bodies.find((body) => body.messageId === canonicalId);
  if (record === undefined) return;
  refundPacedRecord(target, record);
}

function refundPacedRecord(
  target: PacedTarget,
  record: PacedBody,
  decrementBurst = false,
): void {
  if (!record.tokenSpent) return;
  record.tokenSpent = false;
  if (decrementBurst) {
    target.sentInBurst = Math.max(0, target.sentInBurst - 1);
  }
  if (record.generation === target.generation) {
    target.tokens = Math.min(
      PEER_ADMISSION_LIMITS.bucketCapacity,
      target.tokens + 1,
    );
  }
}

function forgetPacedBodies(
  target: PacedTarget,
  messageIds: readonly string[],
): void {
  const forgotten = new Set(messageIds.map(canonicalizeMsgId));
  target.bodies = target.bodies.filter(
    (record) => !forgotten.has(record.messageId),
  );
}

/** Test-only: forget what every target has been sent. */
export function resetSendPacerForTest(): void {
  pacedTargets.clear();
}

export type PeerSendOutcome =
  | { kind: 'sent'; peer: PeerSessionInfo; address: string }
  | { kind: 'disabled' }
  | { kind: 'self'; name: string }
  | { kind: 'not-found'; suggestions: string[] }
  | { kind: 'ambiguous'; matches: string[] }
  | { kind: 'failed'; peer: PeerSessionInfo; address: string; reason: string };

export interface SendToPeerOptions {
  target: string;
  message: string;
  /** Current approval mode, asserted to the receiver for mode parity. */
  approvalMode: ApprovalMode | null;
  /**
   * Addresses the caller's own routing keeps in-process (a teammate's
   * name, the broadcast keyword). A peer whose bare name is reserved is
   * reported — in suggestions and in the sent address — as `name [ref]`,
   * the form that reaches it.
   */
  isReserved?: (address: string) => boolean;
}

/**
 * Resolve `target` against the reachable peers and deliver `message`.
 *
 * Every failure is a described outcome rather than a thrown error: the
 * caller renders all of them to a model, and each one has a different
 * next step (turn the feature on, fix the name, add a ref, retry).
 */
export async function sendToPeer(
  options: SendToPeerOptions,
): Promise<PeerSendOutcome> {
  const own = await readOwnSessionRecord();
  const self = own === null ? null : toPeerSessionInfo(own);
  if (!self) return { kind: 'disabled' };

  const directory = await listMessageablePeers();
  // Exclude every incarnation of this session, not just its own socket:
  // the registry is keyed by PID, and `qwen --resume <id>` from a second
  // pane runs the same session id under another process — differently
  // named when resumed from another directory. The receiver's gate
  // accepts a frame pinned to its own id, so such a twin would deliver a
  // message right back to this session while the ledger reads delivered.
  const peers = directory.filter(
    (peer) =>
      peer.ipcPath !== self.ipcPath && peer.sessionId !== self.sessionId,
  );
  const resolved = resolvePeerTarget(peers, options.target);

  if (resolved.kind === 'none') {
    // A session can find its own name — or a twin's — in list_agents;
    // addressing it is a mistake worth naming, not a silent "no such
    // session".
    const incarnations = [
      self,
      ...directory.filter((peer) => peer.sessionId === self.sessionId),
    ];
    if (resolvePeerTarget(incarnations, options.target).kind !== 'none') {
      return { kind: 'self', name: self.name };
    }
    return {
      kind: 'not-found',
      suggestions: suggestPeerNames(
        peers,
        options.target,
        undefined,
        options.isReserved,
      ),
    };
  }
  if (resolved.kind === 'ambiguous') {
    return {
      kind: 'ambiguous',
      // Round-trip every address before printing it. `name [ref]` is the
      // form the caller is told to retry with, but two sessions can share
      // both — one name over a 6-hex ref collision — and then this list
      // prints one string twice and the retry it advises resolves straight
      // back to this branch. `advertisablePeerAddress` is the same
      // uniqueness check `list_agents` prints through, so an entry that
      // survives it is an address the retry can actually use.
      matches: resolved.matches.map((peer) => {
        const address = advertisablePeerAddress(
          peer,
          peers,
          options.isReserved,
        );
        return address === undefined
          ? `${peer.name} [${peer.ref}] in ${peer.cwd} — no address reaches ` +
              `this one while its twin is running`
          : `${address} in ${peer.cwd}`;
      }),
    };
  }

  const peer = resolved.peer;
  // The address the ledger remembers is the one list_agents would print:
  // a receipt that names an address which re-resolves ambiguous — or that
  // the listing never showed — sends the model in circles.
  //
  // When no advertisable form exists, the caller's own target is the one
  // address known to reach this peer: `resolved.kind === 'one'` says it
  // just resolved here uniquely, and a reserved target would have been
  // routed in-process before reaching this function. A synthesized
  // `[ref]` had neither guarantee — it is exactly the form
  // `advertisablePeerAddress` may have just rejected.
  const address =
    advertisablePeerAddress(peer, peers, options.isReserved) ??
    options.target.trim();
  // The wire contract drops frames with empty content silently, and no
  // receipt can ever follow; reporting such a write as sent would strand
  // the ledger entry pending and tell the model not to re-send.
  if (options.message.length === 0) {
    return {
      kind: 'failed',
      peer,
      address,
      reason:
        'the message is empty — there is nothing to deliver. Say what to send.',
    };
  }
  // Refused here rather than dropped there. The receiver would turn this
  // message away, and the only thing writing it anyway buys is a wasted
  // connection and an answer that arrives too late for a model already
  // composing the next one. Failing now puts the reason where the caller
  // will read it: batch, or wait.
  const frame = buildUserFrame({
    content: options.message,
    from: self.ipcPath,
    // Our own inbox token, so the receiver's receipts authenticate back.
    ...(self.ipcToken !== undefined ? { replyToken: self.ipcToken } : {}),
    fromName: self.name,
    // Pin the frame to the session the name resolved to. The address is
    // keyed by PID, and PIDs get reused: if that session has since been
    // replaced by another one at the same path, the receiver sees the
    // mismatch and refuses rather than acting on a message meant for its
    // predecessor.
    toSessionId: peer.sessionId,
    ...(options.approvalMode !== null
      ? { fromMode: senderModeClass(options.approvalMode) }
      : {}),
  });
  const reservation = reservePacerToken(
    peer.ipcPath,
    peer.sessionId,
    options.message,
    frame.msgId,
  );
  if (!reservation.ok) {
    return {
      kind: 'failed',
      peer,
      address,
      reason: reservation.repeat
        ? `that exact message went to that session within the last ${PEER_ADMISSION_LIMITS.dedupWindowMs / 1000} seconds, and its ` +
          'inbox turns away a repeat before anyone reads it, so this one was not sent. ' +
          'Say something different, or wait for a reply rather than re-sending.'
        : reservation.sentInBurst === 0
          ? 'that session inbox is still over its rate limit, so this message was not sent. Wait a little before sending more.'
          : `too many messages to that session just now: ${reservation.sentInBurst} were sent ` +
            `in the last ${PEER_BURST_WINDOW_MS / 1000} seconds and more would be dropped by its rate limit, so this one was ` +
            'not sent. Batch what remains into one message, or wait a little before sending more.',
    };
  }

  // Tracked before the write, not after: a receiver whose loop is stalled
  // accepts the connection and lets the bytes sit in the kernel buffer,
  // so a send can time out here and still be read — and receipted — once
  // it resumes. Only a failure that proves the frame never arrived
  // forgets it again.
  trackSent(frame.msgId, {
    address,
    ipcPath: peer.ipcPath,
    sentAt: pacerWallNow(),
    state: 'pending',
  });
  try {
    await sendPeerFrame(peer.ipcPath, frame, {
      ...(peer.ipcToken !== undefined ? { authToken: peer.ipcToken } : {}),
    });
    return { kind: 'sent', peer, address };
  } catch (error) {
    const definitelyUnwritten =
      error instanceof PeerSendError &&
      NEVER_WRITTEN_SEND_CODES.has(error.code);
    if (definitelyUnwritten) {
      reservation.refund();
      sentMessages.delete(canonicalizeMsgId(frame.msgId));
    }
    return {
      kind: 'failed',
      peer,
      address,
      reason: describeSendFailure(error),
    };
  }
}

/**
 * Turn an errno into something a model can act on.
 *
 * The distinction that matters: a stale address means "re-discover", a
 * busy pipe means "retry the same address". Collapsing both into "send
 * failed" makes the model guess.
 */
export function describeSendFailure(error: unknown): string {
  if (error instanceof PeerSendError) {
    switch (error.code) {
      case 'ENOENT':
      case 'ECONNREFUSED':
        return 'that session just exited — its address is stale. List the agents again to see who is reachable now.';
      case 'EAGAIN':
      case 'EBUSY':
        return 'the session is alive but momentarily busy. Retry the same name shortly.';
      case 'ETIMEDOUT':
        return 'the session accepted the connection but had not read the message after 5 seconds. It may still read it once it is free, so do not assume it was lost or resend the same message; wait for a delivery receipt, then tell that session user if none arrives.';
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
