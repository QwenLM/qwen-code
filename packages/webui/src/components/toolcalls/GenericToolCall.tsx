/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Generic tool call component - handles all tool call types as fallback
 */

import type { FC } from 'react';
import {
  ToolCallContainer,
  ToolCallCard,
  ToolCallRow,
  LocationsList,
  safeTitle,
  groupContent,
} from './shared/index.js';
import type { BaseToolCallProps } from './shared/index.js';
import { getToolDisplayLabel } from './labelUtils.js';

/**
 * Generic tool call component that can display any tool call type
 * Used as fallback for unknown tool call kinds
 * Minimal display: show description and outcome
 */
export const GenericToolCall: FC<BaseToolCallProps> = ({
  toolCall,
  isFirst,
  isLast,
}) => {
  const { kind, title, content, locations, toolCallId } = toolCall;
  const operationText = safeTitle(title);
  const displayLabel = getToolDisplayLabel({ kind, title });

  // Group content by type
  const { textOutputs, errors } = groupContent(content);

  // Error case: show operation + error in card layout
  if (errors.length > 0) {
    return (
      <ToolCallCard icon="🔧">
        <ToolCallRow label={displayLabel}>
          <div>{operationText}</div>
        </ToolCallRow>
        <ToolCallRow label="Error">
          <div className="text-[#c74e39] font-medium">{errors.join('\n')}</div>
        </ToolCallRow>
      </ToolCallCard>
    );
  }

  // Success with output: use card for long output, compact for short
  if (textOutputs.length > 0) {
    const output = textOutputs.join('\n');
    const isLong = output.length > 150;

    if (isLong) {
      const truncatedOutput =
        output.length > 300 ? output.substring(0, 300) + '...' : output;

      return (
        <ToolCallCard icon="🔧">
          <ToolCallRow label={displayLabel}>
            <div>{operationText}</div>
          </ToolCallRow>
          <ToolCallRow label="Output">
            <div className="whitespace-pre-wrap font-mono text-[13px] opacity-90">
              {truncatedOutput}
            </div>
          </ToolCallRow>
        </ToolCallCard>
      );
    }

    // Short output - compact format
    const statusFlag: 'success' | 'error' | 'warning' | 'loading' | 'default' =
      toolCall.status === 'in_progress' || toolCall.status === 'pending'
        ? 'loading'
        : 'success';
    return (
      <ToolCallContainer
        label={displayLabel}
        status={statusFlag}
        toolCallId={toolCallId}
        isFirst={isFirst}
        isLast={isLast}
      >
        {operationText || output}
      </ToolCallContainer>
    );
  }

  // Success with files: show operation + file list in compact format
  if (locations && locations.length > 0) {
    const statusFlag: 'success' | 'error' | 'warning' | 'loading' | 'default' =
      toolCall.status === 'in_progress' || toolCall.status === 'pending'
        ? 'loading'
        : 'success';
    return (
      <ToolCallContainer
        label={displayLabel}
        status={statusFlag}
        toolCallId={toolCallId}
        isFirst={isFirst}
        isLast={isLast}
      >
        <LocationsList locations={locations} />
      </ToolCallContainer>
    );
  }

  // No output - show just the operation
  if (operationText) {
    const statusFlag: 'success' | 'error' | 'warning' | 'loading' | 'default' =
      toolCall.status === 'in_progress' || toolCall.status === 'pending'
        ? 'loading'
        : 'success';
    return (
      <ToolCallContainer
        label={displayLabel}
        status={statusFlag}
        toolCallId={toolCallId}
        isFirst={isFirst}
        isLast={isLast}
      >
        {operationText}
      </ToolCallContainer>
    );
  }

  return null;
};
