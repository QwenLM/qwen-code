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
import { receiverReviewsActions } from './inbound-gate.js';
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
 * The receiver's parity rule asks one question — does the sender still
 * put a human in front of each action? — so the class is the answer to
 * exactly that, using the same predicate the receiving gate applies to
 * itself. Two sessions in the same mode therefore always agree on which
 * class they are in.
 */
export function senderModeClass(mode: ApprovalMode): 'bypass' | 'prompting' {
  return receiverReviewsActions(mode) ? 'prompting' : 'bypass';
}

/** What this session remembers about a message it sent. */
export interface SentPeerMessage {
  /** The address the model used, as list_agents printed it. */
  address: string;
  /** Last receipt applied, or 'pending' before any. */
  state: PeerDeliveryStatus | 'pending';
}

/** A receipt that moved a sent message to a new state. */
export interface SettledPeerReceipt {
  address: string;
  previous: PeerDeliveryStatus | 'pending';
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
  ]),
  // A refusal is decided at admission, so it cannot follow a hold: a
  // message already parked was not turned away. Switching the setting to
  // `refuse` while it sits there settles it as `denied` — someone chose.
  held: new Set(['delivered', 'denied', 'expired', 'misaddressed']),
  delivered: new Set(['expired', 'misaddressed']),
  denied: new Set(),
  refused: new Set(),
  expired: new Set(),
  misaddressed: new Set(),
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
  return { address: entry.address, previous };
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
): void {
  trackSent(msgId, { address, state: 'pending' });
}

/** Test-only: forget every tracked send. */
export function resetSentPeerMessagesForTest(): void {
  sentMessages.clear();
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

  // Tracked before the write, not after: a receiver whose loop is stalled
  // accepts the connection and lets the bytes sit in the kernel buffer,
  // so a send can time out here and still be read — and receipted — once
  // it resumes. Only a failure that proves the frame never arrived
  // forgets it again.
  trackSent(frame.msgId, {
    address,
    state: 'pending',
  });
  try {
    await sendPeerFrame(peer.ipcPath, frame, {
      ...(peer.ipcToken !== undefined ? { authToken: peer.ipcToken } : {}),
    });
    return { kind: 'sent', peer, address };
  } catch (error) {
    if (
      error instanceof PeerSendError &&
      (error.code === 'ENOENT' ||
        error.code === 'ECONNREFUSED' ||
        error.code === 'EMSGSIZE' ||
        // A refused connect (full backlog) and this side's own send cap
        // both mean the frame was never written.
        error.code === 'EAGAIN' ||
        error.code === 'EBUSY')
    ) {
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
        return 'the session accepted the connection but had not read the message after 5 seconds. It may still read it once it is free, so do not assume it was lost; retry once, and if it repeats, that session is stuck and its user should be told.';
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
