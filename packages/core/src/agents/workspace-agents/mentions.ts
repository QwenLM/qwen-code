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
    const rest = token.slice(agent.name.length);
    if (/^[A-Za-z0-9_-]/.test(rest)) continue;
    // Nor into more of a Latin word: "@maría" is not "mar", "@alice２" is not
    // "alice". A Han or kana continuation is still a separate word.
    if (/^[\p{Script=Latin}\p{Nd}]/u.test(rest)) continue;
    if (!best || agent.name.length > best.name.length) best = agent;
  }
  return best;
}

/**
 * Whether `token` is a typo of `name` rather than unrelated prose. Bounded
 * Levenshtein: the only question asked is "distance ≤ 2", so the computation
 * bails as soon as no row cell can still come back under the limit.
 */
function nearMissOf(name: string, token: string): boolean {
  const a = name.toLowerCase();
  const b = token.toLowerCase();
  if (Math.abs(a.length - b.length) > 2) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      rowMin = Math.min(rowMin, curr[j]!);
    }
    if (rowMin > 2) return false;
    prev = curr;
  }
  return prev[b.length]! <= 2;
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
      // Only a near-miss of a roster name is an unknown mention. Any other
      // unmatched `@word` is prose (@media, @param, @Override) and carries no
      // routing authority — recording it would suppress the assignee fallback
      // for a string nobody addressed.
      if (!agents.some((candidate) => nearMissOf(candidate.name, name))) {
        continue;
      }
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
 * the model in the thread prompt so it never has to guess the spelling.
 */
export function mentionToken(agent: WorkspaceAgent): string {
  return `@${agent.name}`;
}
