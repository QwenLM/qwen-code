/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FC } from 'react';
import { useState } from 'react';
import { MessageContent } from './MessageContent.js';
import { ChevronIcon } from '../icons/index.js';
import './ThinkingMessage.css';

/**
 * ThinkingMessage component props interface
 */
export interface ThinkingMessageProps {
  /** Thinking content */
  content: string;
  /** Message timestamp */
  timestamp: number;
  /** File click callback */
  onFileClick?: (path: string) => void;
  /** Whether to expand by default, defaults to false */
  defaultExpanded?: boolean;
  /** Status: 'loading' means thinking in progress, 'default' means thinking complete */
  status?: 'loading' | 'default';
}

/**
 * ThinkingMessage - Collapsible thinking message component
 *
 * Displays the LLM's thinking process, collapsed by default, click to expand and view details.
 * Style reference from Claude Code's thinking message design:
 * - Collapsed: gray dot + "Thinking" + down arrow
 * - Expanded: solid dot + "Thinking" + up arrow + thinking content
 * - Aligned with other message items, with status icon and connector line
 */
export const ThinkingMessage: FC<ThinkingMessageProps> = ({
  content,
  timestamp: _timestamp,
  onFileClick,
  defaultExpanded = false,
  status = 'default',
}) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const handleToggle = () => {
    setIsExpanded(!isExpanded);
  };

  return (
    <div
      className={`qwen-message message-item thinking-message thinking-status-${status}`}
    >
      <div className="thinking-content-wrapper">
        {/* Clickable title bar */}
        <button
          type="button"
          onClick={handleToggle}
          className="thinking-toggle-btn"
          aria-expanded={isExpanded}
          aria-label={isExpanded ? 'Collapse thinking' : 'Expand thinking'}
        >
          {/* Thinking label text */}
          <span className="thinking-label">Thinking</span>
          {/* Expand/collapse arrow */}
          <ChevronIcon
            size={12}
            direction={isExpanded ? 'up' : 'down'}
            className="thinking-chevron"
          />
        </button>

        {/* Thinking content displayed when expanded */}
        {isExpanded && (
          <div className="thinking-content">
            <MessageContent content={content} onFileClick={onFileClick} />
          </div>
        )}
      </div>
    </div>
  );
};
