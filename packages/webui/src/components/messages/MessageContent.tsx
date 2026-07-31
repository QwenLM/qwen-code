/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FC } from 'react';
import { memo } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer/MarkdownRenderer.js';

export interface MessageContentProps {
  content: string;
  onFileClick?: (filePath: string) => void;
  enableFileLinks?: boolean;
}

const MessageContentBase: FC<MessageContentProps> = ({
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

MessageContentBase.displayName = 'MessageContent';

export const MessageContent = memo(MessageContentBase);
