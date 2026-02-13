/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hook System
 *
 * A comprehensive event hook system that allows developers to inject custom logic
 * at predefined points in the CLI operation lifecycle.
 *
 * Architecture:
 * - HookSystem: Central orchestration layer that coordinates all components
 * - Registry: Manages hook definitions
 * - Planner: Plans hook execution (sequential/parallel, matching)
 * - Runner: Executes hook commands or JS plugins
 * - Aggregator: Merges results from multiple hooks
 * - Translator: Converts SDK types to stable hook formats
 * - EventHandler: Coordinates the complete execution pipeline
 * - MessageBusHandler: Provides RPC-style communication via message bus
 */

// Types
export {
  HookEventName,
  HookType,
  NotificationType,
  SessionStartSource,
  SessionEndReason,
  PreCompactTrigger,
  DefaultHookOutput,
  PreToolUseHookOutput,
  PostToolUseHookOutput,
  UserPromptSubmitHookOutput,
  StopHookOutput,
  createHookOutput,
} from './types.js';

export type {
  HookConfig,
  CommandHookConfig,
  HookDefinition,
  HookInput,
  HookOutput,
  HookDecision,
  HookExecutionResult,
  HookExecutionPlan,
  PreToolUseInput,
  PreToolUseOutput,
  PostToolUseInput,
  PostToolUseOutput,
  PermissionRequestInput,
  PermissionRequestOutput,
  UserPromptSubmitInput,
  UserPromptSubmitOutput,
  StopInput,
  StopOutput,
  SubagentStopInput,
  SubagentStopOutput,
  NotificationInput,
  NotificationOutput,
  SessionStartInput,
  SessionStartOutput,
  SessionEndInput,
  SessionEndOutput,
  PreCompactInput,
  PreCompactOutput,
} from './types.js';

// Registry
export { HookRegistry, createHookRegistry } from './registry.js';

export type { HookRegistryConfig } from './registry.js';

// Planner
export { HookPlanner, createHookPlanner, matchToolName } from './planner.js';

export type {
  MatchPattern,
  MatchPatternType,
  HookMatchResult,
  PlanOptions,
} from './planner.js';

// Aggregator
export {
  HookAggregator,
  aggregateHookResults,
  DEFAULT_AGGREGATION_CONFIG,
  EVENT_AGGREGATION_CONFIGS,
} from './aggregator.js';

export type {
  HookAggregationResult,
  DecisionMergeStrategy,
  MessageMergeStrategy,
  AggregationConfig,
} from './aggregator.js';

// Runner
export { HookRunner, createHookRunner } from './runner.js';

export type { HookRunnerConfig, CommandHookResult } from './runner.js';

// Translator
export { HookTranslator, createHookTranslator } from './translator.js';

export type {
  SDKToolUse,
  SDKToolResponse,
  SDKUserPrompt,
} from './translator.js';

// Event Handler
export { HookEventHandler, createHookEventHandler } from './eventHandler.js';

export type {
  HookEventContext,
  HookExecutionRequest,
  HookExecutionResponse,
  HookEventHandlerOptions,
  HookEventHandlerFn,
} from './eventHandler.js';

// Message Bus Handler
export {
  MessageBusHookEventHandler,
  createMessageBusHookEventHandler,
} from './messageBusHandler.js';

export type {
  HookExecutionMessageRequest,
  HookExecutionMessageResponse,
  HookTelemetryEvent,
  HookMessageBus,
  MessageBusHookEventHandlerOptions,
  MessageHandler,
} from './messageBusHandler.js';

// Hook System (Orchestration Layer)
export { HookSystem, createHookSystem } from './hookSystem.js';

export type {
  HookSystemConfig,
  HookSystemState,
  CreateHookSystemOptions,
} from './hookSystem.js';
