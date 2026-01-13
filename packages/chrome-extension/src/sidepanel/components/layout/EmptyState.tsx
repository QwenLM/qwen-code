/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';

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

export const EmptyState: React.FC<EmptyStateProps> = ({
  isAuthenticated = false,
  loadingMessage,
}) => {
  const iconSrc = getExtensionAssetUrl('icons/icon-source.png');

  const description = loadingMessage
    ? 'Preparing Qwen Code Chrome Extension...'
    : isAuthenticated
      ? 'What would you like to do? Ask about this codebase or we can start writing code.'
      : 'Welcome! Please log in to start using Qwen Code.';

  return (
    <div className="flex flex-col items-center justify-center h-full p-5 md:p-10">
      <div className="flex flex-col items-center gap-8 w-full">
        {/* Qwen Logo */}
        <div className="flex flex-col items-center gap-6">
          <img
            src={iconSrc}
            alt="Qwen Logo"
            className="w-[60px] h-[60px] object-contain"
            onError={(e) => {
              // Fallback to a div with text if image fails to load
              const target = e.target as HTMLImageElement;
              target.style.display = 'none';
              const parent = target.parentElement;
              if (parent) {
                const fallback = document.createElement('div');
                fallback.className =
                  'w-[60px] h-[60px] flex items-center justify-center text-2xl font-bold';
                fallback.textContent = 'Q';
                parent.appendChild(fallback);
              }
            }}
          />
          <div className="text-center">
            <div className="text-[15px] text-app-primary-foreground leading-normal font-normal max-w-[400px]">
              {description}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
