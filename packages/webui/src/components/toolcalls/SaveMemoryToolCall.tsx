/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * SaveMemory tool call component - displays saved memory content
 */

import type { FC } from 'react';
import {
  ToolCallContainer,
  groupContent,
  mapToolStatusToContainerStatus,
} from './shared/index.js';
import type { BaseToolCallProps } from './shared/index.js';

/**
 * SaveMemory tool call component
 * Displays saved memory content in a simple text format
 */
export const SaveMemoryToolCall: FC<BaseToolCallProps> = ({
  toolCall,
  isFirst,
  isLast,
}) => {
  const { content } = toolCall;

  // Group content by type
  const { textOutputs, errors } = groupContent(content);

  // Determine container status
  const containerStatus = mapToolStatusToContainerStatus(toolCall.status);

  // Error case
  if (errors.length > 0) {
    return (
      <ToolCallContainer
        label="SaveMemory"
        status="error"
        isFirst={isFirst}
        isLast={isLast}
      >
        <div className="text-[#c74e39] text-[var(--app-secondary-foreground)] py-0.5">
          {errors.join('\n')}
        </div>
      </ToolCallContainer>
    );
  }

  // No content case
  if (textOutputs.length === 0) {
    return null;
  }

  const memoryContent = textOutputs.join('\n\n');

  return (
    <ToolCallContainer
      label="SaveMemory"
      status={containerStatus}
      isFirst={isFirst}
      isLast={isLast}
    >
      <div className="text-[var(--app-secondary-foreground)] py-0.5 italic">
        {memoryContent}
      </div>
    </ToolCallContainer>
  );
};
