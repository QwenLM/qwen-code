/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * WebFetch/WebSearch tool call component
 * Displays web fetch and search operations with URL/query and output
 */

import { useState, type FC } from 'react';
import {
  ToolCallContainer,
  safeTitle,
  groupContent,
  mapToolStatusToContainerStatus,
} from './shared/index.js';
import type { BaseToolCallProps } from './shared/index.js';

type WebVariant = 'fetch' | 'search';

/** Default collapsed height in pixels */
const COLLAPSED_HEIGHT = 120;

/** Threshold for showing expand button (content longer than this will be collapsible) */
const EXPAND_THRESHOLD = 300;

/**
 * Get the URL or query from tool call data
 * @param variant - 'fetch' or 'search'
 * @param title - Tool call title
 * @param rawInput - Raw input object
 * @returns URL or query string
 */
const getWebTarget = (
  variant: WebVariant,
  title: unknown,
  rawInput?: unknown,
): string => {
  // Try to extract URL or query from rawInput
  if (rawInput && typeof rawInput === 'object') {
    const input = rawInput as Record<string, unknown>;
    if (variant === 'fetch' && input['url']) {
      return String(input['url']);
    }
    if (variant === 'search' && input['query']) {
      return String(input['query']);
    }
  }
  return safeTitle(title);
};

/**
 * Output card component with expand/collapse functionality
 * @param props - Component props
 * @returns JSX element
 */
const OutputCard: FC<{
  content: string;
  isError?: boolean;
}> = ({ content, isError = false }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const isLongContent = content.length > EXPAND_THRESHOLD;

  return (
    <div className="border-[0.5px] border-[var(--app-input-border)] rounded-[5px] bg-[var(--app-tool-background)] my-2 max-w-full text-[1em] items-start">
      <div className="flex flex-col gap-[3px] p-1">
        <div className="grid grid-cols-[max-content_1fr] p-1">
          <div className="text-[var(--app-secondary-foreground)] text-left opacity-50 py-1 px-2 pl-1 font-mono text-[0.85em]">
            OUT
          </div>
          <div
            className={`whitespace-pre-wrap break-words m-0 p-1 overflow-hidden ${
              !isExpanded && isLongContent
                ? `max-h-[${COLLAPSED_HEIGHT}px] [mask-image:linear-gradient(to_bottom,var(--app-primary-background)_80px,transparent_${COLLAPSED_HEIGHT}px)]`
                : ''
            }`}
            style={
              !isExpanded && isLongContent
                ? { maxHeight: `${COLLAPSED_HEIGHT}px` }
                : undefined
            }
          >
            <pre
              className={`m-0 overflow-hidden font-mono text-[0.85em] ${
                isError ? 'text-[#c74e39]' : ''
              }`}
            >
              {content}
            </pre>
          </div>
        </div>

        {/* Expand/Collapse button */}
        {isLongContent && (
          <div className="flex justify-center border-t border-[var(--app-input-border)] pt-1">
            <button
              type="button"
              onClick={() => setIsExpanded(!isExpanded)}
              className="text-[var(--app-secondary-foreground)] text-[0.8em] hover:text-[var(--app-primary-foreground)] cursor-pointer bg-transparent border-none px-2 py-1 rounded hover:bg-[var(--app-input-background)] transition-colors"
            >
              {isExpanded ? '▲ Collapse' : '▼ Show more'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * WebFetch/WebSearch tool call implementation
 * @param props - Component props including toolCall, variant, isFirst, isLast
 * @returns JSX element
 */
const WebFetchToolCallImpl: FC<BaseToolCallProps & { variant: WebVariant }> = ({
  toolCall,
  variant,
  isFirst,
  isLast,
}) => {
  const { title, content, rawInput, toolCallId } = toolCall;

  const webTarget = getWebTarget(variant, title, rawInput);
  const label = variant === 'fetch' ? 'Web Fetch' : 'Web Search';

  // Group content by type
  const { textOutputs, errors } = groupContent(content);

  // Map tool status to container status
  const containerStatus =
    errors.length > 0
      ? 'error'
      : mapToolStatusToContainerStatus(toolCall.status);

  // Error case
  if (errors.length > 0) {
    return (
      <ToolCallContainer
        label={label}
        status={containerStatus}
        toolCallId={toolCallId}
        isFirst={isFirst}
        isLast={isLast}
        labelSuffix={webTarget}
      >
        <OutputCard content={errors.join('\n')} isError />
      </ToolCallContainer>
    );
  }

  // Success with output
  if (textOutputs.length > 0) {
    const output = textOutputs.join('\n');

    return (
      <ToolCallContainer
        label={label}
        status={containerStatus}
        toolCallId={toolCallId}
        isFirst={isFirst}
        isLast={isLast}
        labelSuffix={webTarget}
      >
        <OutputCard content={output} />
      </ToolCallContainer>
    );
  }

  // No output yet - show just the URL/query (loading state)
  return (
    <ToolCallContainer
      label={label}
      status={containerStatus}
      toolCallId={toolCallId}
      isFirst={isFirst}
      isLast={isLast}
      labelSuffix={webTarget}
    />
  );
};

/**
 * WebFetchToolCall - displays web fetch/search tool calls
 * Shows URL/query and output with OUT card
 * @param props - Component props
 * @returns JSX element
 */
export const WebFetchToolCall: FC<BaseToolCallProps> = (props) => {
  const normalizedKind = props.toolCall.kind.toLowerCase();
  const variant: WebVariant =
    normalizedKind === 'web_search' || normalizedKind === 'websearch'
      ? 'search'
      : 'fetch'; // 'fetch', 'web_fetch', 'webfetch' all map to 'fetch'
  return <WebFetchToolCallImpl {...props} variant={variant} />;
};
