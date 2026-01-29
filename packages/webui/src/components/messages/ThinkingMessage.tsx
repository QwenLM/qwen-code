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
 * ThinkingMessage 组件的属性接口
 */
export interface ThinkingMessageProps {
  /** 思考内容 */
  content: string;
  /** 消息时间戳 */
  timestamp: number;
  /** 文件点击回调 */
  onFileClick?: (path: string) => void;
  /** 是否默认展开，默认为 false */
  defaultExpanded?: boolean;
  /** 状态: 'loading' 表示正在思考, 'default' 表示思考完成 */
  status?: 'loading' | 'default';
}

/**
 * ThinkingMessage - 可折叠的思考消息组件
 *
 * 显示 LLM 的思考过程，默认收起状态，点击可展开查看详细内容。
 * 样式参考 Claude Code 的 thinking 消息设计：
 * - 收起状态：灰色圆点 + "Thinking" + 向下箭头
 * - 展开状态：实心圆点 + "Thinking" + 向上箭头 + 思考内容
 * - 与其他消息项对齐，有 status icon 和连接线
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
        {/* 可点击的标题栏 */}
        <button
          type="button"
          onClick={handleToggle}
          className="thinking-toggle-btn"
          aria-expanded={isExpanded}
          aria-label={isExpanded ? 'Collapse thinking' : 'Expand thinking'}
        >
          {/* Thinking 文字 */}
          <span className="thinking-label">Thinking</span>
          {/* 展开/收起箭头 */}
          <ChevronIcon
            size={12}
            direction={isExpanded ? 'up' : 'down'}
            className="thinking-chevron"
          />
        </button>

        {/* 展开时显示的思考内容 */}
        {isExpanded && (
          <div className="thinking-content">
            <MessageContent content={content} onFileClick={onFileClick} />
          </div>
        )}
      </div>
    </div>
  );
};
