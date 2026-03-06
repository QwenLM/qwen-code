/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebViewImageMessage } from '../../utils/imageMessageUtils.js';

export interface ImageMessageRendererProps {
  msg: WebViewImageMessage;
  imageIndex: number;
  index: number;
}

export function ImageMessageRenderer({
  msg,
  imageIndex,
  index,
}: ImageMessageRendererProps) {
  if (msg.kind !== 'image' || !msg.imagePath) {
    return null;
  }

  const label = `[Image #${imageIndex}]`;
  const showImage = Boolean(msg.imageSrc) && !msg.imageMissing;

  return (
    <div
      key={`message-${index}`}
      className="qwen-message user-message-container flex gap-0 my-1 items-start text-left flex-col relative"
      style={{ position: 'relative' }}
    >
      <div
        className="inline-block relative whitespace-pre-wrap rounded-md max-w-full overflow-x-auto overflow-y-hidden select-text leading-[1.5]"
        style={{
          border: '1px solid var(--app-input-border)',
          borderRadius: 'var(--corner-radius-medium)',
          backgroundColor: 'var(--app-input-background)',
          padding: '6px 8px',
          color: 'var(--app-primary-foreground)',
        }}
      >
        <div
          style={{
            fontSize: '12px',
            color: 'var(--app-secondary-foreground)',
            marginBottom: '4px',
          }}
        >
          {label}
        </div>
        {showImage ? (
          <img
            src={msg.imageSrc}
            alt={msg.imagePath}
            className="max-w-full rounded-md border border-gray-600"
          />
        ) : (
          <div
            style={{
              fontSize: '12px',
              color: 'var(--app-secondary-foreground)',
            }}
          >
            @{msg.imagePath}
          </div>
        )}
      </div>
    </div>
  );
}
