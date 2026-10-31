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
import {
  hasPlanModeBlock,
  HostedChildChains,
  hostedFirstInputText,
  hostedOpenTeamChainMember,
  MEMBER_MESSAGE_ID_PREFIX,
} from './hosted-member-chain.js';

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
  /** H4e-b2 decision 6: the member name of a child of the open team. */
  readonly teammate?: string;
  readonly text: string;
}): string {
  const head = [
    '<session-message>',
    `<message-id>${escapeXml(params.messageId)}</message-id>`,
    params.fromTaskId === null
      ? '<from>parent</from>'
      : `<from>child agent ${escapeXml(params.fromTaskId)}</from>`,
    ...(params.teammate === undefined
      ? []
      : [`<teammate>${escapeXml(params.teammate)}</teammate>`]),
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

/**
 * B3c decision 8: the content the lead commits for one member message
 * under its `msgc_` id. The header line is fixed and the name is the
 * lead's word (its roster), never the sending member's.
 */
export function memberMessageContent(from: string, text: string): string {
  return `<member-message from="${from}">\n${text}\n</member-message>`;
}

/** The fixed header/footer slice of the member-message content above. */
const MEMBER_MESSAGE_HEAD =
  /^<member-message from="([a-z0-9]+(?:-[a-z0-9]+)*)">\n/;
const MEMBER_MESSAGE_FOOT = '\n</member-message>';

/**
 * The sender and text of a member message's content, read on the
 * recipient's side: the name comes from the header anchored at the
 * content's start and is limited to the member-name characters. A body
 * without that shape is not a member message — only the lead mints
 * `msgc_` ids, so anything else under one is a fault to fall back on.
 */
export function parseMemberMessageContent(
  content: string,
): { readonly from: string; readonly text: string } | undefined {
  const head = MEMBER_MESSAGE_HEAD.exec(content);
  if (head === null) return undefined;
  const rest = content.slice(head[0].length);
  if (!rest.endsWith(MEMBER_MESSAGE_FOOT)) return undefined;
  return {
    from: head[1]!,
    text: rest.slice(0, rest.length - MEMBER_MESSAGE_FOOT.length),
  };
}

/**
 * B3c decision 8: what a member message's recipient reads — who wrote,
 * how to answer (naming the sender, or `"parent"` while the run is in
 * plan mode), with the header and footer stripped. The wrapper also says
 * the answer to the leader's last instruction still follows in full.
 */
export function memberMessageNotificationText(params: {
  readonly messageId: string;
  readonly member: string;
  readonly text: string;
  readonly planMode: boolean;
}): string {
  const member = escapeXml(params.member);
  const head = [
    '<session-message>',
    `<message-id>${escapeXml(params.messageId)}</message-id>`,
    `<from>member ${member}</from>`,
    params.planMode
      ? `<reply>To answer ${member} while your run is in plan mode, use send_message with to "parent"; then answer the leader's last instruction in full.</reply>`
      : `<reply>To answer ${member}, use send_message with to "${member}"; then answer the leader's last instruction in full.</reply>`,
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
    /** The Session's close began: like a parent's, it sends no more. */
    readonly closing: boolean;
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
      if (params.closing) {
        throw new ManagedSessionRecordError(
          'This Session is closing and sends no more messages.',
        );
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
      await this.store.authority.settlePendingAppend();
      const contentDigest = createHash('sha256')
        .update(params.content)
        .digest('hex');
      if (contentDigest !== params.contentDigest) {
        throw new ManagedSessionRecordError(
          `Session message ${params.messageId} content does not match its digest.`,
        );
      }
      let fromTaskId: string | null = null;
      let teammate: string | undefined;
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
        // H4e-b2 decision 6: a member's message names it while its chain
        // root is on the open team's roster. The reply hint stays H4d-b's
        // task id: a later team may reuse both names, and the task id
        // always reaches the chain that wrote.
        teammate = hostedOpenTeamChainMember(
          this.store.authority.extensionRecordsInDomain('team_state'),
          new HostedChildChains(
            this.store.authority.extensionRecordsInDomain('child_run'),
          ),
          params.childRunId,
        )?.name;
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
      // b3c: a member message (its msgc_ id) renders who wrote it, never
      // the leader it traveled through (decision 8); a malformed header
      // falls back to the leader's form, which only the lead could commit.
      const memberMessage = params.messageId.startsWith(
        MEMBER_MESSAGE_ID_PREFIX,
      )
        ? parseMemberMessageContent(params.content.toString('utf8'))
        : undefined;
      const notificationText =
        memberMessage === undefined ||
        // The name rides the to_parent render; member messages are to_child.
        params.route === 'to_parent'
          ? sessionMessageNotificationText({
              messageId: params.messageId,
              fromTaskId,
              ...(teammate === undefined ? {} : { teammate }),
              text: params.content.toString('utf8'),
            })
          : memberMessageNotificationText({
              messageId: params.messageId,
              member: memberMessage.from,
              text: memberMessage.text,
              planMode: await this.inPlanMode(),
            });
      const input: ManagedSessionInputRequest = {
        inputId,
        turnId: inputId,
        source: SESSION_MESSAGE_INPUT_SOURCE,
        contentRef: await this.store.resources.publish(
          'managed-input',
          Buffer.from(JSON.stringify({ text: notificationText }), 'utf8'),
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
   * b3c decision 9: whether this Session's run is in plan mode — its
   * first input carries an unescaped plan-mode block. One shared reader
   * (R1-10) carries the read; an unreadable body still fails closed:
   * the reply hint that always works is "parent".
   */
  private async inPlanMode(): Promise<boolean> {
    try {
      const text = await hostedFirstInputText(this.store);
      return text !== undefined && hasPlanModeBlock(text);
    } catch {
      return true;
    }
  }

  /**
   * The relay's reconciliation of a receipt that stays accepted: consumed
   * once the turn that read it settled completed (the commit after that
   * turn may have been lost), not yet while it has not settled, and never
   * when it ended otherwise. The call also reloads a Session a replaced
   * Harness no longer holds, so its wake pump reads a waiting message.
   */
  async consume(messageId: string): Promise<void> {
    await this.store.authority.settlePendingAppend();
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
