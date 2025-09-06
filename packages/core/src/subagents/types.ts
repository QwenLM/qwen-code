/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  PromptConfig,
  ModelConfig,
  RunConfig,
  ToolConfig,
} from '../core/subagent.js';

/**
 * Represents the storage level for a subagent configuration.
 * - 'project': Stored in `.qwen/agents/` within the project directory
 * - 'user': Stored in `~/.qwen/agents/` in the user's home directory
 */
export type SubagentLevel = 'project' | 'user';

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

  /** Absolute path to the configuration file */
  filePath: string;

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
   * Optional background color for runtime display.
   * If 'auto' or omitted, uses automatic color assignment.
   */
  backgroundColor?: string;
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
