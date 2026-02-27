/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useState } from 'react';
import type { ImageAttachment } from '../utils/imageUtils.js';
import { usePasteHandler } from './usePasteHandler.js';

export interface UseImageAttachmentsProps {
  onError?: (error: string) => void;
}

export function useImageAttachments({
  onError,
}: UseImageAttachmentsProps = {}) {
  const [attachedImages, setAttachedImages] = useState<ImageAttachment[]>([]);

  // Image handling
  const handleAddImages = useCallback((newImages: ImageAttachment[]) => {
    if (newImages.length === 0) {
      return;
    }
    setAttachedImages((prev) => [...prev, ...newImages]);
  }, []);

  const handleRemoveImage = useCallback((imageId: string) => {
    setAttachedImages((prev) => prev.filter((img) => img.id !== imageId));
  }, []);

  const clearImages = useCallback(() => {
    setAttachedImages([]);
  }, []);

  // Initialize paste handler
  const { handlePaste } = usePasteHandler({
    onImagesAdded: handleAddImages,
    getCurrentTotalSize: () =>
      attachedImages.reduce((sum, img) => sum + img.size, 0),
    onError: (error) => {
      console.error('Paste error:', error);
      onError?.(error);
    },
  });

  return {
    attachedImages,
    handleAddImages,
    handleRemoveImage,
    clearImages,
    handlePaste,
  };
}
