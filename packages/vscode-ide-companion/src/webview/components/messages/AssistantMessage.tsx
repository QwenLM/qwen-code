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
}

/**
 * AssistantMessage component - renders AI responses with Claude Code styling
 * Supports different states: default, success, error, warning, loading
 *
 * Claude Code DOM structure:
 * <div class="K o"><span class="i"><p>...</p></span></div>
 *
 * Styles:
 * .o - outer container with padding-left: 30px and ::before for bullet
 * .i - inner span wrapper
 */
export const AssistantMessage: React.FC<AssistantMessageProps> = ({
  content,
  timestamp: _timestamp,
  onFileClick,
  status = 'default',
}) => {
  // Empty content not rendered directly, avoid poor visual experience from only showing ::before dot
  if (!content || content.trim().length === 0) {
    return null;
  }

  // Map status to CSS class (only for ::before pseudo-element)
  const getStatusClass = () => {
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
        paddingTop: '8px',
        paddingBottom: '8px',
      }}
    >
      <span style={{ width: '100%' }}>
        <p
          style={{
            margin: 0,
            width: '100%',
            wordWrap: 'break-word',
            overflowWrap: 'break-word',
            whiteSpace: 'normal',
          }}
        >
          <MessageContent content={content} onFileClick={onFileClick} />
        </p>
      </span>
    </div>
  );
};
