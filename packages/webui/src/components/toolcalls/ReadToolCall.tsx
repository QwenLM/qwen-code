/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Read tool call component - displays file reading operations
 * Pure UI component - platform interactions via usePlatform hook
 */

import type { FC } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileLink } from '../layout/FileLink.js';
import {
  groupContent,
  mapToolStatusToContainerStatus,
} from './shared/index.js';
import { usePlatform } from '../../context/PlatformContext.js';
import type {
  BaseToolCallProps,
  ToolCallContainerProps,
} from './shared/index.js';

/**
 * Simple container for Read tool calls
 */
const ReadToolCallContainer: FC<ToolCallContainerProps> = ({
  label,
  status = 'success',
  children,
  toolCallId: _toolCallId,
  labelSuffix,
  className: _className,
  isFirst = false,
  isLast = false,
}) => (
  <div
    className={`ReadToolCall qwen-message message-item ${_className || ''} relative pl-[30px] py-2 select-text toolcall-container toolcall-status-${status}`}
    data-first={isFirst}
    data-last={isLast}
  >
    <div className="toolcall-content-wrapper flex flex-col gap-1 min-w-0 max-w-full">
      <div className="flex items-baseline gap-1.5 relative min-w-0">
        <span className="text-[14px] leading-none font-bold text-[var(--app-primary-foreground)]">
          {label}
        </span>
        <span className="text-[11px] text-[var(--app-secondary-foreground)]">
          {labelSuffix}
        </span>
      </div>
      {children && (
        <div className="text-[var(--app-secondary-foreground)] py-0.5">
          {children}
        </div>
      )}
    </div>
  </div>
);

/**
 * ReadToolCall - displays file reading operations
 * Shows: Read filename (no content preview)
 */
export const ReadToolCall: FC<BaseToolCallProps> = ({
  toolCall,
  isFirst,
  isLast,
}) => {
  const { content, locations, toolCallId } = toolCall;
  const platform = usePlatform();
  const openedDiffsRef = useRef<Map<string, string>>(new Map());
  const [isExpanded, setIsExpanded] = useState(false);

  // Group content by type; memoize to avoid new array identities on every render
  const { errors, diffs, textOutputs } = useMemo(
    () => groupContent(content),
    [content],
  );

  /**
   * Open diff view (if platform supports it)
   */
  const handleOpenDiff = useCallback(
    (
      path: string | undefined,
      oldText: string | null | undefined,
      newText: string | undefined,
    ) => {
      if (!path) {
        return;
      }
      if (platform.openDiff) {
        platform.openDiff(path, oldText, newText);
        return;
      }
      // Fallback: post message for platforms that handle it differently
      platform.postMessage({
        type: 'openDiff',
        data: {
          path,
          oldText: oldText ?? '',
          newText: newText ?? '',
        },
      });
    },
    [platform],
  );

  // Auto-open diff when a read call returns diff content (once per diff signature)
  useEffect(() => {
    if (diffs.length === 0) {
      return;
    }

    const firstDiff = diffs[0];
    const path = firstDiff.path || locations?.[0]?.path || '';
    if (!path) {
      return;
    }

    if (firstDiff.oldText === undefined || firstDiff.newText === undefined) {
      return;
    }

    const signature = `${path}:${firstDiff.oldText ?? ''}:${firstDiff.newText ?? ''}`;
    const lastSignature = openedDiffsRef.current.get(toolCallId);
    if (lastSignature === signature) {
      return;
    }

    openedDiffsRef.current.set(toolCallId, signature);
    const timer = setTimeout(() => {
      handleOpenDiff(path, firstDiff.oldText, firstDiff.newText);
    }, 100);
    return () => clearTimeout(timer);
  }, [diffs, handleOpenDiff, locations, toolCallId]);

  // Compute container status based on toolCall.status
  const containerStatus = mapToolStatusToContainerStatus(toolCall.status);

  // Error case: show error from content
  if (errors.length > 0) {
    const path = locations?.[0]?.path || '';
    return (
      <ReadToolCallContainer
        label="Read"
        className="read-tool-call-error"
        status="error"
        toolCallId={toolCallId}
        isFirst={isFirst}
        isLast={isLast}
        labelSuffix={
          path ? (
            <FileLink
              path={path}
              showFullPath={false}
              className="text-xs font-mono text-[var(--app-secondary-foreground)] hover:underline"
            />
          ) : undefined
        }
      >
        {errors.join('\n')}
      </ReadToolCallContainer>
    );
  }

  // Failed status case: show failure message even if no explicit error content
  if (toolCall.status === 'failed') {
    const path = locations?.[0]?.path || '';
    const failureMessage =
      textOutputs.length > 0 ? textOutputs.join('\n') : 'Read operation failed';
    return (
      <ReadToolCallContainer
        label="Read"
        className="read-tool-call-error"
        status="error"
        toolCallId={toolCallId}
        isFirst={isFirst}
        isLast={isLast}
        labelSuffix={
          path ? (
            <FileLink
              path={path}
              showFullPath={false}
              className="text-xs font-mono text-[var(--app-secondary-foreground)] hover:underline"
            />
          ) : undefined
        }
      >
        {failureMessage}
      </ReadToolCallContainer>
    );
  }

  // Success case with diff
  if (diffs.length > 0) {
    const path = diffs[0]?.path || locations?.[0]?.path || '';
    return (
      <ReadToolCallContainer
        label="Read"
        className="read-tool-call-success"
        status={containerStatus}
        toolCallId={toolCallId}
        isFirst={isFirst}
        isLast={isLast}
        labelSuffix={
          path ? (
            <FileLink
              path={path}
              showFullPath={false}
              className="text-xs font-mono text-[var(--app-secondary-foreground)] hover:underline"
            />
          ) : undefined
        }
      >
        {null}
      </ReadToolCallContainer>
    );
  }

  // Success case: show which file was read (with optional content)
  if (locations && locations.length > 0) {
    const path = locations[0].path;
    const textContent = textOutputs.length > 0 ? textOutputs.join('\n') : '';
    const EXPAND_THRESHOLD = 300;
    const isLongContent = textContent.length > EXPAND_THRESHOLD;

    return (
      <ReadToolCallContainer
        label="Read"
        className="read-tool-call-success"
        status={containerStatus}
        toolCallId={toolCallId}
        isFirst={isFirst}
        isLast={isLast}
        labelSuffix={
          path ? (
            <FileLink
              path={path}
              showFullPath={false}
              className="text-xs font-mono text-[var(--app-secondary-foreground)] hover:underline"
            />
          ) : undefined
        }
      >
        {textContent ? (
          <div className="border border-[var(--app-input-border)] rounded-[5px] bg-[var(--app-tool-background)] overflow-hidden">
            <div
              className={`p-2 ${
                !isExpanded && isLongContent
                  ? 'max-h-[100px] overflow-hidden'
                  : ''
              }`}
              style={
                !isExpanded && isLongContent
                  ? {
                      maskImage:
                        'linear-gradient(to bottom, var(--app-primary-background) 60px, transparent 100px)',
                    }
                  : undefined
              }
            >
              <pre className="whitespace-pre-wrap break-words text-xs font-mono m-0">
                {textContent}
              </pre>
            </div>
            {isLongContent && (
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="flex items-center justify-center w-full py-1 px-2 border-t border-[var(--app-input-border)] cursor-pointer text-[var(--app-secondary-foreground)] text-[0.75em] opacity-70 hover:opacity-100 hover:bg-[var(--app-code-background)] transition-opacity bg-transparent"
              >
                {isExpanded ? '▲ Collapse' : '▼ Show more'}
              </button>
            )}
          </div>
        ) : null}
      </ReadToolCallContainer>
    );
  }

  /**
   * Fallback case: ACP message has content but no locations field.
   * This can happen when:
   * 1. IDE companion missed the initial tool_call event (which contains locations)
   * 2. The CLI sent tool_call_update without locations
   * 3. External tools (like MCP tools) don't provide location metadata
   *
   * In these cases, we still render the content to avoid silently dropping the output.
   */
  if (textOutputs.length > 0) {
    const textContent = textOutputs.join('\n');
    const EXPAND_THRESHOLD = 300;
    const isLongContent = textContent.length > EXPAND_THRESHOLD;

    return (
      <ReadToolCallContainer
        label="Read"
        className="read-tool-call-success"
        status={containerStatus}
        toolCallId={toolCallId}
        isFirst={isFirst}
        isLast={isLast}
      >
        <div className="border border-[var(--app-input-border)] rounded-[5px] bg-[var(--app-tool-background)] overflow-hidden">
          <div
            className={`p-2 ${
              !isExpanded && isLongContent
                ? 'max-h-[100px] overflow-hidden'
                : ''
            }`}
            style={
              !isExpanded && isLongContent
                ? {
                    maskImage:
                      'linear-gradient(to bottom, var(--app-primary-background) 60px, transparent 100px)',
                  }
                : undefined
            }
          >
            <pre className="whitespace-pre-wrap break-words text-xs font-mono m-0">
              {textContent}
            </pre>
          </div>
          {isLongContent && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="flex items-center justify-center w-full py-1 px-2 border-t border-[var(--app-input-border)] cursor-pointer text-[var(--app-secondary-foreground)] text-[0.75em] opacity-70 hover:opacity-100 hover:bg-[var(--app-code-background)] transition-opacity bg-transparent"
            >
              {isExpanded ? '▲ Collapse' : '▼ Show more'}
            </button>
          )}
        </div>
      </ReadToolCallContainer>
    );
  }

  // No file info and no content - nothing to display
  return null;
};
