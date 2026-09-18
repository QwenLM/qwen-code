/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * How a session a program drives over ACP puts a held cross-session
 * message in front of a person.
 *
 * A hold is a question: deliver this message to the session, or drop it.
 * ACP already has the one channel for asking a client's user a question —
 * `session/request_permission` — and every client that drives a session
 * renders it: an editor's permission dialog, and through the daemon a
 * `permission_request` event, the pending-interaction list and the vote
 * route. So a held message is asked about the same way, and nothing new
 * has to exist on the other side.
 *
 * The request says what it is in `_meta.qwenInteractionKind` and carries
 * the message details in `rawInput` and `_meta.peerMessage`, for a client
 * that wants to render it as more than a generic approval.
 */

import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import {
  describeHoldCause,
  type HeldMessage,
} from '@qwen-code/qwen-code-core/ipc/inbound-gate.js';
import {
  peerSenderLabel,
  sanitizePeerText,
} from '@qwen-code/qwen-code-core/ipc/peer-envelope.js';

/** The option that delivers a held message to the session. */
export const PEER_DELIVER_OPTION_ID = 'peer_deliver';
/** The option that drops it. */
export const PEER_DROP_OPTION_ID = 'peer_drop';

/** What `_meta.qwenInteractionKind` says a peer review request is. */
export const PEER_MESSAGE_INTERACTION_KIND = 'peer_message';

/**
 * Longest message body shown in a review. The whole message is still
 * what gets delivered; this bounds only what a dialog has to lay out.
 */
export const MAX_PEER_REVIEW_TEXT_CHARS = 2000;

/** How a person answered a review; `cancelled` is no answer at all. */
export type PeerReviewDecision = 'deliver' | 'drop' | 'cancelled';

/** The facts about a held message a review request is built from. */
export interface PeerReviewSubject {
  entry: HeldMessage;
  /** Wall-clock epoch milliseconds, or null when the hold never expires. */
  expiresAt: number | null;
}

/**
 * The details a review carries beyond its title and body, in the shape
 * clients read from `rawInput` and `_meta.peerMessage`.
 */
export interface PeerReviewDetails {
  msgId: string;
  sender: string;
  from?: string;
  fromName?: string;
  origin: 'peer' | 'own-process' | 'controller';
  controller?: string;
  cause: HeldMessage['cause'];
  causeText: string;
  heldAt: number;
  expiresAt: number | null;
}

/** Who sent a held message, as a person should see it. */
export function heldSenderLabel(entry: HeldMessage): string {
  return peerSenderLabel({
    from: entry.frame.from ?? 'unknown session',
    ...(entry.frame.fromName !== undefined
      ? { fromName: entry.frame.fromName }
      : {}),
    ...(entry.controller ? { controller: entry.controller } : {}),
  });
}

export function peerReviewDetails(
  subject: PeerReviewSubject,
): PeerReviewDetails {
  const { entry } = subject;
  return {
    msgId: entry.frame.msgId,
    sender: heldSenderLabel(entry),
    ...(entry.frame.from !== undefined ? { from: entry.frame.from } : {}),
    ...(entry.frame.fromName !== undefined
      ? { fromName: sanitizePeerText(entry.frame.fromName, 200) }
      : {}),
    origin: entry.controller
      ? 'controller'
      : entry.selfSent
        ? 'own-process'
        : 'peer',
    ...(entry.controller ? { controller: entry.controller.label } : {}),
    cause: entry.cause,
    causeText: describeHoldCause(entry.cause, entry.policyScope),
    heldAt: entry.heldAt,
    expiresAt: subject.expiresAt,
  };
}

/**
 * The permission request that asks a client's user about one held
 * message, for the session `sessionId`.
 *
 * The tool call id is derived from the message id, so a client that sees
 * the same message asked about twice can tell it is the same one.
 */
export function buildPeerReviewRequest(
  sessionId: string,
  subject: PeerReviewSubject,
): RequestPermissionRequest {
  const details = peerReviewDetails(subject);
  const expiry =
    subject.expiresAt === null ? {} : { expiresAt: subject.expiresAt };
  return {
    sessionId,
    toolCall: {
      toolCallId: `peer-message:${details.msgId}`,
      title: `Cross-session message: ${details.sender}`,
      kind: 'other',
      status: 'pending',
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: sanitizePeerText(
              subject.entry.frame.message.content,
              MAX_PEER_REVIEW_TEXT_CHARS,
            ),
          },
        },
      ],
      rawInput: { ...details },
      _meta: {
        qwenInteractionKind: PEER_MESSAGE_INTERACTION_KIND,
        peerMessage: { ...details },
        ...expiry,
      },
    },
    options: [
      {
        optionId: PEER_DELIVER_OPTION_ID,
        name: 'Deliver to this session',
        kind: 'allow_once',
      },
      { optionId: PEER_DROP_OPTION_ID, name: 'Drop', kind: 'reject_once' },
    ],
    // On the request as well as the tool call: a host that times requests
    // out reads it here, the one place every request has.
    _meta: { qwenInteractionKind: PEER_MESSAGE_INTERACTION_KIND, ...expiry },
  };
}

/**
 * What a client's answer means. Anything but one of the two offered
 * options — a cancellation, a timeout, an option this request never
 * offered — is no answer, and leaves the message where it is.
 */
export function peerReviewDecision(
  response: RequestPermissionResponse,
): PeerReviewDecision {
  if (response.outcome.outcome !== 'selected') return 'cancelled';
  switch (response.outcome.optionId) {
    case PEER_DELIVER_OPTION_ID:
      return 'deliver';
    case PEER_DROP_OPTION_ID:
      return 'drop';
    default:
      return 'cancelled';
  }
}

/** The key a review is tracked under: one per message and hold. */
export function peerReviewKey(entry: HeldMessage): string {
  return `${entry.frame.msgId}\0${entry.heldAt}`;
}
