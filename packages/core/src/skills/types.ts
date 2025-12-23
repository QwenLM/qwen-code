/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Represents the metadata structure from the YAML Frontmatter in a SKILL.md file.
 * This is the single source of truth for the skill's type definition.
 */
export interface SkillMetadata {
  /**
   * The unique name of the skill, in hyphen-case.
   */
  name: string;

  /**
   * A clear description of what the skill does and when it should be used by the LLM.
   */
  description: string;

  /**
   * [Optional] The license under which the skill is provided.
   */
  license?: string;

  /**
   * [Optional] The display color for the skill in the UI.
   */
  color?: string;

  /**
   * [Optional] A map for additional, client-specific metadata.
   */
  metadata?: Record<string, string>;
}

/**
 * Options for listing skills.
 */
export interface ListSkillsOptions {
  /**
   * Filter skills by availability level.
   * If omitted, returns all available skills from all levels.
   */
  level?: import('../index.js').SubagentLevel;

  /**
   * Sort the results by a specific field.
   * Defaults to undefined (no specific sort order).
   */
  sortBy?: 'name' | 'level';

  /**
   * Sort order. Defaults to 'asc'.
   */
  sortOrder?: 'asc' | 'desc';

  /**
   * Force a refresh from disk, bypassing the cache.
   */
  force?: boolean;
}

/**
 * Represents a fully loaded and parsed Skill, managed by the SkillManager in the core package.
 */
export interface Skill {
  /**
   * The parsed metadata from the SKILL.md frontmatter.
   */
  metadata: SkillMetadata;

  /**
   * The absolute path to the skill's directory, captured by the loader.
   */
  path: string;

  /**
   * The Markdown-formatted instructions for the model.
   */
  instructions: string;
}
