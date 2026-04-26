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
  maxVisibleItems?: number;
}

const STATUS_ICONS = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
} as const;

const DEFAULT_MAX_VISIBLE_TODOS = 5;
const MIN_VISIBLE_TODOS = 1;
const TERMINAL_ROWS_PER_VISIBLE_TODO = 5;

function clampVisibleTodoCount(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_VISIBLE_TODOS;
  }

  return Math.max(
    MIN_VISIBLE_TODOS,
    Math.min(DEFAULT_MAX_VISIBLE_TODOS, Math.floor(value)),
  );
}

export function getStickyTodoMaxVisibleItems(terminalHeight: number): number {
  if (!Number.isFinite(terminalHeight) || terminalHeight <= 0) {
    return DEFAULT_MAX_VISIBLE_TODOS;
  }

  return clampVisibleTodoCount(terminalHeight / TERMINAL_ROWS_PER_VISIBLE_TODO);
}

export const StickyTodoList: React.FC<StickyTodoListProps> = ({
  todos,
  width,
  maxVisibleItems = DEFAULT_MAX_VISIBLE_TODOS,
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
  const numberColumnWidth = String(todos.length).length + 2;
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
