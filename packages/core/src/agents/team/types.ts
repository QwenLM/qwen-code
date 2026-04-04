/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Type definitions for the agent team system.
 *
 * Defines the persisted team configuration (TeamFile, TeamMember),
 * the distributed task model (SwarmTask), runtime context (TeamContext),
 * and teammate identity (TeammateIdentity).
 */

import type { DisplayMode } from '../backends/types.js';
import type { PermissionMode } from '../../hooks/types.js';

// ─── Team File ──────────────────────────────────────────────

/**
 * Persisted at `~/.qwen/teams/{team-name}/config.json`.
 */
export interface TeamFile {
  /** Team name (sanitized, used as directory name). */
  name: string;
  /** Optional human-readable description. */
  description?: string;
  /** Creation timestamp (ms since epoch). */
  createdAt: number;
  /** Agent ID of the team leader. */
  leadAgentId: string;
  /** Leader's session UUID (for discovery). */
  leadSessionId?: string;
  /** Phase 2: pane IDs hidden from UI. */
  hiddenPaneIds?: string[];
  /** Paths pre-approved for teammate tool use. */
  teamAllowedPaths?: TeamAllowedPath[];
  /** All team members (leader is not included). */
  members: TeamMember[];
}

/**
 * A path pre-approved for a specific tool across the team.
 */
export interface TeamAllowedPath {
  /** Absolute filesystem path. */
  path: string;
  /** Tool name this approval applies to. */
  toolName: string;
  /** Agent name that added this approval. */
  addedBy: string;
  /** When this approval was added (ms since epoch). */
  addedAt: number;
}

/**
 * A single team member (teammate, not the leader).
 */
export interface TeamMember {
  /** Unique agent ID (convention: "name@teamName"). */
  agentId: string;
  /** Human-readable name. */
  name: string;
  /** Agent type (e.g., subagent definition name). */
  agentType?: string;
  /** Model identifier override. */
  model?: string;
  /** Custom system prompt override. */
  prompt?: string;
  /** Assigned color for UI display. */
  color?: string;
  /** When this member joined (ms since epoch). */
  joinedAt: number;
  /** Working directory for this member. */
  cwd: string;
  /** Tmux pane ID (empty string for in-process). */
  tmuxPaneId: string;
  /** Git worktree path if isolated. */
  worktreePath?: string;
  /** Backend type used to spawn this member. */
  backendType?: DisplayMode;
  /** false = idle, undefined/true = active. */
  isActive?: boolean;
  /** Tool subscriptions (event channels). */
  subscriptions: string[];
  /** Whether plan mode is required for this member. */
  planModeRequired?: boolean;
  /** Permission mode for this member. */
  mode?: PermissionMode;
  /** Phase 2: member's session UUID. */
  sessionId?: string;
}

// ─── Distributed Tasks ──────────────────────────────────────

/** Task status values. */
export type SwarmTaskStatus = 'pending' | 'in_progress' | 'completed';

/**
 * A single task in the distributed task system.
 * Persisted as `~/.qwen/tasks/{teamName}/{id}.json`.
 */
export interface SwarmTask {
  /** Auto-incremented task ID. */
  id: string;
  /** Short title. */
  subject: string;
  /** Detailed description. */
  description: string;
  /** Present tense label for UI (e.g., "Running tests"). */
  activeForm?: string;
  /** Agent ID of the current owner. */
  owner?: string;
  /** Current task status. */
  status: SwarmTaskStatus;
  /** Task IDs that this task blocks. */
  blocks: string[];
  /** Task IDs that block this task. */
  blockedBy: string[];
  /** Arbitrary metadata. */
  metadata?: Record<string, unknown>;
}

// ─── Runtime Context ────────────────────────────────────────

/**
 * Runtime context for an active team session.
 * Set on TeamCreate, cleared on TeamDelete. Stored on Config.
 */
export interface TeamContext {
  /** Team name. */
  teamName: string;
  /** Absolute path to the team config file. */
  teamFilePath: string;
  /** Agent ID of the team leader. */
  leadAgentId: string;
  /** Map of teammate agent IDs → summary info. */
  teammates: Record<
    string,
    {
      name: string;
      color?: string;
      cwd: string;
      spawnedAt: number;
    }
  >;
}

// ─── Teammate Identity ──────────────────────────────────────

/**
 * Identity of a teammate, resolved via AsyncLocalStorage (in-process)
 * or dynamic context (pane-based, Phase 2).
 */
export interface TeammateIdentity {
  /** Unique agent ID (convention: "name@teamName"). */
  agentId: string;
  /** Human-readable agent name. */
  agentName: string;
  /** Team name this agent belongs to. */
  teamName: string;
  /** Assigned color for UI display. */
  color?: string;
  /** Whether this agent is the team leader. */
  isTeamLead: boolean;
  /** Session ID of the parent (leader) session. */
  parentSessionId?: string;
}

// ─── Constants ──────────────────────────────────────────────

/** Maximum number of teammates allowed per team. */
export const MAX_TEAMMATES = 10;

/** Directory name under ~/.qwen for team configs. */
export const TEAMS_DIR = 'teams';

/** Directory name under ~/.qwen for task files. */
export const TASKS_DIR = 'tasks';

/** Filename for the team config within a team directory. */
export const TEAM_CONFIG_FILENAME = 'config.json';

/** Directory name for mailbox inboxes within a team directory. */
export const INBOXES_DIR = 'inboxes';

/**
 * Available teammate colors for UI display.
 * Ordered by visual distinctness; assigned round-robin.
 */
export const TEAMMATE_COLORS = [
  '#FF6B6B', // red
  '#4ECDC4', // teal
  '#45B7D1', // blue
  '#FFA07A', // salmon
  '#98D8C8', // mint
  '#DDA0DD', // plum
  '#F0E68C', // khaki
  '#87CEEB', // sky blue
  '#FFB347', // orange
  '#B0E0E6', // powder blue
] as const;
