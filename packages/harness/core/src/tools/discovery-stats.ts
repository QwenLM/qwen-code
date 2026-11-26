/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-session discovery effort, shared by CodeMode scripts and mcp_list /
 * mcp_get so both lazy and eager arms are measured the same way: the rank a tool
 * had in the earliest search of the session that returned it, and how many
 * discovery operations preceded the first successful MCP call.
 */
import { BoundedLruMap } from '../utils/boundedLruMap.js';

const MAX_SESSIONS = 32;

interface SessionDiscovery {
  ranks: Map<string, number>;
  operations: number;
  /** Prompt (user turn) of the first discovery operation. */
  firstPromptId?: string;
  succeeded: boolean;
}

export interface FirstMcpSuccess {
  operations: number;
  firstPromptId?: string;
  sameTurn: boolean;
}

const sessions = new BoundedLruMap<string, SessionDiscovery>(MAX_SESSIONS);

function session(sessionId: string): SessionDiscovery {
  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = { ranks: new Map(), operations: 0, succeeded: false };
    sessions.set(sessionId, entry);
  }
  return entry;
}

/** A discovery operation, such as a listing or a schema lookup. */
export function recordDiscovery(sessionId: string, promptId?: string): void {
  const entry = session(sessionId);
  entry.operations++;
  entry.firstPromptId ??= promptId;
}

/** A ranked search; each tool keeps the rank of the earliest search that returned it. */
export function recordSearchResults(
  sessionId: string,
  names: readonly string[],
  promptId?: string,
): void {
  recordDiscovery(sessionId, promptId);
  const { ranks } = session(sessionId);
  names.forEach((name, index) => {
    if (!ranks.has(name)) ranks.set(name, index + 1);
  });
}

export function searchRank(
  sessionId: string,
  name: string,
): number | undefined {
  return sessions.get(sessionId)?.ranks.get(name);
}

/** The discovery effort before the session's first successful MCP call; reported once. */
export function takeFirstMcpSuccess(
  sessionId: string,
  promptId?: string,
): FirstMcpSuccess | undefined {
  const entry = session(sessionId);
  if (entry.succeeded) return undefined;
  entry.succeeded = true;
  return {
    operations: entry.operations,
    ...(entry.firstPromptId === undefined
      ? {}
      : { firstPromptId: entry.firstPromptId }),
    sameTurn: entry.firstPromptId === undefined || entry.firstPromptId === promptId,
  };
}

/** Stats fields of a first MCP success, under the caller's key prefix. */
export function firstMcpSuccessFields(
  first: FirstMcpSuccess | undefined,
  prefix = '',
): Record<string, string | number | boolean> {
  if (!first) return {};
  return {
    [`${prefix}discovery_ops`]: first.operations,
    [`${prefix}discovery_same_turn`]: first.sameTurn,
    ...(first.firstPromptId
      ? { [`${prefix}discovery_first_prompt_id`]: first.firstPromptId }
      : {}),
  };
}
