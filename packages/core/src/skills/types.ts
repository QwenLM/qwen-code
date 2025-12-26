/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Represents the storage level for a skill configuration.
 * - 'project': Stored in `.qwen/skills/` within the project directory
 * - 'user': Stored in `~/.qwen/skills/` in the user's home directory
 */
export type SkillLevel = 'project' | 'user';

/**
 * Core configuration for a skill as stored in SKILL.md files.
 * Each skill directory contains a SKILL.md file with YAML frontmatter
 * containing metadata, followed by markdown content describing the skill.
 */
export interface SkillConfig {
  /** Unique name identifier for the skill */
  name: string;

  /** Human-readable description of what this skill provides */
  description: string;

  /**
   * Optional list of tool names that this skill is allowed to use.
   * For v1, this is informational only (no gating).
   */
  allowedTools?: string[];

  /**
   * Storage level - determines where the configuration file is stored
   */
  level: SkillLevel;

  /**
   * Absolute path to the skill directory containing SKILL.md
   */
  filePath: string;

  /**
   * The markdown body content from SKILL.md (after the frontmatter)
   */
  body: string;
}

/**
 * Runtime configuration for a skill when it's being actively used.
 * Extends SkillConfig with additional runtime-specific fields.
 */
export type SkillRuntimeConfig = SkillConfig;

/**
 * Result of a validation operation on a skill configuration.
 */
export interface SkillValidationResult {
  /** Whether the configuration is valid */
  isValid: boolean;

  /** Array of error messages if validation failed */
  errors: string[];

  /** Array of warning messages (non-blocking issues) */
  warnings: string[];
}

/**
 * Options for listing skills.
 */
export interface ListSkillsOptions {
  /** Filter by storage level */
  level?: SkillLevel;

  /** Force refresh from disk, bypassing cache. Defaults to false. */
  force?: boolean;
}

/**
 * Error thrown when a skill operation fails.
 */
export class SkillError extends Error {
  constructor(
    message: string,
    readonly code: SkillErrorCode,
    readonly skillName?: string,
  ) {
    super(message);
    this.name = 'SkillError';
  }
}

/**
 * Error codes for skill operations.
 */
export const SkillErrorCode = {
  NOT_FOUND: 'NOT_FOUND',
  INVALID_CONFIG: 'INVALID_CONFIG',
  INVALID_NAME: 'INVALID_NAME',
  FILE_ERROR: 'FILE_ERROR',
  PARSE_ERROR: 'PARSE_ERROR',
} as const;

export type SkillErrorCode =
  (typeof SkillErrorCode)[keyof typeof SkillErrorCode];
