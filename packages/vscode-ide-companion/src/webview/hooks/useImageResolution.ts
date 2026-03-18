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
import {
  applyImageResolution,
  expandUserMessageWithImages,
} from '../utils/imageMessageUtils.js';

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
          : {
              messages: [message],
              imagePaths: [] as string[],
            };
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
