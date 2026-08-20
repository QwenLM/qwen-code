/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared copy utilities for toolcall components
 */

import type { FC } from 'react';
import { useState, useCallback } from 'react';
import { usePlatform } from '../../../context/PlatformContext.js';

/**
 * Handle copy to clipboard using platform-specific API with fallback
 * @param text Text to copy
 * @param event Mouse event to stop propagation
 * @param platformCopy Optional platform-specific copy function
 */
export const handleCopyToClipboard = async (
  text: string,
  event: React.MouseEvent,
  platformCopy?: (text: string) => Promise<void>,
): Promise<void> => {
  event.stopPropagation(); // Prevent triggering the row click
  try {
    // Use platform-specific copy if available, otherwise fall back to navigator.clipboard
    if (platformCopy) {
      await platformCopy(text);
    } else {
      await navigator.clipboard.writeText(text);
    }
  } catch (err) {
    console.error('Failed to copy text:', err);
  }
};

/**
 * Copy button component props
 */
interface CopyButtonProps {
  text: string;
}

/**
 * CopyButton - Shared copy button component with Tailwind styles
 * Uses PlatformContext for platform-specific clipboard access with fallback
 * Note: Parent element should have 'group' class for hover effect
 */
export const CopyButton: FC<CopyButtonProps> = ({ text }) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const platform = usePlatform();

  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      await handleCopyToClipboard(text, e, platform.copyToClipboard);
      setShowTooltip(true);
      setTimeout(() => setShowTooltip(false), 1000);
    },
    [text, platform.copyToClipboard],
  );

  // Check if copy feature is available
  const canCopy = platform.features?.canCopy !== false;

  if (!canCopy) {
    return null;
  }

  return (
    <button
      className="col-start-3 bg-transparent border-none px-2 py-1.5 cursor-pointer text-[var(--app-secondary-foreground)] opacity-0 transition-opacity duration-200 ease-out flex items-center justify-center rounded relative group-hover:opacity-70 hover:!opacity-100 hover:bg-[var(--app-input-border)] active:scale-95"
      onClick={handleClick}
      title="Copy"
      aria-label="Copy to clipboard"
      type="button"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M4 4V3C4 2.44772 4.44772 2 5 2H13C13.5523 2 14 2.44772 14 3V11C14 11.5523 13.5523 12 13 12H12M3 6H11C11.5523 6 12 6.44772 12 7V13C12 13.5523 11.5523 14 11 14H3C2.44772 14 2 13.5523 2 13V7C2 6.44772 2.44772 6 3 6Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {showTooltip && (
        <span className="absolute -top-7 right-0 bg-[var(--app-tool-background)] text-[var(--app-primary-foreground)] px-2 py-1 rounded text-xs whitespace-nowrap border border-[var(--app-input-border)] pointer-events-none">
          Copied!
        </span>
      )}
    </button>
  );
};
