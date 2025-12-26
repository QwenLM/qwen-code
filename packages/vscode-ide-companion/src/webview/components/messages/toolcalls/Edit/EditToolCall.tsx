/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Edit tool call component - specialized for file editing operations
 */

import { useMemo } from 'react';
import type { BaseToolCallProps } from '../shared/types.js';
import {
  groupContent,
  mapToolStatusToContainerStatus,
} from '../../../../utils/utils.js';
import { FileLink } from '../../../layout/FileLink.js';
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
    className={`qwen-message message-item ${_className || ''} relative pl-[30px] py-2 select-text toolcall-container toolcall-status-${status}`}
  >
    <div className="EditToolCall toolcall-content-wrapper flex flex-col gap-1 min-w-0 max-w-full">
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
 * Calculate diff summary (added/removed lines)
 */
const getDiffSummary = (
  oldText: string | null | undefined,
  newText: string | undefined,
): string => {
  const oldLines = oldText ? oldText.split('\n').length : 0;
  const newLines = newText ? newText.split('\n').length : 0;
  const diff = newLines - oldLines;

  if (diff > 0) {
    return `+${diff} lines`;
  } else if (diff < 0) {
    return `${diff} lines`;
  } else {
    return 'Modified';
  }
};

/**
 * Specialized component for Edit tool calls
 * Optimized for displaying file editing operations with diffs
 */
export const EditToolCall: React.FC<BaseToolCallProps> = ({ toolCall }) => {
  const { content, locations, toolCallId } = toolCall;

  // Group content by type; memoize to avoid new array identities on every render
  const { errors, diffs } = useMemo(() => groupContent(content), [content]);

  // Failed case: show explicit failed message and render inline diffs
  if (toolCall.status === 'failed') {
    const firstDiff = diffs[0];
    const path = firstDiff?.path || locations?.[0]?.path || '';
    const containerStatus = mapToolStatusToContainerStatus(toolCall.status);
    return (
      <div
        className={`qwen-message message-item relative py-2 select-text toolcall-container toolcall-status-${containerStatus}`}
      >
        <div className="toolcall-edit-content flex flex-col gap-1 min-w-0 max-w-full">
          <div className="flex items-center justify-between min-w-0">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="text-[13px] leading-none font-bold text-[var(--app-primary-foreground)]">
                Edit
              </span>
              {path && (
                <FileLink
                  path={path}
                  showFullPath={false}
                  className="font-mono text-[var(--app-secondary-foreground)] hover:underline"
                />
              )}
            </div>
          </div>
          {/* Failed state text (replace summary) */}
          <div className="inline-flex text-[var(--app-secondary-foreground)] text-[0.85em] opacity-70 flex-row items-start w-full gap-1 flex items-center">
            <span className="flex-shrink-0 w-full">edit failed</span>
          </div>
        </div>
      </div>
    );
  }

  // Error case: show error
  if (errors.length > 0) {
    const path = diffs[0]?.path || locations?.[0]?.path || '';
    return (
      <ToolCallContainer
        label={'Edit'}
        status="error"
        toolCallId={toolCallId}
        labelSuffix={
          path ? (
            <FileLink
              path={path}
              showFullPath={false}
              className="text-xs font-mono hover:underline"
            />
          ) : undefined
        }
      >
        {errors.join('\n')}
      </ToolCallContainer>
    );
  }

  // Success case with diff: show minimal inline preview; clicking the title opens VS Code diff
  if (diffs.length > 0) {
    const firstDiff = diffs[0];
    const path = firstDiff.path || (locations && locations[0]?.path) || '';
    const summary = getDiffSummary(firstDiff.oldText, firstDiff.newText);
    const containerStatus = mapToolStatusToContainerStatus(toolCall.status);
    return (
      <div
        className={`qwen-message message-item relative py-2 select-text toolcall-container toolcall-status-${containerStatus}`}
      >
        <div className="toolcall-edit-content flex flex-col gap-1 min-w-0 max-w-full">
          <div className="flex items-center justify-between min-w-0">
            <div className="flex items-baseline gap-1.5 min-w-0">
              {/* Align the inline Edit label styling with shared toolcall label: larger + bold */}
              <span className="text-[13px] leading-none font-bold text-[var(--app-primary-foreground)]">
                Edit
              </span>
              {path && (
                <FileLink
                  path={path}
                  showFullPath={false}
                  className="font-mono text-[var(--app-secondary-foreground)] hover:underline"
                />
              )}
            </div>
          </div>
          <div className="inline-flex text-[var(--app-secondary-foreground)] text-[0.85em] opacity-70 flex-row items-start w-full gap-1 flex items-baseline">
            <span className="flex-shrink-0 relative top-[-0.1em]">⎿</span>
            <span className="flex-shrink-0 w-full">{summary}</span>
          </div>
        </div>
      </div>
    );
  }

  // Success case without diff: show file in compact format
  if (locations && locations.length > 0) {
    const containerStatus = mapToolStatusToContainerStatus(toolCall.status);
    return (
      <ToolCallContainer
        label={`Edit`}
        status={containerStatus}
        toolCallId={toolCallId}
        labelSuffix={
          <FileLink
            path={locations[0].path}
            showFullPath={false}
            className="text-xs font-mono text-[var(--app-secondary-foreground)] hover:underline"
          />
        }
      >
        <div className="inline-flex text-[var(--app-secondary-foreground)] text-[0.85em] opacity-70 flex-row items-start w-full gap-1 flex items-center">
          <span className="flex-shrink-0 relative top-[-0.1em]">⎿</span>
          <FileLink
            path={locations[0].path}
            line={locations[0].line}
            showFullPath={true}
          />
        </div>
      </ToolCallContainer>
    );
  }

  // No output, don't show anything
  return null;
};
