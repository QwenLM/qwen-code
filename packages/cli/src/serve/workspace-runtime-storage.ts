/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SessionService,
  Storage,
  type SessionServiceOptions,
} from '@qwen-code/qwen-code-core';
import type { WorkspaceRuntime } from './workspace-registry.js';
import { resolveRuntimeWorktreeRootSetting } from './server/worktree-root.js';

export function runWithWorkspaceRuntimeStorage<T>(
  runtime: Pick<WorkspaceRuntime, 'sessionRuntimeBaseDir'>,
  fn: () => T,
): T {
  return Storage.runWithResolvedRuntimeBaseDir(
    runtime.sessionRuntimeBaseDir,
    fn,
  );
}

export function createWorkspaceRuntimeSessionService(
  runtime: WorkspaceRuntime,
  options: Omit<SessionServiceOptions, 'runtimeBaseDir'> = {},
): SessionService {
  const worktreeRoot =
    options.worktreeRoot ??
    (runtime.env !== undefined
      ? resolveRuntimeWorktreeRootSetting(runtime)
      : undefined);
  return new SessionService(runtime.workspaceCwd, {
    ...options,
    ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
    runtimeBaseDir: runtime.sessionRuntimeBaseDir,
  });
}
