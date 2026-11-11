/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, type SlashCommand } from './types.js';
import { UnifiedTaskPanel } from '../components/UnifiedTaskPanel.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useTaskRegistry } from '../contexts/TaskRegistryContext.js';
import { dismissTask } from '../utils/taskActions.js';

function UnifiedTaskPanelWithState({
  onClose,
}: {
  onClose: () => void;
}) {
  const uiState = useUIState();
  const registry = useTaskRegistry();
  return (
    <UnifiedTaskPanel
      tasks={uiState.unifiedTasks}
      onClose={onClose}
      onDismissTask={(task) =>
        dismissTask(registry, task, (text) =>
          uiState.historyManager.addItem({ type: 'info', text }, Date.now()),
        )
      }
    />
  );
}

export const tasksCommand: SlashCommand = {
  name: 'tasks',
  altNames: ['bg', 'background'],
  kind: CommandKind.BUILT_IN,
  description: 'Show background tasks panel',
  autoExecute: true,
  isSafeConcurrent: true,
  action: async (context) => ({
    type: 'custom_dialog',
    component: (
      <UnifiedTaskPanelWithState
        onClose={() => context.ui.removeComponent()}
      />
    ),
  }),
};

export const workflowsCommand: SlashCommand = {
  name: 'workflows',
  altNames: ['workflow-tasks'],
  kind: CommandKind.BUILT_IN,
  description: 'Browse workflow tasks in the session rail',
  autoExecute: true,
  isSafeConcurrent: true,
  action: async (context) => {
    context.ui.viewWorkflowSessions();
  },
};
