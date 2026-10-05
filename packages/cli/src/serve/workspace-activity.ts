/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WorkspaceRuntime } from './workspace-registry.js';
import { getWorkspaceRuntimeCoordinatorIfSupported } from './workspace-runtime-coordinator.js';

export interface WorkspaceRemovalActivity {
  sessions: number;
  activePrompts: number;
  pendingSessionStarts: number;
  acpConnections: number;
  memoryTasks: number;
  channelWorkers: number;
  voiceSessions: number;
  workspaceRuntime: number;
}

export function readWorkspaceActivity(
  runtime: WorkspaceRuntime,
  controllerActivity = {
    pendingSessionStarts: 0,
    channelWorkers: 0,
    voiceSessions: 0,
  },
  acpActivity = { acpConnections: 0, memoryTasks: 0 },
): WorkspaceRemovalActivity {
  return {
    ...controllerActivity,
    ...acpActivity,
    sessions: runtime.bridge.sessionCount,
    activePrompts: runtime.bridge.activePromptCount,
    workspaceRuntime:
      getWorkspaceRuntimeCoordinatorIfSupported(runtime)?.hasActiveWork() ===
      true
        ? 1
        : 0,
  };
}
