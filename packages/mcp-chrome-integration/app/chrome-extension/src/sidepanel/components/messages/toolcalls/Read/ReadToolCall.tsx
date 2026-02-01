/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Read tool call component - specialized for file reading operations
 */

import type React from 'react';
import { useCallback, useEffect, useMemo } from 'react';
import type { BaseToolCallProps } from '../shared/types.js';
import {
  groupContent,
  mapToolStatusToContainerStatus,
} from '../shared/utils.js';
import { FileLink } from '../../../layout/FileLink.js';
import { useVSCode } from '../../../../hooks/useVSCode.js';
import { handleOpenDiff } from '../../../../utils/diffUtils.js';
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
    className={`ReadToolCall qwen-message message-item ${_className || ''} relative pl-[30px] py-2 select-text toolcall-container toolcall-status-${status}`}
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
        <div className="text-[var(--app-secondary-foreground)] py-1">
          {children}
        </div>
      )}
    </div>
  </div>
);

/**
 * Specialized component for Read tool calls
 * Optimized for displaying file reading operations
 * Shows: Read filename (no content preview)
 */
export const ReadToolCall: React.FC<BaseToolCallProps> = ({ toolCall }) => {
  const { content, locations, toolCallId } = toolCall;
  const vscode = useVSCode();

  // Group content by type; memoize to avoid new array identities on every render
  const { errors, diffs } = useMemo(() => groupContent(content), [content]);

  // Post a message to the extension host to open a VS Code diff tab
  const handleOpenDiffInternal = useCallback(
    (
      path: string | undefined,
      oldText: string | null | undefined,
      newText: string | undefined,
    ) => {
      handleOpenDiff(vscode, path, oldText, newText);
    },
    [vscode],
  );

  // Auto-open diff when a read call returns diff content.
  // Only trigger once per toolCallId so we don't spam as in-progress updates stream in.
  useEffect(() => {
    if (diffs.length > 0) {
      const firstDiff = diffs[0];
      const path = firstDiff.path || (locations && locations[0]?.path) || '';

      if (
        path &&
        firstDiff.oldText !== undefined &&
        firstDiff.newText !== undefined
      ) {
        const timer = setTimeout(() => {
          handleOpenDiffInternal(path, firstDiff.oldText, firstDiff.newText);
        }, 100);
        return () => timer && clearTimeout(timer);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolCallId]);

  // Compute container status based on toolCall.status (pending/in_progress -> loading)
  const containerStatus:
    | 'success'
    | 'error'
    | 'warning'
    | 'loading'
    | 'default' = mapToolStatusToContainerStatus(toolCall.status);

  // Error case: show error
  if (errors.length > 0) {
    const path = locations?.[0]?.path || '';
    return (
      <ToolCallContainer
        label={'Read'}
        className="read-tool-call-error"
        status="error"
        toolCallId={toolCallId}
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
      </ToolCallContainer>
    );
  }

  // Success case with diff: keep UI compact; VS Code diff is auto-opened above
  if (diffs.length > 0) {
    const path = diffs[0]?.path || locations?.[0]?.path || '';
    return (
      <ToolCallContainer
        label={'Read'}
        className="read-tool-call-success"
        status={containerStatus}
        toolCallId={toolCallId}
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
      </ToolCallContainer>
    );
  }

  // Success case: show which file was read with filename in label
  if (locations && locations.length > 0) {
    const path = locations[0].path;
    return (
      <ToolCallContainer
        label={'Read'}
        className="read-tool-call-success"
        status={containerStatus}
        toolCallId={toolCallId}
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
      </ToolCallContainer>
    );
  }

  // No file info, don't show
  return null;
};
