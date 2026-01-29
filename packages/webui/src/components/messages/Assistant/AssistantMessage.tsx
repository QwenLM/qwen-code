/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FC } from 'react';
import { MessageContent } from '../MessageContent.js';
import './AssistantMessage.css';

export type AssistantMessageStatus =
  | 'default'
  | 'success'
  | 'error'
  | 'warning'
  | 'loading';

export interface AssistantMessageProps {
  content: string;
  timestamp?: number;
  onFileClick?: (path: string) => void;
  status?: AssistantMessageStatus;
  /** When true, render without the left status bullet (no ::before dot) */
  hideStatusIcon?: boolean;
  /** Whether this is the first item in an AI response sequence (for timeline) */
  isFirst?: boolean;
  /** Whether this is the last item in an AI response sequence (for timeline) */
  isLast?: boolean;
}

/**
 * AssistantMessage component - renders AI responses with styling
 * Supports different states: default, success, error, warning, loading
 */
export const AssistantMessage: FC<AssistantMessageProps> = ({
  content,
  timestamp: _timestamp,
  onFileClick,
  status = 'default',
  hideStatusIcon = false,
  isFirst = false,
  isLast = false,
}) => {
  // Empty content not rendered directly
  if (!content || content.trim().length === 0) {
    return null;
  }

  const getStatusClass = () => {
    if (hideStatusIcon) {
      return '';
    }
    switch (status) {
      case 'success':
        return 'assistant-message-success';
      case 'error':
        return 'assistant-message-error';
      case 'warning':
        return 'assistant-message-warning';
      case 'loading':
        return 'assistant-message-loading';
      default:
        return 'assistant-message-default';
    }
  };

  return (
    <div
      className={`qwen-message message-item assistant-message-container ${getStatusClass()}`}
      data-first={isFirst}
      data-last={isLast}
      style={{
        width: '100%',
        alignItems: 'flex-start',
        paddingLeft: '30px',
        userSelect: 'text',
        position: 'relative',
      }}
    >
      <span style={{ width: '100%' }}>
        <div
          style={{
            margin: 0,
            width: '100%',
            wordWrap: 'break-word',
            overflowWrap: 'break-word',
            whiteSpace: 'normal',
          }}
        >
          <MessageContent
            content={content}
            onFileClick={onFileClick}
            enableFileLinks={false}
          />
        </div>
      </span>
    </div>
  );
};
