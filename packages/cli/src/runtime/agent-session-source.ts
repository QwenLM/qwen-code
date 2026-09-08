/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

export const AGENT_HOST_SESSION_SOURCE_TYPE = 'agent-host';

/**
 * A top-level session that belongs to one agent.
 *
 * The bridge's spawn request carries no persona, so an agent session is told
 * who it is the same way the host session is: by its source type, with the
 * agent's id in `sourceId`. The child recognises itself at `newSession`, reads
 * the workspace roster, and applies its own definition before it goes live.
 * This identifies the agent; the shared ACP process is not a crash boundary.
 */
export const AGENT_SESSION_SOURCE_TYPE = 'agent';

/** Deterministic per identity, so an agent has exactly one session. */
export function agentSessionId(agentId: string): string {
  // UUID v5 in the standard URL namespace: ACP only accepts RFC UUIDs.
  const bytes = createHash('sha1')
    .update(Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex'))
    .update(`qwen-code:workspace-agent:${agentId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
