/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { type FC, memo } from 'react';
import { CollapsibleFileContent } from './CollapsibleFileContent.js';
import { EditPencilIcon } from '../icons/EditIcons.js';
import { MessageMeta } from './MessageMeta.js';

export interface FileContext {
  fileName: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
}

export interface UserMessageProps {
  content: string;
  timestamp: number;
  onFileClick?: (path: string) => void;
  fileContext?: FileContext;
  onEdit?: () => void;
  editDisabled?: boolean;
}

const UserMessageBase: FC<UserMessageProps> = ({
  content,
  timestamp,
  onFileClick,
  fileContext,
  onEdit,
  editDisabled = false,
}) => {
  const getFileContextDisplay = () => {
    if (!fileContext) {
      return null;
    }
    const { fileName, startLine, endLine } = fileContext;
    if (startLine != null) {
      if (endLine != null && endLine !== startLine) {
        return `${fileName}#${startLine}-${endLine}`;
      }
      return `${fileName}#${startLine}`;
    }
    return fileName;
  };

  const fileContextDisplay = getFileContextDisplay();

  return (
    <div
      className="qwen-message user-message-container group flex gap-0 my-1 items-start text-left flex-col relative"
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
        <CollapsibleFileContent
          content={content}
          onFileClick={onFileClick}
          enableFileLinks={false}
        />
      </div>

      <MessageMeta
        timestamp={timestamp}
        copyText={content}
        onEdit={onEdit}
        editDisabled={editDisabled}
        editIcon={<EditPencilIcon size={14} />}
      />

      {fileContextDisplay && (
        <div className="mt-1">
          <button
            type="button"
            className="inline-flex items-center py-0 pr-2 gap-1 rounded-sm cursor-pointer relative opacity-50 bg-transparent border-none"
            onClick={() => fileContext && onFileClick?.(fileContext.filePath)}
            disabled={!onFileClick}
          >
            <span
              title={fileContextDisplay}
              style={{
                fontSize: '12px',
                color: 'var(--app-secondary-foreground)',
              }}
            >
              {fileContextDisplay}
            </span>
          </button>
        </div>
      )}
    </div>
  );
};

UserMessageBase.displayName = 'UserMessage';

export const UserMessage = memo(UserMessageBase);
