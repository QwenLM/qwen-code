/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { MessageContent } from '../MessageContent.js';
import './AssistantMessage.css';

interface AssistantMessageProps {
  content: string;
  timestamp: number;
  onFileClick?: (path: string) => void;
  status?: 'default' | 'success' | 'error' | 'warning' | 'loading';
  // When true, render without the left status bullet (no ::before dot)
  hideStatusIcon?: boolean;
}

/**
 * AssistantMessage component - renders AI responses with Qwen Code styling
 * Supports different states: default, success, error, warning, loading
 */
export const AssistantMessage: React.FC<AssistantMessageProps> = ({
  content,
  timestamp: _timestamp,
  onFileClick,
  status = 'default',
  hideStatusIcon = false,
}) => {
  // Empty content not rendered directly, avoid poor visual experience from only showing ::before dot
  if (!content || content.trim().length === 0) {
    return null;
  }

  // Map status to CSS class (only for ::before pseudo-element)
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
      style={{
        width: '100%',
        alignItems: 'flex-start',
        paddingLeft: '30px',
        userSelect: 'text',
        position: 'relative',
        // paddingTop: '8px',
        // paddingBottom: '8px',
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
