/**
 * Image preview component
 * 
 * Shows thumbnails of pasted images with a remove button.
 */

import type { FC } from 'react';
import { PastedImage } from '../hooks/useImagePaste';
import { CloseIcon } from '../icons/CloseIcon';

export interface ImagePreviewProps {
  image: PastedImage;
  isProcessing?: boolean;
  onRemove: (imageId: string) => void;
  showRemove?: boolean;
}

export const ImagePreview: FC<ImagePreviewProps> = ({
  image,
  isProcessing = false,
  onRemove,
  showRemove = true,
}) => {
  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRemove(image.id);
  };

  return (
    <div
      className={`
        relative inline-block
        border border-gray-300 dark:border-gray-600
        rounded-lg overflow-hidden
        bg-gray-50 dark:bg-gray-800
        transition-all duration-200
        ${isProcessing ? 'opacity-50 animate-pulse' : 'opacity-100'}
        hover:shadow-md
      `}
      title={image.fileName || 'Pasted image'}
    >
      <img
        src={image.dataUrl}
        alt={image.fileName || 'Pasted image'}
        className="w-20 h-20 object-cover"
        loading="lazy"
      />

      {isProcessing && (
        <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-30">
          <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {showRemove && (
        <button
          type="button"
          onClick={handleRemove}
          className="
            absolute top-1 right-1
            w-5 h-5 flex items-center justify-center
            bg-red-500 hover:bg-red-600
            text-white rounded-full
            opacity-0 group-hover:opacity-100
            transition-opacity duration-200
            focus:opacity-100
          "
          title="Remove image"
          aria-label="Remove image"
        >
          <CloseIcon size={12} />
        </button>
      )}

      <div
        className="
          absolute bottom-0 left-0 right-0
          bg-black bg-opacity-75
          text-white text-xs
          px-2 py-1
          opacity-0 hover:opacity-100
          transition-opacity duration-200
          truncate
        "
      >
        {image.fileName || 'image'}
        {image.size && ` (${formatFileSize(image.size)})`}
      </div>
    </div>
  );
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  } else {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}

export interface ImagePreviewListProps {
  images: PastedImage[];
  isProcessing?: boolean;
  onRemove: (imageId: string) => void;
}

export const ImagePreviewList: FC<ImagePreviewListProps> = ({
  images,
  isProcessing = false,
  onRemove,
}) => {
  if (images.length === 0) {
    return null;
  }

  return (
    <div
      className="
        flex flex-wrap gap-2
        p-2
        border-t border-gray-200 dark:border-gray-700
        bg-gray-50 dark:bg-gray-900
      "
    >
      {images.map((image) => (
        <div key={image.id} className="group">
          <ImagePreview
            image={image}
            isProcessing={isProcessing}
            onRemove={onRemove}
          />
        </div>
      ))}
    </div>
  );
};
