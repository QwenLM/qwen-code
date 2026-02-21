/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Subagents — file-based configuration layer.
 *
 * This module provides the foundation for the subagents feature by implementing
 * a file-based configuration system that builds on the agent runtime.
 *
 */

// Core types and interfaces
export type {
  SubagentConfig,
  SubagentLevel,
  SubagentRuntimeConfig,
  ValidationResult,
  ListSubagentsOptions,
  CreateSubagentOptions,
  SubagentErrorCode,
} from './types.js';

export { SubagentError } from './types.js';

// Built-in agents registry
export { BuiltinAgentRegistry } from './builtin-agents.js';

// Validation system
export { SubagentValidator } from './validation.js';

// Main management class
export { SubagentManager } from './subagent-manager.js';
