/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview The smallest thing that turns booked work into a running agent.
 *
 * Admission decides *whether* a run exists; this decides *when* it starts and
 * on which body. The split matters because a booked run is a durable fact that
 * stays true until something changes it under the lock, while "this agent is
 * free right now" is an observation that expires the moment it is read. Putting
 * the second kind in the rules layer is what an earlier revision did with a
 * `defer` outcome, and it gave one situation two spellings.
 *
 * A periodic pass also reconciles interrupted runs and delivers posts that
 * were coalesced while a body was already working.
 */

import { assembleAgentPrompt } from './prompt.js';
import {
  generateRunId,
  isAgentAddressable,
  listThreads,
  maxConcurrentRunsFor,
  readWorkspaceAgents,
  readAgentWorkspace,
  reconcileThreadOutbox,
  withAgentStoreTransaction,
  type AgentStoreTransaction,
} from './store.js';
import {
  applyAggregateStatus,
  finishRunInTransaction,
  reportChildReply,
} from './run-lifecycle.js';
import {
  bindRunSession,
  claimRun,
  postMessageInTransaction,
  requeueRun,
  reserveRunSession,
  SYSTEM_AUTHOR_ID,
  upsertRunUsage,
} from './thread-actions.js';
import type {
  WorkspaceAgent,
  Thread,
  ThreadEvent,
  ThreadRun,
} from './types.js';
import { threadPriorityRank } from './types.js';
import { isThreadTerminal } from './types.js';

/** What the runtime says about one agent's session on one thread. */
export type AgentBodyState =
  | { kind: 'absent' }
  | { kind: 'unavailable'; error: string }
  | { kind: 'completed' }
  | { kind: 'failed'; runId: string; attempt: number; error: string }
  | {
      kind: 'running';
      threadId?: string;
      runId?: string;
      attempt?: number;
    };

export type AgentStartResult =
  | {
      status: 'started';
      sessionId: string;
      /** Start execution only after the session and usage baseline are saved. */
      activate?: () => void;
    }
  | { status: 'agent_unavailable'; error: string }
  | { status: 'launch_failed'; error: string; failureStage?: string };

export interface AgentSessionTarget {
  agent: WorkspaceAgent;
  threadId: string;
  /** Existing binding, used to continue sessions created before the current id convention. */
  sessionId?: string;
}

export interface AgentDispatchPort {
  inspect(target: AgentSessionTarget): Promise<AgentBodyState>;
  cancel?(input: {
    agent: WorkspaceAgent;
    threadId: string;
    runId: string;
    attempt: number;
    sessionId?: string;
  }): Promise<boolean>;
  deliver?(input: {
    agent: WorkspaceAgent;
    prompt: string;
    deliveryId: string;
    // The same identity `start` carries. A mid-run delivery is another turn of
    // the same run, and the runtime has to be able to tell the body which run
    // that is — it cannot infer it from a session that serves many threads.
    workspaceId: string;
    threadId: string;
    rootThreadId: string;
    runId: string;
    attempt: number;
    contextThroughSequence: number;
    sessionId?: string;
  }): Promise<boolean>;
  start(input: {
    agent: WorkspaceAgent;
    prompt: string;
    workspaceId: string;
    threadId: string;
    threadTitle: string;
    rootThreadId: string;
    runId: string;
    attempt: number;
    contextThroughSequence: number;
    sessionId?: string;
  }): Promise<AgentStartResult>;
  /**
   * Total tokens this task session has spent since it started, or undefined
   * when the runtime cannot say.
   *
   * A cumulative reading rather than a per-round event: a session reports what
   * it has spent, not what each round cost, so the dispatcher charges the
   * difference across a run. That is why `usageByRound` records a
   * monotonically increasing total under one synthetic round rather than
   * pretending to per-round detail the source does not have.
   */
  totalTokens?(target: AgentSessionTarget): Promise<number | undefined>;
  /**
   * The session id `start` will use, asked before it is used.
   *
   * The dispatcher records this on the claimed run *before* starting, so that
   * by the time the runtime creates the session, the store already names it.
   * That is what lets session creation authorize an `sourceType: agent` claim
   * by looking the session up (`findAgentSessionBinding`) instead of trusting
   * the caller. Without the reservation the first turn of every thread would
   * be refused: `bindRunSession` runs after `start`, so at creation time no run
   * would name the session yet.
   *
   * Ports that cannot predict the id return undefined and simply do not get
   * the pre-binding.
   */
  plannedSessionId?(input: {
    agent: WorkspaceAgent;
    threadId: string;
    sessionId?: string;
  }): string | undefined;
}

export type DispatchResultKind =
  | 'started'
  | 'delivered'
  | 'delivery_race'
  | 'cancelling'
  | 'cancelled'
  | 'requeued'
  | 'recovered_terminal'
  | 'recovery_failed'
  | 'busy_other_thread'
  | 'runtime_unavailable'
  | 'launch_failed'
  | 'agent_unavailable'
  | 'runtime_divergence';

export interface DispatchRecord {
  agentId: string;
  threadId: string;
  runId: string;
  kind: DispatchResultKind;
  detail?: string;
}

interface Candidate {
  agent: WorkspaceAgent;
  thread: Thread;
  run: ThreadRun;
}

const LIVE = new Set(['running', 'finishing', 'cancelling']);

function pendingTriggerIds(run: ThreadRun): string[] {
  const delivered = new Set(
    run.status === 'finishing' || run.status === 'completed'
      ? run.consumedMessageIds
      : run.acceptedMessageIds,
  );
  return run.triggerMessageIds.filter((id) => !delivered.has(id));
}

function bodyCarriesRun(
  state: AgentBodyState,
  thread: Thread,
  run: ThreadRun,
): boolean {
  return (
    state.kind === 'running' &&
    state.threadId === thread.id &&
    state.runId === run.id &&
    state.attempt === run.attempts
  );
}

function priorSessionId(thread: Thread, run: ThreadRun): string | undefined {
  if (run.sessionId) return run.sessionId;
  for (let index = thread.runs.length - 1; index >= 0; index -= 1) {
    const previous = thread.runs[index];
    if (previous?.agentId === run.agentId && previous.sessionId) {
      return previous.sessionId;
    }
  }
  return undefined;
}

async function acceptRunningDelivery(
  projectRoot: string,
  input: {
    threadId: string;
    runId: string;
    attempt: number;
    throughSequence: number;
    messageIds: string[];
  },
): Promise<boolean> {
  return withAgentStoreTransaction(projectRoot, async (transaction) => {
    const thread = await transaction.readThread(input.threadId);
    const run = thread?.runs.find((entry) => entry.id === input.runId);
    if (
      !thread ||
      !run ||
      run.status !== 'running' ||
      run.attempts !== input.attempt
    ) {
      return false;
    }
    await transaction.writeThread({
      ...thread,
      runs: thread.runs.map((entry) =>
        entry.id === run.id
          ? {
              ...entry,
              acceptedMessageIds: Array.from(
                new Set([...entry.acceptedMessageIds, ...input.messageIds]),
              ),
              contextThroughSequence: input.throughSequence,
            }
          : entry,
      ),
    });
    return true;
  });
}

async function rebookUndeliveredTriggers(
  projectRoot: string,
  threadId: string,
  runId: string,
  attempt: number,
  now: number,
): Promise<ThreadRun | undefined> {
  return withAgentStoreTransaction(projectRoot, (transaction) =>
    rebookUndeliveredTriggersInTransaction(
      transaction,
      threadId,
      runId,
      attempt,
      now,
    ),
  );
}

async function rebookUndeliveredTriggersInTransaction(
  transaction: AgentStoreTransaction,
  threadId: string,
  runId: string,
  attempt: number,
  now: number,
): Promise<ThreadRun | undefined> {
  const thread = await transaction.readThread(threadId);
  const run = thread?.runs.find((entry) => entry.id === runId);
  if (
    !thread ||
    !run ||
    run.attempts !== attempt ||
    isThreadTerminal(thread.status) ||
    (run.status !== 'running' &&
      run.status !== 'finishing' &&
      run.status !== 'completed')
  ) {
    return undefined;
  }
  const pending = pendingTriggerIds(run);
  if (pending.length === 0) return undefined;

  const queued = thread.runs.find(
    (entry) =>
      entry.id !== run.id &&
      entry.agentId === run.agentId &&
      entry.status === 'queued',
  );
  const successor: ThreadRun = queued
    ? {
        ...queued,
        triggerMessageIds: Array.from(
          new Set([...queued.triggerMessageIds, ...pending]),
        ),
      }
    : {
        id: generateRunId(),
        agentId: run.agentId,
        status: 'queued',
        triggerMessageIds: pending,
        acceptedMessageIds: [],
        consumedMessageIds: [],
        usageByRound: [],
        queueSequence: await transaction.allocateRunSequence(),
        queuedAt: now,
        attempts: 0,
      };

  const pendingSet = new Set(pending);
  const nextRuns = thread.runs
    .map((entry) =>
      entry.id === run.id
        ? {
            ...entry,
            triggerMessageIds: entry.triggerMessageIds.filter(
              (id) => !pendingSet.has(id),
            ),
          }
        : entry.id === successor.id
          ? successor
          : entry,
    )
    .concat(
      thread.runs.some((entry) => entry.id === successor.id) ? [] : [successor],
    );
  const messages = thread.messages.map((message) =>
    pendingSet.has(message.id)
      ? {
          ...message,
          outcomes: message.outcomes.map((outcome) =>
            outcome.runId === run.id && outcome.targetAgentId === run.agentId
              ? {
                  ...outcome,
                  kind: 'coalesce' as const,
                  into: 'queued' as const,
                  runId: successor.id,
                }
              : outcome,
          ),
        }
      : message,
  );
  let next = { ...thread, messages, runs: nextRuns };
  next = await applyAggregateStatus(transaction, next, now);
  await transaction.writeThread(next);
  return successor;
}

/**
 * The oldest queued run for every agent that is not already working.
 *
 * Ordered by the lock-issued `queueSequence`, never by `queuedAt` or by file
 * enumeration: posts arrive from different processes whose wall clocks can
 * disagree, and directory order would let one thread starve behind another
 * purely because of how its id sorts.
 */
/**
 * How many of the same agent's queued runs start before this one, in the
 * order {@link selectCandidates} takes them: priority, then queue sequence.
 * Zero for a run that is not queued.
 */
export function queuedAhead(
  threads: readonly Thread[],
  threadId: string,
  runId: string,
): number {
  const thread = threads.find((candidate) => candidate.id === threadId);
  const run = thread?.runs.find((candidate) => candidate.id === runId);
  if (!thread || !run || run.status !== 'queued') return 0;
  const rank = threadPriorityRank(thread.priority);
  let ahead = 0;
  for (const other of threads) {
    const otherRank = threadPriorityRank(other.priority);
    for (const candidate of other.runs) {
      if (
        candidate.status === 'queued' &&
        candidate.agentId === run.agentId &&
        candidate.id !== run.id &&
        (otherRank < rank ||
          (otherRank === rank && candidate.queueSequence < run.queueSequence))
      ) {
        ahead++;
      }
    }
  }
  return ahead;
}

export function selectCandidates(
  agents: readonly WorkspaceAgent[],
  threads: readonly Thread[],
): Candidate[] {
  // "Busy" is a count against each agent's own limit, not a flag. An agent
  // owns a process now, so working two threads at once is a policy its
  // `maxConcurrentRuns` sets; the default of 1 keeps the old behaviour for
  // anyone who has not raised it.
  const live = new Map<string, number>();
  for (const thread of threads) {
    for (const run of thread.runs) {
      if (LIVE.has(run.status)) {
        live.set(run.agentId, (live.get(run.agentId) ?? 0) + 1);
      }
    }
  }

  const queued: Candidate[] = [];
  for (const thread of threads) {
    if (isThreadTerminal(thread.status)) continue;
    for (const run of thread.runs) {
      if (run.status !== 'queued') continue;
      const agent = agents.find((candidate) => candidate.id === run.agentId);
      // A retired or disabled agent keeps its history and its name but takes
      // no new work; the roster entry survives so its old posts still read.
      if (!agent || !isAgentAddressable(agent)) continue;
      queued.push({ agent, thread, run });
    }
  }

  // One global queue, then fill each agent up to its remaining capacity.
  // Sorting first is what keeps the order a workspace-wide queue rather than a
  // per-agent one: an agent with room does not jump ahead of older work it
  // could also have taken.
  //
  // Priority outranks age, and is the only thing that does. Within a priority
  // the order is still the lock-issued `queueSequence`, so equal work is
  // strictly first-come and a thread cannot be starved by a steady arrival of
  // peers. A thread with no priority ranks as the default, which is why
  // marking one urgent moves it and marking nothing changes nothing.
  queued.sort(
    (a, b) =>
      threadPriorityRank(a.thread.priority) -
        threadPriorityRank(b.thread.priority) ||
      a.run.queueSequence - b.run.queueSequence,
  );
  const taken: Candidate[] = [];
  const room = new Map<string, number>();
  for (const candidate of queued) {
    const id = candidate.agent.id;
    if (!room.has(id)) {
      room.set(id, maxConcurrentRunsFor(candidate.agent) - (live.get(id) ?? 0));
    }
    const remaining = room.get(id)!;
    if (remaining <= 0) continue;
    room.set(id, remaining - 1);
    taken.push(candidate);
  }
  return taken;
}

function canStart(state: AgentBodyState): boolean {
  switch (state.kind) {
    case 'absent':
    case 'completed':
    case 'failed':
      return true;
    default:
      return false;
  }
}

/**
 * Posts what an agent said in plain text as its message on the thread.
 *
 * A chat model usually just answers. Without this the answer lived only in the
 * run's progress snapshot: peers could not read it, `thread_read` and a parent
 * report did not carry it, and the thread looked stuck. Posting goes through
 * normal admission, so an @mention in the answer wakes that agent. The origin
 * id makes a retried reconcile post it once.
 */
async function postPlainReply(
  transaction: AgentStoreTransaction,
  thread: Thread,
  runId: string,
): Promise<void> {
  const run = thread.runs.find((entry) => entry.id === runId);
  const text = run?.progress?.outputText?.trim();
  if (
    !run ||
    !text ||
    run.status !== 'completed' ||
    run.closeKind !== undefined ||
    // A status post earlier in the run is not its answer; only the same text
    // already posted is. A replay is caught by the origin id below.
    thread.messages.some(
      (message) =>
        message.sourceRunId === run.id && message.text.trim() === text,
    )
  ) {
    return;
  }
  const posted = await postMessageInTransaction(transaction, thread.id, {
    from: run.agentId,
    authorKind: 'agent',
    text,
    sourceRunId: run.id,
    originEventId: `reply_${run.id}_${run.attempts}`,
  });
  const reported = reportChildReply(posted.thread, posted.message, run.id);
  if (reported !== posted.thread) await transaction.writeThread(reported);
}

async function reconcileInterruptedRuns(
  projectRoot: string,
  port: AgentDispatchPort,
  agents: readonly WorkspaceAgent[],
  threads: readonly Thread[],
  now: number,
): Promise<DispatchRecord[]> {
  const records: DispatchRecord[] = [];
  for (const thread of threads) {
    for (const run of thread.runs) {
      if (!LIVE.has(run.status)) continue;
      const agent = agents.find((candidate) => candidate.id === run.agentId);
      if (!agent) continue;
      const base = { agentId: agent.id, threadId: thread.id, runId: run.id };
      const state = await port.inspect({
        agent,
        threadId: thread.id,
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      });
      if (
        state.kind === 'failed' &&
        run.status !== 'cancelling' &&
        state.runId === run.id &&
        state.attempt === run.attempts
      ) {
        await chargeRunUsage(projectRoot, port, agent, thread.id, run);
        await withAgentStoreTransaction(projectRoot, (transaction) =>
          finishRunInTransaction(transaction, {
            threadId: thread.id,
            runId: run.id,
            outcome: {
              status: 'failed',
              attempt: run.attempts,
              error: state.error,
              failureStage: 'execution',
            },
            now,
          }),
        );
        records.push({ ...base, kind: 'recovery_failed', detail: state.error });
        continue;
      }
      if (run.status === 'cancelling') {
        if (state.kind === 'running' && !bodyCarriesRun(state, thread, run)) {
          records.push({
            ...base,
            kind: 'runtime_divergence',
            detail: state.threadId ?? state.runId ?? 'unknown running body',
          });
          continue;
        }
        if (state.kind === 'running') {
          const requested = await port.cancel?.({
            agent,
            threadId: thread.id,
            runId: run.id,
            attempt: run.attempts,
            ...(run.sessionId ? { sessionId: run.sessionId } : {}),
          });
          if (
            (
              await port.inspect({
                agent,
                threadId: thread.id,
                ...(run.sessionId ? { sessionId: run.sessionId } : {}),
              })
            ).kind === 'running'
          ) {
            records.push({
              ...base,
              kind: 'cancelling',
              detail: requested
                ? 'awaiting_runtime_stop'
                : 'cancel_not_accepted',
            });
            continue;
          }
        }
        await chargeRunUsage(projectRoot, port, agent, thread.id, run);
        await withAgentStoreTransaction(projectRoot, (transaction) =>
          finishRunInTransaction(transaction, {
            threadId: thread.id,
            runId: run.id,
            outcome: { status: 'cancelled', attempt: run.attempts },
            now,
          }),
        );
        records.push({ ...base, kind: 'cancelled' });
        continue;
      }
      if (bodyCarriesRun(state, thread, run)) continue;
      if (state.kind === 'running') {
        records.push({
          ...base,
          kind: 'runtime_divergence',
          detail: state.threadId ?? state.runId ?? 'unknown running body',
        });
        continue;
      }

      // A turn that ended before reading a later message still did its work:
      // it completes and the unread message goes to a successor run. Only a
      // turn that never read its own input is replayed.
      const readNothing =
        run.consumedMessageIds.length === 0 &&
        run.acceptedMessageIds.length > 0;
      if (
        run.status === 'finishing' ||
        (state.kind === 'completed' && !readNothing)
      ) {
        // Charge before the run goes terminal: once it is completed the
        // baseline it was started with has nowhere left to live, and an
        // uncharged run would let a tree spend past its budget silently.
        await chargeRunUsage(projectRoot, port, agent, thread.id, run);
        await withAgentStoreTransaction(projectRoot, async (transaction) => {
          const finished = await finishRunInTransaction(transaction, {
            threadId: thread.id,
            runId: run.id,
            outcome: { status: 'completed', attempt: run.attempts },
            now,
          });
          await postPlainReply(transaction, finished, run.id);
          await rebookUndeliveredTriggersInTransaction(
            transaction,
            thread.id,
            run.id,
            run.attempts,
            now,
          );
        });
        records.push({ ...base, kind: 'recovered_terminal' });
        continue;
      }
      if (run.attempts < 2) {
        if (
          await requeueRun(projectRoot, {
            threadId: thread.id,
            runId: run.id,
            attempt: run.attempts,
          })
        ) {
          records.push({ ...base, kind: 'requeued' });
        }
        continue;
      }
      await chargeRunUsage(projectRoot, port, agent, thread.id, run);
      await withAgentStoreTransaction(projectRoot, (transaction) =>
        finishRunInTransaction(transaction, {
          threadId: thread.id,
          runId: run.id,
          outcome: {
            status: 'failed',
            attempt: run.attempts,
            error: 'Agent body disappeared after its recovery attempt.',
            failureStage: 'recovery',
          },
          now,
        }),
      );
      records.push({ ...base, kind: 'recovery_failed' });
    }
  }
  return records;
}

async function deliverRunningInputs(
  projectRoot: string,
  port: AgentDispatchPort,
  workspaceId: string,
  agents: readonly WorkspaceAgent[],
  threads: readonly Thread[],
  now: number,
): Promise<DispatchRecord[]> {
  const records: DispatchRecord[] = [];
  for (const thread of threads) {
    for (const run of thread.runs) {
      if (
        (run.status !== 'running' &&
          run.status !== 'finishing' &&
          run.status !== 'completed') ||
        pendingTriggerIds(run).length === 0
      ) {
        continue;
      }
      const agent = agents.find((candidate) => candidate.id === run.agentId);
      if (!agent) continue;
      const base = { agentId: agent.id, threadId: thread.id, runId: run.id };
      let delivered = false;
      if (run.status === 'running' && port.deliver) {
        const state = await port.inspect({
          agent,
          threadId: thread.id,
          ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        });
        if (bodyCarriesRun(state, thread, run)) {
          const prompt = assembleAgentPrompt({
            workspaceId,
            agent,
            run,
            thread,
            roster: agents,
          });
          const through = thread.messages.find(
            (message) => message.sequence === prompt.contextThroughSequence,
          );
          if (through) {
            const committed =
              thread.deliveryByAgent[run.agentId]?.committedThroughSequence ??
              0;
            const messageIds = thread.messages
              .filter(
                (message) =>
                  message.sequence > committed &&
                  message.sequence <= prompt.contextThroughSequence,
              )
              .map((message) => message.id);
            delivered = await port.deliver({
              agent,
              prompt: prompt.text,
              deliveryId: through.id,
              workspaceId,
              threadId: thread.id,
              rootThreadId: thread.rootThreadId,
              runId: run.id,
              attempt: run.attempts,
              contextThroughSequence: prompt.contextThroughSequence,
              ...(run.sessionId ? { sessionId: run.sessionId } : {}),
            });
            if (delivered) {
              delivered = await acceptRunningDelivery(projectRoot, {
                threadId: thread.id,
                runId: run.id,
                attempt: run.attempts,
                throughSequence: prompt.contextThroughSequence,
                messageIds,
              });
            }
          }
        }
      }
      if (delivered) {
        records.push({ ...base, kind: 'delivered' });
        continue;
      }
      const successor = await rebookUndeliveredTriggers(
        projectRoot,
        thread.id,
        run.id,
        run.attempts,
        now,
      );
      if (successor) {
        records.push({
          ...base,
          kind: 'delivery_race',
          detail: successor.id,
        });
      }
    }
  }
  return records;
}

/**
 * Starts at most one run per idle agent, then delivers parent reports.
 *
 * Returns what happened to each candidate. `busy_other_thread` leaves the run
 * queued on purpose: it is an observation about this instant, and the next
 * pass re-reads it rather than persisting a decision that was already stale
 * when it was written.
 */
/**
 * The synthetic round a session's cumulative reading is recorded under.
 *
 * A session reports what it has spent in total, not what each round cost, so
 * there is no honest per-round breakdown to write. One entry that grows is the
 * truthful shape; inventing rounds would make the record look more precise
 * than the source.
 */
const SESSION_USAGE_ROUND = 1;

/**
 * Charges what this run cost, as the difference from its starting reading.
 *
 * A task session can carry several turns on the same thread. The baseline is
 * written when the run starts; the delta is what this run owes. A runtime that
 * cannot report usage charges nothing rather than guessing, which under-counts
 * instead of blocking work that was never measured.
 */
async function chargeRunUsage(
  projectRoot: string,
  port: AgentDispatchPort,
  agent: WorkspaceAgent,
  threadId: string,
  run: ThreadRun,
): Promise<void> {
  if (!port.totalTokens) return;
  const total = await port.totalTokens({
    agent,
    threadId,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
  });
  if (total === undefined) return;
  const baseline = run.usageBaselineTokens ?? 0;
  const spent = Math.max(0, total - baseline);
  if (spent === 0) return;
  await upsertRunUsage(projectRoot, threadId, run.id, {
    attempt: run.attempts,
    round: SESSION_USAGE_ROUND,
    tokens: spent,
  });
}

export async function dispatchOnce(
  projectRoot: string,
  port: AgentDispatchPort,
  options: { now?: number } = {},
): Promise<DispatchRecord[]> {
  const now = options.now ?? Date.now();
  const workspace = await readAgentWorkspace(projectRoot);
  const agents = await readWorkspaceAgents(projectRoot);
  let { threads } = await listThreads(projectRoot);
  const records: DispatchRecord[] = [];

  records.push(
    ...(await reconcileInterruptedRuns(
      projectRoot,
      port,
      agents,
      threads,
      now,
    )),
  );
  ({ threads } = await listThreads(projectRoot));
  records.push(
    ...(await deliverRunningInputs(
      projectRoot,
      port,
      workspace.workspaceId,
      agents,
      threads,
      now,
    )),
  );
  ({ threads } = await listThreads(projectRoot));

  for (const candidate of selectCandidates(agents, threads)) {
    const { agent, thread, run } = candidate;
    const base = { agentId: agent.id, threadId: thread.id, runId: run.id };
    const sessionId = priorSessionId(thread, run);

    const state = await port.inspect({
      agent,
      threadId: thread.id,
      ...(sessionId ? { sessionId } : {}),
    });
    if (!canStart(state)) {
      // The store says this agent is free and the runtime says it is not. The
      // runtime is authoritative about its own body, so leave the run queued
      // and report the divergence rather than starting a second one.
      records.push({
        ...base,
        kind:
          state.kind === 'running'
            ? 'busy_other_thread'
            : state.kind === 'unavailable'
              ? 'runtime_unavailable'
              : 'runtime_divergence',
        ...(state.kind === 'running' && state.threadId
          ? { detail: state.threadId }
          : state.kind === 'unavailable'
            ? { detail: state.error }
            : {}),
      });
      continue;
    }

    const claimed = await claimRun(projectRoot, {
      threadId: thread.id,
      runId: run.id,
      now,
    });
    if (!claimed) continue;

    const prompt = assembleAgentPrompt({
      workspaceId: workspace.workspaceId,
      agent,
      run: claimed.run,
      thread: claimed.thread,
      roster: agents,
    });

    // Reserve the session id before the port creates it. Session creation
    // authorizes an `sourceType: agent` claim by finding a live run that names
    // the session; `bindRunSession` below only runs once `start` has returned,
    // so without this the first turn on every thread would be refused by the
    // check meant to keep other callers out.
    const plannedSessionId = port.plannedSessionId?.({
      agent,
      threadId: thread.id,
      ...(sessionId ? { sessionId } : {}),
    });
    if (plannedSessionId) {
      await reserveRunSession(projectRoot, {
        threadId: thread.id,
        runId: run.id,
        attempt: claimed.run.attempts,
        sessionId: plannedSessionId,
      });
    }

    const result = await port.start({
      agent,
      prompt: prompt.text,
      workspaceId: workspace.workspaceId,
      threadId: thread.id,
      threadTitle: thread.title,
      rootThreadId: thread.rootThreadId,
      runId: run.id,
      attempt: claimed.run.attempts,
      contextThroughSequence: prompt.contextThroughSequence,
      ...(sessionId ? { sessionId } : {}),
    });

    if (result.status === 'started') {
      // Session ports prepare first: persist the baseline and run binding
      // before activation lets the model call any thread tools.
      const usageBaselineTokens = await port.totalTokens?.({
        agent,
        threadId: thread.id,
        sessionId: result.sessionId,
      });
      if (
        run.attempts > 0 &&
        run.usageBaselineTokens !== undefined &&
        usageBaselineTokens !== undefined &&
        usageBaselineTokens > run.usageBaselineTokens
      ) {
        await upsertRunUsage(projectRoot, thread.id, run.id, {
          attempt: run.attempts,
          round: SESSION_USAGE_ROUND,
          tokens: usageBaselineTokens - run.usageBaselineTokens,
        });
      }
      await bindRunSession(projectRoot, {
        threadId: thread.id,
        runId: run.id,
        attempt: claimed.run.attempts,
        sessionId: result.sessionId,
        contextThroughSequence: prompt.contextThroughSequence,
        ...(usageBaselineTokens !== undefined ? { usageBaselineTokens } : {}),
      });
      result.activate?.();
      records.push({ ...base, kind: 'started' });
      continue;
    }

    // A configuration error and a failed start are both terminal for this run,
    // and both must release the queue slot. Leaving it queued would make one
    // broken agent definition look like an agent that is merely slow.
    await withAgentStoreTransaction(projectRoot, (transaction) =>
      finishRunInTransaction(transaction, {
        threadId: thread.id,
        runId: run.id,
        outcome: {
          status: 'failed',
          attempt: claimed.run.attempts,
          error: result.error,
          failureStage:
            result.status === 'agent_unavailable' ? 'definition' : 'launch',
        },
        now,
      }),
    );
    records.push({
      ...base,
      kind:
        result.status === 'agent_unavailable'
          ? 'agent_unavailable'
          : 'launch_failed',
      detail: result.error,
    });
  }

  await deliverParentReports(projectRoot);
  return records;
}

function isParentReport(event: ThreadEvent): boolean {
  return event.kind === 'parent_report';
}

function parentReportText(thread: Thread, event: ThreadEvent): string {
  const label = `Sub-thread ${thread.id} ("${thread.title}")`;
  switch (event.payload['event']) {
    case 'child_blocked':
      return `${label} is blocked: ${String(event.payload['reason'] ?? 'it needs input')}`;
    case 'child_failed':
      return `${label} failed: ${String(event.payload['error'] ?? 'unknown error')}`;
    case 'child_cancelled':
      return `${label} was cancelled.`;
    case 'child_done':
      return `${label} was marked done by a person.`;
    case 'child_replied':
      // Not quoted: an @name in the answer would wake that agent instead of
      // the parent's assignee.
      return `${label} replied. Read it with thread_read.`;
    default:
      return `${label} is ready for review.`;
  }
}

/**
 * Posts each pending parent report into its parent thread, exactly once.
 *
 * The event id is the idempotency key: a replay finds the message already
 * carrying that `originEventId` and returns it instead of posting again. The
 * report is system-authored but keeps the child run that caused it, so the hop
 * is auditable and charged rather than suppressed as a self-post — and because
 * it is not written by the parent's own assignee, it wakes them even when one
 * agent owns both threads.
 */
export async function deliverParentReports(
  projectRoot: string,
): Promise<number> {
  const { threads } = await listThreads(projectRoot);
  let delivered = 0;
  for (const thread of threads) {
    if (
      !thread.outbox.some(
        (event) => event.status === 'pending' && isParentReport(event),
      )
    ) {
      continue;
    }
    await reconcileThreadOutbox(
      projectRoot,
      thread.id,
      async (transaction, event) => {
        const parentThreadId = event.payload['parentThreadId'];
        if (typeof parentThreadId !== 'string') return;
        const parent = await transaction.readThread(parentThreadId);
        if (!parent) return;
        await postMessageInTransaction(transaction, parentThreadId, {
          from: SYSTEM_AUTHOR_ID,
          authorKind: 'system',
          ...(event.causedByRunId ? { sourceRunId: event.causedByRunId } : {}),
          triggerKind: 'child_report',
          originEventId: event.id,
          text: parentReportText(thread, event),
        });
        delivered += 1;
      },
      isParentReport,
    );
  }
  return delivered;
}
