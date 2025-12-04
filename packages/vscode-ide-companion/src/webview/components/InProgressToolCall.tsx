/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * In-progress tool call component - displays active tool calls with Claude Code style
 */

import React from 'react';
import type { ToolCallData } from './toolcalls/shared/types.js';
import { FileLink } from './ui/FileLink.js';
import { useVSCode } from '../hooks/useVSCode.js';

interface InProgressToolCallProps {
  toolCall: ToolCallData;
  onFileClick?: (path: string, line?: number | null) => void;
}

/**
 * Format the kind name to a readable label
 */
const formatKind = (kind: string): string => {
  const kindMap: Record<string, string> = {
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    execute: 'Execute',
    bash: 'Execute',
    command: 'Execute',
    search: 'Search',
    grep: 'Search',
    glob: 'Search',
    find: 'Search',
    think: 'Think',
    thinking: 'Think',
    fetch: 'Fetch',
    delete: 'Delete',
    move: 'Move',
  };

  return kindMap[kind.toLowerCase()] || 'Tool Call';
};

/**
 * Get file name from path
 */
const getFileName = (path: string): string => path.split('/').pop() || path;

/**
 * Component to display in-progress tool calls with Claude Code styling
 * Shows kind, file name, and file locations
 */
export const InProgressToolCall: React.FC<InProgressToolCallProps> = ({
  toolCall,
  onFileClick: _onFileClick,
}) => {
  const { kind, title, locations, content } = toolCall;
  const vscode = useVSCode();

  // Format the kind label
  const kindLabel = formatKind(kind);

  // Map tool kind to a Tailwind text color class (Claude-like palette)
  const kindColorClass = React.useMemo(() => {
    const k = kind.toLowerCase();
    if (k === 'read') {
      return 'text-[#4ec9b0]';
    }
    if (k === 'write' || k === 'edit') {
      return 'text-[#e5c07b]';
    }
    if (k === 'execute' || k === 'bash' || k === 'command') {
      return 'text-[#c678dd]';
    }
    if (k === 'search' || k === 'grep' || k === 'glob' || k === 'find') {
      return 'text-[#61afef]';
    }
    if (k === 'think' || k === 'thinking') {
      return 'text-[#98c379]';
    }
    return 'text-[var(--app-primary-foreground)]';
  }, [kind]);

  // Get file name from locations or title
  let fileName: string | null = null;
  let filePath: string | null = null;
  let fileLine: number | null = null;

  if (locations && locations.length > 0) {
    fileName = getFileName(locations[0].path);
    filePath = locations[0].path;
    fileLine = locations[0].line || null;
  } else if (typeof title === 'string') {
    fileName = title;
  }

  // Extract content text from content array
  let contentText: string | null = null;
  // Extract first diff (if present)
  let diffData: {
    path?: string;
    oldText?: string | null;
    newText?: string;
  } | null = null;
  if (content && content.length > 0) {
    // Look for text content
    for (const item of content) {
      if (item.type === 'content' && item.content?.text) {
        contentText = item.content.text;
        break;
      }
    }

    // If no text content found, look for other content types
    if (!contentText) {
      for (const item of content) {
        if (item.type === 'content' && item.content) {
          contentText = JSON.stringify(item.content, null, 2);
          break;
        }
      }
    }

    // Look for diff content
    for (const item of content) {
      if (
        item.type === 'diff' &&
        (item.oldText !== undefined || item.newText !== undefined)
      ) {
        diffData = {
          path: item.path,
          oldText: item.oldText ?? null,
          newText: item.newText,
        };
        break;
      }
    }
  }

  // Handle open diff
  const handleOpenDiff = () => {
    if (!diffData) {
      return;
    }
    const path = diffData.path || filePath || '';
    vscode.postMessage({
      type: 'openDiff',
      data: {
        path,
        oldText: diffData.oldText || '',
        newText: diffData.newText || '',
      },
    });
  };

  return (
    <div className="relative pl-[30px] py-2 select-text toolcall-container in-progress-toolcall">
      <div className="toolcall-content-wrapper flex flex-col gap-1 min-w-0 max-w-full">
        <div className="flex items-center gap-2 relative min-w-0 toolcall-header">
          <span
            className={`text-[14px] leading-none font-bold ${kindColorClass}`}
          >
            {kindLabel}
          </span>
          {filePath && (
            <FileLink
              path={filePath}
              line={fileLine ?? undefined}
              showFullPath={false}
              className="text-[14px]"
            />
          )}
          {!filePath && fileName && (
            <span className="text-[14px] leading-none text-[var(--app-secondary-foreground)]">
              {fileName}
            </span>
          )}

          {diffData && (
            <button
              type="button"
              onClick={handleOpenDiff}
              className="text-[11px] px-2 py-0.5 border border-[var(--app-input-border)] rounded-small text-[var(--app-primary-foreground)] bg-transparent hover:bg-[var(--app-ghost-button-hover-background)] cursor-pointer"
            >
              Open Diff
            </button>
          )}
        </div>

        {contentText && (
          <div className="text-[var(--app-secondary-foreground)]">
            <div className="inline-flex text-[var(--app-secondary-foreground)] text-[0.85em] opacity-70 mt-[2px] mb-[2px] flex-row items-start w-full gap-1">
              <span className="flex-shrink-0 relative top-[-0.1em]">⎿</span>
              <span className="toolcall-content-text flex-shrink-0 w-full">
                {contentText}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
