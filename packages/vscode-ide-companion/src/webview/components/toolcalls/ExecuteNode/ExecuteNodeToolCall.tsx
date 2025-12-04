/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * ExecuteNode tool call component - specialized for node/npm execution operations
 */

import type React from 'react';
import type { BaseToolCallProps } from '../shared/types.js';
import { ToolCallContainer } from '../shared/LayoutComponents.js';
import { safeTitle, groupContent } from '../shared/utils.js';
import './ExecuteNode.css';

/**
 * Specialized component for ExecuteNode tool calls
 * Shows: Execute bullet + description + branch connector
 */
export const ExecuteNodeToolCall: React.FC<BaseToolCallProps> = ({
  toolCall,
}) => {
  const { title, content, rawInput, toolCallId } = toolCall;
  const commandText = safeTitle(title);

  // Group content by type
  const { textOutputs, errors } = groupContent(content);

  // Extract command from rawInput if available
  let _inputCommand = commandText;
  if (rawInput && typeof rawInput === 'object') {
    const inputObj = rawInput as { command?: string };
    _inputCommand = inputObj.command || commandText;
  } else if (typeof rawInput === 'string') {
    _inputCommand = rawInput;
  }

  // Error case
  if (errors.length > 0) {
    return (
      <ToolCallContainer
        label="Execute"
        status="error"
        toolCallId={toolCallId}
        className="execute-toolcall"
      >
        {/* Branch connector summary (Claude-like) */}
        <div className="inline-flex text-[var(--app-secondary-foreground)] text-[0.85em] opacity-70 mt-[2px] mb-[2px] flex-row items-start w-full gap-1">
          <span className="flex-shrink-0 relative top-[-0.1em]">⎿</span>
          <span className="flex-shrink-0 w-full">{commandText}</span>
        </div>
        {/* Error content */}
        <div className="execute-node-error-content">
          <pre className="execute-node-pre execute-node-error-pre">
            {errors.join('\n')}
          </pre>
        </div>
      </ToolCallContainer>
    );
  }

  // Success case: show command with branch connector (similar to the example)
  return (
    <ToolCallContainer label="Execute" status="success" toolCallId={toolCallId}>
      <div className="inline-flex text-[var(--app-secondary-foreground)] text-[0.85em] opacity-70 mt-[2px] mb-[2px] flex-row items-start w-full gap-1">
        <span className="flex-shrink-0 relative top-[-0.1em]">⎿</span>
        <span className="flex-shrink-0 w-full">{commandText}</span>
      </div>
      {textOutputs.length > 0 && (
        <div className="execute-node-output-content">
          <pre className="execute-node-pre">{textOutputs.join('\n')}</pre>
        </div>
      )}
    </ToolCallContainer>
  );
};
