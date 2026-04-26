/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { memo, useMemo } from 'react';
import { Box, Text } from 'ink';
import { t } from '../../i18n/index.js';
import { Colors } from '../colors.js';
import { theme } from '../semantic-colors.js';
import {
  getOrderedStickyTodos,
  STICKY_TODO_MAX_VISIBLE_ITEMS,
  getStickyTodosRenderKey,
} from '../utils/todoSnapshot.js';
import type { TodoItem } from './TodoDisplay.js';

interface StickyTodoListProps {
  todos: TodoItem[];
  width: number;
  maxVisibleItems?: number;
}

const STATUS_ICONS = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
} as const;

const StickyTodoListComponent: React.FC<StickyTodoListProps> = ({
  todos,
  width,
  maxVisibleItems = STICKY_TODO_MAX_VISIBLE_ITEMS,
}) => {
  const orderedTodos = useMemo(() => getOrderedStickyTodos(todos), [todos]);
  const todoNumberById = useMemo(
    () =>
      new Map(todos.map((todo, index) => [todo.id, `${index + 1}.`] as const)),
    [todos],
  );

  const visibleTodos = orderedTodos.slice(0, maxVisibleItems);
  const overflowCount = orderedTodos.length - maxVisibleItems;

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
      {visibleTodos.map((todo, index) => {
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
                wrap="truncate-end"
              >
                {todo.content}
              </Text>
            </Box>
          </Box>
        );
      })}
      {overflowCount > 0 && (
        <Text color={theme.text.secondary}>
          {t('... and {{count}} more', { count: String(overflowCount) })}
        </Text>
      )}
    </Box>
  );
};

export const StickyTodoList = memo(
  StickyTodoListComponent,
  (previousProps, nextProps) =>
    previousProps.width === nextProps.width &&
    previousProps.maxVisibleItems === nextProps.maxVisibleItems &&
    getStickyTodosRenderKey(previousProps.todos) ===
      getStickyTodosRenderKey(nextProps.todos),
);
