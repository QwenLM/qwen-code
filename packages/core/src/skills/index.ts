/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Skills feature implementation
 *
 * This module provides the foundation for the skills feature, which allows
 * users to define reusable skill configurations that can be loaded by the
 * model via a dedicated Skills tool.
 *
 * Skills are stored as directories containing a SKILL.md file with YAML
 * frontmatter for metadata. They can be loaded from four levels
 * (precedence: project > user > extension > bundled):
 * - Project-level: `.qwen/skills/`
 * - User-level: `~/.qwen_local/skills/`
 * - Extension-level: provided by installed extensions
 * - Bundled: built-in skills shipped with qwen-code
 */

// Core types and interfaces
export type {
  SkillConfig,
  SkillLevel,
  SkillValidationResult,
  ListSkillsOptions,
  SkillErrorCode,
} from './types.js';

export { SkillError } from './types.js';

// Main management class
export { SkillManager } from './skill-manager.js';
