/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { MessageContent } from './MessageContent.js';

interface FileContext {
  fileName: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
}

interface UserMessageProps {
  content: string;
  timestamp: number;
  onFileClick?: (path: string) => void;
  fileContext?: FileContext;
}

export const UserMessage: React.FC<UserMessageProps> = ({
  content,
  timestamp: _timestamp,
  onFileClick,
  fileContext,
}) => {
  // Generate display text for file context
  const getFileContextDisplay = () => {
    if (!fileContext) {
      return null;
    }
    const { fileName, startLine, endLine } = fileContext;
    if (startLine && endLine) {
      return startLine === endLine
        ? `${fileName}#${startLine}`
        : `${fileName}#${startLine}-${endLine}`;
    }
    return fileName;
  };

  const fileContextDisplay = getFileContextDisplay();

  return (
    <div
      className="qwen-message user-message-container flex gap-0 my-1 items-start text-left flex-col relative"
      style={{ position: 'relative' }}
    >
      <div
        className="inline-block relative whitespace-pre-wrap rounded-md max-w-full overflow-x-auto overflow-y-hidden select-text leading-[1.5]"
        style={{
          border: '1px solid var(--app-input-border)',
          borderRadius: 'var(--corner-radius-medium)',
          backgroundColor: 'var(--app-input-background)',
          padding: '4px 6px',
          color: 'var(--app-primary-foreground)',
        }}
      >
        {/* For user messages, do NOT convert filenames to clickable links */}
        <MessageContent
          content={content}
          onFileClick={onFileClick}
          enableFileLinks={false}
        />
      </div>

      {/* File context indicator */}
      {fileContextDisplay && (
        <div className="mt-1">
          <div
            role="button"
            tabIndex={0}
            className="mr inline-flex items-center py-0 pr-2 gap-1 rounded-sm cursor-pointer relative opacity-50"
            onClick={() => fileContext && onFileClick?.(fileContext.filePath)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                fileContext && onFileClick?.(fileContext.filePath);
              }
            }}
          >
            <div
              className="gr"
              title={fileContextDisplay}
              style={{
                fontSize: '12px',
                color: 'var(--app-secondary-foreground)',
              }}
            >
              {fileContextDisplay}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
