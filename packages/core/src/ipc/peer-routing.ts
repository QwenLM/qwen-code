/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The one rule for "does this address stay inside the process".
 *
 * `send_message` tries its in-process routes before it looks at peer
 * sessions, and `list_agents` must advertise a peer only under a string
 * those routes will not intercept — so both, and the near-miss suggester
 * that feeds the model addresses too, ask this predicate rather than each
 * keeping a copy of the routing table that can drift.
 */

import { sanitizeName } from '../agents/team/teamHelpers.js';
import { LEADER_NAME } from '../agents/team/types.js';

/** The slice of a team file the routing rule reads. */
export interface InProcessRoutingTeam {
  leadAgentId: string;
  members: ReadonlyArray<{ name: string }>;
}

/**
 * True when `send_message` routes `address` somewhere inside this process.
 *
 * `*` is the team broadcast keyword and is claimed before any team check
 * — with no team it errors rather than falling through, so it can never
 * name a peer. The leader handle, the lead agent id, and member names
 * (matched the way `TeamManager.sendMessage` matches them: sanitized) are
 * in-process only while a team is active; with none, a session that
 * happens to be named `leader` is reachable like any other.
 */
export function isInProcessRecipient(
  address: string,
  team: InProcessRoutingTeam | null | undefined,
): boolean {
  if (address === '*') return true;
  if (!team) return false;
  if (address.toLowerCase() === LEADER_NAME) return true;
  if (address === team.leadAgentId) return true;
  const sanitized = sanitizeName(address);
  return team.members.some((member) => member.name === sanitized);
}
