/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useRef, useCallback } from 'react';
import type {
  WebViewMessage,
  WebViewMessageBase,
} from '../utils/imageMessageUtils.js';
import { expandUserMessageWithImages } from '../utils/imageMessageUtils.js';

export interface UseImageResolutionProps {
  vscode: {
    postMessage: (message: unknown) => void;
  };
}

export function useImageResolution({ vscode }: UseImageResolutionProps) {
  const imageResolutionRef = useRef<Map<string, string | null>>(new Map());
  const pendingImagePathsRef = useRef<Set<string>>(new Set());
  const imageRequestIdRef = useRef(0);

  const expandMessages = useCallback(
    (
      messages: WebViewMessageBase[],
    ): {
      messages: WebViewMessage[];
      imagePaths: string[];
    } => {
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

  const requestImageResolutions = useCallback(
    (imagePaths: string[]) => {
      if (imagePaths.length === 0) {
        return;
      }

      const pending = imagePaths.filter(
        (path) =>
          !imageResolutionRef.current.has(path) &&
          !pendingImagePathsRef.current.has(path),
      );

      if (pending.length === 0) {
        return;
      }

      for (const path of pending) {
        pendingImagePathsRef.current.add(path);
      }

      if (pending.length === 0) {
        return;
      }

      imageRequestIdRef.current += 1;
      vscode.postMessage({
        type: 'resolveImagePaths',
        data: { paths: pending, requestId: imageRequestIdRef.current },
      });
    },
    [vscode],
  );

  const applyImageResolutions = useCallback(() => {
    // This function is called after image resolutions are received
    // The actual application happens in the calling component
    // by passing the current resolutions to applyImageResolution
  }, []);

  const handleImagePathsResolved = useCallback(
    (resolved: Array<{ path: string; src?: string | null }>) => {
      for (const item of resolved) {
        pendingImagePathsRef.current.delete(item.path);
        imageResolutionRef.current.set(
          item.path,
          item.src === null || item.src === undefined ? null : item.src,
        );
      }
      // Notify parent that resolutions have been updated
      applyImageResolutions();
    },
    [applyImageResolutions],
  );

  const clearImageResolutions = useCallback(() => {
    imageResolutionRef.current.clear();
    pendingImagePathsRef.current.clear();
  }, []);

  const getCurrentResolutions = useCallback(
    () => imageResolutionRef.current,
    [],
  );

  return {
    expandMessages,
    requestImageResolutions,
    applyImageResolutions,
    handleImagePathsResolved,
    clearImageResolutions,
    getCurrentResolutions,
  };
}
