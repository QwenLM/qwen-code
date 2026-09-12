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
  toA2ATaskState,
  toQwenA2ATaskMetadata,
} from './a2a-contract.js';
import type { A2ATaskState, QwenA2ATaskMetadata } from './a2a-contract.js';
import { checkA2AGrant } from './a2a-grants.js';
import {
  acceptExternalSubmission,
  cancelExternalThreadForCaller,
  getExternalThreadForCaller,
  listExternalThreadsForCaller,
  ExternalIntakeConflictError,
} from './external-intake.js';
import { isAgentAddressable, readWorkspaceAgents } from './store.js';
import type { A2AGrantScope, Thread, WorkspaceAgent } from './types.js';

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
  | { kind: 'invalid'; detail: string };

export type A2AResult<T> =
  | { ok: true; value: T }
  | ({ ok: false } & A2AFailure);

/** The A2A `Task` this daemon publishes, in the shape the spec names. */
export interface A2ATaskView {
  id: string;
  contextId: string;
  status: { state: A2ATaskState; timestamp: string };
  metadata: Record<string, QwenA2ATaskMetadata>;
}

export interface A2ACaller {
  callerId: string;
  secret: string;
}

function taskView(thread: Thread): A2ATaskView {
  return {
    id: thread.id,
    // The thread tree, not the thread: A2A calls contextId "the contextual
    // collection of interactions", which is what a parent and its splits are.
    contextId: thread.rootThreadId,
    status: {
      state: toA2ATaskState(thread.status),
      timestamp: new Date().toISOString(),
    },
    // Namespaced by the extension URI so a client that does not implement the
    // extension has no reason to read it, and two extensions cannot collide.
    metadata: { [QWEN_A2A_EXTENSION_URI]: toQwenA2ATaskMetadata(thread) },
  };
}

async function authorize(
  projectRoot: string,
  caller: A2ACaller,
  agentId: string,
  required: A2AGrantScope,
): Promise<{ ok: true; agent: WorkspaceAgent } | { ok: false }> {
  const check = await checkA2AGrant(projectRoot, {
    callerId: caller.callerId,
    agentId,
    secret: caller.secret,
    required,
  });
  if (!check.ok) return { ok: false };
  const agents = await readWorkspaceAgents(projectRoot);
  const agent = agents.find((candidate) => candidate.id === agentId);
  // A grant naming an agent that is gone, retired or disabled is not a way in.
  // Checked after the secret so a caller with no valid grant learns nothing
  // about which agents exist.
  if (!agent || !isAgentAddressable(agent)) return { ok: false };
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
  // Submitting work is `analysis` scope: it is the least a caller can be
  // granted and still be useful, so a read-only grant can do it. What the
  // agent is then allowed to *do* is the agent's own tool policy, not this.
  const auth = await authorize(
    projectRoot,
    caller,
    request.agentId,
    'analysis',
  );
  if (!auth.ok) return { ok: false, kind: 'refused' };
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
    return { ok: true, value: taskView(accepted.thread) };
  } catch (error) {
    if (error instanceof ExternalIntakeConflictError) {
      return {
        ok: false,
        kind: 'conflict',
        existingTaskId: error.existingThreadId,
      };
    }
    throw error;
  }
}

/**
 * `getTask` — poll one task.
 *
 * `not_found` covers both "no such task" and "not yours", because a caller
 * able to tell them apart can enumerate another client's task ids.
 */
export async function a2aGetTask(
  projectRoot: string,
  caller: A2ACaller,
  taskId: string,
): Promise<A2AResult<A2ATaskView>> {
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
    'analysis',
  );
  // A revoked caller loses its own history too. Otherwise revocation would
  // stop new work while leaving the old readable indefinitely.
  if (!auth.ok) return { ok: false, kind: 'refused' };
  return { ok: true, value: taskView(thread) };
}

/** `listTasks` — this caller's tasks and no one else's. */
export async function a2aListTasks(
  projectRoot: string,
  caller: A2ACaller,
  agentId: string,
): Promise<A2AResult<A2ATaskView[]>> {
  const auth = await authorize(projectRoot, caller, agentId, 'analysis');
  if (!auth.ok) return { ok: false, kind: 'refused' };
  const threads = await listExternalThreadsForCaller(
    projectRoot,
    caller.callerId,
  );
  return {
    ok: true,
    // Scoped twice: to the caller by the store, and to the agent the grant
    // names. One caller holding two grants must not see across them.
    value: threads
      .filter((thread) => thread.externalIntake?.targetAgentId === agentId)
      .map(taskView),
  };
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
    'analysis',
  );
  if (!auth.ok) return { ok: false, kind: 'refused' };
  const cancelled = await cancelExternalThreadForCaller(
    projectRoot,
    caller.callerId,
    taskId,
  );
  if (!cancelled) return { ok: false, kind: 'not_found' };
  return {
    ok: true,
    value: {
      task: taskView(cancelled.thread),
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
 */
export async function a2aAgentCardForCaller(
  projectRoot: string,
  caller: A2ACaller,
  agentIds: readonly string[],
  baseUrl: string,
): Promise<A2AAgentCard> {
  const skills: A2AAgentCard['skills'] = [];
  for (const agentId of agentIds) {
    const auth = await authorize(projectRoot, caller, agentId, 'analysis');
    if (!auth.ok) continue;
    skills.push({
      id: auth.agent.id,
      name: auth.agent.name,
      description: auth.agent.description ?? '',
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
