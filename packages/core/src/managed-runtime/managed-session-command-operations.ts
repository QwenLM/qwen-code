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
  SessionCommand,
  SessionCommandKind,
} from './managed-session-command-record.js';
import {
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from './managed-session-records.js';

// H4e-b3 of #12827: the pure construction side of the member command
// channel. Every revision body the member, its leader and the control
// plane's message relay commit is built here; the verb funnel in
// packages/cli/src/serve/hosted-session-command-session.ts serializes them
// onto `commitExtensionRecord`. See
// docs/design/2026-10-11-managed-agent-team-member-commands.md.

/**
 * The member mints the command id from its own Session, the collapsed
 * prompt key of its Turn and the call, so the id is unique across Sessions
 * and a re-driven call names the same command again (replay stability).
 * `promptKey` arrives already collapsed the way H4e-b2's call keys are
 * (`hostedPromptKey` in hosted-member-chain.ts).
 */
export function sessionCommandId(params: {
  readonly senderSessionId: string;
  readonly promptKey: string;
  readonly callId: string;
}): string {
  const digest = createHash('sha256')
    .update(`${params.senderSessionId}\0${params.promptKey}\0${params.callId}`)
    .digest('hex');
  return `cmd_${digest.slice(0, 32)}`;
}

function commandRun(
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

/** The member's outbox entry, revision 1: planned, its target unfixed. */
export function outboundCommandBody(params: {
  readonly commandId: string;
  readonly kind: SessionCommandKind;
  readonly childRunId: string;
  readonly senderSessionId: string;
  readonly argsRef: ManagedSessionDurableRef;
  readonly executionCallId: string;
}): SessionCommand {
  return Object.freeze({
    direction: 'outbound',
    commandId: params.commandId,
    route: 'to_parent',
    kind: params.kind,
    childRunId: params.childRunId,
    senderSessionId: params.senderSessionId,
    targetSessionId: null,
    argsRef: params.argsRef,
    argsDigest: params.argsRef.digest,
    replyRef: null,
    replyDigest: null,
    run: commandRun(params.executionCallId, 'planned'),
  });
}

/** The relay claimed the command: the target is fixed at the handover. */
export function outboundCommandHandoverBody(
  previous: SessionCommand,
  targetSessionId: string,
): SessionCommand {
  return Object.freeze({
    ...previous,
    targetSessionId,
    run: commandRun(previous.run.executionCallId, 'accepting'),
  });
}

/**
 * The leader answered the command: the reply is copied back with the
 * `accepted` revision (the relay's `answered` verb).
 */
export function outboundCommandAnsweredBody(
  previous: SessionCommand,
  replyRef: ManagedSessionDurableRef,
): SessionCommand {
  return Object.freeze({
    ...previous,
    replyRef,
    replyDigest: replyRef.digest,
    run: commandRun(previous.run.executionCallId, 'accepted'),
  });
}

/** The parked call read the reply: the outbox entry is consumed. */
export function outboundCommandConsumedBody(
  previous: SessionCommand,
): SessionCommand {
  return Object.freeze({
    ...previous,
    run: commandRun(previous.run.executionCallId, 'consumed'),
  });
}

/** Any other single delivery step of an outbox entry. */
export function outboundCommandFinishedBody(
  previous: SessionCommand,
  state: 'cancelled' | 'rejected' | 'unknown',
): SessionCommand {
  return Object.freeze({
    ...previous,
    run: commandRun(previous.run.executionCallId, state),
  });
}

/**
 * The leader's receipt, revision 1: opens consumed with the reply the
 * leader knew at once. A command that changes nothing (a board read)
 * commits no receipt — only the member's journal keeps that reply.
 */
export function inboundCommandBody(params: {
  readonly commandId: string;
  readonly kind: Exclude<SessionCommandKind, 'board_read'>;
  readonly childRunId: string;
  readonly senderSessionId: string;
  readonly targetSessionId: string;
  readonly argsRef: ManagedSessionDurableRef;
  readonly replyRef: ManagedSessionDurableRef;
}): SessionCommand {
  return Object.freeze({
    direction: 'inbound',
    commandId: params.commandId,
    route: 'to_parent',
    kind: params.kind,
    childRunId: params.childRunId,
    senderSessionId: params.senderSessionId,
    targetSessionId: params.targetSessionId,
    argsRef: params.argsRef,
    argsDigest: params.argsRef.digest,
    replyRef: params.replyRef,
    replyDigest: params.replyRef.digest,
    run: commandRun(null, 'consumed'),
  });
}

/**
 * The reply document, `{ "outcome": "answered" | "refused", "text": "…" }`:
 * `answered` is the call's result, `refused` ends the call with a tool
 * error. A refusal is still a reply. The shape is deliberately closed so
 * the leader-side producer and the member-side reader agree in both
 * languages.
 */
export interface SessionCommandReply {
  readonly outcome: 'answered' | 'refused';
  readonly text: string;
}

export function answeredCommandReply(text: string): SessionCommandReply {
  return Object.freeze({ outcome: 'answered', text });
}

export function refusedCommandReply(text: string): SessionCommandReply {
  return Object.freeze({ outcome: 'refused', text });
}

/**
 * Parses the reply document carried under a `replyRef` resource.
 */
export function parseSessionCommandReply(value: unknown): SessionCommandReply {
  const json = value as { outcome?: unknown; text?: unknown };
  if (
    typeof json !== 'object' ||
    json === null ||
    Object.keys(json).length !== 2 ||
    (json.outcome !== 'answered' && json.outcome !== 'refused') ||
    typeof json.text !== 'string'
  ) {
    throw new ManagedSessionRecordError(
      'Session command reply must be { outcome: answered | refused, text: string }.',
    );
  }
  return Object.freeze({ outcome: json.outcome, text: json.text });
}

/** The reply's serialized form, canonical so both sides digest it alike. */
export function sessionCommandReplyBytes(reply: SessionCommandReply): Buffer {
  return Buffer.from(JSON.stringify(reply), 'utf8');
}

/** Reads the reply resource bytes back into a reply document. */
export function sessionCommandReplyFromBytes(
  bytes: Buffer,
): SessionCommandReply {
  return parseSessionCommandReply(
    JSON.parse(bytes.toString('utf8')) as ManagedSessionJsonValue,
  );
}

/**
 * The runtime's own bound on one member: commands, reads included, one of
 * its runs may ever make. It bounds what a looping model can ask of the
 * relay and of the leader's journal.
 */
export const MANAGED_SESSION_COMMAND_RUNTIME_LIMITS = Object.freeze({
  maxPerRun: 256,
} as const);
