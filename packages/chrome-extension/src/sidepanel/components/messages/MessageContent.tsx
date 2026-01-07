/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { MarkdownRenderer } from './MarkdownRenderer/MarkdownRenderer.js';

interface MessageContentProps {
  content: string;
  onFileClick?: (filePath: string) => void;
  enableFileLinks?: boolean;
}

export const MessageContent: React.FC<MessageContentProps> = ({
  content,
  onFileClick,
  enableFileLinks,
}) => (
  <MarkdownRenderer
    content={content}
    onFileClick={onFileClick}
    enableFileLinks={enableFileLinks}
  />
);
