/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Public API for the Modes Layer.
 *
 * Modes are specialized agent profiles that configure system prompts,
 * tool access, model parameters, and sub-agent/skill availability
 * for specific development workflows.
 */

// Types
export type {
  ModeConfig,
  ModeRuntime,
  ModeLevel,
  ModeApprovalMode,
  ValidationResult,
  ListModesOptions,
  CreateModeOptions,
} from './types.js';

export { ModeError, ModeErrorCode } from './types.js';

// Manager
export { ModeManager, type ModeManagerEvents } from './mode-manager.js';

// Validation
export { ModeValidator, modeValidator } from './mode-validation.js';

// Loading
export {
  loadModesFromDir,
  loadModeFile,
  parseModeContent,
  getUserModesDir,
  getProjectModesDir,
  getModeFilePath,
} from './mode-load.js';

// Built-in modes
export {
  BUILTIN_MODES,
  GENERAL_MODE,
  ARCHITECT_MODE,
  DEVELOPER_MODE,
  REVIEWER_MODE,
  DEBUGGER_MODE,
  TESTER_MODE,
  DEVOPS_MODE,
  PRODUCT_MODE,
  SECURITY_MODE,
  OPTIMIZER_MODE,
} from './builtin-modes.js';

// Parallel execution
export {
  ParallelTaskRunner,
  type ParallelTaskStatus,
  type ParallelTaskConfig,
  type ParallelGroupConfig,
  type ParallelTaskRuntime,
  type ParallelGroupRuntime,
  type ParallelRunnerEvents,
} from './parallel-task-runner.js';

// Mode hooks
export {
  ModeHookRegistry,
  type ModeHook,
  type HookTrigger,
  type HookCommandType,
  type HookExecutionResult,
} from './mode-hooks.js';

// Mode presets
export {
  ModePresetRegistry,
  type ModePreset,
  BUILTIN_PRESETS,
} from './mode-presets.js';

// Mode inheritance
export {
  resolveInheritedMode,
  getInheritanceChain,
  isInheritedFrom,
  findDescendants,
} from './mode-inheritance.js';

// Mode detection
export { ModeDetector, type ModeSuggestion } from './mode-detection.js';

// Mode context
export {
  ContextAwareSwitcher,
  type ModeContextRule,
  type ModeContext,
  type ContextTrigger,
} from './mode-context.js';

// Mode analytics
export {
  ModeAnalytics,
  type ModeUsageStats,
  type ProductivityReport,
} from './mode-analytics.js';

// Mode quality gates
export {
  ModeQualityGateManager,
  type QualityGate,
  type QualityGateResult,
  type ModeQualityConfig,
  type QualityGateRunResult,
  type QualityGateThresholds,
} from './mode-quality-gates.js';

// Mode workflow pipelines
export {
  ModeWorkflowRunner,
  BUILTIN_PIPELINES,
  type WorkflowStep,
  type ModeWorkflow,
  type PipelineResult,
  type ModeWorkflowEvents,
} from './mode-workflow.js';

// Mode cross-communication
export {
  CrossModeCommunicationManager,
  type CrossModeMessage,
  type Artifact,
  type CrossModeCommEvents,
} from './mode-cross-communication.js';

// Mode smart task splitting
export {
  SmartTaskSplitter,
  type TaskSplit,
  type SplitAnalysis,
} from './mode-smart-split.js';

// Mode memory (per-mode isolated conversation memory)
export {
  ModeMemoryManager,
  type ModeMemoryEntry,
  type ModeMemoryBlock,
} from './mode-memory.js';

// Mode collaboration (multi-user mode collaboration)
export {
  ModeCollaborationManager,
  type CollaboratorRole,
  type CollaborationSession,
  type ModeCollaborationEvents,
  type CommunicationEntry,
} from './mode-collaboration.js';

// Mode session management (save/restore)
export { ModeSessionManager, type SessionState } from './mode-session.js';

// Mode templates (file generation)
export {
  ModeTemplateManager,
  type ModeTemplate,
  type TemplateCategory,
  toPascalCase,
  toCamelCase,
  toConstantCase,
} from './mode-templates.js';
