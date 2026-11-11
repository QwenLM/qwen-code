/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Public API for the agent engine module.
 *
 * SDK 投影原语、压缩管线、模型路由、生命周期观察者，以及 SessionQueryRunner /
 * TUI 共用的类型。
 */

// SDK projection helpers — shared by SessionQueryRunner and headless slash handler
export {
  cloneUsageForSdkOutput,
  projectCompactUsageForSdk,
  cloneUsageForSdkResult,
  cloneUsageWithDefaults,
  deriveSdkProjectionUuid,
  isSyntheticTranscriptMessage,
  maskModelUsageForSdkOutput,
  projectModelStreamEventForSdk,
  projectModelMessageForSdk,
  parseSdkInputBlock,
  projectInputBlockForSdk,
  projectUserInputForSdk,
  projectCompactBoundaryForSdk,
  shouldEmitChildAssistantBlock,
  splitAssistantForSdk,
  splitUserForSdk,
} from './headless-projection.js';

// Types
export type {
  QueryEngineSlashCommandContext,
  QueryEngineSlashCommandHandler,
  ToolRegistryFactory,
} from './types.js';
export type {
  HookBeforeResult,
  HookAfterResult,
} from '../core/hook-coordinator-types.js';

// Compression pipeline
export { CompressionPipeline } from '../compression-v2/pipeline.js';
export type { CompressionRequestModel } from '../compression-v2/types.js';
export { finalizePostCompact } from '../compression-v2/post-compact-finalize.js';
export type {
  FinalizePostCompactArgs,
  FinalizePostCompactResult,
} from '../compression-v2/post-compact-finalize.js';
export { applyPostCompact } from '../compression-v2/apply-post-compact.js';
export type { ApplyPostCompactCallbacks } from '../compression-v2/apply-post-compact.js';

export type { HookCoordinatorAdapter } from '../core/hook-coordinator-types.js';

// Query lifecycle observers
export {
  QueryLifecycleRunner,
  DEFAULT_LIFECYCLE_OBSERVER_TIMEOUT_MS,
  type QueryLifecycleContext,
  type QueryLifecycleObserver,
  type QueryLifecycleRunnerOptions,
} from './query-lifecycle-observer.js';
export type { QueryBusinessContext } from '../core/query-business-context.js';
