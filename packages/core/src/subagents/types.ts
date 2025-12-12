/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, FunctionDeclaration } from '@google/genai';

/**
 * Represents the storage level for a subagent configuration.
 * - 'project': Stored in `.qwen/agents/` within the project directory
 * - 'user': Stored in `~/.qwen/agents/` in the user's home directory
 * - 'builtin': Built-in agents embedded in the codebase, always available
 * - 'session': Session-level agents provided at runtime, read-only
 */
export type SubagentLevel = 'project' | 'user' | 'builtin' | 'session';

/**
 * Core configuration for a subagent as stored in Markdown files.
 * This interface represents the file-based configuration that gets
 * converted to runtime configuration for SubAgentScope.
 */
export interface SubagentConfig {
  /** Unique name identifier for the subagent */
  name: string;

  /** Human-readable description of when and how to use this subagent */
  description: string;

  /**
   * Optional list of tool names that this subagent is allowed to use.
   * If omitted, the subagent inherits all available tools.
   */
  tools?: string[];

  /**
   * System prompt content that defines the subagent's behavior.
   * Supports ${variable} templating via ContextState.
   */
  systemPrompt: string;

  /** Storage level - determines where the configuration file is stored */
  level: SubagentLevel;

  /** Absolute path to the configuration file. Optional for session subagents. */
  filePath?: string;

  /**
   * Optional model configuration. If not provided, uses defaults.
   * Can specify model name, temperature, and top_p values.
   */
  modelConfig?: Partial<ModelConfig>;

  /**
   * Optional runtime configuration. If not provided, uses defaults.
   * Can specify max_time_minutes and max_turns.
   */
  runConfig?: Partial<RunConfig>;

  /**
   * Optional color for runtime display.
   * If 'auto' or omitted, uses automatic color assignment.
   */
  color?: string;

  /**
   * Indicates whether this is a built-in agent.
   * Built-in agents cannot be modified or deleted.
   */
  readonly isBuiltin?: boolean;
}

/**
 * Runtime configuration that converts file-based config to existing SubAgentScope.
 * This interface maps SubagentConfig to the existing runtime interfaces.
 */
export interface SubagentRuntimeConfig {
  /** Prompt configuration for SubAgentScope */
  promptConfig: PromptConfig;

  /** Model configuration for SubAgentScope */
  modelConfig: ModelConfig;

  /** Runtime execution configuration for SubAgentScope */
  runConfig: RunConfig;

  /** Optional tool configuration for SubAgentScope */
  toolConfig?: ToolConfig;
}

/**
 * Result of a validation operation on a subagent configuration.
 */
export interface ValidationResult {
  /** Whether the configuration is valid */
  isValid: boolean;

  /** Array of error messages if validation failed */
  errors: string[];

  /** Array of warning messages (non-blocking issues) */
  warnings: string[];
}

/**
 * Options for listing subagents.
 */
export interface ListSubagentsOptions {
  /** Filter by storage level */
  level?: SubagentLevel;

  /** Filter by tool availability */
  hasTool?: string;

  /** Sort order for results */
  sortBy?: 'name' | 'lastModified' | 'level';

  /** Sort direction */
  sortOrder?: 'asc' | 'desc';

  /** Force refresh from disk, bypassing cache. Defaults to false. */
  force?: boolean;
}

/**
 * Options for creating a new subagent.
 */
export interface CreateSubagentOptions {
  /** Storage level for the new subagent */
  level: SubagentLevel;

  /** Whether to overwrite existing subagent with same name */
  overwrite?: boolean;

  /** Custom directory path (overrides default level-based path) */
  customPath?: string;
}

/**
 * Error thrown when a subagent operation fails.
 */
export class SubagentError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly subagentName?: string,
  ) {
    super(message);
    this.name = 'SubagentError';
  }
}

/**
 * Error codes for subagent operations.
 */
export const SubagentErrorCode = {
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  INVALID_CONFIG: 'INVALID_CONFIG',
  INVALID_NAME: 'INVALID_NAME',
  FILE_ERROR: 'FILE_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
} as const;

export type SubagentErrorCode =
  (typeof SubagentErrorCode)[keyof typeof SubagentErrorCode];

/**
 * Describes the possible termination modes for a subagent.
 * This enum provides a clear indication of why a subagent's execution might have ended.
 */
export enum SubagentTerminateMode {
  /**
   * Indicates that the subagent's execution terminated due to an unrecoverable error.
   */
  ERROR = 'ERROR',
  /**
   * Indicates that the subagent's execution terminated because it exceeded the maximum allowed working time.
   */
  TIMEOUT = 'TIMEOUT',
  /**
   * Indicates that the subagent's execution successfully completed all its defined goals.
   */
  GOAL = 'GOAL',
  /**
   * Indicates that the subagent's execution terminated because it exceeded the maximum number of turns.
   */
  MAX_TURNS = 'MAX_TURNS',
  /**
   * Indicates that the subagent's execution was cancelled via an abort signal.
   */
  CANCELLED = 'CANCELLED',
}

/**
 * Configures the initial prompt for the subagent.
 */
export interface PromptConfig {
  /**
   * A single system prompt string that defines the subagent's persona and instructions.
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
 * Configures the tools available to the subagent during its execution.
 */
export interface ToolConfig {
  /**
   * A list of tool names (from the tool registry) or full function declarations
   * that the subagent is permitted to use.
   */
  tools: Array<string | FunctionDeclaration>;
}

/**
 * Configures the generative model parameters for the subagent.
 * This interface specifies the model to be used and its associated generation settings,
 * such as temperature and top-p values, which influence the creativity and diversity of the model's output.
 */
export interface ModelConfig {
  /**
   * The name or identifier of the model to be used (e.g., 'qwen3-coder-plus').
   *
   * TODO: In the future, this needs to support 'auto' or some other string to support routing use cases.
   */
  model?: string;
  /**
   * The temperature for the model's sampling process.
   */
  temp?: number;
  /**
   * The top-p value for nucleus sampling.
   */
  top_p?: number;
}

/**
 * Configures the execution environment and constraints for the subagent.
 * This interface defines parameters that control the subagent's runtime behavior,
 * such as maximum execution time, to prevent infinite loops or excessive resource consumption.
 *
 * TODO: Consider adding max_tokens as a form of budgeting.
 */
export interface RunConfig {
  /** The maximum execution time for the subagent in minutes. */
  max_time_minutes?: number;
  /**
   * The maximum number of conversational turns (a user message + model response)
   * before the execution is terminated. Helps prevent infinite loops.
   */
  max_turns?: number;
}
