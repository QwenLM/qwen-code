/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type {
  ExtensionDeliveryState,
  ExtensionRun,
} from './managed-extension-record.js';
import type {
  SessionMessage,
  SessionMessageRoute,
} from './managed-session-message-record.js';
import { MANAGED_SESSION_MESSAGE_LIMITS } from './managed-session-message-record.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';

// H4d-b of #12827: the pure construction side of the session message
// runtime. Every revision body the senders, the receivers and the control
// plane's message relay commit is built here; the verb funnel in
// packages/cli/src/serve/hosted-session-message-session.ts serializes them
// onto `commitExtensionRecord`. See
// docs/design/2026-10-10-managed-session-message-runtime.md.

/**
 * The sender mints the message id from its own Session and the sending
 * call, so the id is unique across Sessions (H4d-a decision 1) and a
 * re-driven call names the same message again.
 */
export function sessionMessageId(params: {
  readonly senderSessionId: string;
  readonly turnId: string;
  readonly callId: string;
}): string {
  const digest = createHash('sha256')
    .update(`${params.senderSessionId}\0${params.turnId}\0${params.callId}`)
    .digest('hex');
  return `msg_${digest.slice(0, 32)}`;
}

/** The input (and wake turn) that carries a message in its target. */
export function sessionMessageInputId(messageId: string): string {
  return `${messageId}:message`;
}

function messageRun(
  executionCallId: string | null,
  state: ExtensionDeliveryState,
): ExtensionRun {
  return Object.freeze({
    state: 'settled',
    reason: null,
    definition: null,
    executionCallId,
    effectId: null,
    dispatchId: null,
    deliveryId: null,
    execution: null,
    runtime: null,
    delivery: Object.freeze({ target: 'session', state }),
  });
}

/** The sender's outbox entry, revision 1: planned, its target unfixed. */
export function outboundMessageBody(params: {
  readonly messageId: string;
  readonly route: SessionMessageRoute;
  readonly childRunId: string;
  readonly senderSessionId: string;
  readonly contentRef: ManagedSessionDurableRef;
  readonly executionCallId: string;
}): SessionMessage {
  return Object.freeze({
    direction: 'outbound',
    messageId: params.messageId,
    route: params.route,
    childRunId: params.childRunId,
    senderSessionId: params.senderSessionId,
    targetSessionId: null,
    contentRef: params.contentRef,
    contentDigest: params.contentRef.digest,
    inputId: null,
    run: messageRun(params.executionCallId, 'planned'),
  });
}

/** The relay claimed the message: the target is fixed at the handover. */
export function outboundHandoverBody(
  previous: SessionMessage,
  targetSessionId: string,
): SessionMessage {
  return Object.freeze({
    ...previous,
    targetSessionId,
    run: messageRun(previous.run.executionCallId, 'accepting'),
  });
}

/** The target committed its receipt: the sender names the carrying input. */
export function outboundAcceptedBody(
  previous: SessionMessage,
  inputId: string,
): SessionMessage {
  return Object.freeze({
    ...previous,
    inputId,
    run: messageRun(previous.run.executionCallId, 'accepted'),
  });
}

/** Any other single delivery step of an outbox entry. */
export function outboundDeliveryBody(
  previous: SessionMessage,
  state: 'consumed' | 'cancelled' | 'rejected',
): SessionMessage {
  return Object.freeze({
    ...previous,
    run: messageRun(previous.run.executionCallId, state),
  });
}

/** The target's receipt, revision 1: accepted together with its input. */
export function inboundMessageBody(params: {
  readonly messageId: string;
  readonly route: SessionMessageRoute;
  readonly childRunId: string;
  readonly senderSessionId: string;
  readonly targetSessionId: string;
  readonly contentRef: ManagedSessionDurableRef;
}): SessionMessage {
  return Object.freeze({
    direction: 'inbound',
    messageId: params.messageId,
    route: params.route,
    childRunId: params.childRunId,
    senderSessionId: params.senderSessionId,
    targetSessionId: params.targetSessionId,
    contentRef: params.contentRef,
    contentDigest: params.contentRef.digest,
    inputId: sessionMessageInputId(params.messageId),
    run: messageRun(null, 'accepted'),
  });
}

/** The receipt's only successor: the turn that read it settled. */
export function inboundConsumedBody(previous: SessionMessage): SessionMessage {
  return Object.freeze({
    ...previous,
    run: messageRun(null, 'consumed'),
  });
}

/** Whether an outbox entry still owes its handover to the target. */
export function isUndeliveredMessage(message: SessionMessage): boolean {
  const state = message.run.delivery?.state;
  return (
    message.direction === 'outbound' &&
    (state === 'planned' || state === 'accepting' || state === 'unknown')
  );
}

/** The bytes a sender may store, before any carrier bound applies. */
export function sessionMessageContentFits(content: Buffer): boolean {
  return content.byteLength <= MANAGED_SESSION_MESSAGE_LIMITS.maxContentBytes;
}
