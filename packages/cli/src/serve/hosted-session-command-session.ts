/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ManagedSessionConflictError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import {
  answeredCommandReply,
  inboundCommandBody,
  MANAGED_SESSION_COMMAND_RUNTIME_LIMITS,
  outboundCommandAnsweredBody,
  outboundCommandBody,
  outboundCommandConsumedBody,
  outboundCommandFinishedBody,
  outboundCommandHandoverBody,
  refusedCommandReply,
  sessionCommandReplyFromBytes,
  type SessionCommandReply,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-command-operations.js';
import {
  MANAGED_SESSION_COMMAND_LIMITS,
  parseSessionCommand,
  type SessionCommand,
  type SessionCommandKind,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-command-record.js';
import {
  isChildSessionRun,
  parseChildRun,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-record.js';
import { MANAGED_CHILD_LIMITS } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-operations.js';
import { MANAGED_SESSION_MESSAGE_RUNTIME_LIMITS } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-operations.js';
import {
  assertManagedSessionDomainEnabled,
  ManagedSessionRecordError,
  type ManagedSessionKey,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { sanitizeName } from '@qwen-code/qwen-code-core/agents/team/teamHelpers.js';
import {
  type HostedChildAgentSession,
  type HostedChildAgentStore,
} from './hosted-child-agent-session.js';
import {
  memberMessageContent,
  type HostedSessionLineage,
} from './hosted-session-message-session.js';
import {
  HOSTED_BROADCAST_POSITIONS,
  HOSTED_MEMBER_MESSAGE_IN_FLIGHT,
  HOSTED_MEMBER_MESSAGE_PER_RUN,
  HostedChildChains,
  hostedMemberView,
  hostedOpenTeamChainMember,
  memberMessageId,
} from './hosted-member-chain.js';
import {
  HostedTeamRefusal,
  type HostedTeamSession,
} from './hosted-team-session.js';

// H4e-b3 of #12827: the command channel a member Session takes to its
// leader. The member commits its outbound entry and parks; the control
// plane's message relay fixes the target at the handover (`handover`),
// drives the leader's `execute`, and copies the reply back (`answered`).
// The leader's `execute` runs on this funnel too: an already committed
// receipt answers first, half-applied board writes re-validate or commit
// their remaining places, and a fresh command gates on the member being
// a live chain head of the open team. Every write rides the children
// funnel's one writes chain. See
// docs/design/2026-10-11-managed-agent-team-member-commands.md.

const ARGS_RESOURCE_KIND = 'managed-command-args';
const REPLY_RESOURCE_KIND = 'managed-command-reply';

/**
 * Decision 4's timeout lock: once one command call of a Turn timed out,
 * every later command call of that Turn refuses at once, so a Turn never
 * holds the mount through a string of waits.
 */
export const SESSION_COMMAND_LEADER_UNANSWERING_TEXT =
  'The leader is not answering; end your turn.';

/**
 * Decision 14's member-facing answer of a command that ended without a
 * reply — the live wait's arm, the resumed wait and the interrupted-turn
 * settle all say exactly this, word for word.
 */
export function sessionCommandEvidenceText(
  state: 'planned' | 'accepting' | 'rejected' | 'cancelled' | 'unknown',
  kind: SessionCommandKind = 'board_write',
): string {
  switch (state) {
    case 'planned':
      return 'The leader did not take the command before the wait ended; it was not sent and nothing happened. Send it again in a fresh turn.';
    case 'accepting':
      if (kind === 'member_message')
        return 'The message reached the leader, but its reply did not arrive in time; some recipients may already have it or get it later. Do not send it again; end your turn and say so in your result.';
      return 'The command reached the leader, but its reply did not arrive in time; a write may have taken effect. End your turn and say so in your result; read the board again before repeating the write.';
    case 'rejected':
      return 'The leader rejected the command; it was not run.';
    case 'cancelled':
      return 'The command was cancelled before it ran; it never left.';
    default:
      if (kind === 'member_message')
        return "The message's outcome is unknown; some recipients may already have it or get it later. Do not send it again.";
      return "The command's outcome is unknown; the leader may have run it and a write may have taken effect. Read the board again before repeating the write.";
  }
}

/**
 * The lead cannot accept the command at all — a lineage or evidence
 * mismatch. The route maps it to `session_command_refused`, and the relay
 * walks such an entry into `rejected`, never re-executing it.
 */
export class SessionCommandRefusalError extends Error {}

/**
 * The command cannot run yet: its sender's run exists but has not
 * attached. The relay's execute may outrun the control plane's attach
 * commit, so this is a wait, never a rejection — the route maps it to
 * `session_command_blocked` and the relay defers without an attempt.
 */
export class SessionCommandBlockedError extends Error {}

function digest(record: unknown): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

/**
 * A reply is at most 64 KiB AS STORED — the receipt commits the
 * JSON.stringify of its outcome-and-text envelope, so the cut is
 * measured on the escape-hungry serialized form, never on the raw text:
 * a lone `\` costs one byte raw and two in JSON, and control characters
 * gain even more. The marker itself joins the budget, and the loop
 * floor (an empty head) always fits.
 */
function cutCommandReplyText(text: string): string {
  const max = MANAGED_SESSION_COMMAND_LIMITS.maxReplyBytes;
  const envelopeOf = (candidate: string): number =>
    Buffer.byteLength(
      JSON.stringify({ outcome: 'answered', text: candidate }),
      'utf8',
    );
  if (envelopeOf(text) <= max) return text;
  const marker = '\n… (the reply grew past its size limit and was cut)';
  // The escape ratio of the untried text estimates the raw budget; an
  // escaping tail can overshoot it, so each pass re-measures the
  // serialized envelope and shrinks until it fits. The estimate lands
  // inside on the first pass for anything but an all-escape tail.
  let budget = Math.max(
    0,
    Math.floor((Buffer.byteLength(text, 'utf8') * max) / envelopeOf(text)),
  );
  for (;;) {
    const head =
      budget > 0
        ? new TextDecoder()
            .decode(Buffer.from(text, 'utf8').subarray(0, budget))
            .replace(/\uFFFD+$/, '')
        : '';
    const candidate = head + marker;
    if (envelopeOf(candidate) <= max) return candidate;
    const overshoot = envelopeOf(candidate) - max;
    budget = Math.max(0, budget - Math.ceil(overshoot / 2) - 1);
  }
}

export class HostedSessionCommandSession {
  constructor(
    private readonly store: HostedChildAgentStore,
    private readonly key: ManagedSessionKey,
    private readonly children: HostedChildAgentSession,
    /** Present exactly on a child Session, which may command its parent. */
    readonly lineage: HostedSessionLineage | undefined,
  ) {}

  /** The last committed body of one command chain in this journal. */
  command(commandId: string): SessionCommand | undefined {
    const existing = this.store.authority.extensionRecord(
      'session_command',
      commandId,
    );
    return existing ? parseSessionCommand(existing.record) : undefined;
  }

  /** Every command chain in this journal. */
  commands(): readonly SessionCommand[] {
    return this.store.authority
      .extensionRecordsInDomain('session_command')
      .map((entry) => parseSessionCommand(entry.record));
  }

  /**
   * The wait bound's anchor (decision 4): when this journal committed the
   * command's outbound entry, read from the commit event itself so a
   * resumed wait measures what is left, never a fresh bound. The store's
   * narrowed view stops at commits; the anchor is a journal event read,
   * taken through the authority it actually is.
   */
  outboundCommittedAt(commandId: string): number | undefined {
    const authority = this.store.authority as unknown as {
      eventsInSequenceRange(
        from: number,
        through: number,
      ): ReadonlyArray<{
        readonly kind: string;
        readonly occurredAt: number;
        readonly payload: Record<string, unknown>;
      }>;
      readonly committedSequence: number;
    };
    for (const event of authority.eventsInSequenceRange(
      1,
      authority.committedSequence,
    )) {
      if (
        event.kind === 'domain.committed' &&
        event.payload['domain'] === 'session_command' &&
        event.payload['operationId'] === `${commandId}:1`
      ) {
        return event.occurredAt;
      }
    }
    return undefined;
  }

  /**
   * A member's board read/write: the outbound `planned` entry, committed
   * before the call begins waiting, so recovery re-enters it even when
   * the Turn crashes right after. A re-driven call names the same
   * `commandId` with the same kind and arguments and replays.
   */
  async runCommand(params: {
    readonly commandId: string;
    readonly kind: SessionCommandKind;
    readonly args: Record<string, unknown>;
    readonly executionCallId: string;
    /** The member's Session is closing: no more commands. */
    readonly closing: boolean;
  }): Promise<void> {
    const lineage = this.lineage;
    if (lineage === undefined) {
      throw new ManagedSessionRecordError(
        'Only a child Session can command its parent.',
      );
    }
    const argsBytes = Buffer.from(JSON.stringify(params.args), 'utf8');
    if (argsBytes.byteLength > MANAGED_SESSION_COMMAND_LIMITS.maxArgsBytes) {
      throw new ManagedSessionRecordError(
        `Session command arguments exceed ${MANAGED_SESSION_COMMAND_LIMITS.maxArgsBytes} bytes (byte_limit).`,
      );
    }
    await this.children.serialized(async () => {
      await this.store.authority.settlePendingAppend();
      const sent = this.command(params.commandId);
      if (sent !== undefined) {
        if (
          sent.direction !== 'outbound' ||
          sent.kind !== params.kind ||
          sent.argsDigest !== digest(params.args)
        ) {
          throw new ManagedSessionConflictError(
            `Session command ${params.commandId} was sent with different evidence.`,
          );
        }
        return;
      }
      if (params.closing) {
        throw new ManagedSessionRecordError(
          'This Session is closing and takes no more commands.',
        );
      }
      if (params.kind === 'plan_submit') {
        for (const prior of this.commands()) {
          if (
            prior.direction !== 'outbound' ||
            prior.kind !== 'plan_submit' ||
            prior.childRunId !== lineage.parentChildRunId
          )
            continue;
          const state = prior.run.delivery?.state;
          if (state === 'cancelled' || state === 'rejected') continue;
          if (state === 'accepted' || state === 'consumed') {
            const reply = await this.readReply(prior.commandId);
            if (reply?.outcome === 'refused') continue;
          }
          throw new ManagedSessionRecordError(
            'This run already submitted a plan whose acceptance is confirmed or unresolved; end your turn and wait for the leader.',
          );
        }
      }
      const volume = this.commands().filter(
        (command) =>
          command.direction === 'outbound' &&
          command.childRunId === lineage.parentChildRunId,
      ).length;
      if (volume >= MANAGED_SESSION_COMMAND_RUNTIME_LIMITS.maxPerRun) {
        throw new ManagedSessionRecordError(
          `This Session has issued ${MANAGED_SESSION_COMMAND_RUNTIME_LIMITS.maxPerRun} commands on this run (budget_exhausted).`,
        );
      }
      const argsRef = await this.store.resources.publish(
        ARGS_RESOURCE_KIND,
        argsBytes,
      );
      await this.commit(
        outboundCommandBody({
          commandId: params.commandId,
          kind: params.kind,
          childRunId: lineage.parentChildRunId,
          senderSessionId: this.key.sessionId,
          argsRef,
          executionCallId: params.executionCallId,
        }),
        `${params.commandId}:1`,
        'sendSessionCommand',
      );
    });
  }

  /** The relay fixed the target: planned → accepting, once and identically. */
  async handover(commandId: string, targetSessionId: string): Promise<void> {
    if (
      this.lineage !== undefined &&
      targetSessionId !== this.lineage.parentSessionId
    ) {
      throw new ManagedSessionConflictError(
        `Session command ${commandId} names ${targetSessionId}, not this Session's parent.`,
      );
    }
    return this.revise(commandId, (previous) => {
      const state = previous.run.delivery?.state;
      if (state === 'planned') {
        return outboundCommandHandoverBody(previous, targetSessionId);
      }
      if (
        previous.targetSessionId === targetSessionId &&
        state !== 'cancelled'
      ) {
        return previous;
      }
      throw new ManagedSessionConflictError(
        `Session command ${commandId} cannot be handed to ${targetSessionId} from ${state}.`,
      );
    });
  }

  /**
   * The relay copied the leader's reply back: the outbound moves to
   * `accepted` with the reply pair. Checked one byte at a time so the
   * stored evidence is the leader's reply, never the relay's paraphrase.
   */
  async answered(commandId: string, reply: SessionCommandReply): Promise<void> {
    const replyBytes = Buffer.from(JSON.stringify(reply), 'utf8');
    if (replyBytes.byteLength > MANAGED_SESSION_COMMAND_LIMITS.maxReplyBytes) {
      throw new SessionCommandRefusalError(
        `Session command reply exceeds ${MANAGED_SESSION_COMMAND_LIMITS.maxReplyBytes} bytes (byte_limit).`,
      );
    }
    const replyDigest = createHash('sha256').update(replyBytes).digest('hex');
    await this.children.serialized(async () => {
      await this.store.authority.settlePendingAppend();
      const existing = this.store.authority.extensionRecord(
        'session_command',
        commandId,
      );
      if (existing === undefined) {
        throw new ManagedSessionRecordError(
          `Session command ${commandId} has no record to revise.`,
        );
      }
      const previous = parseSessionCommand(existing.record);
      const state = previous.run.delivery?.state;
      if (
        (state === 'accepted' || state === 'consumed') &&
        previous.replyDigest === replyDigest
      ) {
        return;
      }
      if (state !== 'accepting' && state !== 'unknown') {
        throw new ManagedSessionConflictError(
          `Session command ${commandId} cannot be answered from ${state}.`,
        );
      }
      const replyRef = await this.store.resources.publish(
        REPLY_RESOURCE_KIND,
        replyBytes,
      );
      await this.commit(
        outboundCommandAnsweredBody(previous, replyRef),
        `${commandId}:${existing.revision + 1}`,
        'commitSessionCommand',
      );
    });
  }

  /**
   * The outbox entry's terminal step: `rejected`, `unknown`, or
   * `cancelled` at the relay's give-up or the tool turn's timeout
   * withdrawal. `cancelled` happens only before the handover; `unknown`
   * and `rejected` only after.
   */
  settle(
    commandId: string,
    state: 'cancelled' | 'rejected' | 'unknown',
  ): Promise<void> {
    const from: Record<typeof state, readonly string[]> = {
      cancelled: ['planned'],
      rejected: ['accepting', 'unknown'],
      unknown: ['accepting'],
    };
    return this.revise(commandId, (previous) => {
      const current = previous.run.delivery?.state ?? '';
      if (current === state) return previous;
      if (!from[state].includes(current)) {
        throw new ManagedSessionConflictError(
          `Session command ${commandId} cannot reach ${state} from ${current}.`,
        );
      }
      return outboundCommandFinishedBody(previous, state);
    });
  }

  /**
   * The parked call read the reply: the outbox entry is consumed, ending
   * the command for everyone. Calls that ended by timeout, refusal or
   * give-up never call this.
   */
  commitConsumed(commandId: string): Promise<void> {
    return this.revise(commandId, (previous) => {
      const state = previous.run.delivery?.state;
      if (state === 'accepted') return outboundCommandConsumedBody(previous);
      if (state === 'consumed') return previous;
      throw new ManagedSessionConflictError(
        `Session command ${commandId} cannot be consumed from ${state}.`,
      );
    });
  }

  /**
   * The parked call's view: the reply when `answered` landed, null while
   * the relay owes one or while the wait ended by timeout, refusal or
   * give-up.
   */
  async readReply(commandId: string): Promise<SessionCommandReply | null> {
    const command = this.command(commandId);
    if (command === undefined || command.direction !== 'outbound') {
      return null;
    }
    const state = command.run.delivery?.state;
    if (
      (state !== 'accepted' && state !== 'consumed') ||
      command.replyRef === null
    ) {
      return null;
    }
    return sessionCommandReplyFromBytes(
      await this.store.resources.read(command.replyRef),
    );
  }

  /**
   * The leader's receipt for an executing command, committed after the
   * run completes. `execute`'s idempotence anchor: a later `execute`
   * finds it and refetches the stored reply rather than recommitting.
   */
  async commitInboundReceipt(params: {
    readonly commandId: string;
    readonly kind: Exclude<SessionCommandKind, 'board_read'>;
    readonly childRunId: string;
    readonly senderSessionId: string;
    readonly args: Record<string, unknown>;
    readonly reply: SessionCommandReply;
  }): Promise<void> {
    await this.children.serialized(async () => {
      await this.store.authority.settlePendingAppend();
      const existing = this.command(params.commandId);
      if (existing !== undefined) {
        if (
          existing.direction !== 'inbound' ||
          existing.kind !== params.kind ||
          existing.replyDigest !== digest(params.reply)
        ) {
          throw new ManagedSessionConflictError(
            `Session command ${params.commandId} was answered with different evidence.`,
          );
        }
        return;
      }
      const argsRef = await this.store.resources.publish(
        ARGS_RESOURCE_KIND,
        Buffer.from(JSON.stringify(params.args), 'utf8'),
      );
      const replyRef = await this.store.resources.publish(
        REPLY_RESOURCE_KIND,
        Buffer.from(JSON.stringify(params.reply), 'utf8'),
      );
      await this.commit(
        inboundCommandBody({
          commandId: params.commandId,
          kind: params.kind,
          childRunId: params.childRunId,
          senderSessionId: params.senderSessionId,
          targetSessionId: this.key.sessionId,
          argsRef,
          replyRef,
        }),
        `${params.commandId}:receipt`,
        'commitSessionCommandReceipt',
      );
    });
  }

  /**
   * `execute`'s first check: an inbound receipt for `commandId` exists and
   * its stored reply is the answer, again.
   */
  async existingReply(
    commandId: string,
  ): Promise<SessionCommandReply | undefined> {
    const receipt = this.command(commandId);
    if (
      receipt === undefined ||
      receipt.direction !== 'inbound' ||
      receipt.replyRef === null
    ) {
      return undefined;
    }
    return sessionCommandReplyFromBytes(
      await this.store.resources.read(receipt.replyRef),
    );
  }

  /**
   * Decision 3: the lead's execution of one command, run on this lead
   * Session's funnels with no model Turn and no lineage. Its answer is
   * derived in three steps, each replay-stable:
   *
   * 1. a committed inbound receipt answers again, stored byte for byte;
   * 2. otherwise any board write the command itself committed (its derived
   *    ids) is found, and what remains re-validates against the current
   *    board — places that no longer fit are named "Not committed";
   * 3. otherwise the fresh admission gates: the sender must be a member
   *    of an open team, on the running, unstopped head of its chain.
   *
   * A board read commits no receipt: it changes nothing and a re-run may
   * answer a newer board. A board write commits its receipt under the
   * same commandId, refused replies included. A `member_message` rides
   * decision 8's sends through the same three steps, its receipt
   * committed like a write; `plan_submit` (b3d) is refused
   * deterministically.
   */
  async execute(
    teams: HostedTeamSession,
    params: {
      readonly commandId: string;
      readonly kind: SessionCommandKind;
      readonly childRunId: string;
      readonly senderSessionId: string;
      readonly args: Record<string, unknown>;
    },
  ): Promise<SessionCommandReply> {
    const existing = await this.existingReply(params.commandId);
    if (existing !== undefined) return existing;
    // The H4d-b inbound rule: the run must be this Session's own child
    // run, attached (once) to the sender. A relay that names anything
    // else has its own bookkeeping bug, so the command is rejected, never
    // run. A run that attached and since settled still proves its sender —
    // its fresh commands fail the running gate below instead.
    const runRecord = this.store.authority.extensionRecord(
      'child_run',
      params.childRunId,
    );
    const parsed =
      runRecord === undefined ? undefined : parseChildRun(runRecord.record);
    const child =
      parsed !== undefined && isChildSessionRun(parsed) ? parsed : undefined;
    if (child !== undefined && child.childSessionId === null) {
      throw new SessionCommandBlockedError(
        `Session command ${params.commandId} names a run that has not attached yet.`,
      );
    }
    if (
      child === undefined ||
      child.childSessionId !== params.senderSessionId
    ) {
      throw new SessionCommandRefusalError(
        `Session command ${params.commandId} names no run of this Session attached to ${params.senderSessionId}.`,
      );
    }
    const receipt = async (
      reply: SessionCommandReply,
    ): Promise<SessionCommandReply> => {
      if (params.kind !== 'board_read') {
        await this.commitInboundReceipt({
          commandId: params.commandId,
          kind: params.kind as Exclude<SessionCommandKind, 'board_read'>,
          childRunId: params.childRunId,
          senderSessionId: params.senderSessionId,
          args: params.args,
          reply,
        });
      }
      return reply;
    };
    if (params.kind === 'plan_submit') {
      try {
        if (teams.plan(params.commandId) === undefined)
          assertManagedSessionDomainEnabled('team_plan');
      } catch (cause) {
        if (!(cause instanceof ManagedSessionRecordError)) throw cause;
        if (teams.supersededPlan(params.commandId) !== undefined)
          throw new SessionCommandBlockedError(
            'Plan submission partially committed; recovery awaits team_plan enablement.',
          );
        return receipt(
          refusedCommandReply(
            'This team command is not accepted yet: members cannot send it to their leader.',
          ),
        );
      }
      if (
        Object.keys(params.args).some((key) => key !== 'plan') ||
        typeof params.args['plan'] !== 'string' ||
        !params.args['plan'].trim()
      )
        return receipt(
          refusedCommandReply('Plan submission requires only a nonempty plan.'),
        );
      try {
        const text = await teams.submitPlan(
          params.commandId,
          params.childRunId,
          params.args['plan'],
        );
        return receipt(answeredCommandReply(cutCommandReplyText(text)));
      } catch (cause) {
        if (cause instanceof HostedTeamRefusal) {
          return receipt(
            refusedCommandReply(cutCommandReplyText(cause.message)),
          );
        }
        throw cause;
      }
    }
    if (params.kind === 'member_message') {
      return this.executeMemberMessage(params, receipt);
    }
    const chains = new HostedChildChains(
      this.store.authority.extensionRecordsInDomain('child_run'),
    );
    const membership = hostedOpenTeamChainMember(
      this.store.authority.extensionRecordsInDomain('team_state'),
      chains,
      params.childRunId,
    );
    const runsNow = (() => {
      if (membership === undefined) return false;
      const view = hostedMemberView(chains, membership.rootChildRunId);
      return (
        view.head?.childRunId === params.childRunId &&
        view.state === 'running' &&
        !view.stopping
      );
    })();
    if (params.kind === 'board_read') {
      if (membership === undefined) {
        return refusedCommandReply(
          'This Session is not a member of an open team.',
        );
      }
      if (!runsNow) {
        return refusedCommandReply(
          'Your run has ended or is being stopped; it takes no more team commands.',
        );
      }
      return answeredCommandReply(
        cutCommandReplyText(
          await teams.memberBoardList(membership.name, params.args),
        ),
      );
    }
    // board_write: `taskId` arrives as a string ("3" or "#3") per the
    // member tool schema — its presence discriminates the update against
    // the create. An update writes one revision per `[self, ...blocks]`,
    // each under `${commandId}:${place + 1}` as the funnel does, so the
    // half-applied probe carries exactly that many landings.
    const updating =
      typeof params.args['taskId'] === 'string' &&
      params.args['taskId'].trim().length > 0;
    const placeCount = (value: unknown): number =>
      Array.isArray(value) &&
      value.every((each) => typeof each === 'string' && each.trim().length > 0)
        ? value.length
        : 0;
    const derivedCommitted = updating
      ? Array.from(
          { length: 1 + placeCount(params.args['addBlocks']) },
          (_, index) => `${params.commandId}:${index + 1}`,
        ).some((recordId) => teams.commandWriteCommitted(recordId))
      : teams.commandWriteCommitted(`${params.commandId}:create`);
    if (!derivedCommitted) {
      if (membership === undefined) {
        return receipt(
          refusedCommandReply('This Session is not a member of an open team.'),
        );
      }
      if (!runsNow) {
        return receipt(
          refusedCommandReply(
            'Your run has ended or is being stopped; it takes no more team commands.',
          ),
        );
      }
    }
    try {
      const text = updating
        ? await teams.memberTaskUpdate(
            membership?.name ?? '',
            params.commandId,
            params.args,
          )
        : await teams.memberTaskCreate(params.commandId, params.args);
      return receipt(answeredCommandReply(cutCommandReplyText(text)));
    } catch (cause) {
      if (cause instanceof HostedTeamRefusal) {
        return receipt(refusedCommandReply(cutCommandReplyText(cause.message)));
      }
      throw cause;
    }
  }

  /**
   * Decision 8 (b3c): the lead's execution of a member's message. A
   * re-run answers the committed receipt first (the `execute` caller's
   * `existingReply` arm); without one, the messages the earlier runs of
   * this command already committed — the `msgc_` entry of each roster
   * position — are probed, so a recipient reached before the cut is
   * reported as reached and is never sent twice. A first run gates the
   * sender exactly like the board commands do; with sends already
   * committed the remaining ones go out as decision 8 says, whatever the
   * sender's own chain did since.
   */
  private async executeMemberMessage(
    params: {
      readonly commandId: string;
      readonly childRunId: string;
      readonly senderSessionId: string;
      readonly args: Record<string, unknown>;
    },
    receipt: (reply: SessionCommandReply) => Promise<SessionCommandReply>,
  ): Promise<SessionCommandReply> {
    const leadSessionId = this.key.sessionId;
    // Every early refusal is cut as a body would be: `maxArgsBytes` and
    // `maxReplyBytes` are both 64 KiB, so an interpolating refusal must
    // never outgrow what a receipt can hold (R1-1).
    const refused = (text: string): Promise<SessionCommandReply> =>
      receipt(refusedCommandReply(cutCommandReplyText(text)));
    const messageIdOf = (position: number): string =>
      memberMessageId({ leadSessionId, commandId: params.commandId, position });
    const committed = new Set<number>();
    for (
      let position = 1;
      position <= HOSTED_BROADCAST_POSITIONS;
      position += 1
    ) {
      if (
        this.store.authority.extensionRecord(
          'session_message',
          messageIdOf(position),
        ) !== undefined
      ) {
        committed.add(position);
      }
    }
    const chains = new HostedChildChains(
      this.store.authority.extensionRecordsInDomain('child_run'),
    );
    const membership = hostedOpenTeamChainMember(
      this.store.authority.extensionRecordsInDomain('team_state'),
      chains,
      params.childRunId,
    );
    if (membership === undefined) {
      if (committed.size === 0) {
        return refused('This Session is not a member of an open team.');
      }
      return receipt(
        answeredCommandReply(
          `The message was sent to ${committed.size} member${committed.size === 1 ? '' : 's'} before its team changed; nothing more was sent.`,
        ),
      );
    }
    const view = hostedMemberView(chains, membership.rootChildRunId);
    const runsNow =
      view.head?.childRunId === params.childRunId &&
      view.state === 'running' &&
      !view.stopping;
    if (committed.size === 0 && !runsNow) {
      return refused(
        'Your run has ended or is being stopped; it takes no more team commands.',
      );
    }
    const senderName = membership.name;
    const team = membership.team;
    const to = params.args['to'];
    const text = params.args['message'];
    if (
      typeof to !== 'string' ||
      to.trim() === '' ||
      typeof text !== 'string' ||
      text.trim() === ''
    ) {
      return refused('A member message takes a nonempty "to" and "message".');
    }
    const content = Buffer.from(memberMessageContent(senderName, text), 'utf8');
    if (content.byteLength > MANAGED_CHILD_LIMITS.maxEnvelopeBytes) {
      return refused(
        `Message exceeds what a member message can carry (byte_limit): keep it under ${MANAGED_CHILD_LIMITS.maxEnvelopeBytes} bytes with its member-message header.`,
      );
    }
    const address = to.trim();
    const recipients: Array<{
      readonly name: string;
      readonly rootChildRunId: string;
      readonly position: number;
    }> = [];
    if (address === '*') {
      for (const [index, member] of team.members.entries()) {
        if (member.name !== senderName) {
          recipients.push({
            name: member.name,
            rootChildRunId: member.childRunId,
            position: index + 1,
          });
        }
      }
      if (recipients.length === 0) {
        return refused(`Team "${team.name}" has no other members to message.`);
      }
    } else {
      const named = sanitizeName(address);
      if (named === '') {
        return refused(
          `Address "${address}" sanitizes to an empty string; name a member of the team, or "*".`,
        );
      }
      if (named === senderName) {
        return refused('A member cannot send a message to itself.');
      }
      const index = team.members.findIndex((member) => member.name === named);
      if (index < 0) {
        return refused(
          `"${address}" is not a member of team "${team.name}". Members: ${team.members.map((each) => each.name).join(', ')}.`,
        );
      }
      const member = team.members[index]!;
      recipients.push({
        name: member.name,
        rootChildRunId: member.childRunId,
        position: index + 1,
      });
    }
    const notReachedText: Record<
      | 'finished'
      | 'ended'
      | 'stopping'
      | 'budget_exhausted'
      | 'count_limit'
      | 'member_budget'
      | 'member_count_limit'
      | 'completed_after_stop',
      string
    > = {
      finished:
        'it has finished; the leader may give it more work, a peer cannot.',
      ended: 'it has ended.',
      stopping: 'it is being stopped.',
      budget_exhausted: `it has received its ${MANAGED_SESSION_MESSAGE_RUNTIME_LIMITS.maxPerRun} messages (budget_exhausted).`,
      count_limit: `it has ${MANAGED_SESSION_MESSAGE_RUNTIME_LIMITS.maxInFlightPerRun} messages still on their way to it (count_limit); wait for them to arrive.`,
      member_budget: `it has received the ${HOSTED_MEMBER_MESSAGE_PER_RUN} member messages one run may hold (budget_exhausted).`,
      member_count_limit: `it has ${HOSTED_MEMBER_MESSAGE_IN_FLIGHT} member messages still on their way (count_limit); wait for them to arrive.`,
      completed_after_stop:
        'it completed after a stop was requested; for more work, the leader can launch a new member under a new name — a peer cannot reach it.',
    };
    const lines: string[] = [];
    let sent = 0;
    for (const recipient of recipients) {
      if (committed.has(recipient.position)) {
        sent += 1;
        lines.push(`- ${recipient.name}: sent.`);
        continue;
      }
      const route = await this.children.sendToRunningMember({
        rootChildRunId: recipient.rootChildRunId,
        content,
        messageId: messageIdOf(recipient.position),
        executionCallId: params.commandId,
      });
      if (route.kind === 'sent') {
        sent += 1;
        lines.push(`- ${recipient.name}: sent.`);
      } else {
        lines.push(
          `- ${recipient.name}: not reached: ${notReachedText[route.reason]}`,
        );
      }
    }
    const heading =
      recipients.length === 1
        ? sent === 1
          ? `Message sent to ${recipients[0]!.name}.`
          : 'The message was not sent:'
        : sent === recipients.length
          ? `Message sent to every other member of team "${team.name}".`
          : sent === 0
            ? `The message reached no member of team "${team.name}":`
            : `Message sent to ${sent} of ${recipients.length} other members of team "${team.name}":`;
    const body = cutCommandReplyText(`${heading}\n${lines.join('\n')}`);
    return receipt(
      sent === 0 ? refusedCommandReply(body) : answeredCommandReply(body),
    );
  }

  private revise(
    commandId: string,
    step: (previous: SessionCommand) => SessionCommand,
  ): Promise<void> {
    return this.children.serialized(async () => {
      await this.store.authority.settlePendingAppend();
      const existing = this.store.authority.extensionRecord(
        'session_command',
        commandId,
      );
      if (existing === undefined) {
        throw new ManagedSessionRecordError(
          `Session command ${commandId} has no record to revise.`,
        );
      }
      const previous = parseSessionCommand(existing.record);
      const next = step(previous);
      if (isDeepStrictEqual(previous, next)) return;
      await this.commit(
        next,
        `${commandId}:${existing.revision + 1}`,
        'commitSessionCommand',
      );
    });
  }

  private async commit(
    record: SessionCommand,
    commandId: string,
    operation: string,
  ): Promise<void> {
    await this.store.authority.commitExtensionRecord(
      {
        operation,
        commandId,
        sessionKey: this.key,
        contentDigest: digest(record),
      },
      {
        domain: 'session_command',
        record,
      },
      { class: 'trusted_entry' },
    );
  }
}
