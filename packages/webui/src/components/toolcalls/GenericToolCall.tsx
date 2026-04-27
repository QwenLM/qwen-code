/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Generic tool call component - handles all tool call types as fallback
 */

import { useState, type FC } from 'react';
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
import { MarkdownRenderer } from '../messages/MarkdownRenderer/MarkdownRenderer.js';

const COLLAPSED_HEIGHT = 200;
const EXPAND_THRESHOLD = 400;

const CollapsibleOutput: FC<{ content: string }> = ({ content }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const isLongContent = content.length > EXPAND_THRESHOLD;

  return (
    <div className="flex flex-col gap-[3px]">
      <div
        className="text-[13px] opacity-90 overflow-hidden"
        style={
          !isExpanded && isLongContent
            ? {
                maxHeight: `${COLLAPSED_HEIGHT}px`,
                maskImage: `linear-gradient(to bottom, var(--app-primary-background) 140px, transparent ${COLLAPSED_HEIGHT}px)`,
                WebkitMaskImage: `linear-gradient(to bottom, var(--app-primary-background) 140px, transparent ${COLLAPSED_HEIGHT}px)`,
              }
            : undefined
        }
      >
        <MarkdownRenderer content={content} enableFileLinks={false} />
      </div>
      {isLongContent && (
        <div className="flex justify-center border-t border-[var(--app-input-border)] pt-1">
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-[var(--app-secondary-foreground)] text-[0.8em] hover:text-[var(--app-primary-foreground)] cursor-pointer bg-transparent border-none px-2 py-1 rounded hover:bg-[var(--app-input-background)] transition-colors"
          >
            {isExpanded ? '▲ Collapse' : '▼ Show more'}
          </button>
        </div>
      )}
    </div>
  );
};

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
      return (
        <ToolCallCard icon="🔧">
          <ToolCallRow label={displayLabel}>
            <div>{operationText}</div>
          </ToolCallRow>
          <ToolCallRow label="Output">
            <CollapsibleOutput content={output} />
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
