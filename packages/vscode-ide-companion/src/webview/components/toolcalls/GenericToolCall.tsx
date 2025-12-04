/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Generic tool call component - handles all tool call types as fallback
 */

import type React from 'react';
import type { BaseToolCallProps } from './shared/types.js';
import {
  ToolCallContainer,
  ToolCallCard,
  ToolCallRow,
  LocationsList,
} from './shared/LayoutComponents.js';
import { DiffDisplay } from './shared/DiffDisplay.js';
import { safeTitle, groupContent } from './shared/utils.js';
import { useVSCode } from '../../hooks/useVSCode.js';

/**
 * Generic tool call component that can display any tool call type
 * Used as fallback for unknown tool call kinds
 * Minimal display: show description and outcome
 */
export const GenericToolCall: React.FC<BaseToolCallProps> = ({ toolCall }) => {
  const { kind, title, content, locations, toolCallId } = toolCall;
  const operationText = safeTitle(title);
  const vscode = useVSCode();

  // Group content by type
  const { textOutputs, errors, diffs } = groupContent(content);

  const handleOpenDiff = (
    path: string | undefined,
    oldText: string | null | undefined,
    newText: string | undefined,
  ) => {
    if (path) {
      vscode.postMessage({
        type: 'openDiff',
        data: { path, oldText: oldText || '', newText: newText || '' },
      });
    }
  };

  // Error case: show operation + error in card layout
  if (errors.length > 0) {
    return (
      <ToolCallCard icon="🔧">
        <ToolCallRow label={kind}>
          <div>{operationText}</div>
        </ToolCallRow>
        <ToolCallRow label="Error">
          <div className="text-[#c74e39] font-medium">{errors.join('\n')}</div>
        </ToolCallRow>
      </ToolCallCard>
    );
  }

  // Success with diff: show diff in card layout
  if (diffs.length > 0) {
    return (
      <ToolCallCard icon="🔧">
        {diffs.map(
          (item: import('./shared/types.js').ToolCallContent, idx: number) => (
            <div key={`diff-${idx}`} style={{ gridColumn: '1 / -1' }}>
              <DiffDisplay
                path={item.path}
                oldText={item.oldText}
                newText={item.newText}
                onOpenDiff={() =>
                  handleOpenDiff(item.path, item.oldText, item.newText)
                }
              />
            </div>
          ),
        )}
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
          <ToolCallRow label={kind}>
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
    return (
      <ToolCallContainer label={kind} status="success" toolCallId={toolCallId}>
        {operationText || output}
      </ToolCallContainer>
    );
  }

  // Success with files: show operation + file list in compact format
  if (locations && locations.length > 0) {
    return (
      <ToolCallContainer label={kind} status="success" toolCallId={toolCallId}>
        <LocationsList locations={locations} />
      </ToolCallContainer>
    );
  }

  // No output - show just the operation
  if (operationText) {
    return (
      <ToolCallContainer label={kind} status="success" toolCallId={toolCallId}>
        {operationText}
      </ToolCallContainer>
    );
  }

  return null;
};
