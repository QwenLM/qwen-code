/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * UpdatedPlan tool call component - specialized for plan update operations
 */

import type React from 'react';
import type { BaseToolCallProps } from '../shared/types.js';
import { ToolCallContainer } from '../shared/LayoutComponents.js';
import { groupContent, safeTitle } from '../shared/utils.js';
import { CheckboxDisplay } from '../../ui/CheckboxDisplay.js';

type EntryStatus = 'pending' | 'in_progress' | 'completed';

interface PlanEntry {
  content: string;
  status: EntryStatus;
}

const mapToolStatusToBullet = (
  status: import('../shared/types.js').ToolCallStatus,
): 'success' | 'error' | 'warning' | 'loading' | 'default' => {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'in_progress':
      return 'warning';
    case 'pending':
      return 'loading';
    default:
      return 'default';
  }
};

// Parse plan entries with - [ ] / - [x] from text as much as possible
const parsePlanEntries = (textOutputs: string[]): PlanEntry[] => {
  const text = textOutputs.join('\n');
  const lines = text.split(/\r?\n/);
  const entries: PlanEntry[] = [];

  const todoRe = /^(?:\s*(?:[-*]|\d+[.)])\s*)?\[( |x|X|-)\]\s+(.*)$/;
  for (const line of lines) {
    const m = line.match(todoRe);
    if (m) {
      const mark = m[1];
      const title = m[2].trim();
      const status: EntryStatus =
        mark === 'x' || mark === 'X'
          ? 'completed'
          : mark === '-'
            ? 'in_progress'
            : 'pending';
      if (title) {
        entries.push({ content: title, status });
      }
    }
  }

  // If no match is found, fall back to treating non-empty lines as pending items
  if (entries.length === 0) {
    for (const line of lines) {
      const title = line.trim();
      if (title) {
        entries.push({ content: title, status: 'pending' });
      }
    }
  }

  return entries;
};

/**
 * Specialized component for UpdatedPlan tool calls
 * Optimized for displaying plan update operations
 */
export const UpdatedPlanToolCall: React.FC<BaseToolCallProps> = ({
  toolCall,
}) => {
  const { content, status } = toolCall;
  const { errors, textOutputs } = groupContent(content);

  // Error-first display
  if (errors.length > 0) {
    return (
      <ToolCallContainer label="Updated Plan" status="error">
        {errors.join('\n')}
      </ToolCallContainer>
    );
  }

  const entries = parsePlanEntries(textOutputs);

  const label = safeTitle(toolCall.title) || 'Updated Plan';

  return (
    <ToolCallContainer
      label={label}
      status={mapToolStatusToBullet(status)}
      className="update-plan-toolcall"
    >
      <ul className="Fr list-none p-0 m-0 flex flex-col gap-1">
        {entries.map((entry, idx) => {
          const isDone = entry.status === 'completed';
          const isIndeterminate = entry.status === 'in_progress';
          return (
            <li
              key={idx}
              className={[
                'Hr flex items-start gap-2 p-0 rounded text-[var(--app-primary-foreground)]',
                isDone ? 'fo opacity-70' : '',
              ].join(' ')}
            >
              <label className="flex items-start gap-2">
                <CheckboxDisplay
                  checked={isDone}
                  indeterminate={isIndeterminate}
                />
              </label>

              <div
                className={[
                  'vo flex-1 text-xs leading-[1.5] text-[var(--app-primary-foreground)]',
                  isDone
                    ? 'line-through text-[var(--app-secondary-foreground)] opacity-70'
                    : 'opacity-85',
                ].join(' ')}
              >
                {entry.content}
              </div>
            </li>
          );
        })}
      </ul>
    </ToolCallContainer>
  );
};
