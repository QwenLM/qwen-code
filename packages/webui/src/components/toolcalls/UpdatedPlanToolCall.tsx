/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * UpdatedPlan tool call component - specialized for plan update operations
 */

import type { FC } from 'react';
import { groupContent, safeTitle } from './shared/index.js';
import type {
  BaseToolCallProps,
  ToolCallContainerProps,
  ToolCallStatus,
  PlanEntry,
  PlanEntryStatus,
} from './shared/index.js';
import { CheckboxDisplay } from './CheckboxDisplay.js';

/**
 * Custom container for UpdatedPlanToolCall with specific styling
 */
const PlanToolCallContainer: FC<ToolCallContainerProps> = ({
  label,
  status = 'success',
  children,
  toolCallId: _toolCallId,
  labelSuffix,
  className: _className,
  isFirst = false,
  isLast = false,
}) => (
  <div
    className={`qwen-message message-item ${_className || ''} relative pl-[30px] py-2 select-text toolcall-container toolcall-status-${status}`}
    data-first={isFirst}
    data-last={isLast}
  >
    <div className="UpdatedPlanToolCall toolcall-content-wrapper flex flex-col gap-2 min-w-0 max-w-full">
      <div className="flex items-baseline gap-1 relative min-w-0">
        <span className="text-[14px] leading-none font-bold text-[var(--app-primary-foreground)]">
          {label}
        </span>
        <span className="text-[11px] text-[var(--app-secondary-foreground)]">
          {labelSuffix}
        </span>
      </div>
      {children && (
        <div className="text-[var(--app-secondary-foreground)] py-1">
          {children}
        </div>
      )}
    </div>
  </div>
);

/**
 * Map tool status to bullet status
 */
const mapToolStatusToBullet = (
  status: ToolCallStatus,
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

/**
 * Parse plan entries with - [ ] / - [x] from text
 */
const parsePlanEntries = (textOutputs: string[]): PlanEntry[] => {
  const text = textOutputs.join('\n');
  const lines = text.split(/\r?\n/);
  const entries: PlanEntry[] = [];

  // Accept [ ], [x]/[X] and in-progress markers [-] or [*]
  const todoRe =
    /^(?:\s{0,10}(?:[-*]|\d{1,3}[.)])\s{0,10})?\[( |x|X|-|\*)\]\s+(.{0,500})$/;
  for (const line of lines) {
    const m = line.match(todoRe);
    if (m) {
      const mark = m[1];
      const title = m[2].trim();
      const status: PlanEntryStatus =
        mark === 'x' || mark === 'X'
          ? 'completed'
          : mark === '-' || mark === '*'
            ? 'in_progress'
            : 'pending';
      if (title) {
        entries.push({ content: title, status });
      }
    }
  }

  // Fallback: treat non-empty lines as pending items
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
export const UpdatedPlanToolCall: FC<BaseToolCallProps> = ({
  toolCall,
  isFirst,
  isLast,
}) => {
  const { content, status } = toolCall;
  const { errors, textOutputs } = groupContent(content);

  // Error-first display
  if (errors.length > 0) {
    return (
      <PlanToolCallContainer
        label="TodoWrite"
        status="error"
        isFirst={isFirst}
        isLast={isLast}
      >
        {errors.join('\n')}
      </PlanToolCallContainer>
    );
  }

  const entries = parsePlanEntries(textOutputs);
  const label = safeTitle(toolCall.title) || 'TodoWrite';

  return (
    <PlanToolCallContainer
      label={label}
      status={mapToolStatusToBullet(status)}
      className="update-plan-toolcall"
      isFirst={isFirst}
      isLast={isLast}
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
    </PlanToolCallContainer>
  );
};
