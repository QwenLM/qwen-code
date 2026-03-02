/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Shared types for multi-agent systems (Arena, Team, Swarm)
 * and the Backend abstraction layer.
 *
 * These types are used across different agent orchestration modes.
 */

import type { AnsiOutput } from '../../utils/terminalSerializer.js';
import type {
  PromptConfig,
  ModelConfig,
  RunConfig,
  ToolConfig,
} from '../runtime/agent-types.js';

/**
 * Canonical display mode values shared across core and CLI.
 */
export const DISPLAY_MODE = {
  IN_PROCESS: 'in-process',
  TMUX: 'tmux',
  ITERM2: 'iterm2',
} as const;

/**
 * Supported display mode values.
 */
export type DisplayMode = (typeof DISPLAY_MODE)[keyof typeof DISPLAY_MODE];

/**
 * Configuration for spawning an agent subprocess.
 */
export interface AgentSpawnConfig {
  /** Unique identifier for this agent */
  agentId: string;
  /** Command to execute (e.g., the CLI binary path) */
  command: string;
  /** Arguments to pass to the command */
  args: string[];
  /** Working directory for the subprocess */
  cwd: string;
  /** Additional environment variables (merged with process.env) */
  env?: Record<string, string>;
  /** Terminal columns (default: 120) */
  cols?: number;
  /** Terminal rows (default: 40) */
  rows?: number;
  /**
   * Backend-specific options (optional).
   * These are ignored by backends that do not support them.
   */
  backend?: {
    tmux?: TmuxBackendOptions;
  };

  /**
   * In-process spawn configuration (optional).
   * When provided, InProcessBackend uses this to create an AgentInteractive
   * instead of launching a PTY subprocess.
   */
  inProcess?: InProcessSpawnConfig;
}

/**
 * Configuration for spawning an in-process agent (no PTY subprocess).
 */
export interface InProcessSpawnConfig {
  /** Human-readable agent name for display. */
  agentName: string;
  /** Optional initial task to start working on immediately. */
  initialTask?: string;
  /** Runtime configuration for the AgentCore. */
  runtimeConfig: {
    promptConfig: PromptConfig;
    modelConfig: ModelConfig;
    runConfig: RunConfig;
    toolConfig?: ToolConfig;
  };
  /**
   * Per-agent auth/provider overrides. When present, a dedicated
   * ContentGenerator is created for this agent instead of inheriting
   * the parent process's. This enables Arena agents to target different
   * model providers (OpenAI, Anthropic, Gemini, etc.) in the same session.
   */
  authOverrides?: {
    authType: string;
    apiKey?: string;
    baseUrl?: string;
  };
}

/**
 * Callback for agent exit events.
 */
export type AgentExitCallback = (
  agentId: string,
  exitCode: number | null,
  signal: number | null,
) => void;

/**
 * Backend abstracts the display/pane management layer for multi-agent systems.
 *
 * Each display mode (in-process / tmux / iTerm2) implements this interface. The orchestration
 * layer (Arena, Team, etc.) delegates all pane operations through the backend,
 * making the display mode transparent.
 */
export interface Backend {
  /** Backend type identifier. */
  readonly type: DisplayMode;

  /**
   * Initialize the backend.
   * - in-process: runs in the current process (not yet implemented)
   * - tmux: verifies tmux availability, creates session
   * - iTerm2: verifies iTerm2 is running
   */
  init(): Promise<void>;

  // ─── Agent Lifecycle ────────────────────────────────────────

  /**
   * Spawn a new agent subprocess.
   *
   * @param config - Agent spawn configuration (command, args, cwd, env, etc.)
   * @returns Promise that resolves when the agent's pane/PTY is created and ready.
   */
  spawnAgent(config: AgentSpawnConfig): Promise<void>;

  /**
   * Stop a specific agent.
   */
  stopAgent(agentId: string): void;

  /**
   * Stop all running agents.
   */
  stopAll(): void;

  /**
   * Clean up all resources (kill processes, destroy panes/sessions).
   */
  cleanup(): Promise<void>;

  /**
   * Register a callback for agent exit events.
   */
  setOnAgentExit(callback: AgentExitCallback): void;

  /**
   * Wait for all agents to exit, with an optional timeout.
   *
   * @returns true if all agents exited, false if timeout was reached.
   */
  waitForAll(timeoutMs?: number): Promise<boolean>;

  // ─── Active Agent & Navigation ──────────────────────────────

  /**
   * Switch the active agent for screen capture and input routing.
   */
  switchTo(agentId: string): void;

  /**
   * Switch to the next agent in order.
   */
  switchToNext(): void;

  /**
   * Switch to the previous agent in order.
   */
  switchToPrevious(): void;

  /**
   * Get the ID of the currently active agent.
   */
  getActiveAgentId(): string | null;

  // ─── Screen Capture ─────────────────────────────────────────

  /**
   * Get the screen snapshot for the currently active agent.
   *
   * @returns AnsiOutput or null if no active agent or not supported.
   */
  getActiveSnapshot(): AnsiOutput | null;

  /**
   * Get the screen snapshot for a specific agent.
   *
   * @param agentId - Agent to capture
   * @param scrollOffset - Lines to scroll back from viewport (default: 0)
   * @returns AnsiOutput or null if not found or not supported.
   */
  getAgentSnapshot(agentId: string, scrollOffset?: number): AnsiOutput | null;

  /**
   * Get the maximum scrollback length for an agent's terminal buffer.
   *
   * @returns Number of scrollable lines, or 0 if not supported.
   */
  getAgentScrollbackLength(agentId: string): number;

  // ─── Input ──────────────────────────────────────────────────

  /**
   * Forward input to the currently active agent's PTY stdin.
   *
   * @returns true if input was forwarded, false otherwise.
   */
  forwardInput(data: string): boolean;

  /**
   * Write input to a specific agent's PTY stdin.
   *
   * @returns true if input was written, false otherwise.
   */
  writeToAgent(agentId: string, data: string): boolean;

  // ─── Resize ─────────────────────────────────────────────────

  /**
   * Resize all agent terminals/panes.
   */
  resizeAll(cols: number, rows: number): void;

  // ─── External Session Info ─────────────────────────────────

  /**
   * Get a user-facing hint for how to attach to the external display session.
   *
   * When the backend runs in external mode (e.g., a detached tmux server),
   * this returns a shell command the user can run to view the agent panes.
   * Returns null if not applicable (e.g., running inside tmux or iTerm2).
   */
  getAttachHint(): string | null;
}

/**
 * Optional tmux backend configuration.
 */
export interface TmuxBackendOptions {
  /** tmux server name for -L (when running outside tmux) */
  serverName?: string;
  /** tmux session name to use/create (when running outside tmux) */
  sessionName?: string;
  /** tmux window name to use/create (when running outside tmux) */
  windowName?: string;
  /** Pane title for this agent */
  paneTitle?: string;
  /** Border style for inactive panes (tmux style string, e.g. "fg=blue") */
  paneBorderStyle?: string;
  /** Border style for active pane (tmux style string, e.g. "fg=green,bold") */
  paneActiveBorderStyle?: string;
  /** Pane border format (default: "#{pane_title}") */
  paneBorderFormat?: string;
  /** Pane border status location */
  paneBorderStatus?: 'top' | 'bottom' | 'off';
  /** Leader pane width percentage (default: 30) */
  leaderPaneWidthPercent?: number;
  /** First split percent when inside tmux (default: 70) */
  firstSplitPercent?: number;
}
