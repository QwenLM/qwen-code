/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Mode validation utilities.
 *
 * Validates mode configurations to ensure they are well-formed
 * and compatible with the runtime system.
 */

import type { ModeConfig, ValidationResult, ModeApprovalMode } from './types.js';
import { ModeError, ModeErrorCode } from './types.js';

/**
 * Valid approval mode values.
 */
const VALID_APPROVAL_MODES: ModeApprovalMode[] = [
  'yolo',
  'auto-edit',
  'default',
  'plan',
];

/**
 * Validates mode configurations.
 */
export class ModeValidator {
  /**
   * Validates a complete mode configuration.
   *
   * @param config - The mode configuration to validate
   * @param availableTools - Set of all available tool names
   * @param availableSubagents - Set of all available sub-agent names
   * @param availableSkills - Set of all available skill names
   * @returns ValidationResult with errors and warnings
   */
  validateConfig(
    config: ModeConfig,
    availableTools: Set<string>,
    availableSubagents: Set<string>,
    availableSkills: Set<string>,
  ): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate name
    const nameValidation = this.validateName(config.name);
    if (!nameValidation.isValid) {
      errors.push(...nameValidation.errors);
    }

    // Validate display name
    if (!config.displayName || config.displayName.trim().length === 0) {
      errors.push('Display name is required and cannot be empty');
    }

    // Validate description
    if (!config.description || config.description.trim().length === 0) {
      errors.push('Description is required and cannot be empty');
    } else if (config.description.length > 500) {
      warnings.push(
        'Description is quite long (>500 chars), consider shortening for better readability',
      );
    }

    // Validate icon
    if (!config.icon || config.icon.trim().length === 0) {
      errors.push('Icon is required and cannot be empty');
    }

    // Validate system prompt
    const promptValidation = this.validateSystemPrompt(config.systemPrompt);
    if (!promptValidation.isValid) {
      errors.push(...promptValidation.errors);
    }
    warnings.push(...promptValidation.warnings);

    // Validate allowed tools
    if (config.allowedTools) {
      const toolsValidation = this.validateTools(
        config.allowedTools,
        availableTools,
      );
      if (!toolsValidation.isValid) {
        errors.push(...toolsValidation.errors);
      }
      warnings.push(...toolsValidation.warnings);
    }

    // Validate denied tools
    if (config.deniedTools) {
      const deniedToolsValidation = this.validateDeniedTools(
        config.deniedTools,
        availableTools,
      );
      if (!deniedToolsValidation.isValid) {
        errors.push(...deniedToolsValidation.errors);
      }
    }

    // Check for overlap between allowed and denied
    if (config.allowedTools && config.deniedTools) {
      const overlap = config.allowedTools.filter((t) =>
        config.deniedTools!.includes(t),
      );
      if (overlap.length > 0) {
        errors.push(
          `Tools cannot be both allowed and denied: ${overlap.join(', ')}`,
        );
      }
    }

    // Validate model config
    if (config.modelConfig) {
      const modelValidation = this.validateModelConfig(config.modelConfig);
      if (!modelValidation.isValid) {
        errors.push(...modelValidation.errors);
      }
      warnings.push(...modelValidation.warnings);
    }

    // Validate run config
    if (config.runConfig) {
      const runValidation = this.validateRunConfig(config.runConfig);
      if (!runValidation.isValid) {
        errors.push(...runValidation.errors);
      }
      warnings.push(...runValidation.warnings);
    }

    // Validate approval mode
    if (config.approvalMode) {
      const approvalValidation = this.validateApprovalMode(config.approvalMode);
      if (!approvalValidation.isValid) {
        errors.push(...approvalValidation.errors);
      }
    }

    // Validate allowed subagents
    if (config.allowedSubagents) {
      const subagentsValidation = this.validateSubagents(
        config.allowedSubagents,
        availableSubagents,
      );
      if (!subagentsValidation.isValid) {
        errors.push(...subagentsValidation.errors);
      }
      warnings.push(...subagentsValidation.warnings);
    }

    // Validate allowed skills
    if (config.allowedSkills) {
      const skillsValidation = this.validateSkills(
        config.allowedSkills,
        availableSkills,
      );
      if (!skillsValidation.isValid) {
        errors.push(...skillsValidation.errors);
      }
      warnings.push(...skillsValidation.warnings);
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validates a mode name.
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

    // Must be alphanumeric with hyphens/underscores, no spaces
    const nameRegex = /^[a-zA-Z0-9_-]+$/;
    if (!nameRegex.test(trimmedName)) {
      errors.push(
        `Name "${trimmedName}" contains invalid characters. Only letters, numbers, hyphens, and underscores are allowed`,
      );
      return { isValid: false, errors, warnings };
    }

    // Length check
    if (trimmedName.length < 2) {
      errors.push('Name must be at least 2 characters long');
      return { isValid: false, errors, warnings };
    }

    if (trimmedName.length > 50) {
      warnings.push(
        'Name is quite long (>50 chars), consider using a shorter name',
      );
    }

    return { isValid: true, errors, warnings };
  }

  /**
   * Validates the system prompt.
   *
   * @param systemPrompt - The system prompt to validate
   * @returns ValidationResult
   */
  validateSystemPrompt(systemPrompt: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!systemPrompt || systemPrompt.trim().length === 0) {
      errors.push('System prompt is required and cannot be empty');
      return { isValid: false, errors, warnings };
    }

    // Minimum length check
    const trimmedPrompt = systemPrompt.trim();
    if (trimmedPrompt.length < 20) {
      warnings.push(
        'System prompt is very short (<20 chars), consider providing more context for better behavior',
      );
    }

    // Very long prompt warning
    if (trimmedPrompt.length > 10000) {
      warnings.push(
        'System prompt is very long (>10,000 chars), this will consume significant tokens',
      );
    }

    return { isValid: true, errors, warnings };
  }

  /**
   * Validates allowed tools.
   *
   * @param tools - Array of tool names
   * @param availableTools - Set of all available tool names
   * @returns ValidationResult
   */
  validateTools(
    tools: string[],
    availableTools: Set<string>,
  ): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (tools.length === 0) {
      errors.push('Allowed tools array is empty, no tools would be available');
      return { isValid: false, errors, warnings };
    }

    // Check for unknown tools
    const unknownTools = tools.filter((t) => !availableTools.has(t));
    if (unknownTools.length > 0) {
      errors.push(
        `Unknown tools specified: ${unknownTools.join(', ')}`,
      );
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * Validates denied tools.
   *
   * @param deniedTools - Array of tool names to deny
   * @param availableTools - Set of all available tool names
   * @returns ValidationResult
   */
  validateDeniedTools(
    deniedTools: string[],
    availableTools: Set<string>,
  ): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for unknown tools in denied list
    const unknownTools = deniedTools.filter((t) => !availableTools.has(t));
    if (unknownTools.length > 0) {
      warnings.push(
        `Unknown tools in denied list (will be ignored): ${unknownTools.join(', ')}`,
      );
    }

    return { isValid: true, errors, warnings };
  }

  /**
   * Validates model configuration.
   *
   * @param modelConfig - Model configuration object
   * @returns ValidationResult
   */
  validateModelConfig(modelConfig: {
    model?: string;
    temperature?: number;
    top_p?: number;
    max_output_tokens?: number;
  }): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (modelConfig.temperature !== undefined) {
      if (
        modelConfig.temperature < 0 ||
        modelConfig.temperature > 2
      ) {
        errors.push(
          `Temperature must be between 0 and 2, got ${modelConfig.temperature}`,
        );
      }
      if (modelConfig.temperature > 1.5) {
        warnings.push(
          'High temperature (>1.5) may produce inconsistent results',
        );
      }
    }

    if (modelConfig.top_p !== undefined) {
      if (modelConfig.top_p < 0 || modelConfig.top_p > 1) {
        errors.push(`top_p must be between 0 and 1, got ${modelConfig.top_p}`);
      }
    }

    if (modelConfig.max_output_tokens !== undefined) {
      if (modelConfig.max_output_tokens < 1) {
        errors.push(
          `max_output_tokens must be positive, got ${modelConfig.max_output_tokens}`,
        );
      }
      if (modelConfig.max_output_tokens > 32000) {
        warnings.push(
          'Very high max_output_tokens (>32000) may exceed model limits',
        );
      }
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * Validates run configuration.
   *
   * @param runConfig - Run configuration object
   * @returns ValidationResult
   */
  validateRunConfig(runConfig: {
    max_turns?: number;
    max_time_minutes?: number;
  }): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (runConfig.max_turns !== undefined) {
      if (runConfig.max_turns < 1) {
        errors.push(`max_turns must be positive, got ${runConfig.max_turns}`);
      }
      if (runConfig.max_turns > 100) {
        warnings.push(
          'Very high max_turns (>100) may run for a long time',
        );
      }
    }

    if (runConfig.max_time_minutes !== undefined) {
      if (runConfig.max_time_minutes < 0.5) {
        errors.push(
          `max_time_minutes must be at least 0.5, got ${runConfig.max_time_minutes}`,
        );
      }
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * Validates approval mode value.
   *
   * @param approvalMode - Approval mode string
   * @returns ValidationResult
   */
  validateApprovalMode(approvalMode: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!VALID_APPROVAL_MODES.includes(approvalMode as ModeApprovalMode)) {
      errors.push(
        `Invalid approval mode: "${approvalMode}". Must be one of: ${VALID_APPROVAL_MODES.join(', ')}`,
      );
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * Validates allowed subagents.
   *
   * @param subagents - Array of sub-agent names
   * @param availableSubagents - Set of all available sub-agent names
   * @returns ValidationResult
   */
  validateSubagents(
    subagents: string[],
    availableSubagents: Set<string>,
  ): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (subagents.length === 0) {
      errors.push(
        'Allowed subagents array is empty, no sub-agents would be available',
      );
      return { isValid: false, errors, warnings };
    }

    const unknown = subagents.filter((s) => !availableSubagents.has(s));
    if (unknown.length > 0) {
      errors.push(`Unknown sub-agents specified: ${unknown.join(', ')}`);
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * Validates allowed skills.
   *
   * @param skills - Array of skill names
   * @param availableSkills - Set of all available skill names
   * @returns ValidationResult
   */
  validateSkills(
    skills: string[],
    availableSkills: Set<string>,
  ): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (skills.length === 0) {
      warnings.push('Allowed skills array is empty, no skills would be active');
    }

    const unknown = skills.filter((s) => !availableSkills.has(s));
    if (unknown.length > 0) {
      errors.push(`Unknown skills specified: ${unknown.join(', ')}`);
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * Creates a ModeError from validation result.
   *
   * @param result - ValidationResult
   * @param modeName - Optional mode name for error context
   * @returns ModeError
   */
  static createErrorFromResult(
    result: ValidationResult,
    modeName?: string,
  ): ModeError {
    return new ModeError(
      result.errors.join('; '),
      ModeErrorCode.VALIDATION_ERROR,
      modeName,
    );
  }
}

/**
 * Singleton instance for convenience.
 */
export const modeValidator = new ModeValidator();
