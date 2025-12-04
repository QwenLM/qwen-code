/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { MessageContent } from '../MessageContent.js';

interface StreamingMessageProps {
  content: string;
  onFileClick?: (path: string) => void;
}

export const StreamingMessage: React.FC<StreamingMessageProps> = ({
  content,
  onFileClick,
}) => (
  <div className="flex gap-0 items-start text-left flex-col relative animate-[fadeIn_0.2s_ease-in]">
    <div
      className="inline-block my-1 relative whitespace-pre-wrap rounded-md max-w-full overflow-x-auto overflow-y-hidden select-text leading-[1.5]"
      style={{
        border: '1px solid var(--app-input-border)',
        borderRadius: 'var(--corner-radius-medium)',
        backgroundColor: 'var(--app-input-background)',
        padding: '4px 6px',
        color: 'var(--app-primary-foreground)',
      }}
    >
      <MessageContent content={content} onFileClick={onFileClick} />
    </div>
    <div
      className="absolute right-3 bottom-3 animate-[pulse_1.5s_ease-in-out_infinite]"
      style={{ color: 'var(--app-primary-foreground)' }}
    >
      ●
    </div>
  </div>
);
