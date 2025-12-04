/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Search tool call component - specialized for search operations
 */

import type React from 'react';
import type { BaseToolCallProps } from './shared/types.js';
import {
  ToolCallContainer,
  ToolCallCard,
  ToolCallRow,
  LocationsList,
} from './shared/LayoutComponents.js';
import { safeTitle, groupContent } from './shared/utils.js';

/**
 * Specialized component for Search tool calls
 * Optimized for displaying search operations and results
 * Shows query + result count or file list
 */
export const SearchToolCall: React.FC<BaseToolCallProps> = ({ toolCall }) => {
  const { title, content, locations } = toolCall;
  const queryText = safeTitle(title);

  // Group content by type
  const { errors } = groupContent(content);

  // Error case: show search query + error in card layout
  if (errors.length > 0) {
    return (
      <ToolCallCard icon="🔍">
        <ToolCallRow label="Search">
          <div className="font-mono">{queryText}</div>
        </ToolCallRow>
        <ToolCallRow label="Error">
          <div className="text-[#c74e39] font-medium">{errors.join('\n')}</div>
        </ToolCallRow>
      </ToolCallCard>
    );
  }

  // Success case with results: show search query + file list
  if (locations && locations.length > 0) {
    // If multiple results, use card layout; otherwise use compact format
    if (locations.length > 1) {
      return (
        <ToolCallCard icon="🔍">
          <ToolCallRow label="Search">
            <div className="font-mono">{queryText}</div>
          </ToolCallRow>
          <ToolCallRow label={`Found (${locations.length})`}>
            <LocationsList locations={locations} />
          </ToolCallRow>
        </ToolCallCard>
      );
    }
    // Single result - compact format
    return (
      <ToolCallContainer label="Search" status="success">
        <span className="font-mono">{queryText}</span>
        <span className="mx-2 opacity-50">→</span>
        <LocationsList locations={locations} />
      </ToolCallContainer>
    );
  }

  // No results - show query only
  if (queryText) {
    return (
      <ToolCallContainer label="Search" status="success">
        <span className="font-mono">{queryText}</span>
      </ToolCallContainer>
    );
  }

  return null;
};
