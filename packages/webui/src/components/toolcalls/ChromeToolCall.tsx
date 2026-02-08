/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Chrome MCP tool call component - compact Bash-like display
 */

import type { FC } from 'react';
import { ToolCallContainer, safeTitle, groupContent } from './shared/index.js';
import type { BaseToolCallProps } from './shared/index.js';

/**
 * Chrome tool call component - displays Chrome MCP tools in compact format
 * Similar to Bash tool display: tool name + description
 */
export const ChromeToolCall: FC<BaseToolCallProps> = ({
  toolCall,
  isFirst,
  isLast,
}) => {
  const { kind, title, content, toolCallId, rawInput } = toolCall;

  // Extract tool name from rawInput or kind
  const getToolName = (): string => {
    if (rawInput && typeof rawInput === 'object') {
      const toolName = (rawInput as Record<string, unknown>).name;
      if (typeof toolName === 'string') {
        return toolName;
      }
    }
    return kind;
  };

  const toolName = getToolName();
  const operationText = safeTitle(title);

  // Group content by type
  const { textOutputs, errors } = groupContent(content);

  // Map tool status to container status
  const containerStatus:
    | 'success'
    | 'error'
    | 'warning'
    | 'loading'
    | 'default' =
    errors.length > 0
      ? 'error'
      : toolCall.status === 'in_progress' || toolCall.status === 'pending'
        ? 'loading'
        : 'success';

  // Format tool name for display (chrome_read_page -> chrome_read_page)
  const displayLabel = toolName;

  // Success without output or with short output - compact format like Bash
  if (errors.length === 0) {
    const output = textOutputs.join('\n');
    const displayText = operationText || output;
    const truncatedText =
      displayText.length > 100
        ? displayText.substring(0, 100) + '...'
        : displayText;

    return (
      <ToolCallContainer
        label={displayLabel}
        status={containerStatus}
        toolCallId={toolCallId}
        isFirst={isFirst}
        isLast={isLast}
      >
        <div className="inline-flex text-[var(--app-secondary-foreground)] text-[0.85em] opacity-70 mt-[2px] mb-[2px] flex-row items-start w-full gap-1">
          <span className="flex-shrink-0 relative top-[-0.1em]">⎿</span>
          <span className="flex-shrink-0 w-full">{truncatedText}</span>
        </div>
      </ToolCallContainer>
    );
  }

  // Error case - show error in compact format
  return (
    <ToolCallContainer
      label={displayLabel}
      status={containerStatus}
      toolCallId={toolCallId}
      isFirst={isFirst}
      isLast={isLast}
    >
      <div className="inline-flex text-[var(--app-secondary-foreground)] text-[0.85em] opacity-70 mt-[2px] mb-[2px] flex-row items-start w-full gap-1">
        <span className="flex-shrink-0 relative top-[-0.1em]">⎿</span>
        <span className="flex-shrink-0 w-full">{operationText}</span>
      </div>
      <div className="text-[#c74e39] text-[0.85em] mt-1 ml-4">
        {errors.join('\n')}
      </div>
    </ToolCallContainer>
  );
};
