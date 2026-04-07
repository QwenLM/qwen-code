/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Mode configuration types for the Modes Layer.
 *
 * Modes are specialized agent profiles that configure system prompts,
 * tool access, model parameters, and sub-agent/skill availability
 * for specific development workflows.
 */

import type {
  ModelConfig,
  RunConfig,
} from '../agents/runtime/agent-types.js';

/**
 * Represents the storage level for a mode configuration.
 * - 'project': Stored in `.qwen/modes/` within the project directory
 * - 'user': Stored in `~/.qwen/modes/` in the user's home directory
 * - 'builtin': Built-in modes embedded in the codebase (lowest priority)
 */
export type ModeLevel = 'project' | 'user' | 'builtin';

/**
 * Approval mode controlling tool execution behavior.
 * - 'yolo': Auto-approve all tools
 * - 'auto-edit': Auto-approve file edits
 * - 'default': Require approval for file edits and shell commands
 * - 'plan': Analyze only, no modifications allowed
 */
export type ModeApprovalMode = 'yolo' | 'auto-edit' | 'default' | 'plan';

/**
 * Core configuration for a mode as stored in MODE.md files.
 * This interface represents the file-based configuration that gets
 * applied to the Config instance when the mode is activated.
 */
export interface ModeConfig {
  /** Unique name identifier for the mode */
  name: string;

  /** Human-readable display name */
  displayName: string;

  /** Description of when and how to use this mode */
  description: string;

  /** Icon (emoji or symbol) for visual identification */
  icon: string;

  /**
   * System prompt that defines the mode's behavior and role.
   * Replaces the default system prompt when mode is active.
   */
  systemPrompt: string;

  /**
   * Optional whitelist of tool names. If specified, only these tools are available.
   * If omitted and deniedTools is also omitted, all tools are available.
   */
  allowedTools?: string[];

  /**
   * Optional blacklist of tool names. These tools are excluded even if allowed
   * or when using the default tool set.
   */
  deniedTools?: string[];

  /**
   * Optional model parameter overrides.
   * If not specified, inherits from current session config.
   */
  modelConfig?: {
    /** Model identifier */
    model?: string;
    /** Sampling temperature (0.0-1.0) */
    temperature?: number;
    /** Top-p sampling parameter */
    top_p?: number;
    /** Maximum output tokens */
    max_output_tokens?: number;
  };

  /**
   * Optional runtime execution parameters.
   * If not specified, uses session defaults.
   */
  runConfig?: {
    /** Maximum number of reasoning turns */
    max_turns?: number;
    /** Maximum time in minutes per turn */
    max_time_minutes?: number;
  };

  /**
   * Approval mode for tool execution.
   * If not specified, inherits from session config.
   */
  approvalMode?: ModeApprovalMode;

  /**
   * Optional list of sub-agent names that are available in this mode.
   * If omitted, all sub-agents are available.
   */
  allowedSubagents?: string[];

  /**
   * Optional list of skill names that are active in this mode.
   * If omitted, all skills are available.
   */
  allowedSkills?: string[];

  /** Storage level - determines where the configuration file is stored */
  level: ModeLevel;

  /** Absolute path to the MODE.md file. Optional for builtin modes. */
  filePath?: string;

  /** Optional color for UI display (hex code or color name) */
  color?: string;

  /**
   * Optional name of a parent mode to inherit from.
   * Inherited fields override parent values.
   */
  inheritedFrom?: string;

  /**
   * Whether this mode supports parallel execution with other instances.
   * When true, multiple tasks can run simultaneously in this mode.
   * Defaults to true for most modes.
   */
  supportsParallel?: boolean;

  /**
   * Maximum number of parallel tasks allowed in this mode.
   * Only relevant when supportsParallel is true.
   * Defaults to unlimited (0).
   */
  maxParallelTasks?: number;
}

/**
 * Runtime state for an active mode.
 * Tracks when the mode was applied and original settings for restoration.
 */
export interface ModeRuntime {
  /** The mode configuration */
  config: ModeConfig;

  /** Timestamp when the mode was activated */
  appliedAt: Date;

  /**
   * Original settings that were replaced by this mode.
   * Used for restoring when switching back.
   */
  originalSettings?: {
    systemPrompt?: string;
    approvalMode?: ModeApprovalMode;
    modelConfig?: ModeConfig['modelConfig'];
    runConfig?: ModeConfig['runConfig'];
  };
}

/**
 * Result of a validation operation on a mode configuration.
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
 * Options for listing modes.
 */
export interface ListModesOptions {
  /** Filter by storage level */
  level?: ModeLevel;

  /** Filter by tool availability */
  hasTool?: string;

  /** Sort order for results */
  sortBy?: 'name' | 'level';

  /** Sort direction */
  sortOrder?: 'asc' | 'desc';

  /** Force refresh from disk, bypassing cache. Defaults to false. */
  force?: boolean;
}

/**
 * Options for creating a new mode.
 */
export interface CreateModeOptions {
  /** Storage level for the new mode */
  level: ModeLevel;

  /** Whether to overwrite existing mode with same name */
  overwrite?: boolean;

  /** Custom directory path (overrides default level-based path) */
  customPath?: string;
}

/**
 * Error thrown when a mode operation fails.
 */
export class ModeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly modeName?: string,
  ) {
    super(message);
    this.name = 'ModeError';
  }
}

/**
 * Error codes for mode operations.
 */
export const ModeErrorCode = {
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  INVALID_CONFIG: 'INVALID_CONFIG',
  INVALID_NAME: 'INVALID_NAME',
  FILE_ERROR: 'FILE_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  SUBAGENT_NOT_FOUND: 'SUBAGENT_NOT_FOUND',
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
} as const;

export type ModeErrorCode = (typeof ModeErrorCode)[keyof typeof ModeErrorCode];
