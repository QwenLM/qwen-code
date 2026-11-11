/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Agent swarm attachment generators.
 *
 *   getTeamContextAttachment()       — live team state (delta by hash)
 */

import { sha1 } from '../../utils/paths.js';
import {
  type AttachmentToolUseContext,
  type AttachmentExternalContext,
  TeamContextAttachment,
} from '../types.js';

// ── getTeamContextAttachment ──────────────────────────────────────────────────

/**
 * Emit a TeamContextAttachment when the subagent progress list changes.
 *
 * Uses SHA-1 hash of the JSON-serialized progress list for delta detection.
 * Only emits when the team state has changed since last turn.
 */
export async function getTeamContextAttachment(
  ctx: AttachmentToolUseContext,
  externalCtx: AttachmentExternalContext | undefined,
): Promise<TeamContextAttachment[]> {
  const progress = externalCtx?.subagentProgress;
  if (!progress || progress.length === 0) return [];

  const agents = progress.map((entry) => ({
    agentName: entry.agentName,
    state: entry.state,
    recentActivity: entry.recentActivity,
    color: entry.color,
  }));
  const hash = sha1(JSON.stringify(agents));
  if (hash === ctx.lastSubagentHash) return [];
  ctx.lastSubagentHash = hash;

  return [
    new TeamContextAttachment({
      type: 'team_context' as const,
      agents,
    }),
  ];
}
