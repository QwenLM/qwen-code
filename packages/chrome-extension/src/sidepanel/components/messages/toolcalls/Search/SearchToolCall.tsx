/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Search tool call component - specialized for search operations
 */

import type React from 'react';
import type { BaseToolCallProps } from '../shared/types.js';
import { FileLink } from '../../../layout/FileLink.js';
import {
  safeTitle,
  groupContent,
  mapToolStatusToContainerStatus,
} from '../shared/utils.js';

/**
 * Specialized component for Search tool calls
 * Optimized for displaying search operations and results
 * Shows query + result count or file list
 */
const InlineContainer: React.FC<{
  status: 'success' | 'error' | 'warning' | 'loading' | 'default';
  labelSuffix?: string;
  children?: React.ReactNode;
  isFirst?: boolean;
  isLast?: boolean;
}> = ({ status, labelSuffix, children, isFirst, isLast }) => {
  const beforeStatusClass = `toolcall-container toolcall-status-${status}`;
  const lineCropTop = isFirst ? 'top-[24px]' : 'top-0';
  const lineCropBottom = isLast
    ? 'bottom-auto h-[calc(100%-24px)]'
    : 'bottom-0';
  return (
    <div
      className={
        `qwen-message message-item relative pl-[30px] py-2 select-text ` +
        `before:absolute before:left-[8px] before:top-2 before:content-["\\25cf"] before:text-[10px] before:z-[1] ` +
        beforeStatusClass
      }
    >
      {/* timeline vertical line */}
      <div
        className={`absolute left-[12px] ${lineCropTop} ${lineCropBottom} w-px bg-[var(--app-primary-border-color)]`}
        aria-hidden
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-[14px] leading-none font-bold text-[var(--app-primary-foreground)]">
            Search
          </span>
          {labelSuffix ? (
            <span className="text-[11px] text-[var(--app-secondary-foreground)]">
              {labelSuffix}
            </span>
          ) : null}
        </div>
        {children ? (
          <div className="mt-1 text-[var(--app-secondary-foreground)]">
            {children}
          </div>
        ) : null}
      </div>
    </div>
  );
};

// Local card layout for multi-result or error display
const SearchCard: React.FC<{
  status: 'success' | 'error' | 'warning' | 'loading' | 'default';
  children: React.ReactNode;
  isFirst?: boolean;
  isLast?: boolean;
}> = ({ status, children, isFirst, isLast }) => {
  const beforeStatusClass =
    status === 'success'
      ? 'before:text-qwen-success'
      : status === 'error'
        ? 'before:text-qwen-error'
        : status === 'warning'
          ? 'before:text-qwen-warning'
          : 'before:text-qwen-loading before:opacity-70 before:animate-pulse-slow';
  const lineCropTop = isFirst ? 'top-[24px]' : 'top-0';
  const lineCropBottom = isLast
    ? 'bottom-auto h-[calc(100%-24px)]'
    : 'bottom-0';
  return (
    <div
      className={
        `qwen-message message-item relative pl-[30px] py-2 select-text ` +
        `before:absolute before:left-[8px] before:top-2 before:content-["\\25cf"] before:text-[10px] before:z-[1] ` +
        beforeStatusClass
      }
    >
      {/* timeline vertical line */}
      <div
        className={`absolute left-[12px] ${lineCropTop} ${lineCropBottom} w-px bg-[var(--app-primary-border-color)]`}
        aria-hidden
      />
      <div className="bg-[var(--app-input-background)] border border-[var(--app-input-border)] rounded-medium p-large my-medium">
        <div className="flex flex-col gap-3 min-w-0">{children}</div>
      </div>
    </div>
  );
};

const SearchRow: React.FC<{ label: string; children: React.ReactNode }> = ({
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

const LocationsListLocal: React.FC<{
  locations: Array<{ path: string; line?: number | null }>;
}> = ({ locations }) => (
  <div className="flex flex-col gap-1 max-w-full">
    {locations.map((loc, idx) => (
      <FileLink key={idx} path={loc.path} line={loc.line} showFullPath={true} />
    ))}
  </div>
);

export const SearchToolCall: React.FC<BaseToolCallProps> = ({
  toolCall,
  isFirst,
  isLast,
}) => {
  const { title, content, locations } = toolCall;
  const queryText = safeTitle(title);

  // Group content by type
  const { errors, textOutputs } = groupContent(content);

  // Error case: show search query + error in card layout
  if (errors.length > 0) {
    return (
      <SearchCard status="error" isFirst={isFirst} isLast={isLast}>
        <SearchRow label="Search">
          <div className="font-mono">{queryText}</div>
        </SearchRow>
        <SearchRow label="Error">
          <div className="text-qwen-error font-medium">{errors.join('\n')}</div>
        </SearchRow>
      </SearchCard>
    );
  }

  // Success case with results: show search query + file list
  if (locations && locations.length > 0) {
    const containerStatus = mapToolStatusToContainerStatus(toolCall.status);
    // If multiple results, use card layout; otherwise use compact format
    if (locations.length > 1) {
      return (
        <SearchCard status={containerStatus} isFirst={isFirst} isLast={isLast}>
          <SearchRow label="Search">
            <div className="font-mono">{queryText}</div>
          </SearchRow>
          <SearchRow label={`Found (${locations.length})`}>
            <LocationsListLocal locations={locations} />
          </SearchRow>
        </SearchCard>
      );
    }
    // Single result - compact format
    return (
      <InlineContainer
        status={containerStatus}
        labelSuffix={`(${queryText})`}
        isFirst={isFirst}
        isLast={isLast}
      >
        <span className="mx-2 opacity-50">→</span>
        <LocationsListLocal locations={locations} />
      </InlineContainer>
    );
  }

  // Show content text if available (e.g., "Listed 4 item(s).")
  if (textOutputs.length > 0) {
    const containerStatus = mapToolStatusToContainerStatus(toolCall.status);
    return (
      <InlineContainer
        status={containerStatus}
        labelSuffix={queryText ? `(${queryText})` : undefined}
        isFirst={isFirst}
        isLast={isLast}
      >
        <div className="flex flex-col">
          {textOutputs.map((text, index) => (
            <div
              key={index}
              className="inline-flex text-[var(--app-secondary-foreground)] text-[0.85em] opacity-70 mt-[2px] mb-[2px] flex-row items-start w-full gap-1"
            >
              <span className="flex-shrink-0 relative top-[-0.1em]">⎿</span>
              <span className="flex-shrink-0 w-full">{text}</span>
            </div>
          ))}
        </div>
      </InlineContainer>
    );
  }

  // No results - show query only
  if (queryText) {
    const containerStatus = mapToolStatusToContainerStatus(toolCall.status);
    return (
      <InlineContainer
        status={containerStatus}
        isFirst={isFirst}
        isLast={isLast}
      >
        <span className="font-mono">{queryText}</span>
      </InlineContainer>
    );
  }

  return null;
};
