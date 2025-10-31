/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { ScrollView } from './shared/ScrollView.js';

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

interface TodoDisplayProps {
  todos: TodoItem[];
  maxHeight?: number;
  maxWidth?: number;
  overflowDirection?: 'top' | 'bottom';
}

const STATUS_ICONS = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
} as const;

export const TodoDisplay: React.FC<TodoDisplayProps> = ({
  todos,
  maxHeight,
  maxWidth,
  overflowDirection = 'top',
}) => {
  if (!todos || todos.length === 0) {
    return null;
  }

  if (typeof maxHeight === 'number' && !Number.isNaN(maxHeight)) {
    const height = Math.max(2, Math.floor(maxHeight));
    const renderIndicator = (hiddenCount: number) =>
      hiddenCount > 0 ? (
        <Box>
          <Text color={Colors.Gray} wrap="truncate">
            ↑ {hiddenCount} hidden task{hiddenCount === 1 ? '' : 's'}
          </Text>
        </Box>
      ) : null;

    return (
      <ScrollView<TodoItem>
        height={height}
        width={typeof maxWidth === 'number' ? maxWidth : undefined}
        data={todos}
        stickTo={overflowDirection === 'bottom' ? 'top' : 'bottom'}
        renderOverflowIndicator={renderIndicator}
        getItemKey={(item) => item.id}
        renderItem={(item: TodoItem) => renderTodoItemRow(item)}
      />
    );
  }

  return (
    <Box flexDirection="column">
      {todos.map((todo) => renderTodoItemRow(todo))}
    </Box>
  );
};

const renderTodoItemRow = (todo: TodoItem) => {
  const statusIcon = STATUS_ICONS[todo.status];
  const isCompleted = todo.status === 'completed';
  const isInProgress = todo.status === 'in_progress';

  const itemColor = isCompleted
    ? Colors.Foreground
    : isInProgress
      ? Colors.AccentGreen
      : Colors.Foreground;

  return (
    <Box>
      <Text color={itemColor}>{`${statusIcon} `}</Text>
      <Text color={itemColor} strikethrough={isCompleted} wrap="wrap">
        {todo.content}
      </Text>
    </Box>
  );
};
