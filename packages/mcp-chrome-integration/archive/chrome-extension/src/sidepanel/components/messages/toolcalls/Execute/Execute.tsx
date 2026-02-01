/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Execute tool call component - specialized for command execution operations
 */

import type React from 'react';
import type { BaseToolCallProps } from '../shared/types.js';
import { safeTitle, groupContent } from '../shared/utils.js';
import './Execute.css';
import type { ToolCallContainerProps } from '../shared/LayoutComponents.js';

export const ToolCallContainer: React.FC<ToolCallContainerProps> = ({
  label,
  status = 'success',
  children,
  toolCallId: _toolCallId,
  labelSuffix,
  className: _className,
}) => (
  <div
    className={`ExecuteToolCall qwen-message message-item ${_className || ''} relative pl-[30px] py-2 select-text toolcall-container toolcall-status-${status}`}
  >
    <div className="toolcall-content-wrapper flex flex-col gap-0 min-w-0 max-w-full">
      <div className="flex items-baseline gap-1.5 relative min-w-0">
        <span className="text-[14px] leading-none font-bold text-[var(--app-primary-foreground)]">
          {label}
        </span>
        <span className="text-[11px] text-[var(--app-secondary-foreground)]">
          {labelSuffix}
        </span>
      </div>
      {children && (
        <div className="text-[var(--app-secondary-foreground)]">{children}</div>
      )}
    </div>
  </div>
);

/**
 * Specialized component for Execute tool calls
 * Shows: Execute bullet + description + IN/OUT card
 */
export const ExecuteToolCall: React.FC<BaseToolCallProps> = ({ toolCall }) => {
  const { title, content, rawInput, toolCallId } = toolCall;
  const commandText = safeTitle(
    (rawInput as Record<string, unknown>)?.description || title,
  );

  // Group content by type
  const { textOutputs, errors } = groupContent(content);

  // Extract command from rawInput if available
  let inputCommand = commandText;
  if (rawInput && typeof rawInput === 'object') {
    const inputObj = rawInput as Record<string, unknown>;
    inputCommand = (inputObj.command as string | undefined) || commandText;
  } else if (typeof rawInput === 'string') {
    inputCommand = rawInput;
  }

  // Map tool status to container status for proper bullet coloring
  const containerStatus:
    | 'success'
    | 'error'
    | 'warning'
    | 'loading'
    | 'default' =
    errors.length > 0 || toolCall.status === 'failed'
      ? 'error'
      : toolCall.status === 'in_progress' || toolCall.status === 'pending'
        ? 'loading'
        : 'success';

  // Error case
  if (errors.length > 0) {
    return (
      <ToolCallContainer
        label="Execute"
        status={containerStatus}
        toolCallId={toolCallId}
        className="execute-default-toolcall"
      >
        {/* Branch connector summary */}
        <div className="inline-flex text-[var(--app-secondary-foreground)] text-[0.85em] opacity-70 mt-[2px] mb-[2px] flex-row items-start w-full gap-1">
          <span className="flex-shrink-0 relative top-[-0.1em]">⎿</span>
          <span className="flex-shrink-0 w-full">{commandText}</span>
        </div>
        {/* Error card - semantic DOM + Tailwind styles */}
        <div className="execute-toolcall-card">
          <div className="execute-toolcall-content">
            {/* IN row */}
            <div className="execute-toolcall-row">
              <div className="execute-toolcall-label">IN</div>
              <div className="execute-toolcall-row-content">
                <pre className="execute-toolcall-pre">{inputCommand}</pre>
              </div>
            </div>

            {/* ERROR row */}
            <div className="execute-toolcall-row">
              <div className="execute-toolcall-label">Error</div>
              <div className="execute-toolcall-row-content">
                <pre className="execute-toolcall-pre execute-toolcall-error-content">
                  {errors.join('\n')}
                </pre>
              </div>
            </div>
          </div>
        </div>
      </ToolCallContainer>
    );
  }

  // Success with output
  if (textOutputs.length > 0) {
    const output = textOutputs.join('\n');
    const truncatedOutput =
      output.length > 500 ? output.substring(0, 500) + '...' : output;

    return (
      <ToolCallContainer
        label="Execute"
        status={containerStatus}
        toolCallId={toolCallId}
      >
        {/* Branch connector summary */}
        <div className="inline-flex text-[var(--app-secondary-foreground)] text-[0.85em] opacity-70 mt-[2px] mb-[2px] flex-row items-start w-full gap-1">
          <span className="flex-shrink-0 relative top-[-0.1em]">⎿</span>
          <span className="flex-shrink-0 w-full">{commandText}</span>
        </div>
        {/* Output card - semantic DOM + Tailwind styles */}
        <div className="execute-toolcall-card">
          <div className="execute-toolcall-content">
            {/* IN row */}
            <div className="execute-toolcall-row">
              <div className="execute-toolcall-label">IN</div>
              <div className="execute-toolcall-row-content">
                <pre className="execute-toolcall-pre">{inputCommand}</pre>
              </div>
            </div>

            {/* OUT row */}
            <div className="execute-toolcall-row">
              <div className="execute-toolcall-label">OUT</div>
              <div className="execute-toolcall-row-content">
                <div className="execute-toolcall-output-subtle">
                  <pre className="execute-toolcall-pre">{truncatedOutput}</pre>
                </div>
              </div>
            </div>
          </div>
        </div>
      </ToolCallContainer>
    );
  }

  // Success without output: show command with branch connector
  return (
    <ToolCallContainer
      label="Execute"
      status={containerStatus}
      toolCallId={toolCallId}
    >
      <div className="inline-flex text-[var(--app-secondary-foreground)] text-[0.85em] opacity-70 mt-[2px] mb-[2px] flex-row items-start w-full gap-1">
        <span className="flex-shrink-0 relative top-[-0.1em]">⎿</span>
        <span className="flex-shrink-0 w-full">{commandText}</span>
      </div>
    </ToolCallContainer>
  );
};
