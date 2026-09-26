/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview `@name` parsing.
 *
 * A mention is the routing signal for the whole agent: it decides who is woken
 * and, when present, suppresses the assignee's automatic wake. So the parse
 * has to be conservative in both directions — a missed mention silently drops
 * work, and a false one wakes an agent (and spends tokens) for a string that
 * was never addressed to it.
 */

import { findAgentByName } from './store.js';
import type { WorkspaceAgent } from './types.js';

/**
 * A candidate `@token`. The character before `@` must not be an ASCII word
 * character or a dot, which is what keeps `user@example.com` and `a@b` from
 * reading as mentions of `example` and `b` — while Chinese and Japanese, which
 * put no space before `@`, still address agents ("请@迁移助手看一下").
 * Trailing punctuation is left outside the capture so "ask @alice, then @bob."
 * resolves both names. A slash immediately after the token marks a scoped
 * package or repository such as `@scope/name`, not an agent address.
 */
const MENTION_PATTERN =
  /(?<![A-Za-z0-9_.])@([\p{L}\p{N}][\p{L}\p{N}_-]{0,47})/gu;

/**
 * The agent a token names. Scripts without spaces run the name into the next
 * word ("@迁移助手看一下"), so when no name matches the whole token the longest
 * name it starts with wins — unless what follows is more of an ASCII name,
 * which keeps "@alice2" from reaching "alice".
 */
function agentForToken(
  agents: readonly WorkspaceAgent[],
  token: string,
): WorkspaceAgent | undefined {
  const exact = findAgentByName(agents, token);
  if (exact) return exact;
  const lowered = token.toLowerCase();
  let best: WorkspaceAgent | undefined;
  for (const agent of agents) {
    if (!lowered.startsWith(agent.name.toLowerCase())) continue;
    if (/^[A-Za-z0-9_-]/.test(token.slice(agent.name.length))) continue;
    if (!best || agent.name.length > best.name.length) best = agent;
  }
  return best;
}

export interface ParsedMentions {
  /** Agent ids, in first-appearance order, deduplicated. */
  ids: string[];
  /** `@tokens` that matched no agent, in first-appearance order. */
  unknown: string[];
}

/**
 * Resolves `@name` tokens in `text` against the workspace roster.
 *
 * Disabled agents still resolve. Whether a disabled agent may be *dispatched*
 * is the policy layer's decision, and swallowing the mention here would make
 * an addressed-but-disabled agent indistinguishable from a typo.
 */
export function parseMentions(
  text: string,
  agents: readonly WorkspaceAgent[],
): ParsedMentions {
  const ids: string[] = [];
  const unknown: string[] = [];
  const seenIds = new Set<string>();
  const seenUnknown = new Set<string>();

  for (const match of text.matchAll(MENTION_PATTERN)) {
    const name = match[1];
    if (!name) continue;
    if (
      match.index !== undefined &&
      text[match.index + match[0].length] === '/'
    ) {
      continue;
    }
    const agent = agentForToken(agents, name);
    if (!agent) {
      const lowered = name.toLowerCase();
      if (!seenUnknown.has(lowered)) {
        seenUnknown.add(lowered);
        unknown.push(name);
      }
      continue;
    }
    if (seenIds.has(agent.id)) continue;
    seenIds.add(agent.id);
    ids.push(agent.id);
  }

  return { ids, unknown };
}

/**
 * The exact token an agent should paste to address another agent. Handed to
 * the model in the thread prompt so it never has to guess the spelling — the
 * same reason Multica gives its squad leader ready-made mention markdown
 * rather than a bare name.
 */
export function mentionToken(agent: WorkspaceAgent): string {
  return `@${agent.name}`;
}
