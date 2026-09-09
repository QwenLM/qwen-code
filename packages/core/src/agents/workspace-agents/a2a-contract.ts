/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview The frozen external contract (plan P1).
 *
 * A2A is a rolling document; this file is the version of it this daemon speaks,
 * pinned so that "A2A-compatible" means something checkable. Every constant
 * here was read from the specification and from `@a2a-js/sdk@1.1.0`'s own
 * type declarations, not inferred from prose — where the two disagree the SDK
 * wins, because it is what a real client links against.
 *
 * Nothing here talks to the network. It is the vocabulary the transport layer
 * will be held to when P2 builds it, kept separate so the mapping can be
 * exercised before any of that exists.
 */

import type { Thread, ThreadStatus } from './types.js';

/**
 * Wire version, sent and matched in the `A2A-Version` header. `Major.Minor`
 * only: the specification says patch versions SHOULD NOT appear in requests,
 * responses or Agent Cards.
 */
export const A2A_PROTOCOL_VERSION = '1.0';

/**
 * The one binding this daemon implements.
 *
 * The spec defines three (`JSONRPC`, `GRPC`, `HTTP+JSON`) and mandates none.
 * JSON-RPC is chosen because the daemon is already an Express app and
 * `@a2a-js/sdk` ships `./server/express` for exactly this shape — gRPC would
 * add `@grpc/grpc-js` and `@bufbuild/protobuf` as runtime peers for no
 * capability we need. Advertised in `AgentInterface.protocolBinding`.
 */
export const A2A_TRANSPORT_BINDING = 'JSONRPC';

/** Where the unauthenticated Agent Card is published (RFC 8615). */
export const A2A_AGENT_CARD_PATH = '.well-known/agent-card.json';

/** Response content type for the HTTP+JSON binding and push payloads. */
export const A2A_CONTENT_TYPE = 'application/a2a+json';

/** The SDK version these constants were read from. */
export const A2A_SDK_SPEC = '@a2a-js/sdk@1.1.0';

/**
 * Our protocol extension, declared in `AgentCapabilities.extensions`.
 *
 * A2A has nowhere in its data model for either of the two things we must carry
 * across the boundary, so both ride here rather than being smuggled into a
 * field that means something else:
 *
 *   - the run frame that tells a dispatched turn which thread it acts on. The
 *     local channel for this is `_meta` on the ACP prompt, which is a daemon
 *     trust boundary and deliberately not reachable from outside; an external
 *     task needs its own, and `Task.metadata` under this URI is it.
 *   - token usage, which A2A 1.0 does not model at all (see
 *     `A2A_UNSUPPORTED`).
 *
 * `required: false` when declared: a client that ignores the extension still
 * gets correct Task and Message semantics, it just cannot see usage.
 */
export const QWEN_A2A_EXTENSION_URI =
  'https://qwenlm.github.io/qwen-code/a2a/workspace-agents/v1';

/**
 * A2A task states, spelled as the SDK's `TaskState` enum spells them.
 *
 * Kept as our own union rather than importing the SDK enum: this package must
 * not take a runtime dependency on the transport layer, and the mapping below
 * is the thing worth testing, not the enum's numbering.
 */
export type A2ATaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_AUTH_REQUIRED'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_REJECTED';

/** The four the spec calls terminal. */
export const A2A_TERMINAL_STATES: ReadonlySet<A2ATaskState> = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

/**
 * Operations an A2A server MUST implement, named as `A2ARequestHandler`
 * declares them. Nothing may be advertised as A2A until all of these answer.
 */
export const A2A_REQUIRED_OPERATIONS = [
  'sendMessage',
  'getTask',
  'listTasks',
  'cancelTask',
  'getAuthenticatedExtendedAgentCard',
] as const;

/**
 * Optional operations and the capability flag each is gated on. We take none
 * of them in the first implementation: streaming and push notifications are
 * both ways of learning about a task sooner, and polling `getTask` answers the
 * same question with no second delivery path to make reliable.
 */
export const A2A_OPTIONAL_OPERATIONS = {
  sendMessageStream: 'streaming',
  resubscribe: 'streaming',
  createTaskPushNotificationConfig: 'pushNotifications',
  getTaskPushNotificationConfig: 'pushNotifications',
  listTaskPushNotificationConfigs: 'pushNotifications',
  deleteTaskPushNotificationConfig: 'pushNotifications',
} as const satisfies Record<string, 'streaming' | 'pushNotifications'>;

/**
 * What the protocol does not give us, recorded so nobody has to rediscover it
 * by building on an assumption. Each entry is a thing the plan asked P1 to
 * settle, and the settlement is here rather than in a document nobody links.
 */
export const A2A_UNSUPPORTED = {
  /**
   * A2A 1.0 has no usage or token fields on `Task` or `Message`. So remote
   * usage is NOT reported by the protocol and cannot be required of a
   * third-party agent. Ours is published in `Task.metadata` under
   * `QWEN_A2A_EXTENSION_URI`, and admission must treat a missing figure as
   * unknown rather than as zero — otherwise a remote agent that declines to
   * report becomes free to call.
   */
  usageReporting: 'absent from the data model; ours rides in Task.metadata',
  /**
   * Deduplication is `MAY`, on `Message.messageId`, and the id is minted by
   * the client. That is not enough on its own: two different callers can
   * present the same id, so a key has to be scoped. See
   * {@link externalRequestKey}.
   */
  idempotency: 'MAY, via client-minted Message.messageId; no scoping',
  /**
   * `TASK_STATE_REJECTED` (the agent declines the work) and
   * `TASK_STATE_AUTH_REQUIRED` have no counterpart in the local thread model,
   * and neither does a cancelled thread — `ThreadStatus` has no such member,
   * only runs do. An inbound `cancelTask` therefore cannot be represented
   * locally today; P2 must add it before claiming cancellation works.
   */
  localStateGaps: 'REJECTED, AUTH_REQUIRED and thread-level cancellation',
} as const;

/**
 * Local thread status → A2A task state.
 *
 * The unit mapping is deliberate and is the load-bearing decision here: an A2A
 * `Task` is one local `Thread`, not one `ThreadRun`. A Task survives
 * `INPUT_REQUIRED` and further input, which is exactly a thread being answered
 * and worked again; a run is a single turn and has no protocol counterpart. An
 * A2A `contextId` is then the thread tree — `rootThreadId` — since the spec
 * calls it "the contextual collection of interactions", which is what a parent
 * thread and its splits are.
 *
 * `in_review` maps to `INPUT_REQUIRED` rather than `WORKING`: the work is not
 * progressing and it is a person who unblocks it, which is what that state
 * means to a caller deciding whether to wait. The distinction between "asked a
 * question" and "submitted for review" is lost across the boundary; it is
 * preserved in the extension metadata for clients that care.
 */
export function toA2ATaskState(status: ThreadStatus): A2ATaskState {
  switch (status) {
    case 'open':
      return 'TASK_STATE_SUBMITTED';
    case 'in_progress':
      return 'TASK_STATE_WORKING';
    case 'blocked':
    case 'in_review':
      return 'TASK_STATE_INPUT_REQUIRED';
    case 'done':
      return 'TASK_STATE_COMPLETED';
    default: {
      // Exhaustiveness: a new ThreadStatus must decide what it looks like to a
      // caller, rather than silently arriving as some default.
      const unreachable: never = status;
      throw new Error(`Unmapped thread status: ${String(unreachable)}`);
    }
  }
}

/** True when a caller polling `getTask` may stop. */
export function isA2ATerminal(state: A2ATaskState): boolean {
  return A2A_TERMINAL_STATES.has(state);
}

/**
 * The idempotency key for an inbound external submission.
 *
 * The protocol offers only a client-minted `messageId`, so the server scopes
 * it: the same id from a different authenticated caller, or aimed at a
 * different agent, is a different request. Without the scope one caller could
 * collide with — or deliberately shadow — another's submission by reusing an
 * id it can see or guess.
 *
 * Must be computed and persisted in the same write that accepts the work. A
 * key written afterwards cannot answer the question it exists for, which is
 * whether a retry arriving mid-acceptance is the same request; and comparing a
 * stored key against a differing body is what makes "same key, different
 * content" a refusal rather than a silent overwrite.
 */
export function externalRequestKey(input: {
  /** Stable id of the authenticated caller, from the transport's auth. */
  callerId: string;
  /** The local agent the work is aimed at. */
  targetAgentId: string;
  /** `Message.messageId` as the caller minted it. */
  messageId: string;
}): string {
  const { callerId, targetAgentId, messageId } = input;
  if (!callerId || !targetAgentId || !messageId) {
    throw new Error(
      'An external request key needs a caller, a target agent and a message id',
    );
  }
  // Length-prefixed rather than delimiter-joined: ids are opaque strings from
  // outside, and a caller able to put the separator inside one could otherwise
  // produce another caller's key.
  return [callerId, targetAgentId, messageId]
    .map((part) => `${part.length}:${part}`)
    .join('');
}

/** Everything the extension publishes about a thread, for `Task.metadata`. */
export interface QwenA2ATaskMetadata {
  /** Distinguishes `blocked` from `in_review`, which A2A merges. */
  localStatus: ThreadStatus;
  /** Absent when this daemon has no figure; never reported as 0 for unknown. */
  tokensUsed?: number;
  rootThreadId: string;
}

export function toQwenA2ATaskMetadata(thread: Thread): QwenA2ATaskMetadata {
  return {
    localStatus: thread.status,
    rootThreadId: thread.rootThreadId,
    ...(typeof thread.tokensUsed === 'number'
      ? { tokensUsed: thread.tokensUsed }
      : {}),
  };
}
