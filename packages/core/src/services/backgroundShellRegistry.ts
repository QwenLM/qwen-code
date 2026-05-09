/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Re-export shim. The shell-task module
 * (`tasks/shell-task.ts`) now owns the `ShellTask` type and lifecycle
 * helpers; this file re-exports them so external SDK consumers that
 * imported from `'@qwen-code/qwen-code-core'` keep their import paths
 * working for one release.
 *
 * Removal: scheduled for the release after PR 2 lands. New code should
 * import from `'../tasks/shell-task.js'` directly.
 */

export {
  type ShellTask,
  type ShellTaskRegistration,
  type BackgroundShellEntry,
  type BackgroundShellStatus,
} from '../tasks/shell-task.js';
