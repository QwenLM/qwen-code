/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Mention routing and agent-to-agent chain accounting.
 *
 * Who a post wakes, and how deep a chain of agents waking each other may go.
 * A post by the person resets the chain to 0; every post by an agent that
 * wakes another agent is one hop deeper. Coalescing bounds fan-out but not
 * two agents @-ing each other back and forth, and every hop is a paid run,
 * hence the (optional) limit.
 */

import { parseMentions } from '../workspace-agents/mentions.js';
import { isAgentAddressable } from '../workspace-agents/store.js';
import type { WorkspaceAgent } from '../workspace-agents/types.js';
import { DEFAULT_AGENT_CHAIN_LIMIT } from './contract.js';

export interface MentionTargets {
  /** Addressable agents to start, in first-mention order, deduplicated. */
  agents: WorkspaceAgent[];
  /** Mentioned agents that are disabled or retired. */
  unavailable: WorkspaceAgent[];
  /** Near-miss `@tokens` that matched no agent (likely typos). */
  unknown: string[];
  /** True when the author mentioned itself (ignored: it does not trigger). */
  selfMentioned: boolean;
}

/**
 * Resolves the `@name` tokens in `text` to the agents a post should wake.
 *
 * `authorAgentId` is set when an agent wrote the text; its own mention never
 * triggers it (an agent signing "— @me" must not loop on itself).
 */
export function resolveMentionTargets(
  text: string,
  roster: readonly WorkspaceAgent[],
  authorAgentId?: string,
): MentionTargets {
  const parsed = parseMentions(text, roster);
  const byId = new Map(roster.map((agent) => [agent.id, agent]));
  const agents: WorkspaceAgent[] = [];
  const unavailable: WorkspaceAgent[] = [];
  let selfMentioned = false;
  for (const id of parsed.ids) {
    const agent = byId.get(id);
    if (!agent) continue;
    if (authorAgentId !== undefined && id === authorAgentId) {
      selfMentioned = true;
      continue;
    }
    if (isAgentAddressable(agent)) agents.push(agent);
    else unavailable.push(agent);
  }
  return { agents, unavailable, unknown: parsed.unknown, selfMentioned };
}

/** Who wrote the post that triggers a run. */
export type ChainTrigger =
  | { kind: 'human' }
  | { kind: 'agent'; chainDepth: number };

/** Depth of the runs a post starts: 0 for a person, author's depth + 1 for an agent. */
export function nextChainDepth(trigger: ChainTrigger): number {
  return trigger.kind === 'human' ? 0 : Math.max(0, trigger.chainDepth) + 1;
}

/**
 * Whether a run at `chainDepth` may start under `limit`. 0 (or anything not
 * a positive integer) means unlimited. A limit of N allows N agent-to-agent
 * hops: depths 0..N run, N + 1 does not.
 */
export function isWithinChainLimit(chainDepth: number, limit: number): boolean {
  if (!Number.isInteger(limit) || limit <= 0) return true;
  return chainDepth <= limit;
}

/**
 * Reads the `experimental.agentChainLimit` setting. A non-integer or negative
 * value falls back to the default rather than to "no agents may chain".
 */
export function normalizeAgentChainLimit(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0
    ? raw
    : DEFAULT_AGENT_CHAIN_LIMIT;
}

/**
 * Depth of a queued run after another trigger is coalesced into it. A
 * person's post among the triggers resets the chain, so the shallower wins.
 */
export function coalesceChainDepth(current: number, incoming: number): number {
  return Math.min(current, incoming);
}
