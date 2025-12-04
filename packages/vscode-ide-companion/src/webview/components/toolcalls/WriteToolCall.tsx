/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Write tool call component - specialized for file writing operations
 */

import type React from 'react';
import type { BaseToolCallProps } from './shared/types.js';
import { ToolCallContainer } from './shared/LayoutComponents.js';
import { groupContent } from './shared/utils.js';
import { FileLink } from '../ui/FileLink.js';

/**
 * Specialized component for Write tool calls
 * Shows: Write filename + error message + content preview
 */
export const WriteToolCall: React.FC<BaseToolCallProps> = ({ toolCall }) => {
  const { content, locations, rawInput, toolCallId } = toolCall;

  // Group content by type
  const { errors, textOutputs } = groupContent(content);

  // Extract filename from path
  // const getFileName = (path: string): string => path.split('/').pop() || path;

  // Extract content to write from rawInput
  let writeContent = '';
  if (rawInput && typeof rawInput === 'object') {
    const inputObj = rawInput as { content?: string };
    writeContent = inputObj.content || '';
  } else if (typeof rawInput === 'string') {
    writeContent = rawInput;
  }

  // Error case: show filename + error message + content preview
  if (errors.length > 0) {
    const path = locations?.[0]?.path || '';
    const errorMessage = errors.join('\n');

    // Truncate content preview
    const truncatedContent =
      writeContent.length > 200
        ? writeContent.substring(0, 200) + '...'
        : writeContent;

    return (
      <ToolCallContainer
        label={'Write'}
        status="error"
        toolCallId={toolCallId}
        labelSuffix={
          path ? (
            <FileLink
              path={path}
              showFullPath={false}
              className="text-xs font-mono text-[var(--app-secondary-foreground)] hover:underline"
            />
          ) : undefined
        }
      >
        <div className="inline-flex text-[var(--app-secondary-foreground)] text-[0.85em] opacity-70 mt-[2px] mb-[2px] flex-row items-start w-full gap-1">
          <span className="flex-shrink-0 relative top-[-0.1em]">⎿</span>
          <span className="flex-shrink-0 w-full">{errorMessage}</span>
        </div>
        {truncatedContent && (
          <div className="bg-[var(--app-input-background)] border border-[var(--app-input-border)] rounded-md p-3 mt-1">
            <pre className="font-mono text-[13px] whitespace-pre-wrap break-words text-[var(--app-primary-foreground)] opacity-90">
              {truncatedContent}
            </pre>
          </div>
        )}
      </ToolCallContainer>
    );
  }

  // Success case: show filename + line count
  if (locations && locations.length > 0) {
    const path = locations[0].path;
    const lineCount = writeContent.split('\n').length;
    return (
      <ToolCallContainer
        label={'Created'}
        status="success"
        toolCallId={toolCallId}
        labelSuffix={
          path ? (
            <FileLink
              path={path}
              showFullPath={false}
              className="text-xs font-mono text-[var(--app-secondary-foreground)] hover:underline"
            />
          ) : undefined
        }
      >
        <div className="inline-flex text-[var(--app-secondary-foreground)] text-[0.85em] opacity-70 flex-row items-start w-full gap-1">
          <span className="flex-shrink-0 relative top-[-0.1em]">⎿</span>
          <span className="flex-shrink-0 w-full">{lineCount} lines</span>
        </div>
      </ToolCallContainer>
    );
  }

  // Fallback: show generic success
  if (textOutputs.length > 0) {
    return (
      <ToolCallContainer label="Write" status="success" toolCallId={toolCallId}>
        {textOutputs.join('\n')}
      </ToolCallContainer>
    );
  }

  // No output, don't show anything
  return null;
};
