/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * EmptyState component - Welcome screen when no conversation is active
 * Shows logo and welcome message based on authentication state
 */

import type { FC } from 'react';
import { usePlatform } from '../../context/PlatformContext.js';

/**
 * Props for EmptyState component
 */
export interface EmptyStateProps {
  /** Whether user is authenticated */
  isAuthenticated?: boolean;
  /** Optional loading message to display */
  loadingMessage?: string;
  /** Optional custom logo URL (overrides platform resource) */
  logoUrl?: string;
  /** App name for welcome message */
  appName?: string;
}

/**
 * EmptyState component
 *
 * Features:
 * - Displays app logo (from platform resources or custom URL)
 * - Shows contextual welcome message based on auth state
 * - Loading state support
 * - Graceful fallback if logo fails to load
 *
 * @example
 * ```tsx
 * <EmptyState
 *   isAuthenticated={true}
 *   appName="Qwen Code"
 * />
 * ```
 */
export const EmptyState: FC<EmptyStateProps> = ({
  isAuthenticated = false,
  loadingMessage,
  logoUrl,
  appName = 'Qwen Code',
}) => {
  const platform = usePlatform();

  // Get logo URL: custom prop > platform resource > undefined
  const iconUri = logoUrl ?? platform.getResourceUrl?.('icon.png');

  const description = loadingMessage
    ? `Preparing ${appName}…`
    : isAuthenticated
      ? 'What would you like to do? Ask about this codebase or we can start writing code.'
      : `Welcome! Please log in to start using ${appName}.`;

  return (
    <div className="flex flex-col items-center justify-center h-full p-5 md:p-10">
      <div className="flex flex-col items-center gap-8 w-full">
        {/* Logo */}
        <div className="flex flex-col items-center gap-6">
          {iconUri ? (
            <img
              src={iconUri}
              alt={`${appName} Logo`}
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
                  fallback.textContent = appName.charAt(0).toUpperCase();
                  parent.appendChild(fallback);
                }
              }}
            />
          ) : (
            <div className="w-[60px] h-[60px] flex items-center justify-center text-2xl font-bold bg-gray-200 rounded">
              {appName.charAt(0).toUpperCase()}
            </div>
          )}
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
