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
import { buildUserFrame, canonicalizeMsgId } from './peer-frames.js';
import {
  formatPeerAddress,
  listMessageablePeers,
  peerRef,
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
  if (!record?.ipcPath) return null;
  return {
    ipcPath: record.ipcPath,
    name: record.name,
    sessionId: record.sessionId,
    ref: peerRef(record.sessionId),
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
  peerName: string;
  sentAt: number;
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
 * The send a receipt refers to, if this session made it.
 *
 * A receipt names a message id, and any process that can reach this
 * session's socket can write a receipt for any id. Only ids this session
 * actually sent are answered for, so a stranger's receipts are noise the
 * inbox drops rather than notices the user reads.
 */
export function lookupSentPeerMessage(
  msgId: string,
): SentPeerMessage | undefined {
  return sentMessages.get(canonicalizeMsgId(msgId));
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

  const peers = (await listMessageablePeers()).filter(
    (peer) => peer.ipcPath !== self.ipcPath,
  );
  const resolved = resolvePeerTarget(peers, options.target);

  if (resolved.kind === 'none') {
    // A session can find its own name in list_agents; addressing it is a
    // mistake worth naming, not a silent "no such session".
    if (resolvePeerTarget([self], options.target).kind === 'one') {
      return { kind: 'self', name: self.name };
    }
    return {
      kind: 'not-found',
      suggestions: suggestPeerNames(peers, options.target),
    };
  }
  if (resolved.kind === 'ambiguous') {
    return {
      kind: 'ambiguous',
      matches: resolved.matches.map(
        (peer) => `${peer.name} [${peer.ref}] in ${peer.cwd}`,
      ),
    };
  }

  const peer = resolved.peer;
  const address = formatPeerAddress(peer, peers);
  const frame = buildUserFrame({
    content: options.message,
    from: self.ipcPath,
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

  try {
    await sendPeerFrame(peer.ipcPath, frame);
    trackSent(frame.msgId, {
      address,
      peerName: peer.name,
      sentAt: Date.now(),
    });
    return { kind: 'sent', peer, address };
  } catch (error) {
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
        return 'the session accepted the connection but never read the message.';
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
