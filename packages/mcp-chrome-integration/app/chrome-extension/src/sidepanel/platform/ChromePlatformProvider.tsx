/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FC, ReactNode } from 'react';
import { useMemo } from 'react';
import { PlatformProvider } from '@qwen-code/webui';
import { useVSCode } from '../hooks/useVSCode.js';

interface ChromePlatformProviderProps {
  children: ReactNode;
}

export const ChromePlatformProvider: FC<ChromePlatformProviderProps> = ({
  children,
}) => {
  const vscode = useVSCode();

  const value = useMemo(
    () => ({
      platform: 'chrome' as const,
      postMessage: (message: unknown) => {
        void vscode.postMessage(message);
      },
      onMessage: (handler: (message: unknown) => void) => {
        if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) {
          return () => {};
        }
        const listener = (message: unknown) => handler(message);
        chrome.runtime.onMessage.addListener(listener);
        return () => chrome.runtime.onMessage.removeListener(listener);
      },
      openFile: (path: string) => {
        void vscode.postMessage({ type: 'openFile', data: { path } });
      },
      openDiff: (
        path: string,
        oldText: string | null | undefined,
        newText: string | undefined,
      ) => {
        void vscode.postMessage({
          type: 'openDiff',
          data: { path, oldText: oldText ?? '', newText: newText ?? '' },
        });
      },
      copyToClipboard: async (text: string) => {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        }
      },
      getResourceUrl: (resourceName: string) =>
        chrome?.runtime?.getURL?.(resourceName),
      features: {
        canOpenFile: true,
        canOpenDiff: true,
        canCopy: true,
      },
    }),
    [vscode],
  );

  return <PlatformProvider value={value}>{children}</PlatformProvider>;
};
