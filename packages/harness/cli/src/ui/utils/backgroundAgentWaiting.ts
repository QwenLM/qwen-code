/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isActiveStatus,
  isAgentTask,
  type UnifiedTask,
} from '@qwen-code/core';
import { theme } from '../semantic-colors.js';
import {
  MessageType,
  StreamingState,
  type HistoryItemWithoutId,
} from '../types.js';

/**
 * Builds the live main-conversation marker shown after the current response
 * while background subagents are still running.
 */
export function buildBackgroundAgentWaitingItem({
  tasks,
  streamingState,
}: {
  tasks: readonly UnifiedTask[];
  streamingState: StreamingState;
}): HistoryItemWithoutId | null {
  if (streamingState !== StreamingState.Idle) return null;

  const count = tasks.filter(
    (task) =>
      isAgentTask(task) &&
      task.type === 'local_agent' &&
      task.isBackgrounded &&
      isActiveStatus(task.status),
  ).length;
  if (count === 0) return null;

  return {
    type: MessageType.INFO,
    text: `Waiting for ${count} background agent${count === 1 ? '' : 's'} to finish`,
    activity: true,
    color: theme.text.secondary,
  };
}
