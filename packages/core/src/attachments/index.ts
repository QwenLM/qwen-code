/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Barrel export for the attachments module.
 *
 * The attachment pipeline provides per-request context injection for the
 * LLM. Generators produce attachments at turn boundaries, and transcript
 * persistence retains them so resume and fork preserve ordered session state.
 * Provider normalization decides which attachment types contribute model
 * context.
 *
 * Primary API:
 *   - getAttachmentMessages() — collects AttachmentMessage array per turn
 *   - normalizeAttachmentsForAPI() — converts attachments to provider messages
 *   - createAttachmentMessage() — factory for AttachmentMessage
 *   - createAttachmentContext() — factory for AttachmentToolUseContext
 *
 * Types:
 *   - Attachment — discriminated union of all ~66 attachment variants
 *   - AttachmentMessage — transcript-level container (uuid + timestamp)
 *   - AttachmentToolUseContext — dependency injection for generators
 */

// Core types
export type {
  Attachment,
  AttachmentMessage,
  AttachmentToolUseContext,
  AttachmentExternalContext,
  QueuedCommand,
  // Hook sub-union (precise)
  HookAttachment,
  // Agent swarms
  SubagentProgressEntry,
} from './types.js';
export {
  // File & Content
  FileAttachment,
  ImageFileAttachment,
  InvalidImageFileAttachment,
  AlreadyReadFileAttachment,
  CompactFileReferenceAttachment,
  PDFReferenceAttachment,
  PDFFileAttachment,
  EditedTextFileAttachment,
  EditedImageFileAttachment,
  DirectoryAttachment,
  // Memory system
  RelevantMemoriesAttachment,
  CurrentSessionMemoryAttachment,
  PlanFileReferenceAttachment,
  // Skills
  SkillListingAttachment,
  InvokedSkillsAttachment,
  // Mode & State
  PlanModeAttachment,
  PlanModeReentryAttachment,
  PlanModeExitAttachment,
  GoalStateAttachment,
  TurnBudgetGuidanceAttachment,
  TurnBudgetExhaustedAttachment,
  RemainingTurnsAttachment,
  AdditionalTurnsAttachment,
  AutoModeAttachment,
  AutoModeExitAttachment,
  VerifyPlanReminderAttachment,
  // System & State
  EnvironmentAttachment,
  SessionContextAttachment,
  DateChangeAttachment,
  CriticalSystemReminderAttachment,
  StreamInterruptionAttachment,
  WorkflowKeywordRequestAttachment,
  UltraEffortEnterAttachment,
  UltraEffortExitAttachment,
  TokenUsageAttachment,
  CompactionReminderAttachment,
  // Queue & Commands
  QueuedCommandAttachment,
  // Task & Agent
  TaskReminderAttachment,
  TodoReminderAttachment,
  AgentMentionAttachment,
  PeerMentionAttachment,
  AgentListingDeltaAttachment,
  // System Deltas
  McpInstructionsDeltaAttachment,
  McpLazyToolsDeltaAttachment,
  McpResourceAttachment,
  // Hook outputs (simplified)
  HookOutputAttachment,
  HookBlockingErrorAttachment,
  HookNonBlockingErrorAttachment,
  HookErrorDuringExecutionAttachment,
  HookSuccessAttachment,
  HookCancelledAttachment,
  HookStoppedContinuationAttachment,
  HookSystemMessageAttachment,
  HookPermissionDecisionAttachment,
  TeamContextAttachment,
  // Post-compact restore
  PostCompactRestoredFilesAttachment,
} from './types.js';
export { BaseAttachment } from './models/base-attachment.js';
export type {
  SessionContext,
  SessionContextInput,
  SessionContextReason,
} from './models/session-context-attachment.js';
export { restoreAttachment } from './transcript-conversion.js';

// Factory
export { createAttachmentMessage } from './factory.js';
export {
  restoreAttachmentTranscriptState,
  restoreInvokedSkillsFromTranscript,
  snapshotAttachmentDeltaState,
} from './transcript-state.js';

// Error isolation
export { maybe, withTimeout } from './maybe.js';

// Normalization
export {
  normalizeAttachmentForAPI,
  normalizeAttachmentsForAPI,
} from './normalize.js';

// Main aggregators
export {
  getAttachments,
  getAttachmentMessages,
  createAttachmentContext,
  type GetAttachmentsOptions,
} from './get-attachments.js';

// Individual generators (exported for testing and advanced use)
export {
  processAtMentionedFiles,
  getChangedFiles,
  generateFileAttachment,
  parseAtMentionedPaths,
} from './generators/file-generators.js';

export {
  getSkillListingConfig,
  getSkillListingAttachments,
  resetSkillListingState,
  buildInvokedSkillsAttachment,
  type SkillListingConfig,
} from './generators/skill-generators.js';

export {
  getDateChangeAttachments,
  getCriticalSystemReminderAttachment,
  getTokenUsageAttachment,
  getCompactionReminderAttachment,
} from './generators/system-generators.js';
export { getEnvironmentAttachments } from './generators/environment-generators.js';
export { getSessionContextAttachments } from './generators/session-context-generators.js';

export {
  containsStandaloneUltracode,
  findStandaloneUltracodeRanges,
  getWorkflowKeywordReminderAttachments,
  type UltracodeKeywordRange,
} from './generators/workflow-generators.js';

export {
  getUltraEffortAttachments,
  ULTRA_EFFORT_ATTACHMENT_CONFIG,
} from './generators/auto-mode-generators.js';

// Memory generators
export {
  seedStaticMemoryPaths,
  getRelevantMemoriesAttachments,
} from './generators/memory-generators.js';
export { seedStartupStaticMemoryFileReadState } from './startup-memory-read-state.js';

// Plan mode generators
export {
  getPlanModeAttachments,
  getPlanModeReentryAttachment,
  getPlanModeExitAttachment,
  getPlanModeInterTurnAttachment,
  getVerifyPlanReminderAttachment,
  PLAN_MODE_ATTACHMENT_CONFIG,
} from './generators/plan-generators.js';

// Hook output generator
export {
  drainHookOutputAttachments,
  enqueueHookOutput,
} from './generators/hook-generators.js';

// Team / agent swarm generators
export { getTeamContextAttachment } from './generators/team-generators.js';

// Post-compact restore generator
export {
  drainPostCompactRestoreAttachments,
  drainPostCompactPlanAttachment,
} from './generators/restore-generators.js';

// MCP instructions delta generator
export {
  getMcpInstructionsDeltaAttachments,
  resetMcpInstructionsDeltaState,
} from './generators/mcp-generators.js';

// Lazy MCP system-reminder generator
export {
  getLazyMcpReminderAttachments,
  resetLazyMcpReminderState,
} from './generators/mcp-lazy-generator.js';

// Agent listing delta generator
export {
  getAvailableAgentTypeNames,
  getAgentListingDeltaAttachments,
  resetAgentListingDeltaState,
} from './generators/agent-generators.js';

// Compact recovery generators
export {
  createPlanAttachmentIfNeeded,
  createSkillAttachmentIfNeeded,
} from './generators/compact-generators.js';
export type { InvokedSkillRecord } from './generators/compact-generators.js';
