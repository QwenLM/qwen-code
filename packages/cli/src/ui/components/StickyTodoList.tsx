/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';
import { Box, Text } from 'ink';
import { t } from '../../i18n/index.js';
import { Colors } from '../colors.js';
import { theme } from '../semantic-colors.js';
import { getOrderedStickyTodos } from '../utils/todoSnapshot.js';
import type { TodoItem } from './TodoDisplay.js';

interface StickyTodoListProps {
  todos: TodoItem[];
  width: number;
}

const STATUS_ICONS = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
} as const;

export const StickyTodoList: React.FC<StickyTodoListProps> = ({
  todos,
  width,
}) => {
  const orderedTodos = useMemo(() => getOrderedStickyTodos(todos), [todos]);
  const todoNumberById = useMemo(
    () =>
      new Map(todos.map((todo, index) => [todo.id, `${index + 1}.`] as const)),
    [todos],
  );

  if (todos.length === 0) {
    return null;
  }

  const numberColumnWidth = String(orderedTodos.length).length + 2;

  return (
    <Box
      marginX={2}
      width={width}
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border.default}
      paddingX={1}
    >
      <Text color={theme.text.secondary} bold>
        {t('Current tasks')}
      </Text>
      {orderedTodos.map((todo, index) => {
        const todoNumber = todoNumberById.get(todo.id) ?? `${index + 1}.`;
        const itemColor =
          todo.status === 'in_progress'
            ? Colors.AccentGreen
            : Colors.Foreground;

        return (
          <Box key={todo.id} flexDirection="row" minHeight={1}>
            <Box width={numberColumnWidth}>
              <Text color={theme.text.secondary}>{todoNumber}</Text>
            </Box>
            <Box width={2}>
              <Text color={itemColor}>{STATUS_ICONS[todo.status]}</Text>
            </Box>
            <Box flexGrow={1}>
              <Text
                color={itemColor}
                strikethrough={todo.status === 'completed'}
                wrap="wrap"
              >
                {todo.content}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
};
