/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export class WorktreeRestoreUnavailableError extends Error {
  readonly code = 'worktree_restore_unavailable';
  override readonly name = 'WorktreeRestoreUnavailableError';
}
