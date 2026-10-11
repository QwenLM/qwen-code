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
import {
  parseSessionMessage,
  type SessionMessage,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-record.js';
import {
  MANAGED_TEAM_LIMITS,
  parseTeamState,
  type TeamState,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-team-record.js';

// H4e-b2 of #12827: what a team adds on top of H4d-b's Session messages —
// a member is its continuation chain, every run of that chain opens its
// instruction with who it is, and a broadcast's ids live where no single
// send or launch can reach them. Pure reads of the lead's committed
// records, shared by the team, child and message funnels and the tool
// turn. See docs/design/2026-10-11-managed-agent-team-mailbox.md.

/** The most members a roster holds, so the most positions a broadcast has. */
export const HOSTED_BROADCAST_POSITIONS = MANAGED_TEAM_LIMITS.maxMembers;

/**
 * The Turn half of a call key. A wake turn acknowledging a child result
 * collapses to a digest, so its keys never grow across hops; every other
 * Turn keys its calls by its prompt id verbatim.
 */
export function hostedPromptKey(promptId: string): string {
  return promptId.endsWith(':accept:notify')
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

const PREAMBLE_BODY =
  'You are a member of this team. Your parent, the agent that launched you, is the team leader. Your result is your answer to the last instruction you receive: if another message from the leader arrives after you have answered, your answer to it becomes your whole result, so answer it in full and repeat anything from your earlier answers the leader still needs. To ask the leader something, use send_message with to "parent"; its reply reaches you after you have answered, as your next instruction. You cannot message other members or edit the team\'s task board.';

/**
 * Decision 5: the fixed text every instruction of a member's chain opens
 * with. Names are sanitized to `[a-z0-9-]`, so they need no escaping.
 */
export function teamMemberPreamble(member: {
  readonly name: string;
  readonly teamName: string;
}): string {
  return `<team-member name="${member.name}" team="${member.teamName}">\n${PREAMBLE_BODY}\n</team-member>\n\n`;
}

const PREAMBLE_FORM =
  /^<team-member name="[a-z0-9]+(?:-[a-z0-9]+)*" team="[a-z0-9]+(?:-[a-z0-9]+)*">\n[^<]*\n<\/team-member>\n\n/;

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
    for (const entry of records) {
      const run = parseChildRun(entry.record);
      if (!isChildSessionRun(run)) continue;
      this.byId.set(run.childRunId, run);
      if (run.predecessorChildRunId !== null) {
        const list = this.successors.get(run.predecessorChildRunId) ?? [];
        list.push(run);
        this.successors.set(run.predecessorChildRunId, list);
      }
    }
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
  const state: HostedMemberView['state'] =
    head?.run.state === 'settled'
      ? 'completed'
      : head?.run.state === 'failed' || head?.run.state === 'cancelled'
        ? head.run.state
        : 'running';
  const newest =
    head === undefined ? undefined : chains.newestContinuation(head.childRunId);
  return {
    head,
    state,
    stopping: state === 'running' && head?.stopRequested === true,
    stopRequestedCompletion:
      state === 'completed' && head?.stopRequested === true,
    continuable:
      state === 'completed' &&
      head?.kind === 'child_agent' &&
      head.stopReason === 'completed' &&
      !head.stopRequested,
    neverStarted:
      newest !== undefined && newest.run.execution === 'not_started_proven'
        ? newest
        : undefined,
  };
}

/** Why a continuation that never started ended, for the lead to read. */
export function neverStartedReason(run: ChildSessionRun): string {
  return run.stopReason ?? run.run.state;
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
 * key extends this one past a colon: a wake turn's `:accept:notify`
 * prompt id collapses to a digest (`hostedPromptKey`), and every other
 * prompt id is assigned whole.
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
