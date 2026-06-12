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

// NOTE: declarative-agent schema helpers (e.g.
// claudePermissionModeToApprovalMode, parseMaxTurns, isPermissionMode)
// live in `agent-frontmatter-schema.ts` and are intentionally NOT
// re-exported here — they are internal to the `SubagentManager` /
// `claude-converter` parse paths and locking their names in the
// package's public API would constrain follow-up schema changes.
// Re-introduce specific exports here when a cross-package caller actually
// needs them.

// Main management class
export { SubagentManager } from './subagent-manager.js';
