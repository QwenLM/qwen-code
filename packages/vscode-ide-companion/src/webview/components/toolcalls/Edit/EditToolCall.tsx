/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Edit tool call component - specialized for file editing operations
 */

import { useEffect, useCallback } from 'react';
import type { BaseToolCallProps } from '../shared/types.js';
import { ToolCallContainer } from '../shared/LayoutComponents.js';
import { DiffDisplay } from '../shared/DiffDisplay.js';
import { groupContent } from '../shared/utils.js';
import { useVSCode } from '../../../hooks/useVSCode.js';
import { FileLink } from '../../ui/FileLink.js';

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
  const vscode = useVSCode();

  // Group content by type
  const { errors, diffs } = groupContent(content);

  const handleOpenDiff = useCallback(
    (
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
    },
    [vscode],
  );

  // Extract filename from path
  const getFileName = (path: string): string => path.split('/').pop() || path;

  // Automatically trigger openDiff when diff content is detected (Claude Code style)
  useEffect(() => {
    // Only auto-open if there are diffs and we have the required data
    if (diffs.length > 0) {
      const firstDiff = diffs[0];
      const path = firstDiff.path || (locations && locations[0]?.path) || '';

      if (
        path &&
        firstDiff.oldText !== undefined &&
        firstDiff.newText !== undefined
      ) {
        // TODO: 暂时注释
        // Add a small delay to ensure the component is fully rendered
        // const timer = setTimeout(() => {
        //   handleOpenDiff(path, firstDiff.oldText, firstDiff.newText);
        // }, 100);
        let timer;
        return () => timer && clearTimeout(timer);
      }
    }
  }, [diffs, locations, handleOpenDiff]);

  // Error case: show error
  if (errors.length > 0) {
    const path = diffs[0]?.path || locations?.[0]?.path || '';
    const fileName = path ? getFileName(path) : '';
    return (
      <ToolCallContainer
        label={fileName ? 'Edit' : 'Edit'}
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

  // Success case with diff: show minimal inline preview; clicking the title opens VS Code diff
  if (diffs.length > 0) {
    const firstDiff = diffs[0];
    const path = firstDiff.path || (locations && locations[0]?.path) || '';
    // const fileName = path ? getFileName(path) : '';
    const summary = getDiffSummary(firstDiff.oldText, firstDiff.newText);
    // No hooks here; define a simple click handler scoped to this block
    const openFirstDiff = () =>
      handleOpenDiff(path, firstDiff.oldText, firstDiff.newText);

    return (
      <div
        className="qwen-message message-item relative py-2 select-text cursor-pointer hover:bg-[var(--app-input-background)] toolcall-container toolcall-status-success"
        onClick={openFirstDiff}
        title="Open diff in VS Code"
      >
        {/* Keep content within overall width: pl-[30px] provides the bullet indent; */}
        {/* IMPORTANT: Always include min-w-0/max-w-full on inner wrappers to prevent overflow. */}
        <div className="toolcall-edit-content flex flex-col gap-1 min-w-0 max-w-full pl-[30px]">
          <div className="flex items-center justify-between min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              {/* Align the inline Edit label styling with shared toolcall label: larger + bold */}
              <span className="text-[14px] leading-none font-bold text-[var(--app-primary-foreground)]">
                Edit
              </span>
              {path && (
                <FileLink
                  path={path}
                  showFullPath={false}
                  className="text-xs font-mono text-[var(--app-secondary-foreground)] hover:underline"
                />
              )}
              {/* {toolCallId && (
                  <span className="text-[10px] opacity-30">
                    [{toolCallId.slice(-8)}]
                  </span>
                )} */}
            </div>
            <span className="text-xs opacity-60 ml-2">open</span>
          </div>
          <div className="inline-flex text-[var(--app-secondary-foreground)] text-[0.85em] opacity-70 flex-row items-start w-full gap-1">
            <span className="flex-shrink-0 relative top-[-0.1em]">⎿</span>
            <span className="flex-shrink-0 w-full">{summary}</span>
          </div>
        </div>

        {/* Content area aligned with bullet indent. Do NOT exceed container width. */}
        {/* For any custom blocks here, keep: min-w-0 max-w-full and avoid extra horizontal padding/margins. */}
        <div className="pl-[30px] mt-1 min-w-0 max-w-full overflow-hidden">
          {diffs.map(
            (
              item: import('../shared/types.js').ToolCallContent,
              idx: number,
            ) => (
              <DiffDisplay
                key={`diff-${idx}`}
                path={item.path}
                oldText={item.oldText}
                newText={item.newText}
                onOpenDiff={() =>
                  handleOpenDiff(item.path, item.oldText, item.newText)
                }
              />
            ),
          )}
        </div>
      </div>
    );
  }

  // Success case without diff: show file in compact format
  if (locations && locations.length > 0) {
    const fileName = getFileName(locations[0].path);
    return (
      <ToolCallContainer
        label={`Edited ${fileName}`}
        status="success"
        toolCallId={toolCallId}
      >
        <div className="inline-flex text-[var(--app-secondary-foreground)] text-[0.85em] opacity-70 flex-row items-start w-full gap-1">
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
