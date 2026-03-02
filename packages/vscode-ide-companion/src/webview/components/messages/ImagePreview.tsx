/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import type { ImageAttachment } from '../../utils/imageUtils.js';

interface ImagePreviewProps {
  images: ImageAttachment[];
  onRemove: (id: string) => void;
}

export const ImagePreview: React.FC<ImagePreviewProps> = ({
  images,
  onRemove,
}) => {
  if (!images || images.length === 0) {
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
              <svg
                className="w-3 h-3"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};
