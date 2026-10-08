/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

export const AGENT_HOST_SESSION_SOURCE_TYPE = 'agent-host';

/**
 * A top-level task session that belongs to one agent.
 *
 * The bridge's spawn request carries no persona, so an agent session is told
 * who it is the same way the host session is: by its source type, with the
 * agent's id in `sourceId`. The session id also includes the thread. The child
 * recognises itself at `newSession`, reads
 * the workspace roster, and applies its own definition before it goes live.
 * This identifies the agent; the shared ACP process is not a crash boundary.
 */
export const AGENT_SESSION_SOURCE_TYPE = 'agent';

/**
 * Machine-owned sessions no session listing or count shows: the agent host
 * and each agent's task sessions. A person still opens one by id.
 */
export const HIDDEN_CATALOG_SOURCE_TYPES: readonly string[] = [
  AGENT_HOST_SESSION_SOURCE_TYPE,
  AGENT_SESSION_SOURCE_TYPE,
];

export function isHiddenCatalogSource(sourceType: string | undefined): boolean {
  return (
    sourceType !== undefined && HIDDEN_CATALOG_SOURCE_TYPES.includes(sourceType)
  );
}

/** UUID v5 in the standard URL namespace: ACP only accepts RFC UUIDs. */
function uuidV5Url(name: string): string {
  const bytes = createHash('sha1')
    .update(Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex'))
    .update(name)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Deterministic per agent and thread, matching Multica's agent × issue scope. */
export function agentThreadSessionId(
  agentId: string,
  threadId: string,
): string {
  return uuidV5Url(`qwen-code:workspace-agent:${agentId}:thread:${threadId}`);
}

/**
 * The hidden Qwen session an agent answers from in one chat session
 * (session multi-agent, session-multi-agent design §3.1). Deterministic per (agent, chat session),
 * so every @-mention of that agent in that session resumes one native
 * session. Its own namespace string, distinct from the thread one.
 */
export function sessionAgentNativeSessionId(
  agentId: string,
  chatSessionId: string,
): string {
  return uuidV5Url(
    `qwen-code:session-agent:${agentId}:chat-session:${chatSessionId}`,
  );
}
