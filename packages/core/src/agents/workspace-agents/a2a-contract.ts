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
 * is held to, kept separate so the mapping can be exercised without it.
 *
 * The unit mapping (session multi-agent, see
 * docs/plans/2026-10-05-session-multi-agent-redesign.md): an A2A `Task` is ONE
 * agent run inside a chat session the daemon created for the caller, and the
 * A2A `contextId` is that chat session's id. A further message with the same
 * `contextId` is another run in the same session, so the agent's native
 * session — and what it remembers — carries over.
 */

import type { SessionAgentRunStatus } from '../session-agents/contract.js';
import { neutralizeMentions } from './mentions.js';
import { isValidAgentName } from './store.js';
import type { WorkspaceAgent } from './types.js';

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

/**
 * Our protocol extension, declared in `AgentCapabilities.extensions`.
 *
 * A2A has nowhere in its data model for the two things worth carrying across
 * the boundary, so both ride here rather than being smuggled into a field
 * that means something else:
 *
 *   - the local run status, which tells a caller seeing `INPUT_REQUIRED`
 *     whether more input would help (it would not for `awaiting_approval`:
 *     only the workspace owner can answer a tool approval);
 *   - token usage, which A2A 1.0 does not model at all.
 *
 * `required: false` when declared: a client that ignores the extension still
 * gets correct Task and Message semantics, it just cannot see the extras.
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

/** States after which a task never changes again. */
export function isTerminalA2ATaskState(state: A2ATaskState): boolean {
  return (
    state === 'TASK_STATE_COMPLETED' ||
    state === 'TASK_STATE_FAILED' ||
    state === 'TASK_STATE_CANCELED' ||
    state === 'TASK_STATE_REJECTED'
  );
}

/**
 * Session agent run status → A2A task state.
 *
 * `awaiting_approval` maps to `INPUT_REQUIRED`: the run is not progressing
 * and a person has to unblock it. That person is the workspace owner, who
 * answers the tool approval in the chat session in WebShell; the A2A caller
 * cannot, and sending more input does not answer it. `localStatus` in the
 * extension metadata tells the two apart.
 *
 * `offline` (the runtime that held the run went away) is a failure from the
 * caller's side: the run will not resume.
 */
export function toA2ATaskState(status: SessionAgentRunStatus): A2ATaskState {
  switch (status) {
    case 'queued':
      return 'TASK_STATE_SUBMITTED';
    case 'running':
      return 'TASK_STATE_WORKING';
    case 'awaiting_approval':
      return 'TASK_STATE_INPUT_REQUIRED';
    case 'completed':
      return 'TASK_STATE_COMPLETED';
    case 'failed':
    case 'offline':
      return 'TASK_STATE_FAILED';
    case 'cancelled':
      return 'TASK_STATE_CANCELED';
    default: {
      // Exhaustiveness: a new run status must decide what it looks like to a
      // caller, rather than silently arriving as some default.
      const unreachable: never = status;
      throw new Error(`Unmapped run status: ${String(unreachable)}`);
    }
  }
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
 * Must be persisted before the work is started. A key written afterwards
 * cannot answer the question it exists for, which is whether a retry arriving
 * mid-acceptance is the same request; and comparing a stored key against a
 * differing body is what makes "same key, different content" a refusal
 * rather than a silent overwrite.
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

/** U+2060 WORD JOINER: invisible, and not a letter or digit. */
const WORD_JOINER = '⁠';

/**
 * The chat-session post an external message becomes.
 *
 * A grant names one agent, so an external caller addresses that agent only:
 * the post is `@<agent> <text>`, and every `@name` in the text that would
 * address someone in `addressable` (the workspace's agents and squads) gets
 * a word joiner after the `@`. That is the mention parser's own grammar, so
 * what it would resolve is exactly what is neutralized; any other `@word`
 * (`@media`, `@scope/pkg`, an email address) is posted as written.
 */
export function a2aMentionText(
  agentName: string,
  text: string,
  addressable: readonly WorkspaceAgent[],
): string {
  if (!isValidAgentName(agentName)) {
    throw new Error(`Invalid agent name: ${JSON.stringify(agentName)}`);
  }
  return `@${agentName} ${neutralizeMentions(text, addressable, WORD_JOINER)}`;
}

/** Everything the extension publishes about a task, for `Task.metadata`. */
export interface QwenA2ATaskMetadata {
  /**
   * The local run status. Distinguishes `awaiting_approval` (the workspace
   * owner must approve a tool call) from other `INPUT_REQUIRED` causes, and
   * `offline` from `failed`. Absent once the run is no longer tracked.
   */
  localStatus?: SessionAgentRunStatus;
  /** Why the run failed, when it did. */
  error?: string;
  /** Absent when this daemon has no figure; never reported as 0 for unknown. */
  tokensUsed?: number;
}
