/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FC } from 'react';
import { CloseSmallIcon } from '../icons/NavigationIcons.js';

// ======================== ImagePreview ========================

export interface ImagePreviewItem {
  id: string;
  name: string;
  data: string;
}

export interface ImagePreviewProps {
  images: ImagePreviewItem[];
  onRemove: (id: string) => void;
}

export const ImagePreview: FC<ImagePreviewProps> = ({ images, onRemove }) => {
  if (images.length === 0) {
    return null;
  }

  return (
    <div className="image-preview-container flex gap-2 px-2 pb-2">
      {images.map((image) => (
        <div key={image.id} className="image-preview-item relative group">
          <div className="relative">
            <img
              src={image.data}
              alt={image.name}
              className="w-14 h-14 object-cover rounded-md border border-gray-500 dark:border-gray-600"
              title={image.name}
            />
            <button
              type="button"
              onClick={() => onRemove(image.id)}
              className="absolute -top-2 -right-2 w-5 h-5 bg-gray-700 dark:bg-gray-600 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-gray-800 dark:hover:bg-gray-500"
              aria-label={`Remove ${image.name}`}
            >
              <CloseSmallIcon />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};

// ======================== ImageMessageRenderer ========================

export interface ImageMessageLike {
  kind: 'image';
  imagePath: string;
  imageSrc?: string;
  imageMissing?: boolean;
}

export interface ImageMessageRendererProps {
  msg: ImageMessageLike;
  imageIndex: number;
}

export const ImageMessageRenderer: FC<ImageMessageRendererProps> = ({
  msg,
  imageIndex,
}) => {
  if (msg.kind !== 'image' || !msg.imagePath) {
    return null;
  }

  const label = `[Image #${imageIndex}]`;
  const showImage = Boolean(msg.imageSrc) && !msg.imageMissing;

  return (
    <div className="qwen-message user-message-container flex gap-0 my-1 items-start text-left flex-col relative">
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
};
