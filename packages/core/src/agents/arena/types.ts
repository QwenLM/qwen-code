/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WorktreeInfo } from '../../services/gitWorktreeService.js';
import type { DisplayMode } from '../backends/types.js';

/**
 * Maximum number of concurrent agents allowed in an Arena session.
 */
export const ARENA_MAX_AGENTS = 5;

/**
 * Represents the status of an Arena agent in interactive mode.
 *
 * Agents run as interactive CLI subprocesses (--prompt-interactive), so
 * they never truly "complete" or "exit" on their own. Instead:
 *
 *   INITIALIZING → RUNNING ⇄ COMPLETED → TERMINATED
 *                        ↘ CANCELLED
 *
 * - INITIALIZING: Worktree created, PTY not yet spawned.
 * - RUNNING:      Agent is actively processing a turn (model thinking / tool execution).
 * - COMPLETED:    Agent finished the current task successfully.
 *                 This is the "selectable" state for /arena select.
 * - CANCELLED:    Agent's current request was cancelled by the user.
 * - TERMINATED:   PTY process has exited (killed, crashed, or shut down).
 */
export enum ArenaAgentStatus {
  /** Worktree created, PTY not yet spawned */
  INITIALIZING = 'initializing',
  /** Agent is actively processing a turn */
  RUNNING = 'running',
  /** Agent finished current task successfully */
  COMPLETED = 'completed',
  /** Agent's current request was cancelled by the user */
  CANCELLED = 'cancelled',
  /** PTY process has exited */
  TERMINATED = 'terminated',
}

/**
 * Represents the status of an Arena session.
 */
export enum ArenaSessionStatus {
  /** Session is being set up */
  INITIALIZING = 'initializing',
  /** Session is running */
  RUNNING = 'running',
  /** Session completed (all agents finished) */
  COMPLETED = 'completed',
  /** Session was cancelled */
  CANCELLED = 'cancelled',
  /** Session failed during initialization */
  FAILED = 'failed',
}

/**
 * Configuration for a model participating in the Arena.
 */
export interface ArenaModelConfig {
  /** Model identifier (e.g., 'qwen-coder-plus', 'gpt-4') */
  modelId: string;
  /** Authentication type for this model */
  authType: string;
  /** Display name for UI */
  displayName?: string;
  /** Optional API key override */
  apiKey?: string;
  /** Optional base URL override */
  baseUrl?: string;
}

/**
 * Configuration for an Arena session.
 */
export interface ArenaConfig {
  /** Unique identifier for this Arena session */
  sessionId: string;
  /** The task/prompt to be executed by all agents */
  task: string;
  /** Models participating in the Arena */
  models: ArenaModelConfig[];
  /** Maximum number of rounds per agent (default: 50) */
  maxRoundsPerAgent?: number;
  /** Total timeout in seconds for the entire Arena session (default: 600) */
  timeoutSeconds?: number;
  /** Approval mode inherited from the main process (e.g., 'auto', 'suggest', etc.) */
  approvalMode?: string;
  /** Source repository path */
  sourceRepoPath: string;
}

/**
 * Statistics for an individual Arena agent.
 */
export interface ArenaAgentStats {
  /** Number of completed rounds */
  rounds: number;
  /** Total tokens used */
  totalTokens: number;
  /** Input tokens used */
  inputTokens: number;
  /** Output tokens used */
  outputTokens: number;
  /** Total execution time in milliseconds */
  durationMs: number;
  /** Number of tool calls made */
  toolCalls: number;
  /** Number of successful tool calls */
  successfulToolCalls: number;
  /** Number of failed tool calls */
  failedToolCalls: number;
}

/**
 * Result from a single Arena agent.
 */
export interface ArenaAgentResult {
  /** Agent identifier */
  agentId: string;
  /** Model configuration used */
  model: ArenaModelConfig;
  /** Final status */
  status: ArenaAgentStatus;
  /** Worktree information */
  worktree: WorktreeInfo;
  /** Final text output from the agent */
  finalText?: string;
  /** Error message if failed */
  error?: string;
  /** Execution statistics */
  stats: ArenaAgentStats;
  /** Git diff of changes made */
  diff?: string;
  /** Files modified by this agent */
  modifiedFiles?: string[];
  /** Start timestamp */
  startedAt: number;
  /** End timestamp */
  endedAt?: number;
}

/**
 * Result from an Arena session.
 */
export interface ArenaSessionResult {
  /** Session identifier */
  sessionId: string;
  /** Original task */
  task: string;
  /** Session status */
  status: ArenaSessionStatus;
  /** Results from all agents */
  agents: ArenaAgentResult[];
  /** Start timestamp */
  startedAt: number;
  /** End timestamp */
  endedAt?: number;
  /** Total duration in milliseconds */
  totalDurationMs?: number;
  /** Whether the repository was auto-initialized */
  wasRepoInitialized: boolean;
  /** Selected winner (agent ID) if user has chosen */
  selectedWinner?: string;
}

/**
 * Options for starting an Arena session.
 */
export interface ArenaStartOptions {
  /** Models to participate (at least 2, max ARENA_MAX_AGENTS) */
  models: ArenaModelConfig[];
  /** The task/prompt for all agents */
  task: string;
  /** Maximum rounds per agent */
  maxRoundsPerAgent?: number;
  /** Timeout in seconds */
  timeoutSeconds?: number;
  /** Approval mode to use for agents (inherited from main process) */
  approvalMode?: string;
  /** Initial terminal columns for agent PTYs (default: process.stdout.columns or 120) */
  cols?: number;
  /** Initial terminal rows for agent PTYs (default: process.stdout.rows or 40) */
  rows?: number;
  /** Display mode preference */
  displayMode?: DisplayMode;
}

/**
 * Callback functions for Arena events.
 */
export interface ArenaCallbacks {
  /** Called when an agent starts */
  onAgentStart?: (agentId: string, model: ArenaModelConfig) => void;
  /** Called when an agent completes */
  onAgentComplete?: (result: ArenaAgentResult) => void;
  /** Called when agent stats are updated */
  onAgentStatsUpdate?: (
    agentId: string,
    stats: Partial<ArenaAgentStats>,
  ) => void;
  /** Called when the arena session completes */
  onArenaComplete?: (result: ArenaSessionResult) => void;
  /** Called on arena error */
  onArenaError?: (error: Error) => void;
}

/**
 * File format for per-agent status (child → main process).
 * Written atomically by ArenaAgentClient to
 * `<arenaSessionDir>/agents/<safeAgentId>.json`.
 */
export interface ArenaStatusFile {
  agentId: string;
  status: 'running' | 'completed' | 'error' | 'cancelled';
  updatedAt: number;
  rounds: number;
  currentActivity?: string;
  stats: ArenaAgentStats;
  finalSummary: string | null;
  error: string | null;
}

/**
 * File format for the arena session config file (`config.json`).
 *
 * Initially written by GitWorktreeService with static config fields
 * (arenaSessionId, sourceRepoPath, worktreeNames, baseBranch, createdAt).
 * Dynamically updated by ArenaManager with agent status data during polling.
 */
export interface ArenaConfigFile {
  /** Arena session identifier */
  arenaSessionId: string;
  /** Source repository path */
  sourceRepoPath: string;
  /** Names of worktrees created */
  worktreeNames: string[];
  /** Base branch used for worktrees */
  baseBranch?: string;
  /** Timestamp when the session was created */
  createdAt: number;
  /** Timestamp of the last status update (set by ArenaManager polling) */
  updatedAt?: number;
  /** Per-agent status data, keyed by agentId (set by ArenaManager polling) */
  agents?: Record<string, ArenaStatusFile>;
}

/**
 * Control signal format for control.json (main → child process).
 * Written by ArenaManager, consumed (read + deleted) by ArenaAgentClient.
 */
export interface ArenaControlSignal {
  type: 'shutdown' | 'cancel';
  reason: string;
  timestamp: number;
}

/**
 * Convert an agentId (e.g. "arena-xxx/qwen-coder-plus") to a filename-safe
 * string by replacing path-unsafe characters with "--".
 */
export function safeAgentId(agentId: string): string {
  return agentId.replace(/[/\\:*?"<>|]/g, '--');
}

/**
 * Internal state for tracking an Arena agent during execution.
 */
export interface ArenaAgentState {
  /** Agent identifier */
  agentId: string;
  /** Model configuration */
  model: ArenaModelConfig;
  /** Current status */
  status: ArenaAgentStatus;
  /** Worktree information */
  worktree: WorktreeInfo;
  /** Abort controller for cancellation */
  abortController: AbortController;
  /** Current statistics */
  stats: ArenaAgentStats;
  /** Start timestamp */
  startedAt: number;
  /** Accumulated text output */
  accumulatedText: string;
  /** Promise for the agent execution */
  executionPromise?: Promise<void>;
  /** Error if failed */
  error?: string;
}
