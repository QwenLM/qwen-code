/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Execute tool call component - specialized for command execution operations
 */

import type React from 'react';
import type { BaseToolCallProps } from '../shared/types.js';
import { ToolCallContainer } from '../shared/LayoutComponents.js';
import { safeTitle, groupContent } from '../../../../utils/utils.js';
import { useVSCode } from '../../../../hooks/useVSCode.js';
import { createAndOpenTempFile } from '../../../../utils/diffUtils.js';
import { CopyButton } from '../shared/copyUtils.js';
import './Bash.css';

/**
 * Specialized component for Execute/Bash tool calls
 * Shows: Bash bullet + description + IN/OUT card
 */
export const ExecuteToolCall: React.FC<BaseToolCallProps> = ({ toolCall }) => {
  const { title, content, rawInput, toolCallId } = toolCall;
  const commandText = safeTitle(title);
  const vscode = useVSCode();

  // Group content by type
  const { textOutputs, errors } = groupContent(content);

  // Extract command from rawInput if available
  let inputCommand = commandText;
  if (rawInput && typeof rawInput === 'object') {
    const inputObj = rawInput as { command?: string };
    inputCommand = inputObj.command || commandText;
  } else if (typeof rawInput === 'string') {
    inputCommand = rawInput;
  }

  // Handle click on IN section
  const handleInClick = () => {
    createAndOpenTempFile(vscode, inputCommand, `bash-input-${toolCallId}`);
  };

  // Handle click on OUT section
  const handleOutClick = () => {
    if (textOutputs.length > 0) {
      const output = textOutputs.join('\n');
      createAndOpenTempFile(vscode, output, `bash-output-${toolCallId}`);
    }
  };

  // Map tool status to container status for proper bullet coloring
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

  // Error case
  if (errors.length > 0) {
    return (
      <ToolCallContainer
        label="Bash"
        status={containerStatus}
        toolCallId={toolCallId}
      >
        {/* Branch connector summary */}
        <div className="inline-flex text-[var(--app-secondary-foreground)] text-[0.85em] opacity-70 mt-[2px] mb-[2px] flex-row items-start w-full gap-1">
          <span className="flex-shrink-0 relative top-[-0.1em]">⎿</span>
          <span className="flex-shrink-0 w-full">{commandText}</span>
        </div>
        {/* Error card - semantic DOM + Tailwind styles */}
        <div className="bash-toolcall-card">
          <div className="bash-toolcall-content">
            {/* IN row */}
            <div
              className="bash-toolcall-row bash-toolcall-row-with-copy group"
              onClick={handleInClick}
              style={{ cursor: 'pointer' }}
            >
              <div className="bash-toolcall-label">IN</div>
              <div className="bash-toolcall-row-content">
                <pre className="bash-toolcall-pre">{inputCommand}</pre>
              </div>
              <CopyButton text={inputCommand} />
            </div>

            {/* ERROR row */}
            <div className="bash-toolcall-row">
              <div className="bash-toolcall-label">Error</div>
              <div className="bash-toolcall-row-content">
                <pre className="bash-toolcall-pre bash-toolcall-error-content">
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
        label="Bash"
        status={containerStatus}
        toolCallId={toolCallId}
      >
        {/* Branch connector summary */}
        <div className="inline-flex text-[var(--app-secondary-foreground)] text-[0.85em] opacity-70 mt-[2px] mb-[2px] flex-row items-start w-full gap-1">
          <span className="flex-shrink-0 relative top-[-0.1em]">⎿</span>
          <span className="flex-shrink-0 w-full">{commandText}</span>
        </div>
        {/* Output card - semantic DOM + Tailwind styles */}
        <div className="bash-toolcall-card">
          <div className="bash-toolcall-content">
            {/* IN row */}
            <div
              className="bash-toolcall-row bash-toolcall-row-with-copy group"
              onClick={handleInClick}
              style={{ cursor: 'pointer' }}
            >
              <div className="bash-toolcall-label">IN</div>
              <div className="bash-toolcall-row-content">
                <pre className="bash-toolcall-pre">{inputCommand}</pre>
              </div>
              <CopyButton text={inputCommand} />
            </div>

            {/* OUT row */}
            <div
              className="bash-toolcall-row"
              onClick={handleOutClick}
              style={{ cursor: 'pointer' }}
            >
              <div className="bash-toolcall-label">OUT</div>
              <div className="bash-toolcall-row-content">
                <div className="bash-toolcall-output-subtle">
                  <pre className="bash-toolcall-pre">{truncatedOutput}</pre>
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
      label="Bash"
      status={containerStatus}
      toolCallId={toolCallId}
    >
      <div
        className="inline-flex text-[var(--app-secondary-foreground)] text-[0.85em] opacity-70 mt-[2px] mb-[2px] flex-row items-start w-full gap-1"
        onClick={handleInClick}
        style={{ cursor: 'pointer' }}
      >
        <span className="flex-shrink-0 relative top-[-0.1em]">⎿</span>
        <span className="flex-shrink-0 w-full">{commandText}</span>
      </div>
    </ToolCallContainer>
  );
};
