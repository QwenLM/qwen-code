/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Re-export shim. The monitor-task module
 * (`tasks/monitor-task.ts`) now owns the `MonitorTask` type, lifecycle
 * helpers, output-path helper, and concurrency caps; this file
 * re-exports them so external SDK consumers that imported from
 * `'@qwen-code/qwen-code-core'` keep their import paths working for one
 * release.
 *
 * Removal: scheduled for the release after PR 2 lands. New code should
 * import from `'../tasks/monitor-task.js'` directly.
 */

export {
  type MonitorTask,
  type MonitorTaskRegistration,
  type MonitorEntry,
  type MonitorNotificationMeta,
  type MonitorNotificationCallback,
  type MonitorRegisterCallback,
  type MonitorStatus,
  MAX_CONCURRENT_MONITORS,
  MAX_RETAINED_TERMINAL_MONITORS,
  getMonitorOutputPath,
} from '../tasks/monitor-task.js';
