/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ServeSessionSupportedCommandsStatus } from '@qwen-code/acp-bridge/status';

// The daemon's workspace trust verdict never reaches the ACP child's
// workflow gate, so the daemon boundary redacts the surfaces itself with the
// same fail-closed shape the child produces when its own gate denies them.
export function redactWorkflowsFromSupportedCommands(
  status: ServeSessionSupportedCommandsStatus,
): ServeSessionSupportedCommandsStatus {
  return {
    ...status,
    availableCommands: status.availableCommands.filter(
      (command) => command.name !== 'workflows',
    ),
    workflowsEnabled: false,
    savedWorkflows: [],
  };
}
