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
  getStickyTodosRenderKey,
  STICKY_TODO_MAX_VISIBLE_ITEMS,
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

function clampVisibleTodoCount(value: number): number {
  if (!Number.isFinite(value)) {
    return STICKY_TODO_MAX_VISIBLE_ITEMS;
  }

  return Math.max(
    1,
    Math.min(STICKY_TODO_MAX_VISIBLE_ITEMS, Math.floor(value)),
  );
}

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

  if (todos.length === 0) {
    return null;
  }

  const visibleTodoCount = clampVisibleTodoCount(maxVisibleItems);
  const visibleTodos = orderedTodos.slice(0, visibleTodoCount);
  const hiddenTodoCount = orderedTodos.length - visibleTodos.length;
  const numberColumnWidth =
    Math.max(
      ...visibleTodos.map(
        (todo, index) =>
          (todoNumberById.get(todo.id) ?? `${index + 1}.`).length,
      ),
    ) + 1;
  // 6 = 2 (status icon column) + 2 (border columns) + 2 (paddingX columns).
  const contentColumnWidth = Math.max(1, width - numberColumnWidth - 6);

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
          <Box key={todo.id} flexDirection="row" height={1}>
            <Box width={numberColumnWidth}>
              <Text color={theme.text.secondary}>{todoNumber}</Text>
            </Box>
            <Box width={2}>
              <Text color={itemColor}>{STATUS_ICONS[todo.status]}</Text>
            </Box>
            <Box width={contentColumnWidth}>
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
      {hiddenTodoCount > 0 && (
        <Box flexDirection="row" height={1}>
          <Box width={numberColumnWidth} />
          <Box width={2} />
          <Box width={contentColumnWidth}>
            <Text color={theme.text.secondary} wrap="truncate-end">
              {t('... and {{count}} more', {
                count: String(hiddenTodoCount),
              })}
            </Text>
          </Box>
        </Box>
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
