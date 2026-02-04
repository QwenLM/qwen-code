/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * SaveMemory tool call component - displays saved memory content
 */

import { useState, type FC } from 'react';
import { ToolCallContainer, CopyButton, groupContent } from './shared/index.js';
import type { BaseToolCallProps } from './shared/index.js';

/** Threshold for showing expand/collapse toggle */
const EXPAND_THRESHOLD = 300;

/**
 * SaveMemory tool call component
 * Displays saved memory content in a card format similar to Bash tool
 */
export const SaveMemoryToolCall: FC<BaseToolCallProps> = ({
  toolCall,
  isFirst,
  isLast,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const { content } = toolCall;

  // Group content by type
  const { textOutputs, errors } = groupContent(content);

  // Determine container status
  const containerStatus =
    errors.length > 0
      ? 'error'
      : toolCall.status === 'pending' || toolCall.status === 'in_progress'
        ? 'loading'
        : 'success';

  // Error case
  if (errors.length > 0) {
    return (
      <ToolCallContainer
        label="SaveMemory"
        status="error"
        isFirst={isFirst}
        isLast={isLast}
      >
        <div className="border border-[var(--app-input-border)] rounded-[5px] bg-[var(--app-tool-background)] my-2 max-w-full">
          <div className="flex flex-col gap-[3px] p-1">
            <div className="grid grid-cols-[max-content_1fr] p-1">
              <div className="text-[var(--app-secondary-foreground)] text-left opacity-50 px-2 py-1 font-mono text-[0.85em]">
                Error
              </div>
              <div className="whitespace-pre-wrap break-words m-0 p-1">
                <pre className="m-0 font-mono text-[0.85em] text-[#c74e39]">
                  {errors.join('\n')}
                </pre>
              </div>
            </div>
          </div>
        </div>
      </ToolCallContainer>
    );
  }

  // No content case
  if (textOutputs.length === 0) {
    return null;
  }

  const memoryContent = textOutputs.join('\n\n');
  const isLongContent = memoryContent.length > EXPAND_THRESHOLD;

  return (
    <ToolCallContainer
      label="SaveMemory"
      status={containerStatus}
      isFirst={isFirst}
      isLast={isLast}
    >
      {/* Card container */}
      <div className="border border-[var(--app-input-border)] rounded-[5px] bg-[var(--app-tool-background)] my-2 max-w-full">
        <div className="flex flex-col gap-[3px] p-1">
          {/* Content row */}
          <div className="grid grid-cols-[max-content_1fr_max-content] p-1 group">
            <div className="text-[var(--app-secondary-foreground)] text-left opacity-50 px-2 py-1 font-mono text-[0.85em]">
              Memory
            </div>
            <div
              className={`whitespace-pre-wrap break-words m-0 p-1 ${
                !isExpanded && isLongContent
                  ? 'max-h-[80px] overflow-hidden'
                  : ''
              }`}
              style={
                !isExpanded && isLongContent
                  ? {
                      maskImage:
                        'linear-gradient(to bottom, var(--app-primary-background) 50px, transparent 80px)',
                    }
                  : undefined
              }
            >
              <pre className="m-0 font-mono text-[0.85em] leading-relaxed text-[var(--app-primary-foreground)] opacity-90 whitespace-pre-wrap">
                {memoryContent}
              </pre>
            </div>
            <CopyButton text={memoryContent} />
          </div>

          {/* Expand/Collapse toggle */}
          {isLongContent && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="flex items-center justify-center py-1 px-2 border-t border-[var(--app-input-border)] cursor-pointer text-[var(--app-secondary-foreground)] text-[0.75em] opacity-70 hover:opacity-100 hover:bg-[var(--app-code-background)] transition-opacity"
            >
              {isExpanded ? '▲ Collapse' : '▼ Show more'}
            </button>
          )}
        </div>
      </div>
    </ToolCallContainer>
  );
};
