/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const AGENT_HOST_SESSION_SOURCE_TYPE = 'agent-host';

/**
 * A session process that *is* one agent.
 *
 * The bridge's spawn request carries no persona, so an agent session is told
 * who it is the same way the host session is: by its source type, with the
 * agent's id in `sourceId`. The child recognises itself at `newSession`, reads
 * the workspace roster, and applies its own definition before it goes live.
 * This is what keeps one agent's crash, memory growth and runaway loop from
 * being every agent's.
 */
export const AGENT_SESSION_SOURCE_TYPE = 'agent';

/** Deterministic per identity, so an agent has exactly one session. */
export function agentSessionId(agentId: string): string {
  return `agent-${agentId}`;
}
