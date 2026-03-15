/**
 * Image paste hook - handles clipboard and drag-drop images
 * 
 * Lets users paste images with Ctrl+V or drag them in.
 * Converts to base64 so they can be sent with messages.
 */

import { useState, useCallback, useEffect } from 'react';

/**
 * Image data from paste or drop
 */
export interface PastedImage {
  /** Unique identifier for the image */
  id: string;
  /** Base64 encoded image data */
  dataUrl: string;
  /** File name if available */
  fileName?: string;
  /** MIME type (e.g., 'image/png', 'image/jpeg') */
  mimeType: string;
  /** File size in bytes */
  size?: number;
  /** Source of the image */
  source: 'clipboard' | 'drag-drop' | 'file-input';
}

/**
 * Image paste state
 */
export interface ImagePasteState {
  /** Whether images are currently being processed */
  isProcessing: boolean;
  /** List of pasted images */
  images: PastedImage[];
  /** Error message if any */
  error: string | null;
  /** Whether an error occurred */
  hasError: boolean;
}

/**
 * Convert File to base64 Data URL
 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Extract images from clipboard items
 */
async function extractImagesFromClipboard(
  items: DataTransferItemList,
): Promise<PastedImage[]> {
  const images: PastedImage[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        const dataUrl = await fileToDataUrl(file);
        images.push({
          id: `clipboard-${Date.now()}-${i}`,
          dataUrl,
          fileName: file.name || `pasted-image-${i}.png`,
          mimeType: item.type,
          size: file.size,
          source: 'clipboard',
        });
      }
    }
  }

  return images;
}

/**
 * Extract images from drag-and-drop
 */
async function extractImagesFromDrop(
  files: FileList,
): Promise<PastedImage[]> {
  const images: PastedImage[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    if (file.type.startsWith('image/')) {
      const dataUrl = await fileToDataUrl(file);
      images.push({
        id: `drop-${Date.now()}-${i}`,
        dataUrl,
        fileName: file.name,
        mimeType: file.type,
        size: file.size,
        source: 'drag-drop',
      });
    }
  }

  return images;
}

/**
 * Image paste hook
 *
 * Provides clipboard image paste and drag-and-drop support
 */
export function useImagePaste() {
  const [state, setState] = useState<ImagePasteState>({
    isProcessing: false,
    images: [],
    error: null,
    hasError: false,
  });

  /**
   * Handle paste event (Ctrl+V)
   */
  const handlePaste = useCallback(
    async (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;

      if (!items) {
        return;
      }

      // Check if clipboard contains images
      const hasImages = Array.from(items).some((item) =>
        item.type.startsWith('image/'),
      );

      if (!hasImages) {
        return; // Let default paste handling occur
      }

      event.preventDefault();
      setState((prev) => ({ ...prev, isProcessing: true }));

      try {
        const images = await extractImagesFromClipboard(items);

        setState((prev) => ({
          ...prev,
          images: [...prev.images, ...images],
          isProcessing: false,
          hasError: false,
          error: null,
        }));
      } catch (error) {
        setState((prev) => ({
          ...prev,
          isProcessing: false,
          hasError: true,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to process image from clipboard',
        }));
      }
    },
    [],
  );

  /**
   * Handle drag-and-drop event
   */
  const handleDrop = useCallback(
    async (event: React.DragEvent) => {
      const files = event.dataTransfer?.files;

      if (!files || files.length === 0) {
        return;
      }

      // Check if any files are images
      const hasImages = Array.from(files).some((file) =>
        file.type.startsWith('image/'),
      );

      if (!hasImages) {
        return; // Let default drop handling occur
      }

      event.preventDefault();
      setState((prev) => ({ ...prev, isProcessing: true }));

      try {
        const images = await extractImagesFromDrop(files);

        setState((prev) => ({
          ...prev,
          images: [...prev.images, ...images],
          isProcessing: false,
          hasError: false,
          error: null,
        }));
      } catch (error) {
        setState((prev) => ({
          ...prev,
          isProcessing: false,
          hasError: true,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to process dropped image',
        }));
      }
    },
    [],
  );

  /**
   * Handle drag over event (required for drop to work)
   */
  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
  }, []);

  /**
   * Clear all pasted images
   */
  const clearImages = useCallback(() => {
    setState((prev) => ({
      ...prev,
      images: [],
      hasError: false,
      error: null,
    }));
  }, []);

  /**
   * Remove a specific image by ID
   */
  const removeImage = useCallback((imageId: string) => {
    setState((prev) => ({
      ...prev,
      images: prev.images.filter((img) => img.id !== imageId),
    }));
  }, []);

  /**
   * Set images directly (for file input)
   */
  const setImages = useCallback((newImages: PastedImage[]) => {
    setState((prev) => ({
      ...prev,
      images: [...prev.images, ...newImages],
    }));
  }, []);

  // Register clipboard paste listener
  useEffect(() => {
    const handlePasteEvent = (event: ClipboardEvent) => {
      handlePaste(event);
    };

    document.addEventListener('paste', handlePasteEvent);

    return () => {
      document.removeEventListener('paste', handlePasteEvent);
    };
  }, [handlePaste]);

  return {
    // State
    images: state.images,
    isProcessing: state.isProcessing,
    error: state.error,
    hasError: state.hasError,

    // Handlers
    handlePaste,
    handleDrop,
    handleDragOver,
    clearImages,
    removeImage,
    setImages,
  };
}
