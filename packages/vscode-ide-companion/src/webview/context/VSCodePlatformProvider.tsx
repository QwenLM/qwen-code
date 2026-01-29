/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * VSCode Platform Provider - Adapts VSCode API to PlatformContext
 * This allows webui components to work with VSCode's messaging system
 */

import { useMemo, useCallback, useEffect, useRef } from 'react';
import type { FC, ReactNode } from 'react';
import { PlatformProvider } from '@qwen-code/webui';
import type { PlatformContextValue } from '@qwen-code/webui';
import { useVSCode } from '../hooks/useVSCode.js';
import { generateIconUrl } from '../utils/resourceUrl.js';

/**
 * Props for VSCodePlatformProvider
 */
interface VSCodePlatformProviderProps {
  children: ReactNode;
}

/**
 * VSCodePlatformProvider - Provides platform context for VSCode extension
 *
 * This component bridges the VSCode API with the platform-agnostic webui components.
 * It wraps children with PlatformProvider and provides VSCode-specific implementations.
 */
export const VSCodePlatformProvider: FC<VSCodePlatformProviderProps> = ({
  children,
}) => {
  const vscode = useVSCode();
  const messageHandlersRef = useRef<Set<(message: unknown) => void>>(new Set());

  // Set up message listener
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      messageHandlersRef.current.forEach((handler) => {
        handler(event.data);
      });
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Open file handler
  const openFile = useCallback(
    (path: string) => {
      vscode.postMessage({
        type: 'openFile',
        data: { path },
      });
    },
    [vscode],
  );

  // Open diff handler
  const openDiff = useCallback(
    (
      path: string,
      oldText: string | null | undefined,
      newText: string | undefined,
    ) => {
      vscode.postMessage({
        type: 'openDiff',
        data: {
          path,
          oldText: oldText ?? '',
          newText: newText ?? '',
        },
      });
    },
    [vscode],
  );

  // Open temp file handler
  const openTempFile = useCallback(
    (content: string, fileName: string = 'temp') => {
      vscode.postMessage({
        type: 'createAndOpenTempFile',
        data: {
          content,
          fileName,
        },
      });
    },
    [vscode],
  );

  // Attach file handler
  const attachFile = useCallback(() => {
    vscode.postMessage({
      type: 'attachFile',
      data: {},
    });
  }, [vscode]);

  // Login handler
  const login = useCallback(() => {
    vscode.postMessage({
      type: 'login',
      data: {},
    });
  }, [vscode]);

  // Copy to clipboard handler
  const copyToClipboard = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  }, []);

  // Get resource URL handler (for icons and other assets)
  const getResourceUrl = useCallback(
    (resourceName: string) => generateIconUrl(resourceName) || undefined,
    [],
  );

  // Subscribe to messages
  const onMessage = useCallback((handler: (message: unknown) => void) => {
    messageHandlersRef.current.add(handler);
    return () => {
      messageHandlersRef.current.delete(handler);
    };
  }, []);

  // Build platform context value
  const platformValue = useMemo<PlatformContextValue>(
    () => ({
      platform: 'vscode',
      postMessage: vscode.postMessage,
      onMessage,
      openFile,
      openDiff,
      openTempFile,
      attachFile,
      login,
      copyToClipboard,
      getResourceUrl,
      features: {
        canOpenFile: true,
        canOpenDiff: true,
        canOpenTempFile: true,
        canAttachFile: true,
        canLogin: true,
        canCopy: true,
      },
    }),
    [
      vscode.postMessage,
      onMessage,
      openFile,
      openDiff,
      openTempFile,
      attachFile,
      login,
      copyToClipboard,
      getResourceUrl,
    ],
  );

  return (
    <PlatformProvider value={platformValue}>
      {children as React.ReactNode}
    </PlatformProvider>
  );
};
