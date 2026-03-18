/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef } from 'react';
import {
  createImageAttachment,
  generatePastedImageName,
  isSupportedImage,
  isWithinSizeLimit,
  formatFileSize,
  MAX_TOTAL_IMAGE_SIZE,
  type ImageAttachment,
} from '../utils/imageUtils.js';

interface UsePasteHandlerOptions {
  onImagesAdded?: (images: ImageAttachment[]) => void;
  onError?: (error: string) => void;
  getCurrentTotalSize?: () => number;
  maxTotalSize?: number;
}

export function usePasteHandler({
  onImagesAdded,
  onError,
  getCurrentTotalSize,
  maxTotalSize = MAX_TOTAL_IMAGE_SIZE,
}: UsePasteHandlerOptions) {
  const processingRef = useRef(false);

  const handlePaste = useCallback(
    async (event: React.ClipboardEvent | ClipboardEvent) => {
      if (processingRef.current) {
        return;
      }

      const clipboardData = event.clipboardData;
      if (!clipboardData) {
        return;
      }

      const files = clipboardData.files;
      if (!files || files.length === 0) {
        return;
      }

      processingRef.current = true;
      event.preventDefault();
      event.stopPropagation();

      const imageAttachments: ImageAttachment[] = [];
      const errors: string[] = [];
      let runningTotal = getCurrentTotalSize?.() ?? 0;

      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];

          if (!file.type.startsWith('image/')) {
            continue;
          }

          if (!isSupportedImage(file)) {
            errors.push(`Unsupported image type: ${file.type}`);
            continue;
          }

          if (!isWithinSizeLimit(file)) {
            errors.push(
              `Image "${file.name || 'pasted image'}" is too large (${formatFileSize(
                file.size,
              )}). Maximum size is 10MB.`,
            );
            continue;
          }

          if (runningTotal + file.size > maxTotalSize) {
            errors.push(
              `Skipping image "${file.name || 'pasted image'}" – total attachment size would exceed ${formatFileSize(maxTotalSize)}.`,
            );
            continue;
          }

          try {
            // Clipboard pastes default to "image.png"; generate a timestamped name instead.
            const imageFile =
              file.name && file.name !== 'image.png'
                ? file
                : new File([file], generatePastedImageName(file.type), {
                    type: file.type,
                  });

            const attachment = await createImageAttachment(imageFile);
            if (attachment) {
              imageAttachments.push(attachment);
              runningTotal += attachment.size;
            }
          } catch (error) {
            console.error('Failed to process pasted image:', error);
            errors.push(
              `Failed to process image "${file.name || 'pasted image'}"`,
            );
          }
        }

        if (errors.length > 0 && onError) {
          onError(errors.join('\n'));
        }

        if (imageAttachments.length > 0 && onImagesAdded) {
          onImagesAdded(imageAttachments);
        }
      } finally {
        processingRef.current = false;
      }
    },
    [onImagesAdded, onError, getCurrentTotalSize, maxTotalSize],
  );

  return { handlePaste };
}
