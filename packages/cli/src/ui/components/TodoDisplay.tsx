/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { ICON } from '../constants.js';

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

interface TodoDisplayProps {
  todos: TodoItem[];
}

const STATUS_ICONS = {
  pending: ICON.CIRCLE_EMPTY,
  in_progress: ICON.CIRCLE_LEFT_HALF,
  completed: ICON.CIRCLE_FILLED,
} as const;

export const TodoDisplay: React.FC<TodoDisplayProps> = ({ todos }) => {
  if (!todos || todos.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column">
      {todos.map((todo) => (
        <TodoItemRow key={todo.id} todo={todo} />
      ))}
    </Box>
  );
};

interface TodoItemRowProps {
  todo: TodoItem;
}

const TodoItemRow: React.FC<TodoItemRowProps> = ({ todo }) => {
  const statusIcon = STATUS_ICONS[todo.status];
  const isCompleted = todo.status === 'completed';
  const isInProgress = todo.status === 'in_progress';

  // Use the same color for both status icon and text, like RadioButtonSelect
  const itemColor = isCompleted
    ? Colors.Foreground
    : isInProgress
      ? Colors.AccentGreen
      : Colors.Foreground;

  return (
    <Box flexDirection="row" minHeight={1}>
      {/* Status Icon */}
      <Box width={3}>
        <Text color={itemColor}>{statusIcon}</Text>
      </Box>

      {/* Content */}
      <Box flexGrow={1}>
        <Text color={itemColor} strikethrough={isCompleted} wrap="wrap">
          {todo.content}
        </Text>
      </Box>
    </Box>
  );
};
