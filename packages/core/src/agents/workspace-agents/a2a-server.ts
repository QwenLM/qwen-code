/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview The five required A2A operations, over chat sessions.
 *
 * Transport-free on purpose. What a JSON-RPC layer adds is framing and HTTP
 * status codes; what can actually be got wrong — who may call, what a retry
 * does, which task a caller may see, what state a caller is told — is all here,
 * so all of it can be exercised without a socket.
 *
 * An A2A task is one agent run in a chat session the daemon created for the
 * caller (see `a2a-contract.ts`). Running agents is the daemon orchestrator's
 * job, which this package cannot reach, so it arrives as an
 * {@link A2ASessionPort}; the caller-to-task mapping and its idempotency are
 * `external-intake.ts`.
 *
 * Every operation takes the caller's identity and secret rather than trusting a
 * caller id in the request body: an id in a payload is a claim, and the whole
 * point of a grant is that the claim gets checked.
 *
 * Approvals: an A2A caller cannot answer a tool approval. A run waiting on
 * one is reported as `INPUT_REQUIRED` with `localStatus: 'awaiting_approval'`,
 * and the workspace owner answers it in the chat session in WebShell (the
 * session is listed there as "A2A · <caller>").
 */

import { createHash } from 'node:crypto';

import type {
  AgentMessageRecordPayload,
  SessionAgentRunStatus,
} from '../session-agents/contract.js';
import {
  isTerminalSessionAgentRunStatus,
  isValidSessionAgentsSessionId,
  readSessionAgents,
} from '../session-agents/binding-store.js';
import { resolveMentionTargetsWithSquads } from '../session-agents/chain.js';
import { readSquads } from '../session-agents/squad-store.js';
import {
  A2A_PROTOCOL_VERSION,
  A2A_TRANSPORT_BINDING,
  QWEN_A2A_EXTENSION_URI,
  a2aMentionText,
  externalRequestKey,
  isTerminalA2ATaskState,
  toA2ATaskState,
} from './a2a-contract.js';
import type { A2ATaskState, QwenA2ATaskMetadata } from './a2a-contract.js';
import { checkA2AGrant } from './a2a-grants.js';
import {
  ExternalIntakeConflictError,
  ExternalIntakeUnknownContextError,
  attachExternalSession,
  completeExternalSubmission,
  getExternalTaskForCaller,
  listExternalTasksForCaller,
  recordExternalTaskResult,
  reserveExternalSubmission,
  type ExternalTaskEntry,
  type ExternalTaskResult,
} from './external-intake.js';
import { isAgentAddressable, readWorkspaceAgents } from './store.js';
import type { WorkspaceAgent } from './types.js';

/**
 * What the transport is told to answer.
 *
 * A closed set, so a new failure cannot reach a caller as an unmapped
 * exception carrying an internal message. `refused` is deliberately one value
 * covering every authorisation failure: an unauthorised caller must not be
 * able to tell "no such agent" from "wrong secret" from "revoked", or it can
 * enumerate this daemon's agents. `unavailable` is retryable: the workspace's
 * agents are not running right now.
 */
export type A2AFailure =
  | { kind: 'refused' }
  | { kind: 'not_found' }
  | { kind: 'unavailable' }
  | { kind: 'conflict'; existingTaskId?: string }
  | { kind: 'invalid'; detail: string };

export type A2AResult<T> =
  | { ok: true; value: T }
  | ({ ok: false } & A2AFailure);

/** The A2A `Task` this daemon publishes, in the shape the spec names. */
export interface A2ATaskView {
  /** The agent run id. */
  id: string;
  /** The chat session id. */
  contextId: string;
  status: { state: A2ATaskState; timestamp: string };
  metadata: Record<string, QwenA2ATaskMetadata>;
  /** The granted agent's reply: what the caller asked for. */
  answer?: string;
  /** A sentence for `TaskStatus.message`, when the state needs one. */
  statusText?: string;
}

export interface A2ACaller {
  callerId: string;
  secret: string;
}

/**
 * A run the orchestrator still reports (its snapshot frame): queued or
 * executing, or finished but not settled — its reply record pending, or
 * interrupted by a daemon restart and offered to the owner for a retry.
 */
export interface A2ASessionRun {
  status: SessionAgentRunStatus;
  /** Epoch ms of the last activity. */
  activityAt?: number;
  error?: string;
  totalTokens?: number;
  /** Finished runs: whether the reply record is in the transcript. */
  recorded?: boolean;
  /** Interrupted by a restart; the workspace owner may retry it. */
  retryable?: boolean;
}

/** A finished run's `agent_message` record, read from the transcript. */
export interface A2ARecordedReply {
  payload: AgentMessageRecordPayload;
  /** Epoch ms the record was written. */
  at?: number;
}

/**
 * What A2A needs from the daemon's session multi-agent orchestrator. The
 * daemon implements it (`cli/src/serve/session-agents/a2a-sessions.ts`);
 * tests fake it. Refusals are an {@link A2ASessionError}; anything else is an
 * internal failure.
 */
export interface A2ASessionPort {
  /** Creates a chat session for this caller and returns its id. */
  createSession(input: {
    callerId: string;
    agentId: string;
    title: string;
  }): Promise<string>;
  /**
   * Closes and removes a session {@link createSession} made that no task
   * could be recorded against.
   */
  discardSession(sessionId: string): Promise<void>;
  /**
   * Posts `text` into the session; the agents it @-mentions answer.
   * Idempotent on `clientMessageId`.
   */
  mention(
    sessionId: string,
    input: { text: string; clientMessageId: string },
  ): Promise<{ runs: Array<{ runId: string; agentId: string }> }>;
  /** The run while the orchestrator reports it; undefined otherwise. */
  liveRun(sessionId: string, runId: string): Promise<A2ASessionRun | undefined>;
  /**
   * The run's `agent_message` record once it is in the transcript; undefined
   * while it is not. Rejects when the transcript cannot be read, so an
   * unreadable file is never taken for "no reply".
   */
  recordedReply(
    sessionId: string,
    runId: string,
  ): Promise<A2ARecordedReply | undefined>;
  /**
   * Cancels a live run, or dismisses one offered for a retry. False when it
   * is neither.
   */
  cancel(sessionId: string, runId: string): Promise<boolean>;
}

/** A refusal from the port, mapped onto {@link A2AFailure}. */
export class A2ASessionError extends Error {
  constructor(
    readonly kind: 'refused' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'A2ASessionError';
  }
}

/** What a session created for an external caller is called in WebShell. */
export function a2aSessionTitle(callerId: string): string {
  return `A2A · ${callerId}`;
}

/**
 * The `clientMessageId` of the post an external message becomes. Derived
 * from the request key, so a retry after a crash between posting and
 * recording the run hits the orchestrator's own idempotency instead of
 * queueing the work twice.
 */
export function a2aClientMessageId(key: string): string {
  return `a2a:${createHash('sha256').update(key).digest('hex').slice(0, 48)}`;
}

const APPROVAL_STATUS_TEXT =
  'Waiting for the workspace owner to approve a tool call. Sending more input does not answer it.';
const REPLY_PENDING_STATUS_TEXT =
  'The agent finished; its reply is being recorded.';
const RETRYABLE_STATUS_TEXT =
  'The run was interrupted by a daemon restart; the workspace owner can retry it.';
const UNTRACKED_RUN_ERROR = 'The run is no longer tracked by this workspace.';
const REPLY_NOT_RECORDED_ERROR =
  'The agent finished, but its reply is not in the session.';

/**
 * What a poll saw; `retryable` results may still change, so are not kept.
 * `runId` is the run observed: the task's own, or the one an owner retry
 * replaced it with.
 */
type Observation = ExternalTaskResult & { retryable?: boolean; runId?: string };

function sessionFailure(error: A2ASessionError): A2AFailure {
  return error.kind === 'refused'
    ? { kind: 'refused' }
    : { kind: 'unavailable' };
}

function viewOf(entry: ExternalTaskEntry, observed: Observation): A2ATaskView {
  const metadata: QwenA2ATaskMetadata = {
    ...(observed.localStatus ? { localStatus: observed.localStatus } : {}),
    ...(observed.error ? { error: observed.error } : {}),
    ...(observed.tokensUsed !== undefined
      ? { tokensUsed: observed.tokensUsed }
      : {}),
  };
  const statusText =
    observed.localStatus === 'awaiting_approval'
      ? APPROVAL_STATUS_TEXT
      : observed.retryable
        ? RETRYABLE_STATUS_TEXT
        : observed.state === 'TASK_STATE_WORKING' &&
            observed.localStatus === 'completed'
          ? REPLY_PENDING_STATUS_TEXT
          : observed.error;
  return {
    id: entry.taskId ?? '',
    contextId: entry.sessionId ?? '',
    status: {
      state: observed.state,
      timestamp: new Date(observed.at).toISOString(),
    },
    metadata: { [QWEN_A2A_EXTENSION_URI]: metadata },
    ...(observed.answer ? { answer: observed.answer } : {}),
    ...(statusText ? { statusText } : {}),
  };
}

/**
 * Where the run is now. A run the workspace owner retried is followed to the
 * run that replaced it: the caller's task is the work, not one attempt at it.
 * The retry is read from the session's agent file, where it is persisted
 * with `retryOf` before it runs. Then, in order: what the orchestrator still
 * reports (live, or finished but not settled); the reply record in the
 * transcript; the run as last persisted in the agent file.
 */
async function observeRun(
  projectRoot: string,
  port: A2ASessionPort,
  sessionId: string,
  runId: string,
  fallbackAt: number,
  followed: ReadonlySet<string> = new Set(),
): Promise<Observation> {
  const file = await readSessionAgents(projectRoot, sessionId);
  const retry = file.runs.find((candidate) => candidate.retryOf === runId);
  // A run is replaced at most once (`run_already_retried`), so the chain has no
  // length bound and neither does the walk; the followed ids still end it if a
  // store file was edited into a cycle.
  if (retry && !followed.has(retry.id)) {
    return observeRun(
      projectRoot,
      port,
      sessionId,
      retry.id,
      fallbackAt,
      new Set([...followed, retry.id]),
    );
  }
  const live = await port.liveRun(sessionId, runId);
  if (live && live.recorded !== true) {
    return {
      // Finished, reply record still on its way: never COMPLETED without the
      // answer the caller is waiting for.
      state:
        live.status === 'completed'
          ? 'TASK_STATE_WORKING'
          : toA2ATaskState(live.status),
      at: live.activityAt ?? fallbackAt,
      runId,
      localStatus: live.status,
      ...(live.error ? { error: live.error } : {}),
      ...(live.retryable ? { retryable: true } : {}),
      ...(live.totalTokens !== undefined
        ? { tokensUsed: live.totalTokens }
        : {}),
    };
  }
  const reply = await port.recordedReply(sessionId, runId);
  if (reply) {
    const { payload } = reply;
    return {
      state: toA2ATaskState(payload.status),
      at: reply.at ?? Date.now(),
      runId,
      localStatus: payload.status,
      ...(payload.displayText.trim() ? { answer: payload.displayText } : {}),
      ...(payload.error ? { error: payload.error } : {}),
      ...(payload.totalTokens !== undefined
        ? { tokensUsed: payload.totalTokens }
        : {}),
    };
  }
  const run = file.runs.find((candidate) => candidate.id === runId);
  if (!run) {
    return {
      state: 'TASK_STATE_FAILED',
      at: Date.now(),
      error: UNTRACKED_RUN_ERROR,
    };
  }
  const at = run.endedAt ?? run.startedAt ?? run.createdAt;
  // Not reported by the orchestrator. `recorded: false` marks a finished run
  // whose record had not landed when the daemon stopped: startup recovery
  // offers it to the owner for a retry, so it is not final yet. Any other
  // finished run without a record will not get one.
  const offered = run.recorded === false;
  const common = {
    at,
    runId,
    localStatus: run.status,
    ...(offered ? { retryable: true } : {}),
    ...(run.totalTokens !== undefined ? { tokensUsed: run.totalTokens } : {}),
  };
  if (run.status === 'completed') {
    return offered && !run.error
      ? { state: 'TASK_STATE_WORKING', ...common }
      : {
          state: 'TASK_STATE_FAILED',
          error: run.error ?? REPLY_NOT_RECORDED_ERROR,
          ...common,
        };
  }
  return {
    state: isTerminalSessionAgentRunStatus(run.status)
      ? toA2ATaskState(run.status)
      : // On disk but not reported: the orchestrator is starting up and has
        // not adopted it yet. Its recovery settles it.
        'TASK_STATE_WORKING',
    ...(run.error ? { error: run.error } : {}),
    ...common,
  };
}

/**
 * The task as a poll sees it: its kept result, or its run now. A kept
 * failure is not final while the owner can retry the run, so one whose run
 * was retried since is observed again and its new outcome kept instead.
 */
async function observeTask(
  projectRoot: string,
  port: A2ASessionPort,
  callerId: string,
  entry: ExternalTaskEntry,
): Promise<Observation> {
  const { sessionId, taskId } = entry;
  if (!sessionId || !taskId) {
    throw new Error('External task has no run.');
  }
  if (
    entry.result &&
    (entry.result.state !== 'TASK_STATE_FAILED' ||
      !(await readSessionAgents(projectRoot, sessionId)).runs.some(
        (candidate) => candidate.retryOf === taskId,
      ))
  ) {
    return entry.result;
  }
  const observed = await observeRun(
    projectRoot,
    port,
    sessionId,
    taskId,
    entry.createdAt,
  );
  if (!isTerminalA2ATaskState(observed.state) || observed.retryable) {
    return observed;
  }
  if (
    entry.result?.state === observed.state &&
    entry.result.at === observed.at
  ) {
    return entry.result;
  }
  // Kept on first sight: the run is trimmed from the session's agent file
  // after 50 newer ones, and the owner may delete the session.
  const { runId: _runId, retryable: _retryable, ...result } = observed;
  return recordExternalTaskResult(projectRoot, callerId, taskId, result, {
    replace: entry.result !== undefined,
  });
}

async function taskView(
  projectRoot: string,
  port: A2ASessionPort,
  callerId: string,
  entry: ExternalTaskEntry,
): Promise<A2ATaskView> {
  return viewOf(entry, await observeTask(projectRoot, port, callerId, entry));
}

/**
 * `admit` gates new work and the card: the agent must still take work.
 * `read` gates reading, listing and withdrawing tasks already submitted: a
 * valid grant and an agent record that still exists are enough, so retiring
 * or disabling an agent does not hide its callers' tasks or leave them
 * uncancelable. Revoking or expiring the grant still hides them.
 */
type AuthorizeMode = 'admit' | 'read';

async function authorize(
  projectRoot: string,
  caller: A2ACaller,
  agentId: string,
  mode: AuthorizeMode = 'admit',
): Promise<{ ok: true; agent: WorkspaceAgent } | { ok: false }> {
  const check = await checkA2AGrant(projectRoot, {
    callerId: caller.callerId,
    agentId,
    secret: caller.secret,
  });
  if (!check.ok) return { ok: false };
  const agents = await readWorkspaceAgents(projectRoot);
  const agent = agents.find((candidate) => candidate.id === agentId);
  // A grant naming an agent that is gone, retired or disabled is not a way in.
  // Checked after the secret so a caller with no valid grant learns nothing
  // about which agents exist.
  if (!agent || (mode === 'admit' && !isAgentAddressable(agent))) {
    return { ok: false };
  }
  return { ok: true, agent };
}

/**
 * Accepts of one request key run one at a time within this daemon, so a
 * retry arriving while the first attempt is still starting the run waits
 * for it and then reads it as a duplicate.
 */
const acceptsInFlight = new Map<string, Promise<unknown>>();

async function serializedByKey<T>(
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = acceptsInFlight.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(run);
  acceptsInFlight.set(key, current);
  try {
    return await current;
  } finally {
    if (acceptsInFlight.get(key) === current) acceptsInFlight.delete(key);
  }
}

/**
 * `sendMessage` — submit work, or re-present a submission already made.
 *
 * Without `contextId` the daemon creates a chat session for the caller; with
 * one the caller was given, the message is another turn in that session and
 * the agent continues its native session. Either way the message is posted
 * as `@<agent> <text>` and the run it starts is the task.
 *
 * Returns a `Task` rather than a `Message`: the work is asynchronous, and the
 * spec's Message branch is for an answer available immediately, which an
 * agent turn never is.
 */
export async function a2aSendMessage(
  projectRoot: string,
  port: A2ASessionPort,
  caller: A2ACaller,
  request: {
    agentId: string;
    messageId: string;
    text: string;
    contextId?: string;
  },
): Promise<A2AResult<A2ATaskView>> {
  if (!request.messageId || !request.text.trim()) {
    return {
      ok: false,
      kind: 'invalid',
      detail: 'messageId and text required',
    };
  }
  // Not a session id at all is the same answer as someone else's session.
  if (
    request.contextId !== undefined &&
    !isValidSessionAgentsSessionId(request.contextId)
  ) {
    return { ok: false, kind: 'invalid', detail: 'Unknown contextId.' };
  }
  const auth = await authorize(projectRoot, caller, request.agentId);
  if (!auth.ok) return { ok: false, kind: 'refused' };
  const { agent } = auth;
  const key = externalRequestKey({
    callerId: caller.callerId,
    targetAgentId: agent.id,
    messageId: request.messageId,
  });
  return serializedByKey(
    `${projectRoot}\0${key}`,
    async (): Promise<A2AResult<A2ATaskView>> => {
      let entry: ExternalTaskEntry;
      let reserved: boolean;
      try {
        const reservation = await reserveExternalSubmission(projectRoot, {
          callerId: caller.callerId,
          targetAgentId: agent.id,
          messageId: request.messageId,
          text: request.text,
          ...(request.contextId !== undefined
            ? { contextId: request.contextId }
            : {}),
        });
        entry = reservation.entry;
        reserved = reservation.outcome === 'reserved';
      } catch (error) {
        if (error instanceof ExternalIntakeConflictError) {
          return {
            ok: false,
            kind: 'conflict',
            ...(error.existingTaskId
              ? { existingTaskId: error.existingTaskId }
              : {}),
          };
        }
        if (error instanceof ExternalIntakeUnknownContextError) {
          return { ok: false, kind: 'invalid', detail: error.message };
        }
        throw error;
      }
      if (reserved) {
        // A failure below leaves the reservation without a run; a retry of
        // the same request resumes it (in the same session, if one was made).
        try {
          const roster = await readWorkspaceAgents(projectRoot);
          const squads = await readSquads(projectRoot);
          const text = a2aMentionText(agent.name, request.text, [
            ...roster,
            ...squads.map((squad) => ({
              id: squad.id,
              name: squad.name,
              createdAt: squad.createdAt,
            })),
          ]);
          // The grant is for this agent alone. `a2aMentionText` neutralizes
          // every other agent and squad name; this checks that the post
          // addresses exactly it, and no squad.
          const targets = resolveMentionTargetsWithSquads(text, roster, squads);
          if (
            targets.agents.length !== 1 ||
            targets.agents[0]?.id !== agent.id ||
            targets.squads.length > 0
          ) {
            return { ok: false, kind: 'refused' };
          }
          let sessionId = entry.sessionId;
          if (!sessionId) {
            const created = await port.createSession({
              callerId: caller.callerId,
              agentId: agent.id,
              title: a2aSessionTitle(caller.callerId),
            });
            try {
              await attachExternalSession(
                projectRoot,
                caller.callerId,
                entry.key,
                created,
              );
            } catch (error) {
              // Not recorded, so a retry would create another: remove this
              // one rather than leave it in the owner's session list.
              await port.discardSession(created).catch(() => {});
              throw error;
            }
            sessionId = created;
          }
          const posted = await port.mention(sessionId, {
            text,
            clientMessageId: a2aClientMessageId(entry.key),
          });
          const run = posted.runs.find(
            (candidate) => candidate.agentId === agent.id,
          );
          if (!run) {
            throw new Error('The post started no run for the granted agent.');
          }
          entry = await completeExternalSubmission(
            projectRoot,
            caller.callerId,
            entry.key,
            run.runId,
          );
        } catch (error) {
          if (error instanceof A2ASessionError) {
            return { ok: false, ...sessionFailure(error) };
          }
          throw error;
        }
      }
      return {
        ok: true,
        value: await taskView(projectRoot, port, caller.callerId, entry),
      };
    },
  );
}

/** One of this caller's tasks with the grant for its agent still valid. */
async function authorizedTask(
  projectRoot: string,
  caller: A2ACaller,
  taskId: string,
): Promise<ExternalTaskEntry | undefined> {
  if (!taskId) return undefined;
  const entry = await getExternalTaskForCaller(
    projectRoot,
    caller.callerId,
    taskId,
  );
  if (!entry?.sessionId || !entry.taskId) return undefined;
  // A revoked caller loses its own history too. Otherwise revocation would
  // stop new work while leaving the old readable indefinitely.
  const auth = await authorize(projectRoot, caller, entry.agentId, 'read');
  return auth.ok ? entry : undefined;
}

/**
 * `getTask` — poll one task.
 *
 * `not_found` covers missing tasks, ownership and credential failures so an
 * unauthorised caller cannot distinguish them by their error codes.
 */
export async function a2aGetTask(
  projectRoot: string,
  port: A2ASessionPort,
  caller: A2ACaller,
  taskId: string,
): Promise<A2AResult<A2ATaskView>> {
  const entry = await authorizedTask(projectRoot, caller, taskId);
  if (!entry) return { ok: false, kind: 'not_found' };
  return {
    ok: true,
    value: await taskView(projectRoot, port, caller.callerId, entry),
  };
}

/** `listTasks` — this caller's tasks for one agent and no one else's. */
export async function a2aListTasks(
  projectRoot: string,
  port: A2ASessionPort,
  caller: A2ACaller,
  agentId: string,
): Promise<A2AResult<A2ATaskView[]>> {
  const auth = await authorize(projectRoot, caller, agentId, 'read');
  if (!auth.ok) return { ok: false, kind: 'refused' };
  const entries = await listExternalTasksForCaller(
    projectRoot,
    caller.callerId,
    agentId,
  );
  const value: A2ATaskView[] = [];
  for (const entry of entries) {
    value.push(await taskView(projectRoot, port, caller.callerId, entry));
  }
  return { ok: true, value };
}

/**
 * `cancelTask` — withdraw work.
 *
 * Cancels the run the task denotes now, which after an owner retry is the
 * replacement. A queued run is cancelled at once. An executing one is asked
 * to stop and reaches `CANCELED` when its program has stopped, so the
 * returned task may still be working: `runsStillLive` says so, keeping the
 * receipt and the actual stop separate. A task already finished is reported
 * as it ended, never rewritten to `CANCELED`. A run shared by coalesced
 * messages is one task; cancelling it cancels it for both.
 */
export async function a2aCancelTask(
  projectRoot: string,
  port: A2ASessionPort,
  caller: A2ACaller,
  taskId: string,
): Promise<A2AResult<{ task: A2ATaskView; runsStillLive: number }>> {
  const entry = await authorizedTask(projectRoot, caller, taskId);
  if (!entry?.sessionId || !entry.taskId) {
    return { ok: false, kind: 'not_found' };
  }
  const observed = await observeTask(projectRoot, port, caller.callerId, entry);
  let cancelled = false;
  if (
    observed.runId &&
    (!isTerminalA2ATaskState(observed.state) || observed.retryable)
  ) {
    try {
      cancelled = await port.cancel(entry.sessionId, observed.runId);
    } catch (error) {
      if (error instanceof A2ASessionError) {
        return { ok: false, ...sessionFailure(error) };
      }
      throw error;
    }
  }
  const task = await taskView(projectRoot, port, caller.callerId, entry);
  return {
    ok: true,
    value: {
      task,
      // Still live only when a run was asked to stop and has not yet.
      runsStillLive:
        cancelled && !isTerminalA2ATaskState(task.status.state) ? 1 : 0,
    },
  };
}

export interface A2AAgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  interfaces: Array<{ url: string; protocolBinding: string }>;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    extendedAgentCard: boolean;
    extensions: Array<{ uri: string; description: string; required: boolean }>;
  };
  skills: Array<{ id: string; name: string; description: string }>;
}

export const A2A_CARD_NAME = 'Qwen Code workspace agents';
export const A2A_CARD_DESCRIPTION =
  'Workspace agents answering in Qwen Code chat sessions';
export const A2A_EXTENSION_DESCRIPTION =
  'Carries the local run status A2A merges (awaiting_approval: the workspace owner must approve a tool call) and token usage, which A2A 1.0 does not model';

/**
 * `getAuthenticatedExtendedAgentCard` — what this daemon offers one caller.
 *
 * Built per caller rather than published wholesale: the card names the agents
 * it can address, and that list is exactly its grants. A caller with one grant
 * does not learn from the card that other agents exist. The unauthenticated
 * card at `.well-known/agent-card.json` is a different, deliberately emptier
 * document — it exists for discovery, not for enumeration.
 */
export async function a2aAgentCardForCaller(
  projectRoot: string,
  caller: A2ACaller,
  agentIds: readonly string[],
  baseUrl: string,
): Promise<A2AAgentCard> {
  const skills: A2AAgentCard['skills'] = [];
  for (const agentId of agentIds) {
    const auth = await authorize(projectRoot, caller, agentId);
    if (!auth.ok) continue;
    skills.push({
      id: auth.agent.id,
      name: auth.agent.name,
      description: auth.agent.description ?? '',
    });
  }
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: A2A_CARD_NAME,
    description: A2A_CARD_DESCRIPTION,
    interfaces: [
      { url: `${baseUrl}/a2a/v1`, protocolBinding: A2A_TRANSPORT_BINDING },
    ],
    capabilities: {
      // Not implemented, so not advertised. The spec gates the optional
      // operations on these flags, and advertising one we do not serve turns a
      // client's correct behaviour into a failed call.
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: true,
      extensions: [
        {
          uri: QWEN_A2A_EXTENSION_URI,
          description: A2A_EXTENSION_DESCRIPTION,
          required: false,
        },
      ],
    },
    skills,
  };
}
