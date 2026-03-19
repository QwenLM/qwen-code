/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Think tool call component - specialized for thinking/reasoning operations
 */

import type { FC } from 'react';
import {
  ToolCallContainer,
  ToolCallCard,
  ToolCallRow,
  groupContent,
} from './shared/index.js';
import type { BaseToolCallProps } from './shared/index.js';

/**
 * Specialized component for Think tool calls
 * Optimized for displaying AI reasoning and thought processes
 * Minimal display: just show the thoughts (no context)
 */
export const ThinkToolCall: FC<BaseToolCallProps> = ({
  toolCall,
  isFirst,
  isLast,
}) => {
  const { content } = toolCall;

  // Group content by type
  const { textOutputs, errors } = groupContent(content);

  // Error case (rare for thinking)
  if (errors.length > 0) {
    return (
      <ToolCallContainer
        label="Think"
        status="error"
        isFirst={isFirst}
        isLast={isLast}
      >
        {errors.join('\n')}
      </ToolCallContainer>
    );
  }

  // Show thoughts - use card for long content, compact for short
  if (textOutputs.length > 0) {
    const thoughts = textOutputs.join('\n\n');
    const isLong = thoughts.length > 200;

    if (isLong) {
      const truncatedThoughts =
        thoughts.length > 500 ? thoughts.substring(0, 500) + '...' : thoughts;

      return (
        <ToolCallCard icon="💭">
          <ToolCallRow label="Think">
            <div className="italic opacity-90 leading-relaxed">
              {truncatedThoughts}
            </div>
          </ToolCallRow>
        </ToolCallCard>
      );
    }

    // Short thoughts - compact format
    const status =
      toolCall.status === 'pending' || toolCall.status === 'in_progress'
        ? 'loading'
        : 'default';
    return (
      <ToolCallContainer
        label="Think"
        status={status}
        isFirst={isFirst}
        isLast={isLast}
      >
        <span className="italic opacity-90">{thoughts}</span>
      </ToolCallContainer>
    );
  }

  // Empty thoughts
  return null;
};
