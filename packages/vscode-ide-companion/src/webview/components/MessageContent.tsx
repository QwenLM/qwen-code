/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * MessageContent component - renders message with code highlighting and clickable file paths
 */

import type React from 'react';
import { MarkdownRenderer } from './MarkdownRenderer.tsx';

interface MessageContentProps {
  content: string;
  onFileClick?: (filePath: string) => void;
}

/**
 * MessageContent component - renders message content with markdown support
 */
export const MessageContent: React.FC<MessageContentProps> = ({
  content,
  onFileClick,
}) => <MarkdownRenderer content={content} onFileClick={onFileClick} />;
