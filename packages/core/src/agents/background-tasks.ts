/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Re-export shim. The agent-task module
 * (`tasks/agent-task.ts`) now owns the `AgentTask` type, lifecycle
 * helpers, label builder, and the background-agent concurrency cap;
 * this file re-exports them so external SDK consumers that imported
 * from `'@qwen-code/qwen-code-core'` (which surfaces this module via
 * `agents/index.ts`) keep their import paths working for one release.
 *
 * Removal: scheduled for the release after PR 2 lands. New code should
 * import from `'./tasks/agent-task.js'` directly.
 */

export {
  type AgentTask,
  type AgentTaskRegistration,
  type AgentCompletionStats,
  type BackgroundActivity,
  type BackgroundNotificationCallback,
  type BackgroundRegisterCallback,
  type BackgroundTaskEntry,
  type BackgroundTaskStatus,
  type NotificationMeta,
  buildBackgroundEntryLabel,
  BACKGROUND_AGENT_CONCURRENCY_ENV,
  DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS,
  MAX_CONCURRENT_BACKGROUND_AGENTS,
  resolveMaxConcurrentBackgroundAgents,
} from './tasks/agent-task.js';
