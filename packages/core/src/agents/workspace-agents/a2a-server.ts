/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview The five required A2A operations, over the local store.
 *
 * Transport-free on purpose. What a JSON-RPC layer adds is framing and HTTP
 * status codes; what can actually be got wrong — who may call, what a retry
 * does, which task a caller may see, what state a caller is told — is all here,
 * so all of it can be exercised without a socket.
 *
 * Every operation takes the caller's identity and secret rather than trusting a
 * caller id in the request body: an id in a payload is a claim, and the whole
 * point of a grant is that the claim gets checked.
 */

import {
  A2A_PROTOCOL_VERSION,
  A2A_TRANSPORT_BINDING,
  QWEN_A2A_EXTENSION_URI,
  toExternalA2ATaskState,
  toQwenA2ATaskMetadata,
} from './a2a-contract.js';
import type { A2ATaskState, QwenA2ATaskMetadata } from './a2a-contract.js';
import { checkA2AGrant } from './a2a-grants.js';
import {
  acceptExternalSubmission,
  cancelExternalThreadForCaller,
  getExternalThreadForCaller,
  ExternalIntakeConflictError,
  ExternalIntakeRefusedError,
} from './external-intake.js';
import {
  isAgentAddressable,
  isAgentLocal,
  isValidId,
  readWorkspaceAgents,
  withAgentStoreTransaction,
  type AgentStoreTransaction,
} from './store.js';
import { isThreadTerminal, type Thread, type WorkspaceAgent } from './types.js';

/**
 * What the transport is told to answer.
 *
 * A closed set, so a new failure cannot reach a caller as an unmapped
 * exception carrying an internal message. `refused` is deliberately one value
 * covering every authorisation failure: an unauthorised caller must not be
 * able to tell "no such agent" from "wrong secret" from "revoked", or it can
 * enumerate this daemon's agents.
 */
export type A2AFailure =
  | { kind: 'refused' }
  | { kind: 'not_found' }
  | { kind: 'conflict'; existingTaskId: string }
  | { kind: 'invalid'; detail: string }
  /** An authorised request this build cannot carry out. */
  | { kind: 'unsupported'; detail: string };

/**
 * Thread-era A2A runs a task as a thread run. Only local agents execute
 * those: Host v1, which leased thread runs to remote Hosts, was replaced by
 * Host v2 (session turns), so a managed-host agent's run would stay queued
 * forever. Refused up front instead (see dispatcher.ts `selectCandidates`).
 */
export const A2A_REMOTE_AGENT_UNSUPPORTED =
  'Remote agents cannot take A2A tasks in this build.';

/**
 * Leads a remote agent's skill description on the caller's card (see
 * {@link a2aAgentCardForCaller}): a task sent to it answers `unsupported`.
 */
export const A2A_REMOTE_AGENT_CARD_NOTE = `Unavailable via A2A in this build: ${A2A_REMOTE_AGENT_UNSUPPORTED}`;

export type A2AResult<T> =
  | { ok: true; value: T }
  | ({ ok: false } & A2AFailure);

/** The A2A `Task` this daemon publishes, in the shape the spec names. */
export interface A2ATaskView {
  id: string;
  contextId: string;
  status: { state: A2ATaskState; timestamp: string };
  metadata: Record<string, QwenA2ATaskMetadata>;
  /** The latest agent post: what the caller asked for. */
  answer?: string;
}

export interface A2ACaller {
  callerId: string;
  secret: string;
}

async function taskView(
  transaction: AgentStoreTransaction,
  threadId: string,
  listedThreads?: readonly Thread[],
): Promise<A2ATaskView> {
  const thread = await transaction.readThread(threadId);
  if (!thread?.externalIntake) throw new Error('External task disappeared.');
  let result = thread.externalIntake.result;
  let state: A2ATaskState;
  let at: number;
  let answer: string | undefined;
  if (result) {
    ({ state, at, answer } = result);
  } else {
    if (isThreadTerminal(thread.status)) {
      listedThreads = [];
    } else if (!listedThreads) {
      const listing = await transaction.listThreads();
      if (listing.unreadable.length > 0)
        throw new Error('Thread records are unreadable.');
      listedThreads = listing.threads;
    }
    const descendants = listedThreads.filter(
      (member) => member.rootThreadId === thread.id && member.id !== thread.id,
    );
    state = toExternalA2ATaskState(thread, descendants);
    at = Math.max(lastActivityAt(thread), ...descendants.map(lastActivityAt));
    // Local people may invite other agents; only the granted agent's root
    // answer belongs to the external caller.
    answer = thread.messages.findLast(
      (message) =>
        message.authorKind === 'agent' &&
        message.from === thread.externalIntake?.targetAgentId,
    )?.text;
    if (
      state === 'TASK_STATE_COMPLETED' ||
      state === 'TASK_STATE_FAILED' ||
      state === 'TASK_STATE_CANCELED'
    ) {
      result = { state, at, ...(answer ? { answer } : {}) };
      await transaction.writeThread({
        ...thread,
        externalIntake: { ...thread.externalIntake, result },
      });
    }
  }
  return {
    id: thread.id,
    contextId: thread.rootThreadId,
    status: { state, timestamp: new Date(at).toISOString() },
    metadata: { [QWEN_A2A_EXTENSION_URI]: toQwenA2ATaskMetadata(thread) },
    ...(answer ? { answer } : {}),
  };
}

/**
 * `admit` gates new work and the card: the agent must still take work.
 * `read` gates reading, listing and withdrawing tasks already submitted: a
 * valid grant and an agent record that still exists are enough, so retiring
 * or disabling an agent does not hide its callers' tasks or leave them
 * uncancelable. Revoking or expiring the grant still hides them.
 */
type AuthorizeMode = 'admit' | 'read';

/**
 * When the task last changed, not when it was read: a poll must not report
 * that the status just moved.
 */
function lastActivityAt(thread: Thread): number {
  return Math.max(
    thread.createdAt,
    ...thread.messages.map((message) => message.at),
    ...thread.runs.map((run) => run.endedAt ?? run.startedAt ?? run.queuedAt),
  );
}

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
 * `sendMessage` — submit work, or re-present a submission already made.
 *
 * Returns a `Task` rather than a `Message`: the work is asynchronous, and the
 * spec's Message branch is for an answer available immediately, which a
 * dispatched agent turn never is.
 */
export async function a2aSendMessage(
  projectRoot: string,
  caller: A2ACaller,
  request: {
    agentId: string;
    messageId: string;
    title: string;
    body: string;
    acceptanceCriteria?: string;
  },
): Promise<A2AResult<A2ATaskView>> {
  if (!request.messageId || !request.body) {
    return {
      ok: false,
      kind: 'invalid',
      detail: 'messageId and body required',
    };
  }
  const auth = await authorize(projectRoot, caller, request.agentId);
  if (!auth.ok) return { ok: false, kind: 'refused' };
  // After the grant check, so only an authorised caller learns where the
  // agent runs.
  if (!isAgentLocal(auth.agent)) {
    return {
      ok: false,
      kind: 'unsupported',
      detail: A2A_REMOTE_AGENT_UNSUPPORTED,
    };
  }
  try {
    const accepted = await acceptExternalSubmission(projectRoot, {
      callerId: caller.callerId,
      targetAgentId: request.agentId,
      messageId: request.messageId,
      title: request.title || request.body.slice(0, 80),
      body: request.body,
      ...(request.acceptanceCriteria
        ? { acceptanceCriteria: request.acceptanceCriteria }
        : {}),
    });
    return {
      ok: true,
      value: await withAgentStoreTransaction(projectRoot, (transaction) =>
        taskView(transaction, accepted.thread.id),
      ),
    };
  } catch (error) {
    if (error instanceof ExternalIntakeConflictError) {
      return {
        ok: false,
        kind: 'conflict',
        existingTaskId: error.existingThreadId,
      };
    }
    if (error instanceof ExternalIntakeRefusedError) {
      return { ok: false, kind: 'refused' };
    }
    throw error;
  }
}

/**
 * `getTask` — poll one task.
 *
 * `not_found` covers missing tasks, ownership and credential failures so an
 * unauthorised caller cannot distinguish them by their error codes.
 */
export async function a2aGetTask(
  projectRoot: string,
  caller: A2ACaller,
  taskId: string,
): Promise<A2AResult<A2ATaskView>> {
  // Not a thread id at all is the same answer as someone else's thread.
  if (!isValidId(taskId)) return { ok: false, kind: 'not_found' };
  const thread = await getExternalThreadForCaller(
    projectRoot,
    caller.callerId,
    taskId,
  );
  if (!thread || !thread.externalIntake)
    return { ok: false, kind: 'not_found' };
  const auth = await authorize(
    projectRoot,
    caller,
    thread.externalIntake.targetAgentId,
    'read',
  );
  // A revoked caller loses its own history too. Otherwise revocation would
  // stop new work while leaving the old readable indefinitely.
  if (!auth.ok) return { ok: false, kind: 'not_found' };
  return {
    ok: true,
    value: await withAgentStoreTransaction(projectRoot, (transaction) =>
      taskView(transaction, thread.id),
    ),
  };
}

/** `listTasks` — this caller's tasks and no one else's. */
export async function a2aListTasks(
  projectRoot: string,
  caller: A2ACaller,
  agentId: string,
): Promise<A2AResult<A2ATaskView[]>> {
  const auth = await authorize(projectRoot, caller, agentId, 'read');
  if (!auth.ok) return { ok: false, kind: 'refused' };
  return withAgentStoreTransaction(projectRoot, async (transaction) => {
    const { threads, unreadable } = await transaction.listThreads();
    if (unreadable.length > 0)
      throw new Error('Thread records are unreadable.');
    const value: A2ATaskView[] = [];
    for (const thread of threads) {
      if (
        thread.externalIntake?.callerId === caller.callerId &&
        thread.externalIntake.targetAgentId === agentId
      ) {
        value.push(await taskView(transaction, thread.id, threads));
      }
    }
    return { ok: true as const, value };
  });
}

/**
 * `cancelTask` — withdraw work.
 *
 * The returned task says no further work will start. It does not claim the
 * body has stopped: `runsStillLive` is reported alongside so the transport can
 * keep the receipt and the actual stop separate, which the plan requires.
 */
export async function a2aCancelTask(
  projectRoot: string,
  caller: A2ACaller,
  taskId: string,
): Promise<A2AResult<{ task: A2ATaskView; runsStillLive: number }>> {
  if (!isValidId(taskId)) return { ok: false, kind: 'not_found' };
  const existing = await getExternalThreadForCaller(
    projectRoot,
    caller.callerId,
    taskId,
  );
  if (!existing?.externalIntake) return { ok: false, kind: 'not_found' };
  const auth = await authorize(
    projectRoot,
    caller,
    existing.externalIntake.targetAgentId,
    'read',
  );
  if (!auth.ok) return { ok: false, kind: 'not_found' };
  const cancelled = await cancelExternalThreadForCaller(
    projectRoot,
    caller.callerId,
    taskId,
  );
  if (!cancelled) return { ok: false, kind: 'not_found' };
  return {
    ok: true,
    value: {
      task: await withAgentStoreTransaction(projectRoot, (transaction) =>
        taskView(transaction, cancelled.thread.id),
      ),
      runsStillLive: cancelled.runsStillLive,
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

/**
 * `getAuthenticatedExtendedAgentCard` — what this daemon offers one caller.
 *
 * Built per caller rather than published wholesale: the card names the agents
 * it can address, and that list is exactly its grants. A caller with one grant
 * does not learn from the card that other agents exist. The unauthenticated
 * card at `.well-known/agent-card.json` is a different, deliberately emptier
 * document — it exists for discovery, not for enumeration.
 *
 * A granted remote (managed-host) agent stays on the card, its description
 * led by {@link A2A_REMOTE_AGENT_CARD_NOTE}, rather than being left out: the
 * transport answers an empty skill list as `refused` (routes/a2a.ts,
 * `getAuthenticatedExtendedAgentCard`), so omitting it would make a granted
 * caller look unauthorised. Like `a2aSendMessage`, which checks the grant
 * before locality, only an authorised caller learns where the agent runs,
 * and `refused` stays distinct from `unsupported`.
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
    const description = auth.agent.description ?? '';
    skills.push({
      id: auth.agent.id,
      name: auth.agent.name,
      description: isAgentLocal(auth.agent)
        ? description
        : [A2A_REMOTE_AGENT_CARD_NOTE, description].filter(Boolean).join(' '),
    });
  }
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: 'Qwen Code workspace agents',
    description: 'Workspace agents collaborating on shared task threads',
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
          description:
            'Carries the local thread status A2A merges, and token usage, which A2A 1.0 does not model',
          required: false,
        },
      ],
    },
    skills,
  };
}
