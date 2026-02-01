/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FC } from 'react';
import { EmptyState as BaseEmptyState } from '@qwen-code/webui';

interface EmptyStateProps {
  isAuthenticated?: boolean;
  loadingMessage?: string;
}

// Helper function to get extension asset URL
function getExtensionAssetUrl(assetPath: string): string {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime.getURL(assetPath);
  }
  // Fallback during development or if chrome API is not available
  return assetPath;
}

export const EmptyState: FC<EmptyStateProps> = ({
  isAuthenticated = false,
  loadingMessage,
}) => {
  const logoUrl = getExtensionAssetUrl('icons/icon-source.png');

  return (
    <BaseEmptyState
      isAuthenticated={isAuthenticated}
      loadingMessage={loadingMessage}
      logoUrl={logoUrl}
      appName="Qwen Code"
    />
  );
};
