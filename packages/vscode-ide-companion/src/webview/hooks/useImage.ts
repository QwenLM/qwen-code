/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef, useState } from 'react';
import type { ImageAttachment } from '../../utils/imageSupport.js';
import {
  MAX_IMAGE_SIZE,
  MAX_TOTAL_IMAGE_SIZE,
  isDisplayableImagePath,
  isSupportedPastedImageMimeType,
  getImageExtensionForMimeType,
  unescapePath,
} from '../../utils/imageSupport.js';

export type { ImageAttachment };

// ======================== Message Types ========================

export interface WebViewMessageBase {
  role: 'user' | 'assistant' | 'thinking';
  content: string;
  timestamp: number;
  fileContext?: {
    fileName: string;
    filePath: string;
    startLine?: number;
    endLine?: number;
  };
}

export interface WebViewImageMessage extends WebViewMessageBase {
  kind: 'image';
  imagePath: string;
  imageSrc?: string;
  imageMissing?: boolean;
}

export type WebViewMessage = WebViewMessageBase | WebViewImageMessage;

// ======================== Message Parsing ========================

interface ParsedImageReference {
  imagePath: string;
  start: number;
  end: number;
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function splitMessageContentForImages(content: string): {
  text: string;
  imagePaths: string[];
} {
  if (!content) {
    return { text: '', imagePaths: [] };
  }

  const imageReferences = parseImageReferences(content);

  if (imageReferences.length === 0) {
    return { text: content, imagePaths: [] };
  }

  let cleanedContent = '';
  let lastIndex = 0;

  for (const reference of imageReferences) {
    cleanedContent += content.slice(lastIndex, reference.start);
    lastIndex = reference.end;
  }

  cleanedContent += content.slice(lastIndex);

  const cleaned = normalizeWhitespace(cleanedContent);
  const imagePaths = imageReferences.map((reference) => reference.imagePath);

  return { text: cleaned, imagePaths };
}

function parseImageReferences(content: string): ParsedImageReference[] {
  const references: ParsedImageReference[] = [];
  let currentIndex = 0;

  while (currentIndex < content.length) {
    let atIndex = -1;
    let nextSearchIndex = currentIndex;

    while (nextSearchIndex < content.length) {
      if (
        content[nextSearchIndex] === '@' &&
        (nextSearchIndex === 0 || content[nextSearchIndex - 1] !== '\\')
      ) {
        atIndex = nextSearchIndex;
        break;
      }
      nextSearchIndex += 1;
    }

    if (atIndex === -1) {
      break;
    }

    let pathEndIndex = atIndex + 1;
    let inEscape = false;

    while (pathEndIndex < content.length) {
      const char = content[pathEndIndex];

      if (inEscape) {
        inEscape = false;
      } else if (char === '\\') {
        inEscape = true;
      } else if (/[,\s;!?()[\]{}]/.test(char)) {
        break;
      } else if (char === '.') {
        const nextChar =
          pathEndIndex + 1 < content.length ? content[pathEndIndex + 1] : '';
        if (nextChar === '' || /\s/.test(nextChar)) {
          break;
        }
      }

      pathEndIndex += 1;
    }

    const rawReference = content.slice(atIndex, pathEndIndex);
    const unescapedReference = unescapePath(rawReference);
    const imagePath = unescapedReference.startsWith('@')
      ? unescapedReference.slice(1)
      : unescapedReference;

    if (isDisplayableImagePath(imagePath)) {
      references.push({
        imagePath,
        start: atIndex,
        end: pathEndIndex,
      });
    }

    currentIndex = pathEndIndex;
  }

  return references;
}

export function expandUserMessageWithImages(message: WebViewMessageBase): {
  messages: WebViewMessage[];
  imagePaths: string[];
} {
  const { text, imagePaths } = splitMessageContentForImages(message.content);
  if (imagePaths.length === 0) {
    return { messages: [message], imagePaths: [] };
  }

  const expanded: WebViewMessage[] = imagePaths.map((imagePath) => ({
    role: 'user',
    content: '',
    timestamp: message.timestamp,
    kind: 'image',
    imagePath,
  }));

  if (text) {
    expanded.push({
      ...message,
      content: text,
    });
  }

  return { messages: expanded, imagePaths };
}

export function applyImageResolution(
  messages: WebViewMessage[],
  resolutions: Map<string, string | null>,
): WebViewMessage[] {
  if (messages.length === 0 || resolutions.size === 0) {
    return messages;
  }

  let changed = false;
  const next = messages.map((message) => {
    if (!('kind' in message) || message.kind !== 'image') {
      return message;
    }

    const resolved = resolutions.get(message.imagePath);
    if (resolved === undefined) {
      return message;
    }

    const imageMissing = resolved === null;
    const imageSrc = resolved ?? undefined;
    if (
      message.imageSrc === imageSrc &&
      message.imageMissing === imageMissing
    ) {
      return message;
    }

    changed = true;
    return {
      ...message,
      imageSrc,
      imageMissing,
    };
  });

  return changed ? next : messages;
}

// ======================== useImagePaste ========================

async function fileToBase64(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function isSupportedImage(file: File): boolean {
  return isSupportedPastedImageMimeType(file.type);
}

function isWithinSizeLimit(file: File): boolean {
  return file.size <= MAX_IMAGE_SIZE;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) {
    return '0 B';
  }
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function createImageAttachment(
  file: File,
): Promise<ImageAttachment | null> {
  if (!isSupportedImage(file)) {
    return null;
  }

  if (!isWithinSizeLimit(file)) {
    return null;
  }

  try {
    const base64Data = await fileToBase64(file);
    return {
      id: `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: file.name || `image_${Date.now()}`,
      type: file.type,
      size: file.size,
      data: base64Data,
      timestamp: Date.now(),
    };
  } catch {
    return null;
  }
}

function generatePastedImageName(mimeType: string): string {
  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2, '0')}${now
    .getMinutes()
    .toString()
    .padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}`;
  return `pasted_image_${timeStr}${getImageExtensionForMimeType(mimeType)}`;
}

export function useImagePaste({
  onError,
}: { onError?: (error: string) => void } = {}) {
  const [attachedImages, setAttachedImages] = useState<ImageAttachment[]>([]);
  const processingRef = useRef(false);

  const handleRemoveImage = useCallback((imageId: string) => {
    setAttachedImages((prev) => prev.filter((img) => img.id !== imageId));
  }, []);

  const clearImages = useCallback(() => {
    setAttachedImages([]);
  }, []);

  const handlePaste = useCallback(
    async (event: React.ClipboardEvent | ClipboardEvent) => {
      if (processingRef.current) {
        return;
      }

      const clipboardData = event.clipboardData;
      if (!clipboardData?.files?.length) {
        return;
      }

      processingRef.current = true;
      event.preventDefault();
      event.stopPropagation();

      const imageAttachments: ImageAttachment[] = [];
      const errors: string[] = [];
      let runningTotal = attachedImages.reduce((sum, img) => sum + img.size, 0);

      try {
        for (let i = 0; i < clipboardData.files.length; i++) {
          const file = clipboardData.files[i];

          if (!file.type.startsWith('image/')) {
            continue;
          }

          if (!isSupportedImage(file)) {
            errors.push(`Unsupported image type: ${file.type}`);
            continue;
          }

          if (!isWithinSizeLimit(file)) {
            errors.push(
              `Image "${file.name || 'pasted image'}" is too large (${formatFileSize(file.size)}). Maximum size is 10MB.`,
            );
            continue;
          }

          if (runningTotal + file.size > MAX_TOTAL_IMAGE_SIZE) {
            errors.push(
              `Skipping image "${file.name || 'pasted image'}" – total attachment size would exceed ${formatFileSize(MAX_TOTAL_IMAGE_SIZE)}.`,
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
          } catch {
            errors.push(
              `Failed to process image "${file.name || 'pasted image'}"`,
            );
          }
        }

        if (errors.length > 0) {
          onError?.(errors.join('\n'));
        }

        if (imageAttachments.length > 0) {
          setAttachedImages((prev) => [...prev, ...imageAttachments]);
        }
      } finally {
        processingRef.current = false;
      }
    },
    [attachedImages, onError],
  );

  return { attachedImages, handleRemoveImage, clearImages, handlePaste };
}

// ======================== useImageResolution ========================

export function useImageResolution({
  vscode,
}: {
  vscode: { postMessage: (message: unknown) => void };
}) {
  const imageResolutionRef = useRef<Map<string, string | null>>(new Map());
  const pendingImagePathsRef = useRef<Set<string>>(new Set());
  const imageRequestIdRef = useRef(0);

  const expandMessages = useCallback(
    (
      messages: WebViewMessageBase[],
    ): { messages: WebViewMessage[]; imagePaths: string[] } => {
      const expanded: WebViewMessage[] = [];
      const allImagePaths: string[] = [];

      for (const message of messages) {
        if (message.role === 'user') {
          const result = expandUserMessageWithImages(message);
          expanded.push(...result.messages);
          allImagePaths.push(...result.imagePaths);
        } else {
          expanded.push(message);
        }
      }

      return { messages: expanded, imagePaths: allImagePaths };
    },
    [],
  );

  const applyCurrentImageResolutions = useCallback(
    (messages: WebViewMessage[]): WebViewMessage[] =>
      applyImageResolution(messages, imageResolutionRef.current),
    [],
  );

  const requestImageResolutions = useCallback(
    (imagePaths: string[]) => {
      if (imagePaths.length === 0) {
        return;
      }

      const pending = imagePaths.filter(
        (p) =>
          !imageResolutionRef.current.has(p) &&
          !pendingImagePathsRef.current.has(p),
      );

      if (pending.length === 0) {
        return;
      }

      for (const p of pending) {
        pendingImagePathsRef.current.add(p);
      }

      imageRequestIdRef.current += 1;
      vscode.postMessage({
        type: 'resolveImagePaths',
        data: { paths: pending, requestId: imageRequestIdRef.current },
      });
    },
    [vscode],
  );

  const materializeMessages = useCallback(
    (messages: WebViewMessageBase[]): WebViewMessage[] => {
      const expanded = expandMessages(messages);
      requestImageResolutions(expanded.imagePaths);
      return applyCurrentImageResolutions(expanded.messages);
    },
    [applyCurrentImageResolutions, expandMessages, requestImageResolutions],
  );

  const materializeMessage = useCallback(
    (message: WebViewMessageBase): WebViewMessage[] => {
      const expanded =
        message.role === 'user'
          ? expandUserMessageWithImages(message)
          : { messages: [message], imagePaths: [] as string[] };
      requestImageResolutions(expanded.imagePaths);
      return applyCurrentImageResolutions(expanded.messages);
    },
    [applyCurrentImageResolutions, requestImageResolutions],
  );

  const mergeResolvedImages = useCallback(
    (
      messages: WebViewMessage[],
      resolved: Array<{ path: string; src?: string | null }>,
    ): WebViewMessage[] => {
      for (const item of resolved) {
        pendingImagePathsRef.current.delete(item.path);
        imageResolutionRef.current.set(
          item.path,
          item.src === null || item.src === undefined ? null : item.src,
        );
      }

      return applyCurrentImageResolutions(messages);
    },
    [applyCurrentImageResolutions],
  );

  const clearImageResolutions = useCallback(() => {
    imageResolutionRef.current.clear();
    pendingImagePathsRef.current.clear();
  }, []);

  return {
    materializeMessages,
    materializeMessage,
    mergeResolvedImages,
    clearImageResolutions,
  };
}
