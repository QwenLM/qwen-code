/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Search tool call component - specialized for search operations
 */

import { useState, type FC } from 'react';
import {
  safeTitle,
  groupContent,
  mapToolStatusToContainerStatus,
  ToolCallContainer,
} from './shared/index.js';
import type { BaseToolCallProps, ContainerStatus } from './shared/index.js';
import { FileLink } from '../layout/FileLink.js';

/**
 * Collapsible output component for search results
 * Shows a summary line that can be expanded to show full content
 */
const CollapsibleOutput: FC<{
  /** Summary text to show when collapsed (e.g., "21 lines of output") */
  summary: string;
  /** Content to show when expanded */
  children: React.ReactNode;
  /** Whether to start expanded (default: false) */
  defaultExpanded?: boolean;
}> = ({ summary, children, defaultExpanded = false }) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  return (
    <div className="flex flex-col">
      <div
        className="inline-flex text-[var(--app-secondary-foreground)] text-[0.85em] opacity-70 mt-[2px] mb-[2px] flex-row items-start w-full gap-1 cursor-pointer hover:opacity-100 transition-opacity"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span className="flex-shrink-0 relative top-[-0.1em]">⎿</span>
        <span className="flex-shrink-0">{summary}</span>
      </div>
      {isExpanded && (
        <div className="ml-4 mt-1 text-[var(--app-secondary-foreground)] text-[0.85em]">
          {children}
        </div>
      )}
    </div>
  );
};

/**
 * Row component for search card layout
 */
const SearchRow: FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div className="grid grid-cols-[80px_1fr] gap-medium min-w-0">
    <div className="text-xs text-[var(--app-secondary-foreground)] font-medium pt-[2px]">
      {label}
    </div>
    <div className="text-[var(--app-primary-foreground)] min-w-0 break-words">
      {children}
    </div>
  </div>
);

/**
 * Card content wrapper for search results
 */
const SearchCardContent: FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="bg-[var(--app-input-background)] border border-[var(--app-input-border)] rounded-md p-3 mt-1">
    <div className="flex flex-col gap-3 min-w-0">{children}</div>
  </div>
);

/**
 * Local locations list component
 */
const LocationsListLocal: FC<{
  locations: Array<{ path: string; line?: number | null }>;
}> = ({ locations }) => (
  <div className="flex flex-col gap-1 max-w-full">
    {locations.map((loc, idx) => (
      <FileLink key={idx} path={loc.path} line={loc.line} showFullPath={true} />
    ))}
  </div>
);

/**
 * Map tool call kind to appropriate display name
 */
const getDisplayLabel = (kind: string): string => {
  const normalizedKind = kind.toLowerCase();
  if (normalizedKind === 'grep' || normalizedKind === 'grep_search') {
    return 'Grep';
  } else if (normalizedKind === 'glob') {
    return 'Glob';
  } else if (normalizedKind === 'web_search') {
    return 'WebSearch';
  } else {
    return 'Search';
  }
};

/**
 * Specialized component for Search tool calls
 * Optimized for displaying search operations and results
 */
export const SearchToolCall: FC<BaseToolCallProps> = ({
  toolCall,
  isFirst,
  isLast,
}) => {
  const { kind, title, content, locations } = toolCall;
  const queryText = safeTitle(title);
  const displayLabel = getDisplayLabel(kind);
  const containerStatus: ContainerStatus = mapToolStatusToContainerStatus(
    toolCall.status,
  );

  // Group content by type
  const { errors, textOutputs } = groupContent(content);

  // Error case: show search query + error in card layout
  if (errors.length > 0) {
    return (
      <ToolCallContainer
        label={displayLabel}
        labelSuffix={queryText}
        status="error"
        isFirst={isFirst}
        isLast={isLast}
      >
        <SearchCardContent>
          <SearchRow label="Query">
            <div className="font-mono">{queryText}</div>
          </SearchRow>
          <SearchRow label="Error">
            <div className="text-[#c74e39] font-medium">
              {errors.join('\n')}
            </div>
          </SearchRow>
        </SearchCardContent>
      </ToolCallContainer>
    );
  }

  // Success case with results: show search query + file list
  if (locations && locations.length > 0) {
    // Use collapsible output for multiple results
    const summaryText = `${locations.length} ${locations.length === 1 ? 'file' : 'files'} found`;
    return (
      <ToolCallContainer
        label={displayLabel}
        labelSuffix={queryText}
        status={containerStatus}
        isFirst={isFirst}
        isLast={isLast}
      >
        <CollapsibleOutput summary={summaryText}>
          <LocationsListLocal locations={locations} />
        </CollapsibleOutput>
      </ToolCallContainer>
    );
  }

  // Show content text if available (e.g., grep output with content)
  if (textOutputs.length > 0) {
    // Count total lines in output
    const totalLines = textOutputs.reduce(
      (acc, text) => acc + text.split('\n').length,
      0,
    );
    const summaryText = `${totalLines} ${totalLines === 1 ? 'line' : 'lines'} of output`;

    return (
      <ToolCallContainer
        label={displayLabel}
        labelSuffix={queryText || undefined}
        status={containerStatus}
        isFirst={isFirst}
        isLast={isLast}
      >
        <CollapsibleOutput summary={summaryText}>
          <div className="flex flex-col gap-1 font-mono text-[0.85em] whitespace-pre-wrap break-all">
            {textOutputs.map((text: string, index: number) => (
              <div key={index}>{text}</div>
            ))}
          </div>
        </CollapsibleOutput>
      </ToolCallContainer>
    );
  }

  // No results - show query only
  if (queryText) {
    return (
      <ToolCallContainer
        label={displayLabel}
        labelSuffix={queryText}
        status={containerStatus}
        isFirst={isFirst}
        isLast={isLast}
      />
    );
  }

  return null;
};
