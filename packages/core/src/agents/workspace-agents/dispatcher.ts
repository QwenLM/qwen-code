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
} from './store.js';
import {
  applyAggregateStatus,
  finishRunInTransaction,
  hasLiveDescendant,
} from './run-lifecycle.js';
import {
  bindRunSession,
  claimRun,
  postMessageInTransaction,
  requeueRun,
  releaseRunClaim,
  SYSTEM_AUTHOR_ID,
  upsertRunUsage,
} from './thread-actions.js';
import type {
  WorkspaceAgent,
  AgentNotifyTarget,
  Thread,
  ThreadEvent,
  ThreadRun,
} from './types.js';
import { threadPriorityRank } from './types.js';

/** What the runtime says about one agent's session on one thread. */
export type AgentBodyState =
  | { kind: 'absent' }
  | { kind: 'unavailable'; error: string }
  | { kind: 'paused' }
  | { kind: 'completed' }
  | { kind: 'failed'; runId: string; attempt: number; error: string }
  | {
      kind: 'running';
      threadId?: string;
      runId?: string;
      attempt?: number;
    };

/**
 * How a body is brought back for the next turn.
 *
 * Three, not four. Writing the production adapter showed that "continue the
 * resident chat" and "revive from the transcript" are not a choice the
 * dispatcher can make: the registry decides, because only it knows whether a
 * resident runtime is still attached, and it already reports the fallback as a
 * typed outcome. A dispatcher that picked between them would be guessing at
 * state it cannot see, and would cold-revive a body that was still resident.
 * What the dispatcher does choose is which of the three genuinely distinct
 * entry points applies: build the persona from scratch, restart a paused
 * entry, or continue a completed one.
 */
export type AgentStartAction = 'launch' | 'resume' | 'continue_completed';

export type AgentStartResult =
  | {
      status: 'started';
      sessionId: string;
      transcriptStartOffset?: number;
      consumedOnStart?: boolean;
      /** Start execution only after the session and usage baseline are saved. */
      activate?: () => void;
    }
  | { status: 'capacity_wait' }
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
    action: AgentStartAction;
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
  /** Definition content hash, when the port can supply one (§9.4). */
  definitionVersion?(agent: WorkspaceAgent): Promise<string | undefined>;
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
  | 'capacity_wait'
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
  return withAgentStoreTransaction(projectRoot, async (transaction) => {
    const thread = await transaction.readThread(threadId);
    const run = thread?.runs.find((entry) => entry.id === runId);
    if (
      !thread ||
      !run ||
      run.attempts !== attempt ||
      thread.status === 'done' ||
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
        thread.runs.some((entry) => entry.id === successor.id)
          ? []
          : [successor],
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
  });
}

/**
 * The oldest queued run for every agent that is not already working.
 *
 * Ordered by the lock-issued `queueSequence`, never by `queuedAt` or by file
 * enumeration: posts arrive from different processes whose wall clocks can
 * disagree, and directory order would let one thread starve behind another
 * purely because of how its id sorts.
 */
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
    if (thread.status === 'done') continue;
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

function actionFor(state: AgentBodyState): AgentStartAction | undefined {
  switch (state.kind) {
    case 'absent':
      return 'launch';
    case 'paused':
      return 'resume';
    case 'completed':
    case 'failed':
      return 'continue_completed';
    default:
      return undefined;
  }
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

      const hasUndrainedInput = run.acceptedMessageIds.some(
        (id) => !run.consumedMessageIds.includes(id),
      );
      if (
        run.status === 'finishing' ||
        (state.kind === 'completed' && !hasUndrainedInput)
      ) {
        // Charge before the run goes terminal: once it is completed the
        // baseline it was started with has nowhere left to live, and an
        // uncharged run would let a tree spend past its budget silently.
        await chargeRunUsage(projectRoot, port, agent, thread.id, run);
        await withAgentStoreTransaction(projectRoot, (transaction) =>
          finishRunInTransaction(transaction, {
            threadId: thread.id,
            runId: run.id,
            outcome: { status: 'completed', attempt: run.attempts },
            now,
          }),
        );
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
 * Returns what happened to each candidate. `capacity_wait` and
 * `busy_other_thread` leave the run queued on purpose: they are observations
 * about this instant, and the next pass re-reads them rather than persisting a
 * decision that was already stale when it was written.
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
    const action = actionFor(state);
    if (!action) {
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

    const definitionVersion = await port.definitionVersion?.(agent);
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
      ...(definitionVersion ? { definitionVersion } : {}),
    });

    const result = await port.start({
      action,
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
        consumedOnStart: result.consumedOnStart,
        ...(definitionVersion ? { definitionVersion } : {}),
        ...(result.transcriptStartOffset !== undefined
          ? { transcriptStartOffset: result.transcriptStartOffset }
          : {}),
        ...(usageBaselineTokens !== undefined ? { usageBaselineTokens } : {}),
      });
      result.activate?.();
      records.push({ ...base, kind: 'started' });
      continue;
    }

    if (result.status === 'capacity_wait') {
      // Backpressure, not failure: the run keeps its place and its attempt.
      await releaseRunClaim(projectRoot, {
        threadId: thread.id,
        runId: run.id,
        attempt: claimed.run.attempts,
      });
      records.push({ ...base, kind: 'capacity_wait' });
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

function isNotification(event: ThreadEvent): boolean {
  return event.kind === 'notification';
}

/** One line a person can act on, in the words the UI uses for the same state. */
export function notificationText(thread: Thread, event: ThreadEvent): string {
  const label = `"${thread.title}"`;
  switch (event.payload['event']) {
    case 'blocker_raised':
      return `${label} needs you: an agent asked a question and is waiting.`;
    case 'thread_in_review':
      return `${label} is ready for review.`;
    case 'gate_tripped':
      if (event.payload['reason'] === 'turn_budget_exhausted') {
        return `${label} reached its automatic-turn limit. Reply to reset the turn counter.`;
      }
      if (event.payload['reason'] === 'token_budget_exhausted') {
        return `${label} reached its task-tree token limit. A reply does not reset it; start a new root task to continue.`;
      }
      return `${label} reached a dispatch limit.`;
    case 'thread_blocked': {
      const reason = event.payload['reason'];
      return typeof reason === 'string'
        ? `${label} is blocked: ${reason}`
        : `${label} is blocked.`;
    }
    case 'run_failed_after_retry': {
      const error = event.payload['error'];
      return typeof error === 'string'
        ? `${label} has a run that failed twice: ${error}`
        : `${label} has a run that failed twice.`;
    }
    default:
      // Never assert a cause the payload does not carry.
      return `${label} changed and may need you.`;
  }
}

export interface AgentNotificationSender {
  (input: {
    target: AgentNotifyTarget;
    text: string;
    /** Stable per event, so a retry is not a second message downstream. */
    deliveryId: string;
  }): Promise<void>;
}

/**
 * Sends each pending notification once, and only once a destination exists.
 *
 * The workspace record carries no default destination, so with none set this
 * does nothing and the events stay pending — the same rule every unconsumed
 * event kind follows, and the reason the outbox reconciler takes a filter at
 * all. Acknowledging them into silence would be worse than not sending: the
 * thread state they announce is durable and visible either way, but a person
 * who configured a channel later would never learn what they missed.
 *
 * A send that throws leaves its event pending with its attempt counted, so the
 * next pass retries rather than dropping it. Duplicates are possible and
 * accepted; silent loss is not.
 */
export async function deliverNotifications(
  projectRoot: string,
  send: AgentNotificationSender | undefined,
): Promise<number> {
  if (!send) return 0;
  const workspace = await readAgentWorkspace(projectRoot);
  const target = workspace.notifyTarget;
  if (!target) return 0;

  const { threads } = await listThreads(projectRoot);
  let sent = 0;
  for (const thread of threads) {
    if (
      !thread.outbox.some(
        (event) => event.status === 'pending' && isNotification(event),
      )
    ) {
      continue;
    }
    await reconcileThreadOutbox(
      projectRoot,
      thread.id,
      async (_transaction, event) => {
        await send({
          target,
          text: notificationText(thread, event),
          deliveryId: event.id,
        });
        sent += 1;
      },
      isNotification,
    );
  }
  return sent;
}

/** Whether a thread still has a descendant that can wake it. Re-exported for
 * callers that need the same rule the status resolver uses. */
export { hasLiveDescendant };
