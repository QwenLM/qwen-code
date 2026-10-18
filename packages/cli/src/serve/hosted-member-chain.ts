/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  isChildSessionRun,
  parseChildRun,
  type ChildSessionRun,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-record.js';
import { isTerminalRunState } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import {
  parseSessionMessage,
  type SessionMessage,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-record.js';
import {
  MANAGED_TEAM_LIMITS,
  parseTeamPlan,
  parseTeamState,
  type TeamState,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-team-record.js';
import {
  assertManagedSessionDomainEnabled,
  assertManagedSessionDurableRef,
  type ManagedSessionDomain,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';

// H4e-b2 of #12827: what a team adds on top of H4d-b's Session messages —
// a member is its continuation chain, every run of that chain opens its
// instruction with who it is, and a broadcast's ids live where no single
// send or launch can reach them. Pure reads of the lead's committed
// records, shared by the team, child and message funnels and the tool
// turn. See docs/design/2026-10-11-managed-agent-team-mailbox.md.

/** The most members a roster holds, so the most positions a broadcast has. */
export const HOSTED_BROADCAST_POSITIONS = MANAGED_TEAM_LIMITS.maxMembers;

/**
 * The Turn half of a call key. A wake turn acknowledging a child result —
 * an acceptance or a blocked outcome — collapses to a digest, so its keys
 * never grow across hops; every other Turn keys its calls by its prompt id
 * verbatim.
 */
export function hostedPromptKey(promptId: string): string {
  return promptId.endsWith(':accept:notify') ||
    promptId.endsWith(':blocked:notify')
    ? createHash('sha256').update(promptId).digest('hex').slice(0, 16)
    : promptId;
}

/** A call's replay-stable key: `${promptKey}:${callId}`, always with a colon. */
export function hostedCallKey(promptId: string, callId: string): string {
  return `${hostedPromptKey(promptId)}:${callId}`;
}

/**
 * Decision 4: the continuation run id of one broadcast recipient. It has
 * no colon, while every single-send and launch run id is a call key, so a
 * provider call id can never mint it.
 */
export function broadcastRunId(
  promptId: string,
  callId: string,
  position: number,
): string {
  return `bcast_${createHash('sha256')
    .update(`${hostedPromptKey(promptId)}\0${callId}\0${position}`)
    .digest('hex')
    .slice(0, 32)}`;
}

/**
 * Decision 4: the message id of one broadcast recipient. Single sends
 * mint `msg_` ids, so `msgb_` never meets them.
 */
export function broadcastMessageId(params: {
  readonly senderSessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly position: number;
}): string {
  return `msgb_${createHash('sha256')
    .update(
      `${params.senderSessionId}\0${params.turnId}\0${params.callId}\0${params.position}`,
    )
    .digest('hex')
    .slice(0, 32)}`;
}

/** The id prefix under which only a lead's member messages live (decision 8). */
export const MEMBER_MESSAGE_ID_PREFIX = 'msgc_';

/**
 * Decision 8 (b3c): the message id of one member message's recipient. The
 * lead alone mints it while it executes a `member_message` command:
 * `msgc_` + 32 hex of sha256(`leadSessionId \0 commandId \0 position`),
 * where `position` is the recipient's 1-based roster position. Digesting
 * the command id lets a re-driven `execute` probe which positions the
 * first run already sent, exactly as H4e-b2's broadcast recovery does.
 */
export function memberMessageId(params: {
  readonly leadSessionId: string;
  readonly commandId: string;
  readonly position: number;
}): string {
  return `${MEMBER_MESSAGE_ID_PREFIX}${createHash('sha256')
    .update(`${params.leadSessionId}\0${params.commandId}\0${params.position}`)
    .digest('hex')
    .slice(0, 32)}`;
}

/**
 * Decision 8's bounds: member messages share H4d-b's 8 in flight and 64
 * per run on the recipient's head with the lead's own messages, and take
 * at most 4 in flight and 16 in all per receiving run, so the lead always
 * keeps room for its own.
 */
export const HOSTED_MEMBER_MESSAGE_IN_FLIGHT = 4;
export const HOSTED_MEMBER_MESSAGE_PER_RUN = 16;

const PREAMBLE_BODY_HEAD =
  'You are a member of this team. Your parent, the agent that launched you, is the team leader. Your result is your answer to the last instruction you receive: if another message from the leader arrives after you have answered, your answer to it becomes your whole result, so answer it in full and repeat anything from your earlier answers the leader still needs. To ask the leader something, use send_message with to "parent"; its reply reaches you after you have answered, as your next instruction.';

const PREAMBLE_TAIL_NO_COMMANDS =
  "You cannot message other members or edit the team's task board.";

/**
 * H4e-b3 decision 5: what the body adds for a plan-mode run, in the
 * build before b3d — it never names `exit_plan_mode`, which this build
 * does not declare.
 */
const PLAN_MODE_BODY =
  'You are in plan mode until the leader approves your plan: your calls may only read, and the decision arrives as your next instruction.';

/**
 * Decision 5: the fixed text every instruction of a member's chain opens
 * with. Names are sanitized to `[a-z0-9-]`, so they need no escaping.
 * H4e-b3 decision 5: the open tag carries `plan-mode="required"` while
 * the member's runs are plan-required (decision 9's composition rule).
 * The wording near the end also follows what the member can do: with
 * `session_command` disabled the member can neither message other
 * members nor edit the task board, and the body says so; with it
 * enabled this build carries both the board commands (b3b) and member
 * messages (b3c), so the closing sentence lifts entirely. The body is
 * composed with explicit single-space separators, so the default
 * commands-enabled non-plan-mode shape — the only build with no
 * trailing clause at all — never ends in whitespace.
 */
export function teamMemberPreamble(
  member: {
    readonly name: string;
    readonly teamName: string;
  },
  planMode: boolean = false,
): string {
  let commandsEnabled = false;
  try {
    assertManagedSessionDomainEnabled('session_command');
    commandsEnabled = true;
  } catch {
    commandsEnabled = false;
  }
  const attribute = planMode ? ' plan-mode="required"' : '';
  let body = PREAMBLE_BODY_HEAD;
  if (!commandsEnabled) body += ' ' + PREAMBLE_TAIL_NO_COMMANDS;
  if (planMode) {
    body += ' ' + PLAN_MODE_BODY;
    try {
      assertManagedSessionDomainEnabled('team_plan');
      body += ' Submit your plan with exit_plan_mode, then end your turn.';
    } catch {
      // Rollback keeps the read restriction without advertising an absent tool.
    }
  }
  return `<team-member name="${member.name}" team="${member.teamName}"${attribute}>\n${body}\n</team-member>\n\n`;
}

const PREAMBLE_FORM =
  /^<team-member name="[a-z0-9]+(?:-[a-z0-9]+)*" team="[a-z0-9]+(?:-[a-z0-9]+)*"(?: plan-mode="required")?>\n[^<]*\n<\/team-member>\n\n/;

/**
 * Decision 9: the plan-mode attribute, read more widely than the member
 * preamble's form — any unescaped block that carries it restricts the
 * run, whatever its body says. A continuation's history is XML-escaped
 * (`&lt;`), so a literal tag is always the run's own block; matching the
 * opening tag alone, without the body's form, also fails closed on a
 * block whose body this build would not recognize.
 */
const PLAN_MODE_TAG =
  /<team-member name="[a-z0-9]+(?:-[a-z0-9]+)*" team="[a-z0-9]+(?:-[a-z0-9]+)*" plan-mode="required">/;

/** Whether a run's first input carries an unescaped plan-mode block. */
export function hasPlanModeBlock(text: string): boolean {
  return PLAN_MODE_TAG.test(text);
}

/**
 * The text of an input's published body. The `/prompt` route stores its
 * message as an array of content parts, while funnels writing their own
 * inputs (child results, notifications, messages) store a bare `{text}`.
 */
export function inputBodyText(body: unknown): string | undefined {
  if (Array.isArray(body)) {
    const parts: string[] = [];
    for (const part of body) {
      const text =
        typeof part === 'object' &&
        part !== null &&
        typeof (part as Record<string, unknown>)['text'] === 'string'
          ? ((part as Record<string, unknown>)['text'] as string)
          : undefined;
      if (text !== undefined) parts.push(text);
    }
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  if (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as Record<string, unknown>)['text'] === 'string'
  ) {
    return (body as Record<string, unknown>)['text'] as string;
  }
  return undefined;
}

/**
 * Decision 9's composition rule: whether a member's next run composes in
 * plan mode — its roster entry is plan-required and the lead holds no
 * approved plan of that member of that team yet. `team_plan` stays
 * disabled until b3d, so nothing here commits; the read keeps plan mode
 * on a b3d journal reopened by this build (decision 5's rollback floor).
 */
export function memberPlanModeRequired(
  team: TeamState,
  plans: ReadonlyArray<{ readonly record: unknown }>,
  memberName: string,
): boolean {
  if (team.lifecycle === 'deleted') return false;
  const member = team.members.find((each) => each.name === memberName);
  if (member === undefined || !member.planModeRequired) return false;
  return !plans.some((entry) => {
    const plan = parseTeamPlan(entry.record);
    return (
      plan.teamId === team.teamId &&
      plan.member === memberName &&
      plan.decision === 'approved'
    );
  });
}

/**
 * The text after a launch's `[description]` wrapper and blank line, or
 * after a continuation's `Your next instruction:` marker — whichever
 * gives this run's own unescaped start. History before the marker is
 * escaped, so only the run's own block can match a preamble form. This
 * one cut serves both callers that must see the same block: the boolean
 * gate and the identity parse (R1-9 — they must never disagree).
 */
function memberPreambleBlockText(firstInput: string): string {
  const marker = 'Your next instruction:';
  const at = firstInput.lastIndexOf(marker);
  if (at >= 0) {
    return firstInput.slice(at + marker.length).replace(/^\s+/, '');
  }
  const wrapped = /^\[[\s\S]*?\]\n\n/.exec(firstInput);
  if (wrapped !== null) return firstInput.slice(wrapped[0].length);
  return firstInput;
}

/**
 * b3b decision 5: whether one run's first input declares member tools —
 * its instruction part opens with a well-formed preamble block, read
 * after a launch's `[description]` and its blank line, or after a
 * continuation's `Your next instruction:` marker (history before it is
 * escaped, so only the run's own block can match). A misread only ever
 * hides the tools: admission is the lead's, not the declaration's.
 */
export function firstInputOpensWithMemberPreamble(firstInput: string): boolean {
  return PREAMBLE_FORM.test(memberPreambleBlockText(firstInput));
}

const PREAMBLE_IDENTITY_FORM =
  /^<team-member name="([a-z0-9]+(?:-[a-z0-9]+)*)" team="([a-z0-9]+(?:-[a-z0-9]+)*)"(?: plan-mode="required")?>\n[^<]*\n<\/team-member>\n\n/;

/**
 * Decision 8 (b3c): who a run's first input says the member is — the name
 * and team its preamble block carries, cut the same way {@link
 * firstInputOpensWithMemberPreamble} cuts. The tool turn's local refusals
 * (self-addressing, `"leader"`) need the name before anything is sent.
 * Built on the same grammar source as the boolean gate, so
 * `firstInputOpensWithMemberPreamble(x) === true` exactly when
 * `memberPreambleIdentity(x) !== undefined`.
 */
export function memberPreambleIdentity(
  firstInput: string,
): { readonly name: string; readonly team: string } | undefined {
  const match = PREAMBLE_IDENTITY_FORM.exec(
    memberPreambleBlockText(firstInput),
  );
  return match === null ? undefined : { name: match[1]!, team: match[2]! };
}

/**
 * R1-10: the one read of a Session's first accepted input's text — an
 * OpenAI message-content array, or a plain {text} envelope for test-path
 * fixtures. A missing first input or a durable ref that is not a
 * 'managed-input' yields undefined; a read failure (malformed ref shape,
 * unreadable resource, unparsed body) propagates, so each caller keeps
 * its own fail direction on `undefined` vs on an exception.
 */
export async function hostedFirstInputText(input: {
  readonly authority: {
    committedSequence: number;
    eventsInSequenceRange(
      from: number,
      through: number,
    ): ReadonlyArray<{
      readonly kind: string;
      readonly payload: Readonly<
        Partial<Record<string, ManagedSessionJsonValue>>
      >;
    }>;
  };
  readonly resources: {
    read(ref: ManagedSessionDurableRef): Promise<Buffer>;
  };
}): Promise<string | undefined> {
  const first = input.authority
    .eventsInSequenceRange(1, input.authority.committedSequence)
    .find((event) => event.kind === 'input.accepted');
  const contentRef = first?.payload['contentRef'];
  if (contentRef === undefined) return undefined;
  const ref = assertManagedSessionDurableRef(contentRef, 'session first input');
  if (ref.kind !== 'managed-input') return undefined;
  const parsed: unknown = JSON.parse(
    (await input.resources.read(ref)).toString('utf8'),
  );
  return inputBodyText(parsed);
}

/**
 * Decision 5's replay evidence: whether a committed instruction is the
 * sent text alone, or one well-formed preamble block followed by it. The
 * block's form is read, never its wording, so a release that rewords the
 * preamble still recognizes what an earlier one committed.
 */
export function isSentInstruction(committed: string, sent: string): boolean {
  if (committed === sent) return true;
  const block = PREAMBLE_FORM.exec(committed);
  return block !== null && committed.slice(block[0].length) === sent;
}

/** The lead's child Session runs, indexed once per call. */
export class HostedChildChains {
  private readonly byId = new Map<string, ChildSessionRun>();
  private readonly successors = new Map<string, ChildSessionRun[]>();

  constructor(records: ReadonlyArray<{ readonly record: unknown }>) {
    // Records come in their first commit's order, so a successor list
    // ends with the continuation committed last.
    for (const entry of records) this.add(entry.record);
  }

  /** Add a run committed during the call that owns this index. */
  add(record: unknown): void {
    const run = parseChildRun(record);
    if (!isChildSessionRun(run)) return;
    this.byId.set(run.childRunId, run);
    if (run.predecessorChildRunId !== null) {
      const list = this.successors.get(run.predecessorChildRunId) ?? [];
      list.push(run);
      this.successors.set(run.predecessorChildRunId, list);
    }
  }

  runs(): readonly ChildSessionRun[] {
    return [...this.byId.values()];
  }

  run(childRunId: string): ChildSessionRun | undefined {
    return this.byId.get(childRunId);
  }

  /** The launch a run's chain started from; a launch is its own root. */
  root(childRunId: string): string {
    let id = childRunId;
    for (;;) {
      const predecessor = this.byId.get(id)?.predecessorChildRunId ?? null;
      if (predecessor === null) return id;
      id = predecessor;
    }
  }

  /**
   * The chain head as H4d-b's routing defines it: the newest continuation
   * that did not prove it never started. H4d-a decision 9 lets at most one
   * started continuation follow a run.
   */
  head(childRunId: string): ChildSessionRun | undefined {
    let head = this.byId.get(childRunId);
    while (head !== undefined) {
      const next = (this.successors.get(head.childRunId) ?? []).find(
        (run) => run.run.execution !== 'not_started_proven',
      );
      if (next === undefined) return head;
      head = next;
    }
    return undefined;
  }

  /** The continuation of `childRunId` committed last, started or not. */
  newestContinuation(childRunId: string): ChildSessionRun | undefined {
    const list = this.successors.get(childRunId);
    return list === undefined ? undefined : list[list.length - 1];
  }

  /**
   * The continuation its predecessor took just before this one. When there
   * is one, it had proved it never started by then, or routing would have
   * reached it instead (H4d-a decision 9).
   */
  previousContinuation(childRunId: string): ChildSessionRun | undefined {
    const predecessor = this.byId.get(childRunId)?.predecessorChildRunId;
    if (predecessor === null || predecessor === undefined) return undefined;
    const list = this.successors.get(predecessor) ?? [];
    const index = list.findIndex((run) => run.childRunId === childRunId);
    return index > 0 ? list[index - 1] : undefined;
  }

  /** Every run of the chain a launch started, never-started ones included. */
  chain(rootChildRunId: string): readonly ChildSessionRun[] {
    const runs: ChildSessionRun[] = [];
    const visit = (id: string) => {
      const run = this.byId.get(id);
      if (run === undefined) return;
      runs.push(run);
      for (const next of this.successors.get(id) ?? []) visit(next.childRunId);
    };
    visit(rootChildRunId);
    return runs;
  }
}

export interface HostedChainMember {
  readonly team: TeamState;
  readonly name: string;
  /** The roster entry's run: the launch the chain started from. */
  readonly rootChildRunId: string;
}

/**
 * Decision 2: the member of the lead's open team whose chain a run belongs
 * to — its chain root on the open team's roster — or none.
 */
export function hostedOpenTeamChainMember(
  teams: ReadonlyArray<{ readonly record: unknown }>,
  chains: HostedChildChains,
  childRunId: string,
): HostedChainMember | undefined {
  const root = chains.root(childRunId);
  for (const entry of teams) {
    const team = parseTeamState(entry.record);
    if (team.lifecycle === 'deleted') continue;
    const member = team.members.find((each) => each.childRunId === root);
    if (member !== undefined)
      return { team, name: member.name, rootChildRunId: root };
  }
  return undefined;
}

/** A member's liveness and what it can still take, read from its chain head. */
export interface HostedMemberView {
  readonly head: ChildSessionRun | undefined;
  readonly state: 'running' | 'completed' | 'failed' | 'cancelled';
  /** Running, with a stop requested. */
  readonly stopping: boolean;
  /**
   * Stopping a continuation that has not attached a child Session yet: if
   * it ends without starting, the head goes back to its predecessor.
   */
  readonly stoppingBeforeStart: boolean;
  /** Settled after a stop was requested: completed, but never continued. */
  readonly stopRequestedCompletion: boolean;
  /** Completed with no stop requested: a message continues it. */
  readonly continuable: boolean;
  /** The head's newest continuation, when it proved it never started. */
  readonly neverStarted: ChildSessionRun | undefined;
}

export function hostedMemberView(
  chains: HostedChildChains,
  rootChildRunId: string,
): HostedMemberView {
  const head = chains.head(rootChildRunId);
  // A rostered member always has a chain head. Treat a missing one as
  // running so callers fail closed by blocking continuation and deletion.
  const state: HostedMemberView['state'] =
    head?.run.state === 'settled'
      ? 'completed'
      : head?.run.state === 'failed' || head?.run.state === 'cancelled'
        ? head.run.state
        : 'running';
  // Every continuation the head took proved it never started, or the
  // newest that did not would be the head.
  const newest =
    head === undefined ? undefined : chains.newestContinuation(head.childRunId);
  return {
    head,
    state,
    stopping: state === 'running' && head?.stopRequested === true,
    stoppingBeforeStart:
      state === 'running' &&
      head?.stopRequested === true &&
      head.predecessorChildRunId !== null &&
      head.childSessionId === null,
    stopRequestedCompletion:
      state === 'completed' && head?.stopRequested === true,
    continuable:
      state === 'completed' &&
      head?.kind === 'child_agent' &&
      head.stopReason === 'completed' &&
      !head.stopRequested,
    neverStarted: newest,
  };
}

/** Why a continuation that never started ended, for the lead to read. */
function neverStartedReason(run: ChildSessionRun): string {
  return run.stopReason ?? run.run.state;
}

/**
 * A run that proved it never started, as the lead must read it: the work
 * it carried did not arrive, nor did the messages sent to it while it
 * waited (H4d-b cancels a message to a run that ended before its
 * handover). A failed child sends no notification, so an answer or the
 * roster is how the lead learns of it. One cancelled before its start, at
 * a user's request (H4f), is told apart: that work may no longer be wanted.
 */
export interface HostedNeverStarted {
  readonly childRunId: string;
  /** Null for a launch: there is no earlier run to send to again. */
  readonly predecessorChildRunId: string | null;
  readonly reason: string;
  readonly cancelled: boolean;
  /** The messages sent to it, none of which arrived. */
  readonly lostMessages: number;
}

export function hostedNeverStarted(
  run: ChildSessionRun,
  messages: readonly SessionMessage[],
): HostedNeverStarted {
  return {
    childRunId: run.childRunId,
    predecessorChildRunId: run.predecessorChildRunId,
    reason: neverStartedReason(run),
    cancelled: run.run.state === 'cancelled',
    // b3c: a member message's sender is another member, so the
    // never-started note never tells the lead to send it again (decision 8).
    lostMessages: messages.filter(
      (message) =>
        message.childRunId === run.childRunId &&
        !message.messageId.startsWith(MEMBER_MESSAGE_ID_PREFIX),
    ).length,
  };
}

/** "never started (creation_failed)", or "was cancelled before it started
 * (stop_requested)". */
export function neverStartedPhrase(neverStarted: HostedNeverStarted): string {
  return neverStarted.cancelled
    ? `was cancelled before it started (${neverStarted.reason})`
    : `never started (${neverStarted.reason})`;
}

/** "1 message sent to it", "2 messages sent to it". */
export function messagesSentToIt(count: number): string {
  return `${count} message${count === 1 ? '' : 's'} sent to it`;
}

export function lostMessagesAction(count: number): string {
  const them = count === 1 ? 'it' : 'them';
  return `${messagesSentToIt(count)} also did not arrive; resend ${them} only if ${count === 1 ? 'its' : 'their'} own send_message ${count === 1 ? 'answer has' : 'answers have'} not already asked you to resend ${them}`;
}

/**
 * "never started (creation_failed), so the work it carried did not
 * arrive, nor did 1 message sent to it" — said of a continuation.
 */
export function neverStartedClause(neverStarted: HostedNeverStarted): string {
  return (
    `${neverStartedPhrase(neverStarted)}, so the work it carried did not arrive` +
    (neverStarted.lostMessages > 0
      ? `, nor did ${messagesSentToIt(neverStarted.lostMessages)}`
      : '')
  );
}

/**
 * H4e-b2: what a committed send reached, as its answer must tell it. A
 * replay or a recovered answer reads it again, so it may find what the
 * first answer could not: the run the send reached has proved since that
 * it never started.
 */
export interface HostedRouteDetails {
  /** The open team member whose chain the send reached. */
  readonly member?: { readonly name: string; readonly teamName: string };
  /** The run the send reached — the continuation it launched, or the
   * waiting run a message was queued for — never started, so the send did
   * not arrive. */
  readonly ownNeverStarted?: HostedNeverStarted;
  /** The continuation taken just before the one the send launched, which
   * never started. */
  readonly previousNeverStarted?: HostedNeverStarted;
  /**
   * The message's own delivery ended, or must end, with no receipt —
   * cancelled before its handover, or rejected by its target — so it did
   * not arrive, though its run did not prove it never started. `chain`
   * says what a resend would meet: a chain that takes messages, one that
   * has ended, or one stopping a continuation that has not started yet.
   */
  readonly deliveryFailed?: {
    readonly state: 'cancelled' | 'rejected';
    readonly chain: 'open' | 'ended' | 'settling' | 'stopping';
  };
  /** The relay gave up without proving whether the message arrived. */
  readonly deliveryUnconfirmed?: true;
}

export function hostedRouteDetails(
  authority: {
    extensionRecordsInDomain(
      domain: ManagedSessionDomain,
    ): ReadonlyArray<{ readonly record: unknown }>;
  },
  route: {
    readonly kind: 'message' | 'continuation';
    readonly childRunId: string;
  },
  /** The id a message route was committed under: its delivery is read. */
  messageId?: string,
  chains = new HostedChildChains(
    authority.extensionRecordsInDomain('child_run'),
  ),
): HostedRouteDetails {
  const messages = outboundChildMessages(
    authority.extensionRecordsInDomain('session_message'),
  );
  const member = hostedOpenTeamChainMember(
    authority.extensionRecordsInDomain('team_state'),
    chains,
    route.childRunId,
  );
  const reached = chains.run(route.childRunId);
  const previous =
    route.kind === 'continuation'
      ? chains.previousContinuation(route.childRunId)
      : undefined;
  // A run that never started says more than the cancel H4d-b gives its
  // messages, so that note takes precedence. A message never handed over
  // to a run that ended or is being stopped is one the relay cancels
  // (H4d-b), so an answer written before that step already reads it so.
  const sentState =
    route.kind === 'message' &&
    messageId !== undefined &&
    reached !== undefined &&
    reached.run.execution !== 'not_started_proven'
      ? messages.find((message) => message.messageId === messageId)?.run
          .delivery?.state
      : undefined;
  const delivery =
    sentState === 'planned' &&
    reached !== undefined &&
    (isTerminalRunState(reached.run.state) || reached.stopRequested)
      ? 'cancelled'
      : sentState;
  const view =
    delivery === 'cancelled' || delivery === 'rejected'
      ? hostedMemberView(chains, chains.root(route.childRunId))
      : undefined;
  return {
    ...(member === undefined
      ? {}
      : { member: { name: member.name, teamName: member.team.name } }),
    ...(reached?.run.execution === 'not_started_proven'
      ? { ownNeverStarted: hostedNeverStarted(reached, messages) }
      : {}),
    ...(previous?.run.execution === 'not_started_proven'
      ? { previousNeverStarted: hostedNeverStarted(previous, messages) }
      : {}),
    ...((delivery === 'cancelled' || delivery === 'rejected') &&
    view !== undefined
      ? {
          deliveryFailed: {
            state: delivery,
            chain: view.stoppingBeforeStart
              ? ('settling' as const)
              : view.stopping
                ? ('stopping' as const)
                : isEndedMember(view)
                  ? ('ended' as const)
                  : ('open' as const),
          },
        }
      : {}),
    ...(delivery === 'unknown' ? { deliveryUnconfirmed: true as const } : {}),
  };
}

/** The lead's outbound messages to the child runs of one Session. */
export function outboundChildMessages(
  records: ReadonlyArray<{ readonly record: unknown }>,
): readonly SessionMessage[] {
  return records
    .map((entry) => parseSessionMessage(entry.record))
    .filter(
      (message) =>
        message.direction === 'outbound' && message.route === 'to_child',
    );
}

/**
 * Decision 7: whether an earlier call of the current Turn gave the member
 * work — a continuation of its chain that did not prove it never started,
 * or a message to one of its started runs that was not cancelled or
 * rejected. Both name their sending call's key, so the lead's records
 * decide it: a key belongs to the Turn when it starts with `turnPrefix`,
 * `${promptKey}:`. A prefix match is exact because no other Turn's prompt
 * key extends this one past a colon: a wake turn's `:accept:notify` or
 * `:blocked:notify` prompt id collapses to a digest (`hostedPromptKey`),
 * and every other prompt id is assigned whole.
 */
export function givenWorkThisTurn(
  chains: HostedChildChains,
  rootChildRunId: string,
  messages: readonly SessionMessage[],
  turnPrefix: string,
): boolean {
  const chain = chains.chain(rootChildRunId);
  // A message to a continuation that never started never arrives (H4d-b
  // cancels it), so only the chain's runs that did start can take one.
  const ids = new Set(
    chain
      .filter((run) => run.run.execution !== 'not_started_proven')
      .map((run) => run.childRunId),
  );
  const fromThisTurn = (callKey: string | null) =>
    callKey !== null && callKey.startsWith(turnPrefix);
  return (
    chain.some(
      (run) =>
        run.predecessorChildRunId !== null &&
        run.run.execution !== 'not_started_proven' &&
        fromThisTurn(run.run.executionCallId),
    ) ||
    messages.some(
      (message) =>
        ids.has(message.childRunId) &&
        message.run.delivery?.state !== 'cancelled' &&
        message.run.delivery?.state !== 'rejected' &&
        fromThisTurn(message.run.executionCallId),
    )
  );
}

/**
 * Whether a run of the member's chain completed: it may have done a task's
 * work, so the member may be recorded on the task a call completes, as
 * #13846 records a completed member, whatever later runs of the chain did.
 */
export function hasCompletedRun(
  chains: HostedChildChains,
  rootChildRunId: string,
): boolean {
  return chains
    .chain(rootChildRunId)
    .some((run) => run.run.state === 'settled');
}

/**
 * What to do about the work a never-started continuation carried. Lost
 * messages are resent only when their own answers have not already asked.
 */
export function neverStartedAction(
  neverStarted: HostedNeverStarted,
  owner: string,
): string {
  const work = neverStarted.cancelled
    ? `If that work is still wanted, send it again with send_message to "${owner}"`
    : `Send that work again with send_message to "${owner}"`;
  if (neverStarted.lostMessages === 0) return work;
  return `${work}; ${lostMessagesAction(neverStarted.lostMessages)}`;
}

/** A head that cannot take more work at all: it ended or is ending. */
export function isEndedMember(view: HostedMemberView): boolean {
  return (
    view.state === 'failed' ||
    view.state === 'cancelled' ||
    view.stopping ||
    view.stopRequestedCompletion
  );
}

/** Whether a head still runs, stopping or not: `team_delete` waits for it. */
export function isRunningMember(view: HostedMemberView): boolean {
  return view.state === 'running';
}
