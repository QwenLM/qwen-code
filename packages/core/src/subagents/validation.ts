/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { SubagentError, SubagentErrorCode } from './types.js';
import type { SubagentConfig, ValidationResult } from './types.js';
import type { RunConfig } from '../agents/runtime/agent-types.js';
import { parseSubagentModelSelection } from './model-selection.js';

/**
 * Validates subagent configurations to ensure they are well-formed
 * and compatible with the runtime system.
 */
export class SubagentValidator {
  /**
   * Validates a complete subagent configuration.
   *
   * @param config - The subagent configuration to validate
   * @returns ValidationResult with errors and warnings
   */
  validateConfig(config: SubagentConfig): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate name
    const nameValidation = this.validateName(config.name);
    if (!nameValidation.isValid) {
      errors.push(...nameValidation.errors);
    }

    // Validate description
    if (!config.description || config.description.trim().length === 0) {
      errors.push('Description is required and cannot be empty');
    } else if (config.description.length > 1000) {
      warnings.push(
        'Description is quite long (>1,000 chars), consider shortening for better readability',
      );
    }

    // Validate system prompt
    const promptValidation = this.validateSystemPrompt(config.systemPrompt);
    if (!promptValidation.isValid) {
      errors.push(...promptValidation.errors);
    }
    warnings.push(...promptValidation.warnings);

    // Validate tools if specified
    if (config.tools) {
      const toolsValidation = this.validateTools(config.tools);
      if (!toolsValidation.isValid) {
        errors.push(...toolsValidation.errors);
      }
      warnings.push(...toolsValidation.warnings);
    }

    // Validate disallowedTools if specified
    if (config.disallowedTools && config.disallowedTools.length > 0) {
      const disallowedValidation = this.validateTools(config.disallowedTools);
      if (!disallowedValidation.isValid) {
        errors.push(...disallowedValidation.errors);
      }
      warnings.push(...disallowedValidation.warnings);
    }

    // Validate model selector if specified
    if (config.model) {
      const modelValidation = this.validateModel(config.model);
      if (!modelValidation.isValid) {
        errors.push(...modelValidation.errors);
      }
      warnings.push(...modelValidation.warnings);
    }

    // Validate run config if specified
    if (config.runConfig) {
      const runValidation = this.validateRunConfig(config.runConfig);
      if (!runValidation.isValid) {
        errors.push(...runValidation.errors);
      }
      warnings.push(...runValidation.warnings);
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validates a subagent name.
   * Names must be valid identifiers that can be used in file paths and tool calls.
   *
   * @param name - The name to validate
   * @returns ValidationResult
   */
  validateName(name: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!name || name.trim().length === 0) {
      errors.push('Name is required and cannot be empty');
      return { isValid: false, errors, warnings };
    }

    const trimmedName = name.trim();

    // Check length constraints
    if (trimmedName.length < 2) {
      errors.push('Name must be at least 2 characters long');
    }

    if (trimmedName.length > 50) {
      errors.push('Name must be 50 characters or less');
    }

    // Check valid characters (Unicode letters/numbers, hyphens, underscores)
    const validNameRegex = /^[\p{L}\p{N}_-]+$/u;
    if (!validNameRegex.test(trimmedName)) {
      errors.push(
        'Name can only contain letters, numbers, hyphens, and underscores',
      );
    }

    // Check that it doesn't start or end with special characters
    if (trimmedName.startsWith('-') || trimmedName.startsWith('_')) {
      errors.push('Name cannot start with a hyphen or underscore');
    }

    if (trimmedName.endsWith('-') || trimmedName.endsWith('_')) {
      errors.push('Name cannot end with a hyphen or underscore');
    }

    // Check for reserved names. `main` is the sentinel used by the /stats
    // attribution pipeline to label the main (non-subagent) conversation;
    // a subagent named `main` would collide with that sentinel and be
    // silently merged into the main bucket.
    const reservedNames = [
      'self',
      'system',
      'user',
      'model',
      'tool',
      'config',
      'default',
      'main',
    ];
    if (reservedNames.includes(trimmedName.toLowerCase())) {
      errors.push(`"${trimmedName}" is a reserved name and cannot be used`);
    }

    // Warnings for naming conventions (only for names that have case distinctions)
    if (
      trimmedName !== trimmedName.toLowerCase() &&
      /[a-zA-Z]/.test(trimmedName)
    ) {
      warnings.push('Consider using lowercase names for consistency');
    }

    if (trimmedName.includes('_') && trimmedName.includes('-')) {
      warnings.push(
        'Consider using either hyphens or underscores consistently, not both',
      );
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validates a system prompt.
   *
   * @param prompt - The system prompt to validate
   * @returns ValidationResult
   */
  validateSystemPrompt(prompt: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!prompt || prompt.trim().length === 0) {
      errors.push('System prompt is required and cannot be empty');
      return { isValid: false, errors, warnings };
    }

    const trimmedPrompt = prompt.trim();

    // Check minimum length for meaningful prompts
    if (trimmedPrompt.length < 10) {
      errors.push('System prompt must be at least 10 characters long');
    }

    // Warn for very long prompts
    if (trimmedPrompt.length > 10000) {
      warnings.push(
        'System prompt is quite long (>10,000 characters), consider shortening',
      );
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validates a list of tool names.
   *
   * @param tools - Array of tool names to validate
   * @returns ValidationResult
   */
  validateTools(tools: string[]): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!Array.isArray(tools)) {
      errors.push('Tools must be an array of strings');
      return { isValid: false, errors, warnings };
    }

    if (tools.length === 0) {
      warnings.push(
        'Empty tools array - subagent will inherit all available tools',
      );
      return { isValid: true, errors, warnings };
    }

    // Check for duplicates
    const uniqueTools = new Set(tools);
    if (uniqueTools.size !== tools.length) {
      warnings.push('Duplicate tool names found in tools array');
    }

    // Validate each tool name
    for (const tool of tools) {
      if (typeof tool !== 'string') {
        errors.push(`Tool name must be a string, got: ${typeof tool}`);
        continue;
      }

      if (tool.trim().length === 0) {
        errors.push('Tool name cannot be empty');
        continue;
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validates a subagent model selector.
   *
   * @param model - Model selector to validate
   * @returns ValidationResult
   */
  validateModel(model: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (typeof model !== 'string' || model.trim().length === 0) {
      errors.push('Model must be a non-empty string');
      return {
        isValid: false,
        errors,
        warnings,
      };
    }

    try {
      parseSubagentModelSelection(model);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Invalid model');
    }

    if (model.trim() === 'inherit') {
      warnings.push(
        'Explicit "inherit" is optional because omitting the model uses the main conversation model',
      );
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validates runtime configuration.
   *
   * @param runConfig - Partial run configuration to validate
   * @returns ValidationResult
   */
  validateRunConfig(runConfig: RunConfig): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (runConfig.max_time_minutes !== undefined) {
      if (typeof runConfig.max_time_minutes !== 'number') {
        errors.push('max_time_minutes must be a number');
      } else if (runConfig.max_time_minutes <= 0) {
        errors.push('max_time_minutes must be greater than 0');
      } else if (runConfig.max_time_minutes > 60) {
        warnings.push(
          'Very long execution time (>60 minutes) may cause resource issues',
        );
      }
    }

    if (runConfig.max_turns !== undefined) {
      if (typeof runConfig.max_turns !== 'number') {
        errors.push('max_turns must be a number');
      } else if (runConfig.max_turns <= 0) {
        errors.push('max_turns must be greater than 0');
      } else if (!Number.isInteger(runConfig.max_turns)) {
        errors.push('max_turns must be an integer');
      } else if (runConfig.max_turns > 100) {
        warnings.push(
          'Very high turn limit (>100) may cause long execution times',
        );
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Throws a SubagentError if validation fails.
   *
   * @param config - Configuration to validate
   * @param subagentName - Name for error context
   * @throws SubagentError if validation fails
   */
  validateOrThrow(config: SubagentConfig, subagentName?: string): void {
    const result = this.validateConfig(config);
    if (!result.isValid) {
      throw new SubagentError(
        `Validation failed: ${result.errors.join(', ')}`,
        SubagentErrorCode.VALIDATION_ERROR,
        subagentName || config.name,
      );
    }
  }
}
