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
} from './types.js';

// `SubagentErrorCode` is both a value (the const enum-like object used
// at runtime) and a type. Re-export both shapes so callers like the
// `qwen serve` workspace-agents route can use it as a value without
// reaching into `./types.js` directly.
export { SubagentError, SubagentErrorCode } from './types.js';

// Built-in agents registry
export {
  BuiltinAgentRegistry,
  DEFAULT_BUILTIN_SUBAGENT_TYPE,
} from './builtin-agents.js';

// Validation system
export { SubagentValidator } from './validation.js';

// Declarative-agent frontmatter schema (CC 2.1.168 parity constants + parsers)
export {
  EFFORT_VALUES,
  EFFORT_ALIASES,
  PERMISSION_MODE_VALUES,
  MEMORY_VALUES,
  ISOLATION_VALUES,
  COLOR_VALUES,
  claudePermissionModeToApprovalMode,
  parseStringOrArray,
  parseBackground,
  parseMaxTurns,
  parseEffort,
  isPermissionMode,
  isMemory,
  isIsolation,
  isColor,
} from './agent-frontmatter-schema.js';
export type {
  EffortValue,
  PermissionModeValue,
  MemoryValue,
  IsolationValue,
  ColorValue,
} from './agent-frontmatter-schema.js';

// Main management class
export { SubagentManager } from './subagent-manager.js';
