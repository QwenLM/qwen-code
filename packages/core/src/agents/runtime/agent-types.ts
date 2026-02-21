/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Agent runtime types.
 *
 * Contains the canonical definitions for agent configuration (prompt, model,
 * run, tool), termination modes, and interactive agent types.
 */

import type { Content, FunctionDeclaration } from '@google/genai';

// ─── Agent Configuration ─────────────────────────────────────

/**
 * Configures the initial prompt for an agent.
 */
export interface PromptConfig {
  /**
   * A single system prompt string that defines the agent's persona and instructions.
   * Note: You should use either `systemPrompt` or `initialMessages`, but not both.
   */
  systemPrompt?: string;

  /**
   * An array of user/model content pairs to seed the chat history for few-shot prompting.
   * Note: You should use either `systemPrompt` or `initialMessages`, but not both.
   */
  initialMessages?: Content[];
}

/**
 * Configures the generative model parameters for an agent.
 */
export interface ModelConfig {
  /**
   * The name or identifier of the model to be used (e.g., 'qwen3-coder-plus').
   *
   * TODO: In the future, this needs to support 'auto' or some other string to support routing use cases.
   */
  model?: string;
  /** The temperature for the model's sampling process. */
  temp?: number;
  /** The top-p value for nucleus sampling. */
  top_p?: number;
}

/**
 * Configures the execution environment and constraints for an agent.
 *
 * TODO: Consider adding max_tokens as a form of budgeting.
 */
export interface RunConfig {
  /** The maximum execution time for the agent in minutes. */
  max_time_minutes?: number;
  /**
   * The maximum number of conversational turns (a user message + model response)
   * before the execution is terminated. Helps prevent infinite loops.
   */
  max_turns?: number;
}

/**
 * Configures the tools available to an agent during its execution.
 */
export interface ToolConfig {
  /**
   * A list of tool names (from the tool registry) or full function declarations
   * that the agent is permitted to use.
   */
  tools: Array<string | FunctionDeclaration>;
}

/**
 * Describes the possible termination modes for an agent.
 * This enum provides a clear indication of why an agent's execution ended.
 */
export enum AgentTerminateMode {
  /** The agent's execution terminated due to an unrecoverable error. */
  ERROR = 'ERROR',
  /** The agent's execution terminated because it exceeded the maximum allowed working time. */
  TIMEOUT = 'TIMEOUT',
  /** The agent's execution successfully completed all its defined goals. */
  GOAL = 'GOAL',
  /** The agent's execution terminated because it exceeded the maximum number of turns. */
  MAX_TURNS = 'MAX_TURNS',
  /** The agent's execution was cancelled via an abort signal. */
  CANCELLED = 'CANCELLED',
  /** The agent was gracefully shut down (e.g., arena/team session ended). */
  SHUTDOWN = 'SHUTDOWN',
}

// ─── Agent Status ────────────────────────────────────────────

/**
 * Canonical lifecycle status for any agent (headless, interactive, arena).
 *
 * State machine:
 *   INITIALIZING → RUNNING ⇄ COMPLETED / FAILED / CANCELLED
 *
 * - INITIALIZING: Setting up (creating chat, loading tools).
 * - RUNNING:      Actively processing (model thinking / tool execution).
 * - COMPLETED:    Finished successfully (may re-enter RUNNING on new input).
 * - FAILED:       Finished with error (API failure, process crash, etc.).
 * - CANCELLED:    Cancelled by user or system.
 */
export enum AgentStatus {
  INITIALIZING = 'initializing',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

/** True for COMPLETED, FAILED, CANCELLED — agent is done working. */
export const isTerminalStatus = (s: AgentStatus): boolean =>
  s === AgentStatus.COMPLETED ||
  s === AgentStatus.FAILED ||
  s === AgentStatus.CANCELLED;

/**
 * Lightweight configuration for an AgentInteractive instance.
 * Carries only interactive-specific parameters; the heavy runtime
 * configs (prompt, model, run, tools) live on AgentCore.
 */
export interface AgentInteractiveConfig {
  /** Unique identifier for this agent. */
  agentId: string;
  /** Human-readable name for display. */
  agentName: string;
  /** Optional initial task to start working on immediately. */
  initialTask?: string;
  /** Max model round-trips per enqueued message (default: unlimited). */
  maxTurnsPerMessage?: number;
  /** Max wall-clock minutes per enqueued message (default: unlimited). */
  maxTimeMinutesPerMessage?: number;
}

/**
 * A message exchanged with or produced by an interactive agent.
 *
 * This is a UI-oriented data model (not the Gemini API Content type).
 * AgentInteractive is the sole writer; the UI reads via getMessages().
 */
export interface AgentMessage {
  /** Discriminator for the message kind. */
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result';
  /** The text content of the message. */
  content: string;
  /** When the message was created (ms since epoch). */
  timestamp: number;
  /**
   * Whether this assistant message contains thinking/reasoning content.
   * Mirrors AgentStreamTextEvent.thought. Only meaningful when role is 'assistant'.
   */
  thought?: boolean;
  /** Optional metadata (e.g. tool call info, round number). */
  metadata?: Record<string, unknown>;
}

/**
 * Snapshot of in-progress streaming state for UI mid-switch handoff.
 * Returned by AgentInteractive.getInProgressStream().
 */
export interface InProgressStreamState {
  /** Accumulated non-thought text so far in the current round. */
  text: string;
  /** Accumulated thinking text so far in the current round. */
  thinking: string;
  /** The reasoning-loop round number being streamed. */
  round: number;
}
