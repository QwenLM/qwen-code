/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { MessageContent } from '../MessageContent.js';

interface ThinkingMessageProps {
  content: string;
  timestamp: number;
  onFileClick?: (path: string) => void;
}

export const ThinkingMessage: React.FC<ThinkingMessageProps> = ({
  content,
  timestamp: _timestamp,
  onFileClick,
}) => (
  <div className="qwen-message thinking-message flex gap-0 items-start text-left py-2 flex-col relative opacity-80 italic pl-6 animate-[fadeIn_0.2s_ease-in]">
    <div
      className="inline-block my-1 relative whitespace-pre-wrap rounded-md max-w-full overflow-x-auto overflow-y-hidden select-text leading-[1.5]"
      style={{
        backgroundColor:
          'var(--app-list-hover-background, rgba(100, 100, 255, 0.1))',
        border: '1px solid rgba(100, 100, 255, 0.3)',
        borderRadius: 'var(--corner-radius-medium)',
        padding: 'var(--app-spacing-medium)',
        color: 'var(--app-primary-foreground)',
      }}
    >
      <span className="inline-flex items-center gap-1 mr-2">
        <span className="inline-block w-1.5 h-1.5 bg-[var(--app-secondary-foreground)] rounded-full opacity-60 animate-[typingPulse_1.4s_infinite_ease-in-out] [animation-delay:0s]"></span>
        <span className="inline-block w-1.5 h-1.5 bg-[var(--app-secondary-foreground)] rounded-full opacity-60 animate-[typingPulse_1.4s_infinite_ease-in-out] [animation-delay:0.2s]"></span>
        <span className="inline-block w-1.5 h-1.5 bg-[var(--app-secondary-foreground)] rounded-full opacity-60 animate-[typingPulse_1.4s_infinite_ease-in-out] [animation-delay:0.4s]"></span>
      </span>
      <MessageContent content={content} onFileClick={onFileClick} />
    </div>
    {/* Timestamp - temporarily hidden */}
    {/* <div
        className="text-xs opacity-60"
        style={{ color: 'var(--app-secondary-foreground)' }}
      >
        {new Date(timestamp).toLocaleTimeString()}
      </div> */}
  </div>
);
