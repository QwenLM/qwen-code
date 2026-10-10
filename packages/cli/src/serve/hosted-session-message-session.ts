/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseChildRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-record.js';
import type { ManagedSessionInputRequest } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { ManagedSessionConflictError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import {
  MANAGED_SESSION_MESSAGE_RUNTIME_LIMITS,
  inboundConsumedBody,
  inboundMessageBody,
  isUndeliveredMessage,
  outboundAcceptedBody,
  outboundDeliveryBody,
  outboundHandoverBody,
  outboundMessageBody,
  sessionMessageInputId,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-operations.js';
import {
  MANAGED_SESSION_MESSAGE_LIMITS,
  parseSessionMessage,
  type SessionMessage,
  type SessionMessageRoute,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-record.js';
import {
  ManagedSessionRecordError,
  type ManagedSessionEvent,
  type ManagedSessionKey,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { escapeXml } from '@qwen-code/qwen-code-core/utils/xml.js';
import {
  boundedNotificationText,
  type HostedChildAgentSession,
  type HostedChildAgentStore,
} from './hosted-child-agent-session.js';
import type { HostedMonitorWakeTurn } from './hosted-monitor-wake.js';

// H4d-b of #12827: the hosted side of durable session messages between a
// parent Session and its child Sessions. A sender commits its outbox entry;
// the control plane's message relay fixes the target at the handover,
// commits the receipt into the target together with the input and wake
// that carry the message, and advances the sender as the target accepts
// and consumes it. Every write rides the child funnel's one writes chain,
// so a message to a child and that child's settlement see one order. See
// docs/design/2026-10-10-managed-session-message-runtime.md.

/** The child funnel's store, plus the journal reads consumption needs. */
export interface HostedSessionMessageStore extends HostedChildAgentStore {
  readonly authority: HostedChildAgentStore['authority'] & {
    readonly committedSequence: number;
    eventsInSequenceRange(
      from: number,
      through: number,
    ): readonly ManagedSessionEvent[];
  };
}

/** The wake input source of a message's carrying input. */
export const SESSION_MESSAGE_INPUT_SOURCE = 'session_message';

/** The lineage a child Session was created with, from its definition. */
export interface HostedSessionLineage {
  readonly parentSessionId: string;
  readonly parentChildRunId: string;
}

/**
 * The target cannot take the message yet: a parent receives a message
 * from its child only once that child's run attached (H4d-a decision 4).
 * The relay holds the message and asks again.
 */
export class SessionMessageNotReadyError extends Error {}

const TRUNCATION_MARKER =
  '\n… (truncated: the full message is on the session message record)';

function digest(record: unknown): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

/** The text a message's carrying input holds, bounded like a notification. */
export function sessionMessageNotificationText(params: {
  readonly messageId: string;
  /** The child task the message came from, or none for the parent. */
  readonly fromTaskId: string | null;
  readonly text: string;
}): string {
  const head = [
    '<session-message>',
    `<message-id>${escapeXml(params.messageId)}</message-id>`,
    params.fromTaskId === null
      ? '<from>parent</from>'
      : `<from>child agent ${escapeXml(params.fromTaskId)}</from>`,
    params.fromTaskId === null
      ? '<reply>To answer, use send_message with to "parent".</reply>'
      : `<reply>To answer, use send_message with task_id "${escapeXml(params.fromTaskId)}".</reply>`,
    '<content>',
  ].join('\n');
  return boundedNotificationText(
    head,
    '</content>\n</session-message>',
    params.text,
    TRUNCATION_MARKER,
  );
}

export class HostedSessionMessageSession {
  constructor(
    private readonly store: HostedSessionMessageStore,
    private readonly key: ManagedSessionKey,
    private readonly children: HostedChildAgentSession,
    /** Present exactly on a child Session, which may message its parent. */
    readonly lineage: HostedSessionLineage | undefined,
  ) {}

  /** The last committed body of one message chain in this journal. */
  message(messageId: string): SessionMessage | undefined {
    const existing = this.store.authority.extensionRecord(
      'session_message',
      messageId,
    );
    return existing ? parseSessionMessage(existing.record) : undefined;
  }

  /**
   * A child's `send_message` to its parent: the outbox entry, before any
   * handover. The control plane checks the lineage at commit, so a Session
   * off its recorded lineage cannot open one.
   */
  async sendToParent(params: {
    readonly text: string;
    readonly messageId: string;
    readonly executionCallId: string;
  }): Promise<void> {
    const lineage = this.lineage;
    if (lineage === undefined) {
      throw new ManagedSessionRecordError(
        'Only a child Session can message its parent.',
      );
    }
    const content = Buffer.from(params.text, 'utf8');
    if (content.byteLength > MANAGED_SESSION_MESSAGE_LIMITS.maxContentBytes) {
      throw new ManagedSessionRecordError(
        `Session message content exceeds ${MANAGED_SESSION_MESSAGE_LIMITS.maxContentBytes} bytes.`,
      );
    }
    await this.children.serialized(async () => {
      const sent = this.message(params.messageId);
      if (sent !== undefined) {
        if (
          sent.direction !== 'outbound' ||
          sent.route !== 'to_parent' ||
          sent.contentDigest !==
            createHash('sha256').update(content).digest('hex')
        ) {
          throw new ManagedSessionConflictError(
            `Session message ${params.messageId} was sent with different evidence.`,
          );
        }
        return;
      }
      const sentBefore = this.store.authority
        .extensionRecordsInDomain('session_message')
        .map((entry) => parseSessionMessage(entry.record))
        .filter(
          (message) =>
            message.direction === 'outbound' &&
            message.childRunId === lineage.parentChildRunId,
        );
      const limits = MANAGED_SESSION_MESSAGE_RUNTIME_LIMITS;
      if (sentBefore.length >= limits.maxPerRun) {
        throw new ManagedSessionRecordError(
          `This Session has sent its parent ${limits.maxPerRun} messages (budget_exhausted).`,
        );
      }
      if (
        sentBefore.filter(isUndeliveredMessage).length >=
        limits.maxInFlightPerRun
      ) {
        throw new ManagedSessionRecordError(
          `This Session has ${limits.maxInFlightPerRun} messages still on their way to its parent (count_limit).`,
        );
      }
      const contentRef = await this.store.resources.publish(
        'managed-message-content',
        content,
      );
      await this.commit(
        outboundMessageBody({
          messageId: params.messageId,
          route: 'to_parent',
          childRunId: lineage.parentChildRunId,
          senderSessionId: this.key.sessionId,
          contentRef,
          executionCallId: params.executionCallId,
        }),
        `${params.messageId}:1`,
        'sendSessionMessage',
      );
    });
  }

  /** The relay fixed the target: planned → accepting, once and identically. */
  handover(messageId: string, targetSessionId: string): Promise<void> {
    return this.revise(messageId, (previous) => {
      const state = previous.run.delivery?.state;
      if (state === 'planned') {
        return outboundHandoverBody(previous, targetSessionId);
      }
      if (
        previous.targetSessionId === targetSessionId &&
        state !== 'cancelled'
      ) {
        return previous;
      }
      throw new ManagedSessionConflictError(
        `Session message ${messageId} cannot be handed to ${targetSessionId} from ${state}.`,
      );
    });
  }

  /** The target committed its receipt: the sender names the carrying input. */
  accepted(messageId: string, inputId: string): Promise<void> {
    // The receipt's input id derives from the message id alone, so any
    // other id is a relay that drifted from it, never the carrying input.
    if (inputId !== sessionMessageInputId(messageId)) {
      return Promise.reject(
        new ManagedSessionRecordError(
          `Session message ${messageId} is carried by ${sessionMessageInputId(messageId)}, not ${inputId}.`,
        ),
      );
    }
    return this.revise(messageId, (previous) => {
      const state = previous.run.delivery?.state;
      if (state === 'accepting' || state === 'unknown') {
        return outboundAcceptedBody(previous, inputId);
      }
      if (
        (state === 'accepted' || state === 'consumed') &&
        previous.inputId === inputId
      ) {
        return previous;
      }
      throw new ManagedSessionConflictError(
        `Session message ${messageId} cannot be accepted from ${state}.`,
      );
    });
  }

  /**
   * The outbox entry's last step: consumed once the target's turn read it,
   * cancelled when it was never handed over, rejected when the handed-over
   * message found its target gone.
   */
  settle(
    messageId: string,
    state: 'consumed' | 'cancelled' | 'rejected' | 'unknown',
  ): Promise<void> {
    // `unknown` is the relay's give-up on a handed-over message whose
    // receipt it could not prove either way.
    const from: Record<typeof state, readonly string[]> = {
      consumed: ['accepted'],
      cancelled: ['planned'],
      rejected: ['accepting', 'unknown'],
      unknown: ['accepting'],
    };
    return this.revise(messageId, (previous) => {
      const current = previous.run.delivery?.state ?? '';
      if (current === state) return previous;
      if (!from[state].includes(current)) {
        throw new ManagedSessionConflictError(
          `Session message ${messageId} cannot reach ${state} from ${current}.`,
        );
      }
      return outboundDeliveryBody(previous, state);
    });
  }

  /**
   * The target's receipt: the content copy, the input that carries it and
   * the wake the authority generates, in one transaction (H4d-a decision
   * 6). A redelivery of the same message answers the committed input; any
   * other content under a taken id conflicts.
   */
  receive(params: {
    readonly messageId: string;
    readonly route: SessionMessageRoute;
    readonly childRunId: string;
    readonly senderSessionId: string;
    readonly content: Buffer;
    readonly contentDigest: string;
  }): Promise<string> {
    return this.children.serialized(async () => {
      const contentDigest = createHash('sha256')
        .update(params.content)
        .digest('hex');
      if (contentDigest !== params.contentDigest) {
        throw new ManagedSessionRecordError(
          `Session message ${params.messageId} content does not match its digest.`,
        );
      }
      let fromTaskId: string | null = null;
      if (params.route === 'to_parent') {
        const run = this.store.authority.extensionRecord(
          'child_run',
          params.childRunId,
        );
        const record = run && parseChildRun(run.record);
        if (record === undefined || record.kind === 'shell') {
          throw new ManagedSessionRecordError(
            'Session message must name a child Session run of this Session.',
          );
        }
        if (record.childSessionId === null) {
          throw new SessionMessageNotReadyError(
            `Child run ${params.childRunId} has not attached yet.`,
          );
        }
        fromTaskId = this.children.taskIdOf(params.childRunId);
      } else if (
        this.lineage?.parentSessionId !== params.senderSessionId ||
        this.lineage.parentChildRunId !== params.childRunId
      ) {
        throw new ManagedSessionRecordError(
          'Session message to a child must follow its recorded lineage.',
        );
      }
      const received = this.message(params.messageId);
      if (received !== undefined) {
        if (
          received.direction !== 'inbound' ||
          received.route !== params.route ||
          received.childRunId !== params.childRunId ||
          received.senderSessionId !== params.senderSessionId ||
          received.contentDigest !== contentDigest
        ) {
          throw new ManagedSessionConflictError(
            `Session message ${params.messageId} was received with different evidence.`,
          );
        }
        return received.inputId!;
      }
      const contentRef = await this.store.resources.publish(
        'managed-message-content',
        params.content,
      );
      const body = inboundMessageBody({
        messageId: params.messageId,
        route: params.route,
        childRunId: params.childRunId,
        senderSessionId: params.senderSessionId,
        targetSessionId: this.key.sessionId,
        contentRef,
      });
      const inputId = sessionMessageInputId(params.messageId);
      const input: ManagedSessionInputRequest = {
        inputId,
        turnId: inputId,
        source: SESSION_MESSAGE_INPUT_SOURCE,
        contentRef: await this.store.resources.publish(
          'managed-input',
          Buffer.from(
            JSON.stringify({
              text: sessionMessageNotificationText({
                messageId: params.messageId,
                fromTaskId,
                text: params.content.toString('utf8'),
              }),
            }),
            'utf8',
          ),
        ),
        deadline: null,
        admissionRef: await this.store.resources.publish(
          'managed-admission',
          Buffer.from('{}', 'utf8'),
        ),
        wakeReason: 'input',
      };
      await this.commit(
        body,
        `${params.messageId}:receive`,
        'receiveSessionMessage',
        input,
      );
      return inputId;
    });
  }

  /**
   * The relay's reconciliation of a receipt that stays accepted: consumed
   * once the turn that read it settled completed (the commit after that
   * turn may have been lost), not yet while it has not settled, and never
   * when it ended otherwise. The call also reloads a Session a replaced
   * Harness no longer holds, so its wake pump reads a waiting message.
   */
  async consume(messageId: string): Promise<void> {
    const receipt = this.message(messageId);
    if (receipt === undefined || receipt.direction !== 'inbound') {
      throw new ManagedSessionRecordError(
        `Session message ${messageId} has no receipt here.`,
      );
    }
    if (receipt.run.delivery?.state === 'consumed') return;
    const authority = this.store.authority;
    const settled = authority
      .eventsInSequenceRange(1, authority.committedSequence)
      .filter(
        (event) =>
          event.kind === 'turn.settled' &&
          event.payload['turnId'] === receipt.inputId,
      )
      .at(-1);
    if (settled === undefined) {
      throw new SessionMessageNotReadyError(
        `Session message ${messageId} has not been read yet.`,
      );
    }
    if (settled.payload['outcome'] !== 'completed') {
      throw new ManagedSessionRecordError(
        `Session message ${messageId}'s turn ended ${String(settled.payload['outcome'])}.`,
      );
    }
    await this.markConsumed(receipt.inputId!);
  }

  /**
   * The wake turn that read a message settled: its receipt moves to
   * consumed. An input that carries no receipt here is not a message's.
   */
  async markConsumed(inputId: string): Promise<void> {
    const receipt = this.store.authority
      .extensionRecordsInDomain('session_message')
      .map((entry) => parseSessionMessage(entry.record))
      .find(
        (message) =>
          message.direction === 'inbound' && message.inputId === inputId,
      );
    if (receipt === undefined) return;
    await this.revise(receipt.messageId, (previous) =>
      previous.run.delivery?.state === 'consumed'
        ? previous
        : inboundConsumedBody(previous),
    );
  }

  private revise(
    messageId: string,
    step: (previous: SessionMessage) => SessionMessage,
  ): Promise<void> {
    return this.children.serialized(async () => {
      const existing = this.store.authority.extensionRecord(
        'session_message',
        messageId,
      );
      if (existing === undefined) {
        throw new ManagedSessionRecordError(
          `Session message ${messageId} has no record to revise.`,
        );
      }
      const previous = parseSessionMessage(existing.record);
      const next = step(previous);
      if (isDeepStrictEqual(previous, next)) return;
      await this.commit(
        next,
        `${messageId}:${existing.revision + 1}`,
        'commitSessionMessage',
      );
    });
  }

  private async commit(
    record: SessionMessage,
    commandId: string,
    operation: string,
    input?: ManagedSessionInputRequest,
  ): Promise<void> {
    await this.store.authority.commitExtensionRecord(
      {
        operation,
        commandId,
        sessionKey: this.key,
        contentDigest: digest(record),
      },
      {
        domain: 'session_message',
        record,
        ...(input === undefined ? {} : { input }),
      },
      { class: 'trusted_entry' },
    );
  }
}

type WakeOutcome =
  | 'settled'
  | 'busy'
  | 'recovery'
  | 'held'
  | 'settled_incomplete';

/**
 * The receipt's consumption follows the wake turn's real settle: a turn
 * that ended incomplete leaves the receipt accepted, owed evidence never
 * widened into consumed (H4b decision 6).
 */
export function withSessionMessageConsumption(
  runWakeTurn: (turn: HostedMonitorWakeTurn) => Promise<WakeOutcome>,
  session: { blocked: boolean; messages?: HostedSessionMessageSession },
  writeStderr: (line: string) => void = () => {},
): (turn: HostedMonitorWakeTurn) => Promise<WakeOutcome> {
  return async (turn) => {
    const outcome = await runWakeTurn(turn);
    if (
      outcome === 'settled' &&
      !session.blocked &&
      turn.source === SESSION_MESSAGE_INPUT_SOURCE &&
      session.messages
    ) {
      try {
        await session.messages.markConsumed(turn.turnId);
      } catch (cause) {
        writeStderr(
          'qwen serve: Hosted session message consumption faltered (receipt stays accepted): ' +
            String(cause),
        );
      }
    }
    return outcome;
  };
}
